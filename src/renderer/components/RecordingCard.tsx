import { Progress, StatusDot } from '@flairstech-aimy/ui'
import type { RecordingItem } from '@shared/types'
import { formatDuration, formatTimestamp, statusPresentation } from '@renderer/lib/format'

interface RecordingCardProps {
  recording: RecordingItem
  selected: boolean
  onSelect: () => void
}

function statusDotState(status: RecordingItem['syncStatus']): 'online' | 'busy' | 'away' | 'offline' {
  switch (status) {
    case 'SYNCED':
      return 'online'
    case 'RECORDING':
    case 'FAILED':
      return 'busy'
    case 'ENCODING':
    case 'UPLOADING':
    case 'TRANSCRIBING':
    case 'INDEXING':
    case 'READY_FOR_REVIEW':
    case 'LOCAL_PENDING':
      return 'away'
    default:
      return 'offline'
  }
}

function shortAppName(app?: string | null): string | null {
  if (!app || app === 'Manual') return null
  if (app === 'Microsoft Teams') return 'Teams'
  if (app === 'Google Meet') return 'Meet'
  if (app === 'Imported Audio') return 'Imported'
  return app
}

export function RecordingCard({
  recording,
  selected,
  onSelect
}: RecordingCardProps) {
  const presentation = statusPresentation(recording)
  const isBusy =
    recording.syncStatus === 'UPLOADING' ||
    recording.syncStatus === 'TRANSCRIBING' ||
    recording.syncStatus === 'ENCODING' ||
    recording.syncStatus === 'INDEXING'

  const appLabel = shortAppName(recording.meetingApp)

  return (
    <button
      type="button"
      aria-selected={selected}
      onClick={onSelect}
      className={`group relative flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors cursor-pointer ${
        selected
          ? 'bg-raised text-ink shadow-sm ring-1 ring-edge-focus'
          : 'bg-transparent text-ink hover:bg-w04'
      }`}
    >
      {/* Line 1: Status Dot + Title + Duration */}
      <div className="flex items-center gap-2">
        <StatusDot state={statusDotState(recording.syncStatus)} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {recording.title}
        </span>
        <span className="shrink-0 font-mono text-2xs text-ink-quiet">
          {formatDuration(recording.durationSeconds)}
        </span>
      </div>

      {/* Line 2: Status Label · Short App + Timestamp */}
      <div className="flex items-center justify-between gap-2 pl-3.5 text-2xs">
        <span className="min-w-0 flex-1 truncate">
          <span
            className={
              recording.syncStatus === 'FAILED'
                ? 'text-err-text font-medium'
                : recording.syncStatus === 'SYNCED'
                  ? 'text-ok-text font-medium'
                  : recording.syncStatus === 'READY_FOR_REVIEW'
                    ? 'text-warn-text font-medium'
                    : 'text-ink-secondary'
            }
          >
            {presentation.label}
          </span>
          {appLabel && <span className="text-ink-quiet"> · {appLabel}</span>}
        </span>

        <span className="shrink-0 text-ink-quiet">{formatTimestamp(recording.createdAt)}</span>
      </div>

      {/* Active Progress Bar (only while actively uploading/encoding/transcribing) */}
      {isBusy && (
        <div className="pt-1 pl-3.5">
          <Progress
            size="thin"
            value={
              recording.syncStatus === 'UPLOADING'
                ? recording.uploadProgress ?? 5
                : recording.syncStatus === 'ENCODING'
                  ? 25
                  : recording.syncStatus === 'TRANSCRIBING'
                    ? 65
                    : 88
            }
            max={100}
            label={`${recording.title} sync progress`}
          />
        </div>
      )}
    </button>
  )
}
