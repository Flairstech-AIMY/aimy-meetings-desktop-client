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
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import type {
  AppSettings,
  CreateRecordingInput,
  DetectedMeeting,
  SignInMethod,
  StartRecordingRequest,
  UpdateRecordingPatch
} from '@shared/types'
import { AimyApiClient } from './aimyApi'
import { getAppIconPng, getTrayIcon, getWindowIcon } from './appIcons'
import { checkDeepFilterAvailable } from './audioEnhancer'
import { AUTH_CALLBACK_URL, AUTH_PROTOCOL, AuthManager } from './auth'
import { ConnectivityMonitor } from './connectivity'
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
let connectivityMonitor: ConnectivityMonitor
let store: RecorderStore
let apiClient: AimyApiClient
let syncManager: SyncManager
let promptManager: PromptWindowManager
let meetingDetector: MeetingDetector
let startupInitPromise: Promise<void> | null = null
let pendingDeepLinkUrl: string | null = null

function extractDeepLinkFromArgv(argv: string[]): string | null {
  const prefix = `${AUTH_PROTOCOL}://`
  return argv.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(prefix)) ?? null
}

function registerAuthProtocolClient(): void {
  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [resolve(process.argv[1])])
      }
    } else {
      app.setAsDefaultProtocolClient(AUTH_PROTOCOL)
    }
  } catch (err) {
    console.warn('[Auth] Failed to register custom protocol handler:', err)
  }
}

async function handleDeepLinkUrl(rawUrl: string): Promise<void> {
  if (!authManager) {
    pendingDeepLinkUrl = rawUrl
    return
  }
  const handled = await authManager.handleProtocolCallback(rawUrl)
  if (handled) {
    showMainWindow()
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.exit(0)
} else {
  registerAuthProtocolClient()

  app.on('second-instance', (_event, argv) => {
    const deepLink = extractDeepLinkFromArgv(argv)
    if (deepLink) {
      void handleDeepLinkUrl(deepLink)
    }
    showMainWindow()
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    void handleDeepLinkUrl(url)
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
  ipcMain.handle('auth:get-session', async () => {
    if (startupInitPromise) await startupInitPromise
    return authManager.getSession()
  })
  ipcMain.handle('auth:sign-in', (_e, method?: SignInMethod) =>
    authManager.signIn(store.getSettings().consoleBaseUrl, mainWindow, method ?? 'browser')
  )
  ipcMain.handle('auth:cancel-sign-in', () => {
    authManager.cancelSignIn()
  })
  ipcMain.handle('auth:sign-out', () => authManager.signOut())
  ipcMain.handle('auth:set-manual-token', (_e, token: string) => authManager.setManualToken(token))
  ipcMain.handle('auth:callback-url', () => AUTH_CALLBACK_URL)

  // Connectivity
  ipcMain.handle('connectivity:get', async () => {
    if (startupInitPromise) await startupInitPromise
    return connectivityMonitor.getStatus()
  })
  ipcMain.handle('connectivity:report-browser-status', (_e, online: boolean) =>
    connectivityMonitor.checkNow(online)
  )

  // AiMY Metadata
  ipcMain.handle('aimy:list-groups', () => apiClient.listGroups())
  ipcMain.handle('aimy:list-agents', (_e, groupId: number) => apiClient.listAgents(groupId))
  ipcMain.handle('aimy:list-document-types', () => apiClient.listDocumentTypes())

  // Settings
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => {
    const prev = store.getSettings()
    const updated = store.updateSettings(patch)
    meetingDetector.setEnabled(updated.detectMeetings)
    if (
      updated.defaultGroupId &&
      updated.defaultGroupId !== prev.defaultGroupId &&
      updated.autoSyncAfterRecording &&
      connectivityMonitor.isOnline() &&
      authManager.getSession().authenticated
    ) {
      void syncManager.syncAllPending({ auto: true })
    }
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
      if (
        settings.autoSyncAfterRecording &&
        connectivityMonitor.isOnline() &&
        authManager.getSession().authenticated &&
        (saved.groupId || settings.defaultGroupId)
      ) {
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

    store = new RecorderStore()
    connectivityMonitor = new ConnectivityMonitor(() => store.getSettings().consoleBaseUrl)
    authManager = new AuthManager(() => connectivityMonitor.isOnline())
    apiClient = new AimyApiClient(
      () => store.getSettings().apiBaseUrl,
      () => authManager.getValidToken(),
      {
        onUnauthorized: () => authManager.handleUnauthorized(),
        onNetworkError: () => connectivityMonitor.reportNetworkError()
      }
    )
    syncManager = new SyncManager(
      store,
      apiClient,
      () => connectivityMonitor.isOnline(),
      () => authManager.getSession().authenticated
    )
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

    authManager.onChange((s) => {
      broadcastToMain('auth:changed', s)
      if (
        s.authenticated &&
        connectivityMonitor.isOnline() &&
        store.getSettings().autoSyncAfterRecording
      ) {
        void syncManager.syncAllPending({ auto: true })
        void syncManager.refreshAllStatuses()
      }
    })

    connectivityMonitor.onChange((status) => {
      broadcastToMain('connectivity:changed', status)
      if (status.online) {
        void authManager.onConnectivityRestored().then(() => {
          if (
            authManager.getSession().authenticated &&
            store.getSettings().autoSyncAfterRecording
          ) {
            void syncManager.syncAllPending({ auto: true })
            void syncManager.refreshAllStatuses()
          }
        })
      }
    })

    connectivityMonitor.onWake(() => {
      if (connectivityMonitor.isOnline()) {
        void authManager.onConnectivityRestored()
      }
    })

    store.onRecordingsChange((items) => {
      broadcastToMain('recordings:updated', items)
      updateTray()
    })
    store.onSettingsChange((settings) => broadcastToMain('settings:updated', settings))

    // Run initial reachability probe + silent token refresh concurrently while window loads
    startupInitPromise = connectivityMonitor
      .checkNow()
      .then(() => authManager.initialize())
      .then(() => {
        if (
          connectivityMonitor.isOnline() &&
          authManager.getSession().authenticated &&
          store.getSettings().autoSyncAfterRecording
        ) {
          void syncManager.syncAllPending({ auto: true })
        }
      })
      .catch((err) => {
        console.warn('[Init] Startup connectivity/auth initialization failed:', err)
      })

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

    connectivityMonitor.start()
    meetingDetector.start()
    syncManager.start()

    const startupDeepLink = pendingDeepLinkUrl ?? extractDeepLinkFromArgv(process.argv)
    if (startupDeepLink) {
      pendingDeepLinkUrl = null
      void handleDeepLinkUrl(startupDeepLink)
    }
  })
}

app.on('before-quit', () => {
  isQuitting = true
  connectivityMonitor?.stop()
  authManager?.dispose()
  meetingDetector?.stop()
  syncManager?.stop()
  promptManager?.hide()
})

app.on('activate', () => {
  showMainWindow()
})
