import { useEffect, useMemo, useState } from 'react'
import {
  AimyNote,
  Button,
  CallRecording,
  CopyButton,
  Divider,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Notice,
  Progress,
  SaveStatus,
  Segmented,
  Select,
  SelectItem,
  StepList,
  Switch,
  Tab,
  Tabs,
  TabsList,
  Tag,
  Textarea,
  TypeToConfirm,
  WorkState,
  toast
} from '@flairstech-aimy/ui'
import {
  AudioLines,
  CheckCircle2,
  ExternalLink,
  FileAudio,
  FolderOpen,
  Link2,
  MoreHorizontal,
  RefreshCw,
  Subtitles,
  Trash2,
  UploadCloud
} from 'lucide-react'
import type { AimyAgent, AimyGroup, RecordingItem, UpdateRecordingPatch, UploadMode } from '@shared/types'
import { formatBytes, formatDuration, formatTimestamp, statusPresentation } from '@renderer/lib/format'

interface RecordingDetailProps {
  recording: RecordingItem
  groups: AimyGroup[]
  isAuthenticated: boolean
  onUpdate: (id: string, patch: UpdateRecordingPatch) => Promise<void>
  onSync: (id: string) => Promise<void>
  onIndex: (id: string) => Promise<void>
  onRefresh: (id: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onEnhanceAudio: (id: string) => Promise<void>
  onTranscribeClip: (id: string) => Promise<void>
  onOpenExternal: (url: string) => void
}

type InspectorTab = 'transcript' | 'notes' | 'sync'

export function RecordingDetail({
  recording,
  groups,
  isAuthenticated,
  onUpdate,
  onSync,
  onIndex,
  onRefresh,
  onDelete,
  onEnhanceAudio,
  onTranscribeClip,
  onOpenExternal
}: RecordingDetailProps) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState(recording.title)
  const [notesDraft, setNotesDraft] = useState(recording.notes)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [agents, setAgents] = useState<AimyAgent[]>([])
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<InspectorTab>('transcript')

  useEffect(() => {
    setTitleDraft(recording.title)
    setNotesDraft(recording.notes)
    setSaveState('idle')
  }, [recording.id])

  useEffect(() => {
    setTitleDraft(recording.title)
  }, [recording.title])

  useEffect(() => {
    setNotesDraft(recording.notes)
  }, [recording.notes])

  useEffect(() => {
    let active = true
    void window.aimyDesktop.getRecordingAudioUrl(recording.id).then((url) => {
      if (active) setAudioUrl(url)
    })
    return () => {
      active = false
    }
  }, [recording.id, recording.audioPath, recording.updatedAt])

  useEffect(() => {
    if (!isAuthenticated || !recording.groupId) {
      setAgents([])
      return
    }
    let active = true
    void window.aimyDesktop
      .listAgents(recording.groupId)
      .then((list) => {
        if (active) setAgents(list)
      })
      .catch(() => {
        if (active) setAgents([])
      })
    return () => {
      active = false
    }
  }, [isAuthenticated, recording.groupId])

  const presentation = statusPresentation(recording)

  const pipelineSteps = useMemo(() => {
    const s = recording.syncStatus
    const hasAudio = Boolean(recording.audioPath) || s !== 'RECORDING'
    const uploaded = Boolean(recording.aimyDocId)

    const recordState: 'done' | 'running' | 'pending' | 'failed' =
      s === 'RECORDING' || s === 'ENCODING' ? 'running' : hasAudio ? 'done' : 'pending'

    const uploadState: 'done' | 'running' | 'pending' | 'failed' =
      s === 'UPLOADING'
        ? 'running'
        : uploaded
          ? 'done'
          : s === 'FAILED' && !uploaded
            ? 'failed'
            : 'pending'

    const transcribeState: 'done' | 'running' | 'pending' | 'failed' =
      recording.uploadMode === 'transcript-json'
        ? uploaded
          ? 'done'
          : 'pending'
        : s === 'TRANSCRIBING'
          ? 'running'
          : s === 'READY_FOR_REVIEW' || s === 'INDEXING' || s === 'SYNCED'
            ? 'done'
            : s === 'FAILED' && uploaded
              ? 'failed'
              : 'pending'

    const indexState: 'done' | 'running' | 'pending' | 'failed' =
      s === 'INDEXING'
        ? 'running'
        : s === 'SYNCED'
          ? 'done'
          : s === 'FAILED' && recording.aimyProcessingStatus === 'READY_FOR_REVIEW'
            ? 'failed'
            : 'pending'

    return [
      {
        label: 'Recorded locally',
        meta: `${formatDuration(recording.durationSeconds)} · ${formatBytes(recording.fileSizeBytes)}`,
        state: recordState
      },
      {
        label:
          recording.uploadMode === 'audio-recording'
            ? 'Uploaded recording to AiMY'
            : 'Sent notes document to AiMY',
        meta:
          s === 'UPLOADING'
            ? `${recording.uploadProgress ?? 0}% uploaded`
            : recording.aimyDocId
              ? `Document #${recording.aimyDocId}`
              : 'Waiting to upload',
        state: uploadState
      },
      {
        label:
          recording.uploadMode === 'audio-recording'
            ? 'Transcribed by AiMY'
            : 'Structured as Markdown document',
        meta:
          recording.aimyProcessingStatus === 'READY_FOR_REVIEW'
            ? 'Transcript ready for review'
            : s === 'TRANSCRIBING'
              ? 'Processing on AiMY server'
              : transcribeState === 'done'
                ? 'Complete'
                : 'Pending upload',
        state: transcribeState
      },
      {
        label: 'Indexed in AiMY Knowledge',
        meta:
          s === 'SYNCED'
            ? recording.lastSyncedAt
              ? `Synced ${formatTimestamp(recording.lastSyncedAt)}`
              : 'Live in AiMY Knowledge'
            : s === 'READY_FOR_REVIEW'
              ? 'Click "Add to Knowledge" to index'
              : 'Pending',
        state: indexState
      }
    ]
  }, [recording])

  const triggerSave = async (patch: UpdateRecordingPatch): Promise<void> => {
    setSaveState('saving')
    try {
      await onUpdate(recording.id, patch)
      setSaveState('saved')
    } catch {
      setSaveState('failed')
    }
  }

  const commitTitle = (): void => {
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== recording.title) {
      void triggerSave({ title: trimmed })
    } else {
      setTitleDraft(recording.title)
    }
  }

  const commitNotes = (): void => {
    if (notesDraft !== recording.notes) {
      void triggerSave({ notes: notesDraft })
    }
  }

  const handleGroupChange = (val: string): void => {
    const groupId = Number(val)
    const found = groups.find((g) => g.group_id === groupId)
    void triggerSave({
      groupId: Number.isFinite(groupId) ? groupId : null,
      groupName: found
        ? `${found.client_name ? `${found.client_name} · ` : ''}${found.group_name}`
        : null,
      agentIds: []
    })
  }

  const toggleAgent = (agentId: number): void => {
    const next = recording.agentIds.includes(agentId)
      ? recording.agentIds.filter((id) => id !== agentId)
      : [...recording.agentIds, agentId]
    void triggerSave({ agentIds: next })
  }

  const runAction = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusyAction(key)
    try {
      await fn()
    } finally {
      setBusyAction(null)
    }
  }

  const activeTranscriptText = recording.aimyTranscript || ''

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-12">
        {/* Row 1: Calm Meta Line + Single Primary Action & Overflow Menu */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-2xs text-ink-secondary">
            <WorkState state={presentation.workState} label={presentation.label} />
            <span className="text-ink-quiet">·</span>
            <span>{formatTimestamp(recording.createdAt)}</span>
            <span className="text-ink-quiet">·</span>
            <span className="font-mono">{formatDuration(recording.durationSeconds)}</span>
            <SaveStatus status={saveState} />
          </div>

          {/* Right: At most 1-2 buttons + 1 clean "More" menu */}
          <div className="flex shrink-0 items-center gap-2">
            {(recording.syncStatus === 'LOCAL_PENDING' || recording.syncStatus === 'FAILED') && (
              <Button
                variant={recording.syncStatus === 'FAILED' ? 'warn' : 'brand'}
                size="sm"
                disabled={!isAuthenticated || !recording.groupId}
                loading={busyAction === 'sync'}
                onClick={() => void runAction('sync', () => onSync(recording.id))}
              >
                <UploadCloud className="size-3.5" />
                {recording.syncStatus === 'FAILED' ? 'Retry sync' : 'Sync to AiMY'}
              </Button>
            )}

            {recording.syncStatus === 'READY_FOR_REVIEW' && (
              <Button
                variant="brand"
                size="sm"
                loading={busyAction === 'index'}
                onClick={() => void runAction('index', () => onIndex(recording.id))}
              >
                <CheckCircle2 className="size-3.5" />
                Add to Knowledge
              </Button>
            )}

            {recording.aimyDocumentUrl && (
              <Button
                variant={recording.syncStatus === 'SYNCED' ? 'ok' : 'ghost'}
                size="sm"
                onClick={() => onOpenExternal(recording.aimyDocumentUrl!)}
              >
                <ExternalLink className="size-3.5" />
                Open in Knowledge
              </Button>
            )}

            <Menu>
              <MenuTrigger asChild>
                <IconButton label="More actions" size="sm">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                {recording.aimyDocumentUrl && (
                  <MenuItem
                    leading={<Link2 className="size-3.5" />}
                    onSelect={() => {
                      void navigator.clipboard.writeText(recording.aimyDocumentUrl!)
                      toast('Copied AiMY Knowledge link')
                    }}
                  >
                    Copy Knowledge link
                  </MenuItem>
                )}

                {recording.aimyDocId && (
                  <MenuItem
                    leading={<RefreshCw className="size-3.5" />}
                    onSelect={() => void runAction('refresh', () => onRefresh(recording.id))}
                  >
                    Refresh AiMY status
                  </MenuItem>
                )}

                {recording.audioPath && (
                  <MenuItem
                    leading={<FolderOpen className="size-3.5" />}
                    onSelect={() => void window.aimyDesktop.revealRecordingInFolder(recording.id)}
                  >
                    Show audio file in folder
                  </MenuItem>
                )}

                {recording.audioPath &&
                  !recording.audioEnhanced &&
                  recording.syncStatus !== 'ENCODING' && (
                    <MenuItem
                      leading={<AudioLines className="size-3.5" />}
                      onSelect={() => void runAction('enhance', () => onEnhanceAudio(recording.id))}
                    >
                      Enhance audio (DeepFilterNet3)
                    </MenuItem>
                  )}

                {isAuthenticated && recording.audioPath && (
                  <MenuItem
                    leading={<FileAudio className="size-3.5" />}
                    onSelect={() =>
                      void runAction('transcribe', () => onTranscribeClip(recording.id))
                    }
                  >
                    Quick-transcribe clip to notes
                  </MenuItem>
                )}

                <MenuSeparator />

                <MenuItem
                  danger
                  leading={<Trash2 className="size-3.5" />}
                  onSelect={() => setDeleteOpen(true)}
                >
                  Delete local recording
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>

        {/* Row 2: Large Editorial Title + Subtle Metadata Line */}
        <div>
          <Input
            variant="line"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
            aria-label="Recording title"
            className="border-transparent hover:border-edge-hover focus-visible:border-brand py-1 text-2xl font-bold tracking-tight"
          />

          <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-ink-secondary">
            <button
              type="button"
              onClick={() => setActiveTab('sync')}
              className="inline-flex items-center gap-1.5 rounded-md bg-w05 px-2 py-0.5 font-medium text-ink transition-colors hover:bg-w08 cursor-pointer"
            >
              <FolderOpen className="size-3 text-ink-quiet" />
              <span>{recording.groupName || 'Select workspace group'}</span>
            </button>

            {recording.meetingApp && (
              <>
                <span className="text-ink-quiet">·</span>
                <span>{recording.meetingApp}</span>
              </>
            )}

            {recording.fileSizeBytes ? (
              <>
                <span className="text-ink-quiet">·</span>
                <span className="font-mono">{formatBytes(recording.fileSizeBytes)}</span>
              </>
            ) : null}

            {recording.audioEnhanced && <Tag tone="ai">Enhanced</Tag>}
            {recording.isPersonal && <Tag tone="neutral">Personal</Tag>}
            {recording.lifecycle === 'draft' && <Tag tone="warn">Draft</Tag>}
            {recording.aimyDocId && (
              <span className="font-mono text-ink-quiet">#{recording.aimyDocId}</span>
            )}
          </div>
        </div>

        {/* Contextual Upload Progress or Error Banner (only when active/failed) */}
        {recording.syncStatus === 'UPLOADING' && (
          <div className="flex flex-col gap-2 rounded-xl border border-info-border bg-info-bg px-4 py-3">
            <div className="flex items-center justify-between text-xs text-ink">
              <span>Uploading to AiMY Knowledge…</span>
              <span className="font-mono font-semibold">{recording.uploadProgress ?? 0}%</span>
            </div>
            <Progress
              size="thin"
              value={recording.uploadProgress ?? 5}
              max={100}
              label="Uploading to AiMY Knowledge"
            />
          </div>
        )}

        {recording.error && (
          <Notice
            tone="err"
            title="Sync issue"
            action={
              <Button
                variant="err"
                size="sm"
                disabled={!isAuthenticated}
                loading={busyAction === 'sync'}
                onClick={() => void runAction('sync', () => onSync(recording.id))}
              >
                <RefreshCw className="size-3.5" />
                Retry sync
              </Button>
            }
          >
            {recording.error}
          </Notice>
        )}

        {/* Full-Width Uncluttered Audio Player */}
        {recording.audioPath && (
          <CallRecording
            key={audioUrl ?? recording.id}
            id={recording.id}
            seconds={Math.max(1, recording.durationSeconds || 1)}
            src={audioUrl ?? undefined}
            kind="call"
          />
        )}

        {/* Clean Section Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-2">
          <Tabs
            size="section"
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as InspectorTab)}
          >
            <TabsList>
              <Tab value="transcript">Transcript</Tab>
              <Tab value="notes">Notes</Tab>
              <Tab value="sync">Settings</Tab>
            </TabsList>
          </Tabs>

          {activeTab === 'transcript' && activeTranscriptText && (
            <div className="flex items-center gap-2">
              <CopyButton value={activeTranscriptText} what="the transcript" size="sm" />
            </div>
          )}
        </div>

        {/* Tab 1: Spacious Transcript & Summary Reader */}
        {activeTab === 'transcript' && (
          <div className="flex flex-col gap-6 pt-1">
            {recording.aimySummary && (
              <AimyNote from="AiMY Knowledge summary">{recording.aimySummary}</AimyNote>
            )}

            {activeTranscriptText ? (
              <pre
                dir="auto"
                className="m-0 whitespace-pre-wrap font-sans text-sm text-ink leading-relaxed"
              >
                {activeTranscriptText}
              </pre>
            ) : (
              <div className="py-6">
                <EmptyState
                  variant="dashed"
                  icon={<Subtitles className="size-7 text-ai-ink" />}
                  title="No transcript yet"
                  description="Sync this recording to AiMY Knowledge to generate a cloud transcript and summary."
                  actions={
                    (recording.syncStatus === 'LOCAL_PENDING' ||
                      recording.syncStatus === 'FAILED') ? (
                      <Button
                        variant="brand"
                        disabled={!isAuthenticated || !recording.groupId}
                        loading={busyAction === 'sync'}
                        onClick={() => void runAction('sync', () => onSync(recording.id))}
                      >
                        <UploadCloud className="size-3.5" />
                        Sync to AiMY Knowledge
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Spacious Meeting Notes Canvas */}
        {activeTab === 'notes' && (
          <div className="flex flex-col gap-4 pt-1">
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-xs text-ink-secondary">
                Write meeting takeaways, decisions, or action items. Changes save automatically.
              </p>
              <div className="flex items-center gap-2">
                {notesDraft.trim() && (
                  <CopyButton value={notesDraft} what="the meeting notes" size="sm" />
                )}
                {isAuthenticated && recording.groupId && notesDraft.trim() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busyAction === 'sync-notes'}
                    onClick={() =>
                      void runAction('sync-notes', async () => {
                        await onUpdate(recording.id, {
                          notes: notesDraft,
                          uploadMode: 'transcript-json'
                        })
                        await onSync(recording.id)
                      })
                    }
                  >
                    <UploadCloud className="size-3.5" />
                    Sync notes to AiMY
                  </Button>
                )}
              </div>
            </div>

            <Textarea
              rows={14}
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              onBlur={commitNotes}
              placeholder="Start typing meeting notes, key decisions, or next steps…"
              className="min-h-72 p-4 text-sm leading-relaxed"
            />
          </div>
        )}

        {/* Tab 3: Sync & Access Settings */}
        {activeTab === 'sync' && (
          <div className="flex flex-col gap-6 pt-2">
            <div className="grid grid-cols-1 gap-5 column:grid-cols-2">
              <Field
                label="Target AiMY workspace group"
                help={
                  groups.length === 0
                    ? isAuthenticated
                      ? 'No groups returned for your account.'
                      : 'Sign in with AiMY to load your groups.'
                    : 'Where this meeting will be stored in AiMY Knowledge.'
                }
              >
                <Select
                  value={recording.groupId != null ? String(recording.groupId) : undefined}
                  onValueChange={handleGroupChange}
                  placeholder="Choose an AiMY group"
                  disabled={!isAuthenticated || groups.length === 0}
                >
                  {groups.map((g) => (
                    <SelectItem key={g.group_id} value={String(g.group_id)}>
                      {g.client_name ? `${g.client_name} · ${g.group_name}` : g.group_name}
                    </SelectItem>
                  ))}
                </Select>
              </Field>

              <Field
                label="Ingestion mode"
                help="Upload audio for cloud transcription, or send meeting notes as a document."
              >
                <Segmented
                  label="Ingestion method"
                  value={recording.uploadMode}
                  onValueChange={(v) => void triggerSave({ uploadMode: v as UploadMode })}
                  options={[
                    { value: 'audio-recording', label: 'Audio file' },
                    { value: 'transcript-json', label: 'Notes / JSON' }
                  ]}
                />
              </Field>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-6">
                <Switch
                  label="Mark new recordings as Personal by default"
                  checked={recording.isPersonal}
                  disabled
                  lockedReason="Can only be changed from AiMY Knowledge."
                />
                <Switch
                  label="Upload as Draft lifecycle by default"
                  checked={recording.lifecycle === 'draft'}
                  disabled
                  lockedReason="Can only be changed from AiMY Knowledge."
                />
              </div>
              <p className="m-0 text-2xs text-ink-quiet">
                Personal visibility and Draft lifecycle are enforced by default and can only be changed from AiMY Knowledge.
              </p>
            </div>

            {agents.length > 0 && (
              <Field
                label="Restrict to specific AiMY agents"
                optional
                help="Leave empty so all agents in this group can access the meeting."
              >
                <div className="flex flex-wrap gap-2 pt-1">
                  {agents.map((ag) => {
                    const active = recording.agentIds.includes(ag.agent_id)
                    return (
                      <Button
                        key={ag.agent_id}
                        size="sm"
                        variant={active ? 'accent' : 'ghost'}
                        onClick={() => toggleAgent(ag.agent_id)}
                      >
                        {ag.agent_name}
                      </Button>
                    )
                  })}
                </div>
              </Field>
            )}

            <Divider />

            {/* Ingestion Pipeline Steps */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h4 className="m-0 text-xs font-semibold text-ink">Ingestion status</h4>
                {(recording.syncStatus === 'LOCAL_PENDING' ||
                  recording.syncStatus === 'FAILED' ||
                  recording.syncStatus === 'SYNCED') && (
                  <Button
                    variant={recording.syncStatus === 'SYNCED' ? 'ghost' : 'brand'}
                    size="sm"
                    disabled={!isAuthenticated || !recording.groupId}
                    loading={busyAction === 'sync'}
                    onClick={() => void runAction('sync', () => onSync(recording.id))}
                  >
                    <UploadCloud className="size-3.5" />
                    {recording.syncStatus === 'SYNCED'
                      ? 'Re-sync to AiMY'
                      : recording.syncStatus === 'FAILED'
                        ? 'Retry sync'
                        : 'Sync to AiMY Knowledge'}
                  </Button>
                )}
              </div>
              <StepList steps={pipelineSteps} />
            </div>
          </div>
        )}
      </div>

      {/* Destructive confirmation per AiMY doctrine */}
      <TypeToConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete local recording"
        description="This deletes the local audio file and history row from this computer. Any document already synced to AiMY Knowledge stays untouched."
        word="delete"
        actionLabel="Delete recording"
        onConfirm={() => {
          setDeleteOpen(false)
          void onDelete(recording.id)
        }}
      />
    </div>
  )
}
