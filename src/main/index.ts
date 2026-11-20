import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
  Tray
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type {
  AppSettings,
  CreateRecordingInput,
  DetectedMeeting,
  StartRecordingRequest,
  UpdateRecordingPatch
} from '@shared/types'
import { AimyApiClient } from './aimyApi'
import { getAppIconPng, getTrayIcon, getWindowIcon } from './appIcons'
import { checkDeepFilterAvailable } from './audioEnhancer'
import { AuthManager } from './auth'
import { MeetingDetector } from './meetingDetector'
import { PromptWindowManager } from './promptWindow'
import { RecorderStore } from './recorderStore'
import { SyncManager } from './syncManager'

// Register custom media scheme for local audio playback + range seeking
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aimy-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let isRecordingActive = false
let activeRecordingTitle = ''
let currentLiveMeeting: DetectedMeeting | null = null

const preloadPath = join(__dirname, '../preload/index.js')
const rendererUrl = process.env['ELECTRON_RENDERER_URL']
const rendererHtml = join(__dirname, '../renderer/index.html')

let authManager: AuthManager
let store: RecorderStore
let apiClient: AimyApiClient
let syncManager: SyncManager
let promptManager: PromptWindowManager
let meetingDetector: MeetingDetector

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function broadcastToMain(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function updateTray(): void {
  if (!tray) return
  tray.setImage(getTrayIcon(isRecordingActive))
  tray.setToolTip(
    isRecordingActive
      ? `AiMY Meetings — Recording: ${activeRecordingTitle || 'Active meeting'}`
      : 'AiMY Meetings — Ready'
  )

  const pendingCount = store
    .listRecordings()
    .filter((r) => r.syncStatus === 'LOCAL_PENDING' || r.syncStatus === 'FAILED').length

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open AiMY Meetings',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    isRecordingActive
      ? {
          label: 'Stop Recording',
          click: () => {
            showMainWindow()
            broadcastToMain('recording:stop-requested')
          }
        }
      : {
          label: 'Start New Recording',
          click: () => {
            showMainWindow()
            broadcastToMain('recording:start-requested', {
              title: `Meeting — ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
              meetingApp: 'Manual'
            } satisfies StartRecordingRequest)
          }
        },
    {
      label: pendingCount > 0 ? `Sync Pending (${pendingCount})` : 'Refresh Sync Status',
      click: () => {
        if (pendingCount > 0) {
          void syncManager.syncAllPending()
        } else {
          void syncManager.refreshAllStatuses()
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Open AiMY Knowledge Console',
      click: () => void shell.openExternal(`${store.getSettings().consoleBaseUrl}/console`)
    },
    { type: 'separator' },
    {
      label: 'Quit AiMY Meetings',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    title: 'AiMY Meetings',
    icon: getWindowIcon(),
    backgroundColor: '#0c0d10',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(rendererHtml)
  }
}

function setupMediaPermissions(): void {
  // Enable automatic Windows WASAPI system audio loopback via getDisplayMedia
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' })
      } else {
        callback({})
      }
    } catch (err) {
      console.error('[Media] Failed to resolve display audio source:', err)
      callback({})
    }
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture' || permission === 'notifications') {
      callback(true)
    } else {
      callback(false)
    }
  })
}

function registerMediaProtocol(): void {
  protocol.handle('aimy-media', (request) => {
    const url = new URL(request.url)
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const item = store.getRecording(id)
    if (!item?.audioPath || !existsSync(item.audioPath)) {
      return new Response('Audio file not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(item.audioPath).toString(), {
      headers: request.headers
    })
  })
}

function registerIpcHandlers(): void {
  // Auth
  ipcMain.handle('auth:get-session', () => authManager.getSession())
  ipcMain.handle('auth:sign-in', () =>
    authManager.signIn(store.getSettings().consoleBaseUrl, mainWindow)
  )
  ipcMain.handle('auth:sign-out', () => authManager.signOut())
  ipcMain.handle('auth:set-manual-token', (_e, token: string) => authManager.setManualToken(token))

  // AiMY Metadata
  ipcMain.handle('aimy:list-groups', () => apiClient.listGroups())
  ipcMain.handle('aimy:list-agents', (_e, groupId: number) => apiClient.listAgents(groupId))
  ipcMain.handle('aimy:list-document-types', () => apiClient.listDocumentTypes())

  // Settings
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => {
    const updated = store.updateSettings(patch)
    meetingDetector.setEnabled(updated.detectMeetings)
    return updated
  })

  // Recordings
  ipcMain.handle('recordings:list', () => store.listRecordings())
  ipcMain.handle('recordings:create', (_e, input: CreateRecordingInput) =>
    store.createRecordingEntry(input)
  )
  ipcMain.handle(
    'recordings:save-audio',
    async (_e, id: string, audioBytes: Uint8Array, inputExt: string, durationSeconds: number, notes?: string) => {
      const saved = await store.saveCapturedAudio(id, audioBytes, inputExt, durationSeconds, notes)
      const settings = store.getSettings()
      if (settings.autoSyncAfterRecording && authManager.getSession().authenticated && (saved.groupId || settings.defaultGroupId)) {
        void syncManager.syncRecording(saved.id)
      }
      return saved
    }
  )
  ipcMain.handle('recordings:import-audio', async () => {
    const res = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: 'Import Meeting Recording',
      properties: ['openFile'],
      filters: [
        { name: 'Audio / Video Recordings', extensions: ['mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm', 'ogg'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return store.importLocalFile(res.filePaths[0])
  })
  ipcMain.handle('recordings:update', (_e, id: string, patch: UpdateRecordingPatch) =>
    store.updateRecordingMetadata(id, patch)
  )
  ipcMain.handle('recordings:delete', (_e, id: string) => {
    store.deleteRecording(id)
    return { ok: true }
  })
  ipcMain.handle('recordings:audio-url', (_e, id: string) => {
    const item = store.getRecording(id)
    if (!item?.audioPath || !existsSync(item.audioPath)) return null
    return `aimy-media://recording/${encodeURIComponent(id)}?v=${encodeURIComponent(item.updatedAt)}`
  })
  ipcMain.handle('recordings:enhance-audio', (_e, id: string) =>
    store.enhanceExistingRecording(id)
  )
  ipcMain.handle('recordings:reveal', (_e, id: string) => {
    const item = store.getRecording(id)
    if (item?.audioPath && existsSync(item.audioPath)) {
      shell.showItemInFolder(item.audioPath)
    }
  })

  // Sync
  ipcMain.handle('sync:one', (_e, id: string) => syncManager.syncRecording(id))
  ipcMain.handle('sync:all-pending', () => syncManager.syncAllPending())
  ipcMain.handle('sync:index', (_e, id: string) => syncManager.indexRecording(id))
  ipcMain.handle('sync:refresh-one', (_e, id: string) => syncManager.refreshRecordingStatus(id))
  ipcMain.handle('sync:refresh-all', () => syncManager.refreshAllStatuses())
  ipcMain.handle('sync:transcribe-clip', async (_e, id: string) => {
    const item = store.getRecording(id)
    if (!item?.audioPath || !existsSync(item.audioPath)) {
      throw new Error('Local audio file not found.')
    }
    return apiClient.transcribeVoiceClip(item.audioPath)
  })

  // Meeting prompt & controls
  ipcMain.handle('meeting:get-active', () => promptManager.getActiveMeeting())
  ipcMain.handle('meeting:get-live', () => currentLiveMeeting)
  ipcMain.handle('meeting:accept', (_e, meeting: DetectedMeeting) => {
    promptManager.hide()
    meetingDetector.dismiss(meeting.id)
    showMainWindow()
    broadcastToMain('recording:start-requested', {
      title: meeting.title || `${meeting.app} Meeting`,
      meetingApp: meeting.app,
      meetingWindowTitle: meeting.title,
      meetingId: meeting.id
    } satisfies StartRecordingRequest)
  })
  ipcMain.handle('meeting:dismiss', (_e, meetingId: string) => {
    meetingDetector.dismiss(meetingId)
    promptManager.hide()
  })
  ipcMain.handle('meeting:hide-prompt', () => {
    promptManager.hide()
  })
  ipcMain.handle('meeting:simulate', () => meetingDetector.simulateMeeting())
  ipcMain.handle(
    'recording:set-state',
    (_e, recording: boolean, title?: string, meetingApp?: string | null) => {
      isRecordingActive = recording
      activeRecordingTitle = title ?? ''
      meetingDetector.setRecordingActive(recording, meetingApp, title)
      updateTray()
    }
  )
  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('system:check-ffmpeg', () => store.checkFfmpegAvailable())
  ipcMain.handle('system:check-deepfilter', () => checkDeepFilterAvailable())
}

if (gotLock) {
  app.whenReady().then(() => {
    app.setAppUserModelId('com.flairstech.aimy.meetings')

    authManager = new AuthManager()
    store = new RecorderStore()
    apiClient = new AimyApiClient(
      () => store.getSettings().apiBaseUrl,
      () => authManager.getValidToken()
    )
    syncManager = new SyncManager(store, apiClient)
    promptManager = new PromptWindowManager(preloadPath, rendererUrl, rendererHtml)
    meetingDetector = new MeetingDetector({
      onDetected: (meeting) => {
        currentLiveMeeting = meeting
        broadcastToMain('meeting:live-changed', meeting)
        const settings = store.getSettings()
        if (settings.autoRecordOnMeeting) {
          meetingDetector.dismiss(meeting.id)
          showMainWindow()
          broadcastToMain('recording:start-requested', {
            title: meeting.title || `${meeting.app} Meeting`,
            meetingApp: meeting.app,
            meetingWindowTitle: meeting.title,
            meetingId: meeting.id
          } satisfies StartRecordingRequest)
        } else {
          promptManager.show(meeting)
        }
      },
      onEnded: ({ wasRecording }) => {
        currentLiveMeeting = null
        broadcastToMain('meeting:live-changed', null)
        // Close any open meeting prompt if the user left the call without starting
        if (!wasRecording) {
          promptManager.hide()
          return
        }
        const settings = store.getSettings()
        if (isRecordingActive && settings.autoStopOnMeetingEnd) {
          broadcastToMain('recording:stop-requested', 'meeting-ended')
        }
      }
    })

    meetingDetector.setEnabled(store.getSettings().detectMeetings)

    authManager.onChange((s) => broadcastToMain('auth:changed', s))
    store.onRecordingsChange((items) => {
      broadcastToMain('recordings:updated', items)
      updateTray()
    })
    store.onSettingsChange((settings) => broadcastToMain('settings:updated', settings))

    registerMediaProtocol()
    setupMediaPermissions()
    registerIpcHandlers()
    createMainWindow()

    if (process.platform === 'darwin') {
      app.dock?.setIcon(getAppIconPng())
    }

    tray = new Tray(getTrayIcon(false))
    tray.on('click', () => showMainWindow())
    updateTray()

    meetingDetector.start()
    syncManager.start()
  })
}

app.on('before-quit', () => {
  isQuitting = true
  meetingDetector?.stop()
  syncManager?.stop()
  promptManager?.hide()
})

app.on('activate', () => {
  showMainWindow()
})
