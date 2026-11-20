import { contextBridge, ipcRenderer } from 'electron'
import type {
  AimyDesktopAPI,
  AppSettings,
  AuthSession,
  ConnectivityStatus,
  CreateRecordingInput,
  DetectedMeeting,
  RecordingItem,
  SignInMethod,
  StartRecordingRequest,
  UpdateRecordingPatch
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AimyDesktopAPI = {
  // Auth
  getAuthSession: () => ipcRenderer.invoke('auth:get-session'),
  signIn: (method?: SignInMethod) => ipcRenderer.invoke('auth:sign-in', method),
  cancelSignIn: () => ipcRenderer.invoke('auth:cancel-sign-in'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  setManualToken: (token: string) => ipcRenderer.invoke('auth:set-manual-token', token),
  getAuthCallbackUrl: () => ipcRenderer.invoke('auth:callback-url'),

  // Connectivity
  getConnectivityStatus: () => ipcRenderer.invoke('connectivity:get'),
  reportBrowserOnlineStatus: (online: boolean) =>
    ipcRenderer.invoke('connectivity:report-browser-status', online),

  // AiMY Workspace metadata
  listGroups: () => ipcRenderer.invoke('aimy:list-groups'),
  listAgents: (groupId: number) => ipcRenderer.invoke('aimy:list-agents', groupId),
  listDocumentTypes: () => ipcRenderer.invoke('aimy:list-document-types'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),

  // Recordings
  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  createRecordingEntry: (input: CreateRecordingInput) =>
    ipcRenderer.invoke('recordings:create', input),
  saveRecordingAudio: (
    id: string,
    audioBytes: Uint8Array,
    inputExt: string,
    durationSeconds: number,
    notes?: string
  ) => ipcRenderer.invoke('recordings:save-audio', id, audioBytes, inputExt, durationSeconds, notes),
  importAudioFile: () => ipcRenderer.invoke('recordings:import-audio'),
  updateRecording: (id: string, patch: UpdateRecordingPatch) =>
    ipcRenderer.invoke('recordings:update', id, patch),
  deleteRecording: (id: string) => ipcRenderer.invoke('recordings:delete', id),
  getRecordingAudioUrl: (id: string) => ipcRenderer.invoke('recordings:audio-url', id),
  enhanceRecordingAudio: (id: string) => ipcRenderer.invoke('recordings:enhance-audio', id),
  revealRecordingInFolder: (id: string) => ipcRenderer.invoke('recordings:reveal', id),

  // Sync
  syncRecording: (id: string) => ipcRenderer.invoke('sync:one', id),
  syncAllPending: () => ipcRenderer.invoke('sync:all-pending'),
  indexRecording: (id: string) => ipcRenderer.invoke('sync:index', id),
  refreshRecordingStatus: (id: string) => ipcRenderer.invoke('sync:refresh-one', id),
  refreshAllStatuses: () => ipcRenderer.invoke('sync:refresh-all'),
  transcribeQuickClip: (id: string) => ipcRenderer.invoke('sync:transcribe-clip', id),

  // Meeting prompt & controls
  getActiveMeetingPrompt: () => ipcRenderer.invoke('meeting:get-active'),
  getLiveMeeting: () => ipcRenderer.invoke('meeting:get-live'),
  acceptMeetingPrompt: (meeting: DetectedMeeting) => ipcRenderer.invoke('meeting:accept', meeting),
  dismissMeetingPrompt: (meetingId: string) => ipcRenderer.invoke('meeting:dismiss', meetingId),
  hideMeetingPrompt: () => ipcRenderer.invoke('meeting:hide-prompt'),
  simulateMeetingDetection: () => ipcRenderer.invoke('meeting:simulate'),
  notifyRecordingState: (isRecording: boolean, title?: string, meetingApp?: string | null) =>
    ipcRenderer.invoke('recording:set-state', isRecording, title, meetingApp),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  checkFfmpegAvailable: () => ipcRenderer.invoke('system:check-ffmpeg'),
  checkDeepFilterAvailable: () => ipcRenderer.invoke('system:check-deepfilter'),

  // Subscriptions
  onAuthChanged: (cb: (session: AuthSession) => void) => subscribe('auth:changed', cb),
  onConnectivityChanged: (cb: (status: ConnectivityStatus) => void) =>
    subscribe('connectivity:changed', cb),
  onRecordingsUpdated: (cb: (recordings: RecordingItem[]) => void) =>
    subscribe('recordings:updated', cb),
  onSettingsUpdated: (cb: (settings: AppSettings) => void) => subscribe('settings:updated', cb),
  onMeetingDetected: (cb: (meeting: DetectedMeeting) => void) => subscribe('meeting:detected', cb),
  onLiveMeetingChanged: (cb: (meeting: DetectedMeeting | null) => void) =>
    subscribe('meeting:live-changed', cb),
  onStartRecordingRequested: (cb: (req: StartRecordingRequest) => void) =>
    subscribe('recording:start-requested', cb),
  onStopRecordingRequested: (cb: (reason?: 'manual' | 'meeting-ended') => void) =>
    subscribe('recording:stop-requested', cb)
}

contextBridge.exposeInMainWorld('aimyDesktop', api)
