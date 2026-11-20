export interface AuthUser {
  id?: string
  name?: string
  email?: string
}

export type AuthStateReason = 'initial' | 'signed-in' | 'signed-out' | 'expired'

export type SignInMethod = 'browser' | 'embedded'

export interface ConnectivityStatus {
  online: boolean
  checkedAt: number
}

export interface AuthSession {
  authenticated: boolean
  user?: AuthUser
  expiresAt?: number | null
  hasRefreshToken?: boolean
  reason?: AuthStateReason
}

export interface AimyGroup {
  group_id: number
  group_name: string
  client_id: number | null
  client_name: string | null
  can_create_shared?: boolean
}

export interface AimyAgent {
  agent_id: number
  agent_name: string
  agent_type?: string | null
}

export interface AimyDocumentType {
  key: string
  label: string
  blurb?: string | null
  citation_label?: string
  ingestion_methods: string[]
  file_rules: Record<string, unknown>
}

export type RecordingSyncStatus =
  | 'RECORDING'
  | 'ENCODING'
  | 'LOCAL_PENDING'
  | 'UPLOADING'
  | 'TRANSCRIBING'
  | 'READY_FOR_REVIEW'
  | 'INDEXING'
  | 'SYNCED'
  | 'FAILED'

export type UploadMode = 'audio-recording' | 'transcript-json'

export interface RecordingItem {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  durationSeconds: number
  meetingApp?: string | null
  meetingWindowTitle?: string | null
  audioPath?: string | null
  audioFileName?: string | null
  audioMimeType?: string | null
  fileSizeBytes?: number | null
  notes: string
  syncStatus: RecordingSyncStatus
  uploadProgress?: number
  uploadMode: UploadMode
  groupId: number | null
  groupName?: string | null
  agentIds: number[]
  isPersonal: boolean
  lifecycle: 'published' | 'draft'
  aimyDocId?: number | null
  aimyDocumentUrl?: string | null
  aimyProcessingStatus?: string | null
  aimySummary?: string | null
  aimyTranscript?: string | null
  audioEnhanced?: boolean
  enhancementEngine?: string | null
  lastSyncedAt?: string | null
  error?: string | null
}

export interface DetectedMeeting {
  id: string
  app: string
  title: string
  detectedAt: string
  micActive: boolean
}

export interface AppSettings {
  apiBaseUrl: string
  consoleBaseUrl: string
  defaultGroupId: number | null
  defaultAgentIds: number[]
  defaultIsPersonal: boolean
  defaultLifecycle: 'published' | 'draft'
  defaultUploadMode: UploadMode
  autoSyncAfterRecording: boolean
  autoIndexAfterTranscription: boolean
  detectMeetings: boolean
  autoRecordOnMeeting: boolean
  autoStopOnMeetingEnd: boolean
  enhanceAudio: boolean
  captureSystemAudio: boolean
  captureMicrophone: boolean
  preferredMicDeviceId: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiBaseUrl: 'https://staging-api-documents-knowledge.aimy.flairstech.com',
  consoleBaseUrl: 'https://staging-knowledge.aimy.flairstech.com',
  defaultGroupId: null,
  defaultAgentIds: [],
  defaultIsPersonal: true,
  defaultLifecycle: 'draft',
  defaultUploadMode: 'audio-recording',
  autoSyncAfterRecording: true,
  autoIndexAfterTranscription: false,
  detectMeetings: true,
  autoRecordOnMeeting: false,
  autoStopOnMeetingEnd: true,
  enhanceAudio: true,
  captureSystemAudio: true,
  captureMicrophone: true,
  preferredMicDeviceId: null
}

export interface CreateRecordingInput {
  title: string
  meetingApp?: string | null
  meetingWindowTitle?: string | null
  notes?: string
  groupId?: number | null
  groupName?: string | null
  agentIds?: number[]
  isPersonal?: boolean
  lifecycle?: 'published' | 'draft'
  uploadMode?: UploadMode
}

export interface UpdateRecordingPatch {
  title?: string
  notes?: string
  groupId?: number | null
  groupName?: string | null
  agentIds?: number[]
  isPersonal?: boolean
  lifecycle?: 'published' | 'draft'
  uploadMode?: UploadMode
}

export interface StartRecordingRequest {
  title?: string
  meetingApp?: string | null
  meetingWindowTitle?: string | null
  meetingId?: string | null
}

export interface AimyDesktopAPI {
  // Auth
  getAuthSession: () => Promise<AuthSession>
  signIn: (method?: SignInMethod) => Promise<AuthSession>
  cancelSignIn: () => Promise<void>
  signOut: () => Promise<AuthSession>
  setManualToken: (token: string) => Promise<AuthSession>
  getAuthCallbackUrl: () => Promise<string>

  // Connectivity
  getConnectivityStatus: () => Promise<ConnectivityStatus>
  reportBrowserOnlineStatus: (online: boolean) => Promise<ConnectivityStatus>

  // AiMY Workspace metadata
  listGroups: () => Promise<AimyGroup[]>
  listAgents: (groupId: number) => Promise<AimyAgent[]>
  listDocumentTypes: () => Promise<AimyDocumentType[]>

  // Settings
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>

  // Recordings
  listRecordings: () => Promise<RecordingItem[]>
  createRecordingEntry: (input: CreateRecordingInput) => Promise<RecordingItem>
  saveRecordingAudio: (
    id: string,
    audioBytes: Uint8Array,
    inputExt: string,
    durationSeconds: number,
    notes?: string
  ) => Promise<RecordingItem>
  importAudioFile: () => Promise<RecordingItem | null>
  updateRecording: (id: string, patch: UpdateRecordingPatch) => Promise<RecordingItem>
  deleteRecording: (id: string) => Promise<{ ok: boolean }>
  getRecordingAudioUrl: (id: string) => Promise<string | null>
  enhanceRecordingAudio: (id: string) => Promise<RecordingItem>
  revealRecordingInFolder: (id: string) => Promise<void>

  // Sync
  syncRecording: (id: string) => Promise<RecordingItem>
  syncAllPending: () => Promise<{ started: number }>
  indexRecording: (id: string) => Promise<RecordingItem>
  refreshRecordingStatus: (id: string) => Promise<RecordingItem>
  refreshAllStatuses: () => Promise<RecordingItem[]>
  transcribeQuickClip: (id: string) => Promise<string>

  // Meeting prompt & desktop controls
  getActiveMeetingPrompt: () => Promise<DetectedMeeting | null>
  getLiveMeeting: () => Promise<DetectedMeeting | null>
  acceptMeetingPrompt: (meeting: DetectedMeeting) => Promise<void>
  dismissMeetingPrompt: (meetingId: string) => Promise<void>
  hideMeetingPrompt: () => Promise<void>
  simulateMeetingDetection: () => Promise<DetectedMeeting>
  notifyRecordingState: (
    isRecording: boolean,
    title?: string,
    meetingApp?: string | null
  ) => Promise<void>
  openExternal: (url: string) => Promise<void>
  checkFfmpegAvailable: () => Promise<boolean>
  checkDeepFilterAvailable: () => Promise<boolean>

  // Subscriptions
  onAuthChanged: (cb: (session: AuthSession) => void) => () => void
  onConnectivityChanged: (cb: (status: ConnectivityStatus) => void) => () => void
  onRecordingsUpdated: (cb: (recordings: RecordingItem[]) => void) => () => void
  onSettingsUpdated: (cb: (settings: AppSettings) => void) => () => void
  onMeetingDetected: (cb: (meeting: DetectedMeeting) => void) => () => void
  onLiveMeetingChanged: (cb: (meeting: DetectedMeeting | null) => void) => () => void
  onStartRecordingRequested: (cb: (req: StartRecordingRequest) => void) => () => void
  onStopRecordingRequested: (cb: (reason?: 'manual' | 'meeting-ended') => void) => () => void
}

declare global {
  interface Window {
    aimyDesktop: AimyDesktopAPI
  }
}
