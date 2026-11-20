import { Notification, shell } from 'electron'
import { existsSync } from 'fs'
import type { RecordingItem } from '@shared/types'
import { AimyApiClient, AimyApiError, buildAimyDocumentUrl, isNetworkError } from './aimyApi'
import { getAppIconPng } from './appIcons'
import { RecorderStore } from './recorderStore'

const POLL_INTERVAL_MS = 6000

export class SyncManager {
  private pollTimer: NodeJS.Timeout | null = null
  private activeUploads = new Set<string>()
  private polling = false

  constructor(
    private store: RecorderStore,
    private api: AimyApiClient,
    private isOnline: () => boolean = () => true,
    private isAuthenticated: () => boolean = () => true
  ) {}

  start(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollInFlightStatuses()
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  async syncRecording(id: string): Promise<RecordingItem> {
    if (this.activeUploads.has(id)) {
      const current = this.store.getRecording(id)
      if (!current) throw new Error('Recording not found')
      return current
    }

    const item = this.store.getRecording(id)
    if (!item) throw new Error(`Recording not found: ${id}`)

    if (!this.isOnline()) {
      return this.store.patchRecording(id, {
        syncStatus: 'LOCAL_PENDING',
        uploadProgress: 0,
        error: 'Offline — saved locally and will sync automatically once connected.'
      })
    }

    if (!this.isAuthenticated()) {
      return this.store.patchRecording(id, {
        syncStatus: 'LOCAL_PENDING',
        uploadProgress: 0,
        error: 'Sign in to AiMY Knowledge to sync this recording.'
      })
    }

    const settings = this.store.getSettings()
    const groupId = item.groupId ?? settings.defaultGroupId
    if (!groupId) {
      return this.store.patchRecording(id, {
        syncStatus: 'FAILED',
        error: 'Select a target AiMY Group first before syncing.'
      })
    }

    this.activeUploads.add(id)
    try {
      this.store.patchRecording(id, {
        groupId,
        syncStatus: 'UPLOADING',
        uploadProgress: 2,
        error: null
      })

      if (item.uploadMode === 'transcript-json') {
        const notesText = item.notes.trim()
        const bodySections: string[] = []
        if (notesText) {
          bodySections.push(`## Meeting Notes\n\n${notesText}`)
        }
        if (bodySections.length === 0 && item.audioPath && existsSync(item.audioPath)) {
          const clipText = await this.api.transcribeVoiceClip(item.audioPath)
          if (clipText.trim()) {
            bodySections.push(`## Transcript\n\n${clipText.trim()}`)
          }
        }
        if (bodySections.length === 0) {
          throw new Error(
            'Add meeting notes or record audio before syncing as a notes document.'
          )
        }

        const formattedBody = [
          `# ${item.title}`,
          '',
          `- **Recorded**: ${new Date(item.createdAt).toLocaleString()}`,
          `- **Source**: ${item.meetingApp || 'AiMY Meetings Desktop'}`,
          `- **Duration**: ${Math.floor(item.durationSeconds / 60)}m ${item.durationSeconds % 60}s`,
          '',
          bodySections.join('\n\n')
        ].join('\n')

        const { documentId } = await this.api.createJsonDocument({
          groupId,
          title: item.title,
          body: formattedBody,
          type: 'article',
          agentIds: item.agentIds,
          isPersonal: item.isPersonal,
          lifecycle: item.lifecycle,
          forceReplace: Boolean(item.aimyDocId)
        })

        const docUrl = buildAimyDocumentUrl(settings.consoleBaseUrl, documentId)
        const updated = this.store.patchRecording(id, {
          aimyDocId: documentId,
          aimyDocumentUrl: docUrl,
          aimyProcessingStatus: 'INGESTED',
          aimyTranscript: formattedBody,
          syncStatus: 'SYNCED',
          uploadProgress: 100,
          lastSyncedAt: new Date().toISOString(),
          error: null
        })
        this.notifySynced(updated)
        return updated
      }

      // Primary mode: Upload audio recording directly to AiMY (/processing/audio -> /processing)
      if (!item.audioPath || !existsSync(item.audioPath)) {
        throw new Error('Local audio file is missing on disk.')
      }

      const { documentId, status } = await this.api.uploadAudioRecording({
        filePath: item.audioPath,
        fileName: item.audioFileName ?? undefined,
        groupId,
        name: item.title,
        agentIds: item.agentIds,
        isPersonal: item.isPersonal,
        lifecycle: item.lifecycle,
        forceReplace: Boolean(item.aimyDocId),
        allowDuplicate: item.isPersonal,
        onProgress: (percent) => {
          this.store.patchRecording(id, { uploadProgress: percent })
        }
      })

      const docUrl = buildAimyDocumentUrl(settings.consoleBaseUrl, documentId)
      const isAsyncRecording = status === 202

      const updated = this.store.patchRecording(id, {
        aimyDocId: documentId,
        aimyDocumentUrl: docUrl,
        aimyProcessingStatus: isAsyncRecording ? 'PROCESSING' : 'INGESTED',
        syncStatus: isAsyncRecording ? 'TRANSCRIBING' : 'SYNCED',
        uploadProgress: 100,
        lastSyncedAt: new Date().toISOString(),
        error: null
      })

      if (!isAsyncRecording) {
        this.notifySynced(updated)
      }
      return updated
    } catch (err) {
      if (isNetworkError(err) || !this.isOnline()) {
        return this.store.patchRecording(id, {
          syncStatus: 'LOCAL_PENDING',
          uploadProgress: 0,
          error: 'Connection interrupted — saved locally and will sync automatically when online.'
        })
      }
      if (err instanceof AimyApiError && err.status === 401) {
        return this.store.patchRecording(id, {
          syncStatus: 'LOCAL_PENDING',
          uploadProgress: 0,
          error: 'Your AiMY session expired — sign in to sync this recording.'
        })
      }
      const message =
        err instanceof AimyApiError
          ? err.detail
          : err instanceof Error
            ? err.message
            : 'Sync failed unexpectedly.'
      return this.store.patchRecording(id, {
        syncStatus: 'FAILED',
        uploadProgress: 0,
        error: message
      })
    } finally {
      this.activeUploads.delete(id)
    }
  }

  async syncAllPending(options?: { auto?: boolean }): Promise<{ started: number }> {
    if (!this.isOnline() || !this.isAuthenticated()) {
      return { started: 0 }
    }

    const settings = this.store.getSettings()
    const auto = Boolean(options?.auto)
    const pending = this.store.listRecordings().filter((r) => {
      if (auto) {
        if (r.syncStatus !== 'LOCAL_PENDING') return false
        return Boolean(r.groupId ?? settings.defaultGroupId)
      }
      return r.syncStatus === 'LOCAL_PENDING' || r.syncStatus === 'FAILED'
    })

    let started = 0
    for (const item of pending) {
      if (this.activeUploads.has(item.id)) continue
      started += 1
      void this.syncRecording(item.id)
    }
    return { started }
  }

  async indexRecording(id: string): Promise<RecordingItem> {
    const item = this.store.getRecording(id)
    if (!item) throw new Error(`Recording not found: ${id}`)
    if (!item.aimyDocId) throw new Error('This recording has not been uploaded to AiMY yet.')

    this.store.patchRecording(id, { syncStatus: 'INDEXING', error: null })
    try {
      await this.api.indexDocument(item.aimyDocId)
      const updated = this.store.patchRecording(id, {
        syncStatus: 'SYNCED',
        aimyProcessingStatus: 'INGESTED',
        lastSyncedAt: new Date().toISOString(),
        error: null
      })
      this.notifySynced(updated)
      return updated
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add recording to knowledge.'
      return this.store.patchRecording(id, {
        syncStatus: 'READY_FOR_REVIEW',
        error: message
      })
    }
  }

  async refreshRecordingStatus(id: string): Promise<RecordingItem> {
    const item = this.store.getRecording(id)
    if (!item) throw new Error(`Recording not found: ${id}`)
    if (!item.aimyDocId) return item

    const docs = await this.api.getDocumentsByIds([item.aimyDocId], true)
    const remote = docs.get(item.aimyDocId)
    if (!remote) return item
    return this.applyRemoteStatus(item, remote)
  }

  async refreshAllStatuses(): Promise<RecordingItem[]> {
    await this.pollInFlightStatuses(true)
    return this.store.listRecordings()
  }

  private async pollInFlightStatuses(includeSyncedWithoutBody = false): Promise<void> {
    if (this.polling) return
    if (!this.isOnline() || !this.isAuthenticated()) return
    const candidates = this.store.listRecordings().filter((r) => {
      if (!r.aimyDocId) return false
      if (r.syncStatus === 'TRANSCRIBING' || r.syncStatus === 'READY_FOR_REVIEW') return true
      if (includeSyncedWithoutBody && r.syncStatus === 'SYNCED' && !r.aimySummary) return true
      return false
    })
    if (candidates.length === 0) return

    this.polling = true
    try {
      const docIds = candidates.map((c) => c.aimyDocId!).filter((id) => id > 0)
      const remoteMap = await this.api.getDocumentsByIds(docIds, true)
      for (const item of candidates) {
        const remote = item.aimyDocId ? remoteMap.get(item.aimyDocId) : undefined
        if (remote) {
          await this.applyRemoteStatus(item, remote)
        }
      }
    } catch (err) {
      // Quietly ignore polling errors (offline / expired token)
      console.debug('[Sync] Poll skipped:', err instanceof Error ? err.message : err)
    } finally {
      this.polling = false
    }
  }

  private async applyRemoteStatus(
    item: RecordingItem,
    remote: {
      processing_status?: string | null
      lifecycle_status?: string | null
      lifecycle?: string | null
      is_personal?: boolean | null
      summary?: string | null
      body?: string | null
      last_error?: string | null
    }
  ): Promise<RecordingItem> {
    const settings = this.store.getSettings()
    const ps = (remote.processing_status || '').toUpperCase()
    const rawLifecycle = (remote.lifecycle_status || remote.lifecycle || '').toLowerCase()
    const syncedLifecycle: 'published' | 'draft' =
      rawLifecycle === 'published'
        ? 'published'
        : rawLifecycle === 'draft'
          ? 'draft'
          : item.lifecycle
    const syncedPersonal =
      typeof remote.is_personal === 'boolean' ? remote.is_personal : item.isPersonal
    const docUrl = item.aimyDocId
      ? buildAimyDocumentUrl(settings.consoleBaseUrl, item.aimyDocId)
      : item.aimyDocumentUrl

    const commonPatch: Partial<RecordingItem> = {
      aimyDocumentUrl: docUrl,
      aimyProcessingStatus: ps || item.aimyProcessingStatus,
      aimySummary: remote.summary ?? item.aimySummary,
      aimyTranscript: remote.body ?? item.aimyTranscript,
      lifecycle: syncedLifecycle,
      isPersonal: syncedPersonal
    }

    if (ps === 'INGESTED') {
      const wasSynced = item.syncStatus === 'SYNCED'
      const updated = this.store.patchRecording(item.id, {
        ...commonPatch,
        syncStatus: 'SYNCED',
        lastSyncedAt: new Date().toISOString(),
        error: null
      })
      if (!wasSynced) {
        this.notifySynced(updated)
      }
      return updated
    }

    if (ps === 'READY_FOR_REVIEW') {
      const updated = this.store.patchRecording(item.id, {
        ...commonPatch,
        syncStatus: 'READY_FOR_REVIEW',
        error: remote.last_error ?? null
      })
      if (settings.autoIndexAfterTranscription) {
        return this.indexRecording(item.id)
      }
      return updated
    }

    if (ps === 'FAILED') {
      return this.store.patchRecording(item.id, {
        ...commonPatch,
        syncStatus: 'FAILED',
        error: remote.last_error || 'AiMY failed to transcribe this recording.'
      })
    }

    if (ps === 'PENDING' || ps === 'PULLED' || ps === 'PROCESSING') {
      return this.store.patchRecording(item.id, {
        ...commonPatch,
        syncStatus: 'TRANSCRIBING'
      })
    }

    return this.store.patchRecording(item.id, commonPatch)
  }

  private notifySynced(item: RecordingItem): void {
    if (!Notification.isSupported()) return
    const n = new Notification({
      title: 'Synced to AiMY Knowledge',
      body: `"${item.title}" is ready in AiMY Knowledge. Click to open.`,
      icon: getAppIconPng()
    })
    n.on('click', () => {
      if (item.aimyDocumentUrl) {
        void shell.openExternal(item.aimyDocumentUrl)
      }
    })
    n.show()
  }
}
