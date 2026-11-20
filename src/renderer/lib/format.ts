import type { RecordingItem, RecordingSyncStatus } from '@shared/types'

export type DashboardTab = 'all' | 'synced' | 'in_progress' | 'left_to_sync'

export function isSyncedStatus(status: RecordingSyncStatus): boolean {
  return status === 'SYNCED'
}

export function isInProgressStatus(status: RecordingSyncStatus): boolean {
  return (
    status === 'RECORDING' ||
    status === 'ENCODING' ||
    status === 'UPLOADING' ||
    status === 'TRANSCRIBING' ||
    status === 'INDEXING'
  )
}

export function isLeftToSyncStatus(status: RecordingSyncStatus): boolean {
  return (
    status === 'LOCAL_PENDING' ||
    status === 'READY_FOR_REVIEW' ||
    status === 'FAILED'
  )
}

export function filterRecordingsByTab(items: RecordingItem[], tab: DashboardTab): RecordingItem[] {
  switch (tab) {
    case 'synced':
      return items.filter((r) => isSyncedStatus(r.syncStatus))
    case 'in_progress':
      return items.filter((r) => isInProgressStatus(r.syncStatus))
    case 'left_to_sync':
      return items.filter((r) => isLeftToSyncStatus(r.syncStatus))
    default:
      return items
  }
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatTimestamp(iso?: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function statusPresentation(item: RecordingItem): {
  workState: 'detected' | 'drafted' | 'staged' | 'completed' | 'failed'
  label: string
  cardStatus?: 'ok' | 'warn' | 'err'
  summaryHint: string
} {
  switch (item.syncStatus) {
    case 'RECORDING':
      return {
        workState: 'detected',
        label: 'Recording',
        summaryHint: 'Capturing live meeting audio'
      }
    case 'ENCODING':
      return {
        workState: 'drafted',
        label: 'Enhancing & encoding',
        summaryHint: 'Running DeepFilterNet3 noise cancellation and encoding to MP3'
      }
    case 'LOCAL_PENDING':
      return {
        workState: 'staged',
        label: 'Waiting to sync',
        cardStatus: 'warn',
        summaryHint: 'Saved locally — ready to upload to AiMY Knowledge'
      }
    case 'UPLOADING':
      return {
        workState: 'drafted',
        label: `Uploading ${item.uploadProgress ?? 0}%`,
        summaryHint: 'Uploading recording to AiMY Knowledge'
      }
    case 'TRANSCRIBING':
      return {
        workState: 'drafted',
        label: 'Transcribing in AiMY',
        summaryHint: 'Uploaded — AiMY is generating the transcript in the background'
      }
    case 'READY_FOR_REVIEW':
      return {
        workState: 'staged',
        label: 'Ready for review',
        cardStatus: 'warn',
        summaryHint: 'Transcription finished — review or add to AiMY Knowledge'
      }
    case 'INDEXING':
      return {
        workState: 'drafted',
        label: 'Adding to knowledge',
        summaryHint: 'Indexing transcript into AiMY Knowledge'
      }
    case 'SYNCED':
      return {
        workState: 'completed',
        label: 'Synced',
        cardStatus: 'ok',
        summaryHint: 'Indexed and searchable in AiMY Knowledge'
      }
    case 'FAILED':
      return {
        workState: 'failed',
        label: 'Sync failed',
        cardStatus: 'err',
        summaryHint: item.error || 'Upload or transcription failed — retry when ready'
      }
  }
}
