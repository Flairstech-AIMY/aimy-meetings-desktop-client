import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
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

function subscribe<T>(eventName: string, cb: (payload: T) => void): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null

  void listen<T>(eventName, (event) => {
    if (!disposed) {
      cb(event.payload)
    }
  }).then((fn) => {
    if (disposed) {
      fn()
    } else {
      unlisten = fn
    }
  })

  return () => {
    disposed = true
    if (unlisten) {
      unlisten()
      unlisten = null
    }
  }
}

export function createTauriAimyDesktopAPI(): AimyDesktopAPI {
  return {
    // Auth
    getAuthSession: () => invoke<AuthSession>('auth_get_session'),
    signIn: (method?: SignInMethod) => invoke<AuthSession>('auth_sign_in', { method: method ?? 'browser' }),
    cancelSignIn: () => invoke<void>('auth_cancel_sign_in'),
    signOut: () => invoke<AuthSession>('auth_sign_out'),
    setManualToken: (token: string) => invoke<AuthSession>('auth_set_manual_token', { token }),
    getAuthCallbackUrl: () => invoke<string>('auth_callback_url'),

    // Connectivity
    getConnectivityStatus: () => invoke<ConnectivityStatus>('connectivity_get'),
    reportBrowserOnlineStatus: (online: boolean) =>
      invoke<ConnectivityStatus>('connectivity_report_browser_status', { online }),

    // AiMY Workspace metadata
    listGroups: () => invoke('aimy_list_groups'),
    listAgents: (groupId: number) => invoke('aimy_list_agents', { groupId }),
    listDocumentTypes: () => invoke('aimy_list_document_types'),

    // Settings
    getSettings: () => invoke<AppSettings>('settings_get'),
    updateSettings: (patch: Partial<AppSettings>) => invoke<AppSettings>('settings_update', { patch }),

    // Recordings
    listRecordings: () => invoke<RecordingItem[]>('recordings_list'),
    createRecordingEntry: (input: CreateRecordingInput) =>
      invoke<RecordingItem>('recordings_create', { input }),
    saveRecordingAudio: (
      id: string,
      audioBytes: Uint8Array,
      inputExt: string,
      durationSeconds: number,
      notes?: string
    ) =>
      invoke<RecordingItem>('recordings_save_audio', {
        id,
        audioBytes: Array.from(audioBytes),
        inputExt,
        durationSeconds,
        notes
      }),
    importAudioFile: () => invoke<RecordingItem | null>('recordings_import_audio'),
    updateRecording: (id: string, patch: UpdateRecordingPatch) =>
      invoke<RecordingItem>('recordings_update', { id, patch }),
    deleteRecording: (id: string) => invoke<{ ok: boolean }>('recordings_delete', { id }),
    getRecordingAudioUrl: async (id: string) => {
      const path = await invoke<string | null>('recordings_audio_path', { id })
      if (!path) return null
      return convertFileSrc(path)
    },
    enhanceRecordingAudio: (id: string) => invoke<RecordingItem>('recordings_enhance_audio', { id }),
    revealRecordingInFolder: (id: string) => invoke<void>('recordings_reveal', { id }),

    // Sync
    syncRecording: (id: string) => invoke<RecordingItem>('sync_one', { id }),
    syncAllPending: () => invoke<{ started: number }>('sync_all_pending'),
    indexRecording: (id: string) => invoke<RecordingItem>('sync_index', { id }),
    refreshRecordingStatus: (id: string) => invoke<RecordingItem>('sync_refresh_one', { id }),
    refreshAllStatuses: () => invoke<RecordingItem[]>('sync_refresh_all'),
    transcribeQuickClip: (id: string) => invoke<string>('sync_transcribe_clip', { id }),

    // Meeting prompt & controls
    getActiveMeetingPrompt: () => invoke<DetectedMeeting | null>('meeting_get_active'),
    getLiveMeeting: () => invoke<DetectedMeeting | null>('meeting_get_live'),
    acceptMeetingPrompt: (meeting: DetectedMeeting) => invoke<void>('meeting_accept', { meeting }),
    dismissMeetingPrompt: (meetingId: string) => invoke<void>('meeting_dismiss', { meetingId }),
    hideMeetingPrompt: () => invoke<void>('meeting_hide_prompt'),
    simulateMeetingDetection: () => invoke<DetectedMeeting>('meeting_simulate'),
    notifyRecordingState: (isRecording: boolean, title?: string, meetingApp?: string | null) =>
      invoke<void>('recording_set_state', {
        recording: isRecording,
        title: title ?? null,
        meetingApp: meetingApp ?? null
      }),
    openExternal: (url: string) => invoke<void>('shell_open_external', { url }),
    checkFfmpegAvailable: () => invoke<boolean>('system_check_ffmpeg'),
    checkDeepFilterAvailable: () => invoke<boolean>('system_check_deepfilter'),

    // Native WASAPI audio capture
    startNativeAudioCapture: (options) => invoke('capture_start', { options }),
    pauseNativeAudioCapture: () => invoke('capture_pause'),
    resumeNativeAudioCapture: () => invoke('capture_resume'),
    abortNativeAudioCapture: () => invoke('capture_abort'),
    stopNativeAudioCapture: () => invoke('capture_stop'),
    saveNativeCapturedAudio: (id, tempWavPath, durationSeconds, notes) =>
      invoke<RecordingItem>('recordings_save_native_capture', {
        id,
        tempWavPath,
        durationSeconds,
        notes
      }),
    onRecordingAudioLevel: (cb: (level: number) => void) => subscribe<number>('recording:audio-level', cb),

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
}

export function ensureAimyDesktopBridge(): void {
  if (typeof window !== 'undefined' && !window.aimyDesktop) {
    window.aimyDesktop = createTauriAimyDesktopAPI()
  }
}
