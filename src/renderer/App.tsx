import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AimyMark,
  AmbientBackground,
  Button,
  EmptyState,
  IconButton,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Orb,
  SearchField,
  StatusPill,
  Tag,
  ThemeToggle,
  Toaster,
  UserMenu,
  toast
} from '@flairstech-aimy/ui'
import {
  ExternalLink,
  FolderUp,
  LogIn,
  LogOut,
  Mic,
  Radio,
  RefreshCw,
  Settings,
  UploadCloud
} from 'lucide-react'
import {
  DEFAULT_SETTINGS,
  type AimyGroup,
  type AppSettings,
  type AuthSession,
  type DetectedMeeting,
  type RecordingItem,
  type SignInMethod,
  type StartRecordingRequest,
  type UpdateRecordingPatch
} from '@shared/types'
import { startAudioCapture, type ActiveCaptureSession } from './lib/audioCapture'
import {
  formatDuration,
  isInProgressStatus,
  isLeftToSyncStatus,
  isSyncedStatus
} from './lib/format'
import { LiveRecorderBar } from './components/LiveRecorderBar'
import { RecordingCard } from './components/RecordingCard'
import { RecordingDetail } from './components/RecordingDetail'
import { SettingsDialog } from './components/SettingsDialog'
import { SignInPromptDialog } from './components/SignInPromptDialog'

type SidebarFilter = 'all' | 'pending' | 'synced'

interface LiveState {
  recordingId: string
  title: string
  meetingApp: string
  notes: string
  elapsedSeconds: number
  audioLevel: number
  isPaused: boolean
  hasSystemAudio: boolean
  hasMicAudio: boolean
}

export function App() {
  const [auth, setAuth] = useState<AuthSession>({ authenticated: false })
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [authCallbackUrl, setAuthCallbackUrl] = useState('aimy-meetings://auth/callback')
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [groups, setGroups] = useState<AimyGroup[]>([])
  const [recordings, setRecordings] = useState<RecordingItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<SidebarFilter>('all')
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [signInModalOpen, setSignInModalOpen] = useState(false)
  const [localOnlyDismissed, setLocalOnlyDismissed] = useState(false)
  const [signingInMethod, setSigningInMethod] = useState<SignInMethod | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const [ffmpegAvailable, setFfmpegAvailable] = useState(true)
  const [deepFilterAvailable, setDeepFilterAvailable] = useState(false)
  const [liveMeeting, setLiveMeeting] = useState<DetectedMeeting | null>(null)
  const [ignoredInAppMeetingId, setIgnoredInAppMeetingId] = useState<string | null>(null)

  const [live, setLive] = useState<LiveState | null>(null)
  const [stoppingRecording, setStoppingRecording] = useState(false)
  const captureRef = useRef<ActiveCaptureSession | null>(null)
  const liveRef = useRef<LiveState | null>(null)
  liveRef.current = live
  const settingsRef = useRef<AppSettings>(settings)
  settingsRef.current = settings
  const groupsRef = useRef<AimyGroup[]>(groups)
  groupsRef.current = groups
  const authRef = useRef<AuthSession>(auth)
  authRef.current = auth
  const onlineRef = useRef<boolean>(online)
  onlineRef.current = online
  const signInAttemptRef = useRef(0)

  // Initial load + IPC subscriptions
  useEffect(() => {
    void Promise.all([
      window.aimyDesktop.getAuthSession(),
      window.aimyDesktop.getConnectivityStatus(),
      window.aimyDesktop.getAuthCallbackUrl(),
      window.aimyDesktop.getSettings(),
      window.aimyDesktop.listRecordings(),
      window.aimyDesktop.checkFfmpegAvailable(),
      window.aimyDesktop.checkDeepFilterAvailable(),
      window.aimyDesktop.getLiveMeeting()
    ]).then(
      ([
        session,
        connectivity,
        callbackUrl,
        loadedSettings,
        loadedRecs,
        hasFfmpeg,
        hasDf,
        activeMeeting
      ]) => {
        setAuth(session)
        setOnline(connectivity.online)
        setAuthCallbackUrl(callbackUrl)
        setSettings(loadedSettings)
        setRecordings(loadedRecs)
        setFfmpegAvailable(hasFfmpeg)
        setDeepFilterAvailable(hasDf)
        setLiveMeeting(activeMeeting)
        if (loadedRecs.length > 0) {
          setSelectedId((prev) => prev ?? loadedRecs[0].id)
        }
        setInitialLoaded(true)
      }
    )

    const unsubAuth = window.aimyDesktop.onAuthChanged((next) => {
      setAuth(next)
      if (next.authenticated) {
        setSignInModalOpen(false)
        setLocalOnlyDismissed(false)
        setSigningInMethod(null)
        setSignInError(null)
      } else if (next.reason === 'expired' || next.reason === 'signed-out') {
        setLocalOnlyDismissed(false)
        setSignInError(null)
      }
    })
    const unsubConnectivity = window.aimyDesktop.onConnectivityChanged((status) => {
      setOnline(status.online)
    })
    const unsubRecs = window.aimyDesktop.onRecordingsUpdated((next) => {
      setRecordings(next)
      setSelectedId((prev) => {
        if (prev && next.some((r) => r.id === prev)) return prev
        return next[0]?.id ?? null
      })
    })
    const unsubSettings = window.aimyDesktop.onSettingsUpdated((next) => setSettings(next))
    const unsubLiveMeeting = window.aimyDesktop.onLiveMeetingChanged((meeting) => {
      setLiveMeeting(meeting)
      if (!meeting) {
        setIgnoredInAppMeetingId(null)
      }
    })

    const handleBrowserOnline = (): void => {
      void window.aimyDesktop.reportBrowserOnlineStatus(true).then((s) => setOnline(s.online))
    }
    const handleBrowserOffline = (): void => {
      setOnline(false)
      void window.aimyDesktop.reportBrowserOnlineStatus(false).then((s) => setOnline(s.online))
    }
    window.addEventListener('online', handleBrowserOnline)
    window.addEventListener('offline', handleBrowserOffline)

    return () => {
      unsubAuth()
      unsubConnectivity()
      unsubRecs()
      unsubSettings()
      unsubLiveMeeting()
      window.removeEventListener('online', handleBrowserOnline)
      window.removeEventListener('offline', handleBrowserOffline)
    }
  }, [])

  // Auto-prompt sign-in on startup, logout, or token expiry when online (suppressed offline / local-only)
  useEffect(() => {
    if (!initialLoaded) return
    if (auth.authenticated) {
      setSignInModalOpen(false)
      return
    }
    if (online && !localOnlyDismissed) {
      setSignInModalOpen(true)
    } else if (!online && !signingInMethod) {
      setSignInModalOpen(false)
    }
  }, [initialLoaded, auth.authenticated, online, localOnlyDismissed, signingInMethod])

  // Load groups whenever authenticated and online
  useEffect(() => {
    if (!auth.authenticated) {
      setGroups([])
      return
    }
    if (!online) return
    let active = true
    void window.aimyDesktop
      .listGroups()
      .then((list) => {
        if (!active) return
        setGroups(list)
        if (list.length > 0 && settingsRef.current.defaultGroupId == null) {
          void window.aimyDesktop.updateSettings({ defaultGroupId: list[0].group_id })
        }
      })
      .catch((err) => {
        console.warn('[App] Failed to load groups:', err)
      })
    return () => {
      active = false
    }
  }, [auth.authenticated, online])

  // Elapsed timer while recording
  useEffect(() => {
    if (!live || live.isPaused) return
    const timer = window.setInterval(() => {
      setLive((prev) => (prev ? { ...prev, elapsedSeconds: prev.elapsedSeconds + 1 } : null))
    }, 1000)
    return () => clearInterval(timer)
  }, [Boolean(live), live?.isPaused])

  const beginRecording = useCallback(async (req?: StartRecordingRequest) => {
    if (captureRef.current || liveRef.current) {
      toast('A recording is already in progress', {
        sub: 'Stop your current recording before starting another.'
      })
      return
    }

    const currentSettings = settingsRef.current
    const title =
      req?.title?.trim() ||
      `Meeting — ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    const meetingApp = req?.meetingApp || 'Manual'
    const defaultGroup = groupsRef.current.find(
      (g) => g.group_id === currentSettings.defaultGroupId
    )

    try {
      const capture = await startAudioCapture({
        captureSystemAudio: currentSettings.captureSystemAudio,
        captureMicrophone: currentSettings.captureMicrophone,
        micDeviceId: currentSettings.preferredMicDeviceId,
        onLevel: (level) => {
          setLive((prev) => (prev ? { ...prev, audioLevel: level } : null))
        }
      })

      const created = await window.aimyDesktop.createRecordingEntry({
        title,
        meetingApp,
        meetingWindowTitle: req?.meetingWindowTitle ?? null,
        groupId: currentSettings.defaultGroupId,
        groupName: defaultGroup
          ? `${defaultGroup.client_name ? `${defaultGroup.client_name} · ` : ''}${defaultGroup.group_name}`
          : null,
        agentIds: currentSettings.defaultAgentIds,
        isPersonal: true,
        lifecycle: 'draft',
        uploadMode: currentSettings.defaultUploadMode
      })

      captureRef.current = capture
      setSelectedId(created.id)
      setLive({
        recordingId: created.id,
        title: created.title,
        meetingApp,
        notes: '',
        elapsedSeconds: 0,
        audioLevel: 0,
        isPaused: false,
        hasSystemAudio: capture.hasSystemAudio,
        hasMicAudio: capture.hasMicAudio
      })
      await window.aimyDesktop.notifyRecordingState(true, title, meetingApp)
      toast('Recording started', {
        sub:
          capture.hasSystemAudio && capture.hasMicAudio
            ? 'Capturing system audio and microphone.'
            : capture.hasSystemAudio
              ? 'Capturing system audio.'
              : 'Capturing microphone audio.'
      })
    } catch (err) {
      toast('Could not start recording', {
        tone: 'err',
        sub: err instanceof Error ? err.message : 'Check audio device permissions.'
      })
    }
  }, [])

  const stopRecording = useCallback(
    async (reason: 'manual' | 'meeting-ended' = 'manual') => {
      const activeCapture = captureRef.current
      const activeLive = liveRef.current
      if (!activeCapture || !activeLive || stoppingRecording) return

      setStoppingRecording(true)
      try {
        const result = await activeCapture.stop()
        captureRef.current = null
        setLive(null)
        await window.aimyDesktop.notifyRecordingState(false)

        await window.aimyDesktop.updateRecording(activeLive.recordingId, {
          title: activeLive.title.trim() || 'Meeting Recording',
          notes: activeLive.notes
        })
        const saved = await window.aimyDesktop.saveRecordingAudio(
          activeLive.recordingId,
          result.bytes,
          result.ext,
          result.durationSeconds,
          activeLive.notes
        )

        const subText = !onlineRef.current
          ? 'Saved locally — will sync automatically once you are back online.'
          : !authRef.current.authenticated
            ? 'Saved locally — sign in to sync with AiMY Knowledge.'
            : saved.syncStatus === 'UPLOADING' || settingsRef.current.autoSyncAfterRecording
              ? 'Saved locally and queued to sync with AiMY Knowledge.'
              : 'Saved locally — click Sync to AiMY when ready.'

        toast(reason === 'meeting-ended' ? 'Meeting ended — recording saved' : 'Recording saved', {
          sub: subText
        })
      } catch (err) {
        toast('Failed to save recording', {
          tone: 'err',
          sub: err instanceof Error ? err.message : 'Unexpected audio capture error.'
        })
      } finally {
        setStoppingRecording(false)
      }
    },
    [stoppingRecording]
  )

  // Subscribe to start/stop requests from Tray & Meeting Prompt window
  useEffect(() => {
    const unsubStart = window.aimyDesktop.onStartRecordingRequested((req) => {
      void beginRecording(req)
    })
    const unsubStop = window.aimyDesktop.onStopRecordingRequested((reason) => {
      void stopRecording(reason ?? 'manual')
    })
    return () => {
      unsubStart()
      unsubStop()
    }
  }, [beginRecording, stopRecording])

  const handleOpenSignInPrompt = (): void => {
    setSignInError(null)
    setSignInModalOpen(true)
  }

  const handleSignIn = async (method: SignInMethod = 'browser'): Promise<void> => {
    if (!onlineRef.current) {
      setSignInError('No internet connection detected. You can continue recording locally.')
      return
    }
    const attemptId = ++signInAttemptRef.current
    setSigningInMethod(method)
    setSignInError(null)
    try {
      const session = await window.aimyDesktop.signIn(method)
      if (signInAttemptRef.current !== attemptId) return
      setAuth(session)
      if (session.authenticated) {
        setSignInModalOpen(false)
        setLocalOnlyDismissed(false)
        toast('Signed in to AiMY Knowledge', {
          sub: session.user?.email || session.user?.name || 'Your session token is active.'
        })
      }
    } catch (err) {
      if (signInAttemptRef.current !== attemptId) return
      const msg = err instanceof Error ? err.message : 'Please try signing in again.'
      setSignInError(msg)
      setSignInModalOpen(true)
    } finally {
      if (signInAttemptRef.current === attemptId) {
        setSigningInMethod(null)
      }
    }
  }

  const handleCancelSignIn = async (): Promise<void> => {
    signInAttemptRef.current += 1
    setSigningInMethod(null)
    setSignInError(null)
    await window.aimyDesktop.cancelSignIn()
  }

  const handleSignOut = async (): Promise<void> => {
    await window.aimyDesktop.signOut()
    toast('Signed out', { sub: 'Local recordings stay saved on your computer.' })
  }

  const handleImportAudio = async (): Promise<void> => {
    try {
      const imported = await window.aimyDesktop.importAudioFile()
      if (imported) {
        setSelectedId(imported.id)
        toast('Audio imported', {
          sub: `"${imported.title}" is ready to sync to AiMY Knowledge.`
        })
      }
    } catch (err) {
      toast('Import failed', {
        tone: 'err',
        sub: err instanceof Error ? err.message : 'Could not import the selected file.'
      })
    }
  }

  const handleSyncOne = async (id: string): Promise<void> => {
    if (!online) {
      toast('You are offline', {
        sub: 'Recording stays saved locally and will sync automatically when connected.'
      })
      return
    }
    if (!auth.authenticated) {
      handleOpenSignInPrompt()
      return
    }
    const updated = await window.aimyDesktop.syncRecording(id)
    if (updated.syncStatus === 'FAILED') {
      toast('Sync failed', {
        tone: 'err',
        sub: updated.error || 'Could not upload recording.',
        action: { label: 'Try again', onClick: () => void handleSyncOne(id) }
      })
    } else if (updated.syncStatus === 'LOCAL_PENDING') {
      toast('Saved locally for sync', {
        sub: updated.error || 'Will retry syncing automatically once connected and signed in.'
      })
    } else if (updated.syncStatus === 'SYNCED') {
      toast('Synced to AiMY Knowledge', {
        sub: `"${updated.title}" is live in AiMY Knowledge.`
      })
    } else {
      toast('Uploaded to AiMY', {
        sub: 'AiMY is now transcribing your recording in the background.'
      })
    }
  }

  const handleIndexOne = async (id: string): Promise<void> => {
    const updated = await window.aimyDesktop.indexRecording(id)
    if (updated.syncStatus === 'SYNCED') {
      toast('Added to AiMY Knowledge', {
        sub: `"${updated.title}" is now searchable in AiMY Knowledge.`
      })
    } else if (updated.error) {
      toast('Could not add to Knowledge', { tone: 'err', sub: updated.error })
    }
  }

  const handleSyncAllPending = async (): Promise<void> => {
    if (!online) {
      toast('You are offline', {
        sub: 'Local recordings will sync automatically once your internet connection returns.'
      })
      return
    }
    if (!auth.authenticated) {
      handleOpenSignInPrompt()
      return
    }
    setSyncingAll(true)
    try {
      const { started } = await window.aimyDesktop.syncAllPending()
      if (started === 0) {
        toast('Nothing left to sync', { sub: 'All recordings are already uploaded or in progress.' })
      } else {
        toast(`Syncing ${started} ${started === 1 ? 'recording' : 'recordings'}`, {
          sub: 'Uploading to AiMY Knowledge in the background.'
        })
      }
    } finally {
      setSyncingAll(false)
    }
  }

  const handleRefreshStatuses = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await window.aimyDesktop.refreshAllStatuses()
      toast('Statuses refreshed', { sub: 'Checked latest transcription status from AiMY.' })
    } finally {
      setRefreshing(false)
    }
  }

  const counts = useMemo(() => {
    const synced = recordings.filter((r) => isSyncedStatus(r.syncStatus)).length
    const inProgress = recordings.filter((r) => isInProgressStatus(r.syncStatus)).length
    const leftToSync = recordings.filter((r) => isLeftToSyncStatus(r.syncStatus)).length
    const totalSeconds = recordings.reduce((acc, r) => acc + (r.durationSeconds || 0), 0)
    return {
      all: recordings.length,
      synced,
      pending: inProgress + leftToSync,
      leftToSync,
      totalSeconds
    }
  }, [recordings])

  const visibleRecordings = useMemo(() => {
    const byFilter = recordings.filter((r) => {
      if (filter === 'synced') return isSyncedStatus(r.syncStatus)
      if (filter === 'pending') return !isSyncedStatus(r.syncStatus)
      return true
    })
    const q = search.trim().toLowerCase()
    if (!q) return byFilter
    return byFilter.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.meetingApp || '').toLowerCase().includes(q) ||
        (r.groupName || '').toLowerCase().includes(q) ||
        r.notes.toLowerCase().includes(q) ||
        (r.aimySummary || '').toLowerCase().includes(q) ||
        (r.aimyTranscript || '').toLowerCase().includes(q)
    )
  }, [recordings, filter, search])

  const selectedRecording = useMemo(
    () => recordings.find((r) => r.id === selectedId) ?? visibleRecordings[0] ?? null,
    [recordings, selectedId, visibleRecordings]
  )

  const defaultGroup = useMemo(
    () => groups.find((g) => g.group_id === settings.defaultGroupId) ?? null,
    [groups, settings.defaultGroupId]
  )

  const filterOptions: { key: SidebarFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'pending', label: 'Pending', count: counts.pending },
    { key: 'synced', label: 'Synced', count: counts.synced }
  ]

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-body text-ink">
      <AmbientBackground />

      {/* Calm, Spacious Top Bar */}
      <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-hairline bg-topbar px-6">
        <div className="flex items-center gap-3">
          <AimyMark variant="lockup" title="AiMY" className="h-5" />
          <span className="h-4 w-px bg-w12" aria-hidden="true" />
          <span className="text-xs font-semibold text-ink">Meetings</span>

          {live ? (
            <StatusPill state={live.isPaused ? 'away' : 'busy'}>
              {live.isPaused ? 'Paused' : 'Recording'} · {formatDuration(live.elapsedSeconds)}
            </StatusPill>
          ) : liveMeeting ? (
            <StatusPill state="online">{liveMeeting.app} active</StatusPill>
          ) : settings.detectMeetings ? (
            <StatusPill state="online">Auto-detect</StatusPill>
          ) : null}

          {!online && <StatusPill state="offline">Offline · Local-only</StatusPill>}
        </div>

        <div className="flex items-center gap-2.5">
          <Button variant="ghost" size="sm" onClick={() => void handleImportAudio()}>
            <FolderUp className="size-3.5" />
            Import
          </Button>

          {!live && (
            <Button variant="brand" size="sm" onClick={() => void beginRecording()}>
              <Radio className="size-3.5" />
              New recording
            </Button>
          )}

          <span className="mx-1 h-4 w-px bg-w12" aria-hidden="true" />

          {auth.authenticated ? (
            <UserMenu
              name={auth.user?.name || auth.user?.email || 'AiMY User'}
              role={defaultGroup?.group_name || 'AiMY Knowledge'}
            >
              <MenuLabel>AiMY Knowledge</MenuLabel>
              <MenuItem
                leading={<ExternalLink className="size-3.5" />}
                onSelect={() =>
                  void window.aimyDesktop.openExternal(`${settings.consoleBaseUrl}/console`)
                }
              >
                Open Knowledge Console
              </MenuItem>
              <MenuItem
                leading={<RefreshCw className="size-3.5" />}
                onSelect={() => void handleRefreshStatuses()}
              >
                Refresh sync statuses
              </MenuItem>
              <MenuItem
                leading={<Settings className="size-3.5" />}
                onSelect={() => setSettingsOpen(true)}
              >
                Preferences
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                leading={<LogOut className="size-3.5" />}
                onSelect={() => void handleSignOut()}
              >
                Sign out
              </MenuItem>
            </UserMenu>
          ) : (
            <Button
              variant="accent"
              size="sm"
              loading={Boolean(signingInMethod)}
              onClick={handleOpenSignInPrompt}
            >
              <LogIn className="size-3.5" />
              Sign in
            </Button>
          )}

          <ThemeToggle />

          <IconButton label="Preferences" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings className="size-4" />
          </IconButton>
        </div>
      </header>

      {/* Edge-to-Edge Architectural Two-Column Split */}
      <main className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
        {/* Left Sidebar: Clean, Uncluttered Recordings List */}
        <aside
          aria-label="Meeting recordings"
          className="flex w-80 shrink-0 flex-col border-r border-hairline"
        >
          {/* Search & 3-Option Filter Bar */}
          <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
            <SearchField
              label="Search recordings"
              placeholder="Search meetings…"
              value={search}
              onValueChange={setSearch}
            />

            <div
              role="tablist"
              aria-label="Filter recordings"
              className="grid grid-cols-3 gap-1 rounded-xl bg-w04 p-1"
            >
              {filterOptions.map((opt) => {
                const active = filter === opt.key
                return (
                  <button
                    key={opt.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(opt.key)}
                    className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-2xs font-semibold transition-colors cursor-pointer ${
                      active
                        ? 'bg-card text-ink shadow-sm'
                        : 'text-ink-secondary hover:text-ink'
                    }`}
                  >
                    <span>{opt.label}</span>
                    {opt.count > 0 && (
                      <span className="font-mono text-2xs text-ink-quiet">{opt.count}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Scrollable List */}
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-1">
            {visibleRecordings.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center">
                <p className="m-0 text-xs font-semibold text-ink">
                  {recordings.length === 0 ? 'No recordings yet' : 'No matches found'}
                </p>
                <p className="m-0 mt-1 text-2xs text-ink-secondary">
                  {recordings.length === 0
                    ? 'Start a new recording or import an audio file.'
                    : 'Try clearing your search or switching filters.'}
                </p>
                {recordings.length > 0 && (
                  <div className="mt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setFilter('all')
                        setSearch('')
                      }}
                    >
                      Show all
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              visibleRecordings.map((item) => (
                <RecordingCard
                  key={item.id}
                  recording={item}
                  selected={selectedRecording?.id === item.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))
            )}
          </div>

          {/* Quiet Sidebar Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-hairline px-4 py-2.5 text-2xs text-ink-quiet">
            <span>
              {counts.all} {counts.all === 1 ? 'meeting' : 'meetings'} ·{' '}
              {formatDuration(counts.totalSeconds)}
            </span>

            <div className="flex items-center gap-1">
              {counts.leftToSync > 0 && auth.authenticated && online && (
                <Button
                  variant="text"
                  size="sm"
                  loading={syncingAll}
                  onClick={() => void handleSyncAllPending()}
                >
                  <UploadCloud className="size-3" />
                  Sync {counts.leftToSync}
                </Button>
              )}
              <IconButton
                label="Refresh sync statuses"
                size="sm"
                disabled={!auth.authenticated || !online || refreshing}
                onClick={() => void handleRefreshStatuses()}
              >
                <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </IconButton>
            </div>
          </div>
        </aside>

        {/* Right Main Canvas: Spacious Editorial Inspector */}
        <section aria-label="Meeting workspace" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Detected Live Meeting Strip (only when a call is detected) */}
          {!live && liveMeeting && ignoredInAppMeetingId !== liveMeeting.id && (
            <div className="border-b border-hairline bg-card/80 px-8 py-3">
              <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="relative size-7 shrink-0">
                    <Orb phase="listening" level={0.35} running className="size-7" />
                  </div>
                  <span className="truncate text-xs font-semibold text-ink">
                    {liveMeeting.title}
                  </span>
                  <Tag tone="accent">{liveMeeting.app}</Tag>
                  {liveMeeting.micActive && (
                    <Tag tone="ok">
                      <Mic className="size-3" />
                      Mic active
                    </Tag>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setIgnoredInAppMeetingId(liveMeeting.id)
                      void window.aimyDesktop.dismissMeetingPrompt(liveMeeting.id)
                    }}
                  >
                    Dismiss
                  </Button>
                  <Button
                    variant="brand"
                    size="sm"
                    onClick={() => {
                      void window.aimyDesktop.hideMeetingPrompt()
                      void beginRecording({
                        title: liveMeeting.title || `${liveMeeting.app} Meeting`,
                        meetingApp: liveMeeting.app,
                        meetingWindowTitle: liveMeeting.title,
                        meetingId: liveMeeting.id
                      })
                    }}
                  >
                    <Radio className="size-3.5" />
                    Record call
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Active Live Recording Bar */}
          {live && (
            <LiveRecorderBar
              title={live.title}
              meetingApp={live.meetingApp}
              elapsedSeconds={live.elapsedSeconds}
              audioLevel={live.audioLevel}
              isPaused={live.isPaused}
              hasSystemAudio={live.hasSystemAudio}
              hasMicAudio={live.hasMicAudio}
              notes={live.notes}
              stopping={stoppingRecording}
              onTitleChange={(title) => setLive((prev) => (prev ? { ...prev, title } : null))}
              onNotesChange={(notes) => setLive((prev) => (prev ? { ...prev, notes } : null))}
              onTogglePause={() => {
                if (!captureRef.current) return
                if (live.isPaused) {
                  captureRef.current.resume()
                  setLive((prev) => (prev ? { ...prev, isPaused: false } : null))
                } else {
                  captureRef.current.pause()
                  setLive((prev) => (prev ? { ...prev, isPaused: true } : null))
                }
              }}
              onStop={() => void stopRecording()}
            />
          )}

          {/* Main Inspector Body */}
          <div className="min-h-0 flex-1">
            {selectedRecording ? (
              <RecordingDetail
                recording={selectedRecording}
                groups={groups}
                isAuthenticated={auth.authenticated}
                onUpdate={async (id: string, patch: UpdateRecordingPatch) => {
                  await window.aimyDesktop.updateRecording(id, patch)
                }}
                onSync={handleSyncOne}
                onIndex={handleIndexOne}
                onRefresh={async (id: string) => {
                  await window.aimyDesktop.refreshRecordingStatus(id)
                  toast('Status updated')
                }}
                onDelete={async (id: string) => {
                  await window.aimyDesktop.deleteRecording(id)
                  toast('Recording deleted from this computer')
                }}
                onEnhanceAudio={async (id: string) => {
                  try {
                    const updated = await window.aimyDesktop.enhanceRecordingAudio(id)
                    toast('Audio enhanced', {
                      sub:
                        updated.enhancementEngine === 'deepfilternet3'
                          ? 'Cleaned with DeepFilterNet3 neural noise cancellation.'
                          : 'Cleaned with FFmpeg speech denoising and normalization.'
                    })
                  } catch (err) {
                    toast('Audio enhancement failed', {
                      tone: 'err',
                      sub: err instanceof Error ? err.message : 'Unexpected enhancement error.'
                    })
                  }
                }}
                onTranscribeClip={async (id: string) => {
                  try {
                    const text = await window.aimyDesktop.transcribeQuickClip(id)
                    const current = recordings.find((r) => r.id === id)
                    const merged = current?.notes
                      ? `${current.notes}\n\n---\n${text}`
                      : text
                    await window.aimyDesktop.updateRecording(id, { notes: merged })
                    toast('Transcript added to notes')
                  } catch (err) {
                    toast('Quick transcription failed', {
                      tone: 'err',
                      sub: err instanceof Error ? err.message : 'Clip may exceed 25 MB limit.'
                    })
                  }
                }}
                onOpenExternal={(url) => void window.aimyDesktop.openExternal(url)}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-10">
                <EmptyState
                  variant="plain"
                  icon={<AimyMark variant="icon" title="" className="h-9 w-9" />}
                  title="Select or record a meeting"
                  description="Choose a recording from the sidebar, start a live capture, or import an existing audio file."
                  actions={
                    <>
                      <Button variant="brand" onClick={() => void beginRecording()}>
                        <Radio className="size-3.5" />
                        New recording
                      </Button>
                      <Button variant="ghost" onClick={() => void handleImportAudio()}>
                        <FolderUp className="size-3.5" />
                        Import audio
                      </Button>
                    </>
                  }
                />
              </div>
            )}
          </div>
        </section>
      </main>

      <SignInPromptDialog
        open={signInModalOpen}
        reason={auth.reason}
        lastUserEmail={auth.user?.email}
        pendingCount={counts.leftToSync}
        online={online}
        signingInMethod={signingInMethod}
        error={signInError}
        onSignIn={handleSignIn}
        onCancelSignIn={handleCancelSignIn}
        onContinueLocalOnly={() => {
          setLocalOnlyDismissed(true)
          setSignInModalOpen(false)
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        groups={groups}
        isAuthenticated={auth.authenticated}
        authCallbackUrl={authCallbackUrl}
        ffmpegAvailable={ffmpegAvailable}
        deepFilterAvailable={deepFilterAvailable}
        onSaveSettings={async (patch) => {
          const next = await window.aimyDesktop.updateSettings(patch)
          setSettings(next)
        }}
        onManualToken={async (token) => {
          const session = await window.aimyDesktop.setManualToken(token)
          setAuth(session)
        }}
        onSimulateMeeting={async () => {
          await window.aimyDesktop.simulateMeetingDetection()
          toast('Meeting prompt triggered', {
            sub: 'Look at the bottom-right corner of your screen.'
          })
        }}
      />

      <Toaster />
    </div>
  )
}
