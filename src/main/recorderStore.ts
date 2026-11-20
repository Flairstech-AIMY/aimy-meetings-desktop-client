import { app } from 'electron'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, extname, join } from 'path'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CreateRecordingInput,
  type RecordingItem,
  type UpdateRecordingPatch
} from '@shared/types'
import { enhanceAndEncodeToMp3 } from './audioEnhancer'

const SUPPORTED_DIRECT_EXTS = new Set(['.mp3', '.wav', '.m4a', '.mp4', '.mov'])

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'audio/webm'
    default:
      return 'application/octet-stream'
  }
}

export class RecorderStore {
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private recordings: RecordingItem[] = []
  private recordingListeners = new Set<(items: RecordingItem[]) => void>()
  private settingsListeners = new Set<(settings: AppSettings) => void>()

  constructor() {
    this.ensureDirs()
    this.load()
  }

  private get dataDir(): string {
    return app.getPath('userData')
  }

  get recordingsDir(): string {
    return join(this.dataDir, 'recordings')
  }

  private get recordingsDbPath(): string {
    return join(this.dataDir, 'recordings.json')
  }

  private get settingsPath(): string {
    return join(this.dataDir, 'settings.json')
  }

  private ensureDirs(): void {
    mkdirSync(this.recordingsDir, { recursive: true })
  }

  private load(): void {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<AppSettings>
        this.settings = { ...DEFAULT_SETTINGS, ...raw }
        let migrated = false
        if (this.settings.defaultIsPersonal !== true) {
          this.settings.defaultIsPersonal = true
          migrated = true
        }
        if (this.settings.defaultLifecycle !== 'draft') {
          this.settings.defaultLifecycle = 'draft'
          migrated = true
        }
        if (migrated) {
          this.saveSettings()
        }
      }
    } catch (err) {
      console.error('[Store] Failed to load settings:', err)
    }

    try {
      if (existsSync(this.recordingsDbPath)) {
        const raw = JSON.parse(readFileSync(this.recordingsDbPath, 'utf8')) as RecordingItem[]
        if (Array.isArray(raw)) {
          // Recover any recordings interrupted mid-recording or mid-upload on crash/restart
          this.recordings = raw.map((item) => {
            const enforcedDefaults = !item.aimyDocId
              ? { isPersonal: true, lifecycle: 'draft' as const }
              : {
                  isPersonal: item.isPersonal ?? true,
                  lifecycle: item.lifecycle ?? ('draft' as const)
                }
            if (item.syncStatus === 'UPLOADING' || item.syncStatus === 'ENCODING') {
              return { ...item, ...enforcedDefaults, syncStatus: 'LOCAL_PENDING', uploadProgress: 0 }
            }
            if (item.syncStatus === 'RECORDING') {
              return item.audioPath && existsSync(item.audioPath)
                ? { ...item, ...enforcedDefaults, syncStatus: 'LOCAL_PENDING' }
                : {
                    ...item,
                    ...enforcedDefaults,
                    syncStatus: 'FAILED',
                    error: 'Recording was interrupted before saving audio.'
                  }
            }
            return { ...item, ...enforcedDefaults }
          })
        }
      }
    } catch (err) {
      console.error('[Store] Failed to load recordings:', err)
    }
  }

  private saveRecordings(): void {
    this.ensureDirs()
    writeFileSync(this.recordingsDbPath, JSON.stringify(this.recordings, null, 2), 'utf8')
    const snapshot = this.listRecordings()
    for (const listener of this.recordingListeners) {
      listener(snapshot)
    }
  }

  private saveSettings(): void {
    this.ensureDirs()
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8')
    const snapshot = this.getSettings()
    for (const listener of this.settingsListeners) {
      listener(snapshot)
    }
  }

  onRecordingsChange(listener: (items: RecordingItem[]) => void): () => void {
    this.recordingListeners.add(listener)
    return () => this.recordingListeners.delete(listener)
  }

  onSettingsChange(listener: (settings: AppSettings) => void): () => void {
    this.settingsListeners.add(listener)
    return () => this.settingsListeners.delete(listener)
  }

  getSettings(): AppSettings {
    return {
      ...this.settings,
      defaultIsPersonal: true,
      defaultLifecycle: 'draft'
    }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      defaultIsPersonal: true,
      defaultLifecycle: 'draft'
    }
    this.saveSettings()
    return this.getSettings()
  }

  listRecordings(): RecordingItem[] {
    return [...this.recordings].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }

  getRecording(id: string): RecordingItem | undefined {
    return this.recordings.find((r) => r.id === id)
  }

  createRecordingEntry(input: CreateRecordingInput): RecordingItem {
    const now = new Date().toISOString()
    const item: RecordingItem = {
      id: randomUUID(),
      title: input.title.trim() || `Meeting ${new Date().toLocaleString()}`,
      createdAt: now,
      updatedAt: now,
      durationSeconds: 0,
      meetingApp: input.meetingApp ?? 'Manual',
      meetingWindowTitle: input.meetingWindowTitle ?? null,
      audioPath: null,
      audioFileName: null,
      audioMimeType: null,
      fileSizeBytes: null,
      notes: input.notes ?? '',
      syncStatus: 'RECORDING',
      uploadProgress: 0,
      uploadMode: input.uploadMode ?? this.settings.defaultUploadMode,
      groupId: input.groupId !== undefined ? input.groupId : this.settings.defaultGroupId,
      groupName: input.groupName ?? null,
      agentIds: input.agentIds ?? [...this.settings.defaultAgentIds],
      isPersonal: true,
      lifecycle: 'draft',
      aimyDocId: null,
      aimyDocumentUrl: null,
      aimyProcessingStatus: null,
      aimySummary: null,
      aimyTranscript: null,
      lastSyncedAt: null,
      error: null
    }
    this.recordings.unshift(item)
    this.saveRecordings()
    return item
  }

  patchRecording(id: string, patch: Partial<RecordingItem>): RecordingItem {
    const idx = this.recordings.findIndex((r) => r.id === id)
    if (idx === -1) throw new Error(`Recording not found: ${id}`)
    const updated: RecordingItem = {
      ...this.recordings[idx],
      ...patch,
      updatedAt: new Date().toISOString()
    }
    this.recordings[idx] = updated
    this.saveRecordings()
    return updated
  }

  updateRecordingMetadata(id: string, patch: UpdateRecordingPatch): RecordingItem {
    const { isPersonal: _ignorePersonal, lifecycle: _ignoreLifecycle, ...allowedPatch } = patch
    return this.patchRecording(id, allowedPatch)
  }

  deleteRecording(id: string): void {
    const existing = this.getRecording(id)
    if (existing?.audioPath && existsSync(existing.audioPath)) {
      try {
        unlinkSync(existing.audioPath)
      } catch {
        // ignore file removal error
      }
    }
    this.recordings = this.recordings.filter((r) => r.id !== id)
    this.saveRecordings()
  }

  async checkFfmpegAvailable(): Promise<boolean> {
    try {
      await execFileAsync('ffmpeg', ['-version'])
      return true
    } catch {
      return false
    }
  }

  async probeDurationSeconds(filePath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath
      ])
      const parsed = Number.parseFloat(stdout.trim())
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
    } catch {
      return 0
    }
  }

  async saveCapturedAudio(
    id: string,
    audioBytes: Uint8Array,
    inputExt: string,
    durationSeconds: number,
    notes?: string
  ): Promise<RecordingItem> {
    this.ensureDirs()
    const normalizedExt = inputExt.startsWith('.') ? inputExt.toLowerCase() : `.${inputExt.toLowerCase()}`
    const rawPath = join(this.recordingsDir, `${id}${normalizedExt}`)
    writeFileSync(rawPath, Buffer.from(audioBytes))

    this.patchRecording(id, {
      syncStatus: 'ENCODING',
      durationSeconds: Math.max(1, Math.round(durationSeconds)),
      ...(notes !== undefined ? { notes } : {})
    })

    let finalPath = rawPath
    let finalExt = normalizedExt
    let audioEnhanced = false
    let enhancementEngine: string | null = null

    const shouldEnhance = this.settings.enhanceAudio
    const hasFfmpeg = await this.checkFfmpegAvailable()

    if (hasFfmpeg && (!SUPPORTED_DIRECT_EXTS.has(normalizedExt) || shouldEnhance)) {
      const mp3Path = join(this.recordingsDir, `${id}.mp3`)
      const tempOutPath = mp3Path === rawPath ? join(this.recordingsDir, `${id}.enhanced.mp3`) : mp3Path
      try {
        const res = await enhanceAndEncodeToMp3(rawPath, tempOutPath, shouldEnhance)
        if (existsSync(tempOutPath) && statSync(tempOutPath).size > 0) {
          if (tempOutPath !== rawPath) {
            try {
              unlinkSync(rawPath)
            } catch {
              // ignore cleanup failure
            }
          }
          if (tempOutPath !== mp3Path) {
            copyFileSync(tempOutPath, mp3Path)
            unlinkSync(tempOutPath)
          }
          finalPath = mp3Path
          finalExt = '.mp3'
          audioEnhanced = res.enhanced
          enhancementEngine = res.engine
        }
      } catch (err) {
        console.error('[Store] Audio enhancement/transcode failed, keeping raw file:', err)
      }
    }

    const stats = statSync(finalPath)
    const probed = durationSeconds > 0 ? Math.round(durationSeconds) : await this.probeDurationSeconds(finalPath)

    return this.patchRecording(id, {
      audioPath: finalPath,
      audioFileName: basename(finalPath),
      audioMimeType: mimeForExt(finalExt),
      fileSizeBytes: stats.size,
      durationSeconds: probed,
      audioEnhanced,
      enhancementEngine,
      syncStatus: 'LOCAL_PENDING',
      error: null
    })
  }

  async enhanceExistingRecording(id: string): Promise<RecordingItem> {
    const existing = this.getRecording(id)
    if (!existing) throw new Error(`Recording not found: ${id}`)
    if (!existing.audioPath || !existsSync(existing.audioPath)) {
      throw new Error('Local audio file is missing on disk.')
    }
    if (!(await this.checkFfmpegAvailable())) {
      throw new Error('FFmpeg is required to enhance audio.')
    }

    const prevStatus = existing.syncStatus
    this.patchRecording(id, { syncStatus: 'ENCODING', error: null })

    const outPath = join(this.recordingsDir, `${id}.enhanced.mp3`)
    const finalPath = join(this.recordingsDir, `${id}.mp3`)
    try {
      const res = await enhanceAndEncodeToMp3(existing.audioPath, outPath, true)
      if (!existsSync(outPath) || statSync(outPath).size === 0) {
        throw new Error('Audio enhancement produced an empty file.')
      }
      if (existing.audioPath !== finalPath && existsSync(existing.audioPath)) {
        try {
          unlinkSync(existing.audioPath)
        } catch {
          // ignore
        }
      }
      copyFileSync(outPath, finalPath)
      unlinkSync(outPath)

      const stats = statSync(finalPath)
      const probed = existing.durationSeconds > 0
        ? existing.durationSeconds
        : await this.probeDurationSeconds(finalPath)

      return this.patchRecording(id, {
        audioPath: finalPath,
        audioFileName: basename(finalPath),
        audioMimeType: 'audio/mpeg',
        fileSizeBytes: stats.size,
        durationSeconds: probed,
        audioEnhanced: res.enhanced,
        enhancementEngine: res.engine,
        syncStatus: prevStatus === 'SYNCED' ? 'SYNCED' : 'LOCAL_PENDING',
        error: null
      })
    } catch (err) {
      this.patchRecording(id, {
        syncStatus: prevStatus === 'ENCODING' ? 'LOCAL_PENDING' : prevStatus,
        error: err instanceof Error ? err.message : 'Audio enhancement failed.'
      })
      throw err
    }
  }

  async importLocalFile(sourcePath: string): Promise<RecordingItem> {
    this.ensureDirs()
    const srcExt = extname(sourcePath).toLowerCase() || '.mp3'
    const baseName = basename(sourcePath, srcExt)
    const entry = this.createRecordingEntry({
      title: baseName.replace(/[_-]+/g, ' ').trim() || 'Imported Recording',
      meetingApp: 'Imported Audio'
    })

    let destPath = join(this.recordingsDir, `${entry.id}${srcExt}`)
    copyFileSync(sourcePath, destPath)
    let finalExt = srcExt
    let audioEnhanced = false
    let enhancementEngine: string | null = null

    const shouldEnhance = this.settings.enhanceAudio
    if ((!SUPPORTED_DIRECT_EXTS.has(srcExt) || shouldEnhance) && (await this.checkFfmpegAvailable())) {
      this.patchRecording(entry.id, { syncStatus: 'ENCODING' })
      const mp3Path = join(this.recordingsDir, `${entry.id}.mp3`)
      const tempOut = mp3Path === destPath ? join(this.recordingsDir, `${entry.id}.enhanced.mp3`) : mp3Path
      try {
        const res = await enhanceAndEncodeToMp3(destPath, tempOut, shouldEnhance)
        if (existsSync(tempOut) && statSync(tempOut).size > 0) {
          if (tempOut !== destPath) {
            unlinkSync(destPath)
          }
          if (tempOut !== mp3Path) {
            copyFileSync(tempOut, mp3Path)
            unlinkSync(tempOut)
          }
          destPath = mp3Path
          finalExt = '.mp3'
          audioEnhanced = res.enhanced
          enhancementEngine = res.engine
        }
      } catch (err) {
        console.error('[Store] Failed to enhance/transcode imported file:', err)
      }
    }

    const stats = statSync(destPath)
    const durationSeconds = await this.probeDurationSeconds(destPath)

    return this.patchRecording(entry.id, {
      audioPath: destPath,
      audioFileName: basename(destPath),
      audioMimeType: mimeForExt(finalExt),
      fileSizeBytes: stats.size,
      durationSeconds,
      audioEnhanced,
      enhancementEngine,
      syncStatus: 'LOCAL_PENDING',
      error: null
    })
  }
}
