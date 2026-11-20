import { createReadStream, statSync } from 'fs'
import http from 'http'
import https from 'https'
import { basename, extname } from 'path'
import type { AimyAgent, AimyDocumentType, AimyGroup } from '@shared/types'

export interface RemoteAimyDocument {
  doc_id: number
  doc_name: string
  title?: string | null
  type?: string | null
  summary?: string | null
  body?: string | null
  processing_status?: string | null
  lifecycle_status?: string | null
  lifecycle?: string | null
  is_personal?: boolean | null
  last_error?: string | null
  group_id?: number | null
  group_name?: string | null
  updated_at?: string | null
  ingested_at?: string | null
}

export interface UploadAudioOptions {
  filePath: string
  fileName?: string
  groupId: number
  name: string
  agentIds?: number[]
  isPersonal?: boolean
  lifecycle?: 'published' | 'draft'
  forceReplace?: boolean
  allowDuplicate?: boolean
  onProgress?: (percent: number) => void
}

export interface CreateJsonDocOptions {
  groupId: number
  title: string
  body: string
  type?: string
  agentIds?: number[]
  isPersonal?: boolean
  lifecycle?: 'published' | 'draft'
  forceReplace?: boolean
  allowDuplicate?: boolean
}

function guessAudioMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
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
    case '.ogg':
      return 'audio/ogg'
    case '.webm':
      return 'audio/webm'
    default:
      return 'application/octet-stream'
  }
}

export function sanitizeDocName(raw: string): string {
  const stripped = raw.replace(/\.(mp3|wav|m4a|mp4|mov|webm|pdf|txt|md)$/i, '')
  const cleaned = stripped.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return cleaned || `meeting_${Date.now()}`
}

export function buildAimyDocumentUrl(consoleBaseUrl: string, docId: number): string {
  const base = consoleBaseUrl.replace(/\/$/, '')
  return `${base}/console?doc=${encodeURIComponent(String(docId))}`
}

export class AimyApiError extends Error {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'AimyApiError'
    this.status = status
    this.detail = detail
  }
}

export class AimyApiClient {
  constructor(
    private getBaseUrl: () => string,
    private getToken: () => Promise<string | null>
  ) {}

  private async requireToken(): Promise<string> {
    const token = await this.getToken()
    if (!token) {
      throw new AimyApiError(401, 'Not signed in to AiMY Knowledge. Please sign in first.')
    }
    return token
  }

  private url(path: string): string {
    return `${this.getBaseUrl().replace(/\/$/, '')}${path}`
  }

  private async jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.requireToken()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined)
    }
    if (init.body && typeof init.body === 'string' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }

    const res = await fetch(this.url(path), { ...init, headers })
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    if (!res.ok) {
      const detail =
        (data && typeof data === 'object' && 'detail' in data && typeof (data as { detail: unknown }).detail === 'string'
          ? (data as { detail: string }).detail
          : typeof data === 'string' && data
            ? data
            : `HTTP ${res.status} ${res.statusText}`)
      throw new AimyApiError(res.status, detail)
    }
    return data as T
  }

  async listGroups(): Promise<AimyGroup[]> {
    return this.jsonRequest<AimyGroup[]>('/list_groups')
  }

  async listAgents(groupId: number): Promise<AimyAgent[]> {
    return this.jsonRequest<AimyAgent[]>(`/agents?group_id=${encodeURIComponent(String(groupId))}`)
  }

  async listDocumentTypes(): Promise<AimyDocumentType[]> {
    return this.jsonRequest<AimyDocumentType[]>('/v2/document-types')
  }

  async createJsonDocument(opts: CreateJsonDocOptions): Promise<{ documentId: number; raw: unknown }> {
    const data = await this.jsonRequest<Record<string, unknown>>('/processing/json', {
      method: 'POST',
      body: JSON.stringify({
        group_id: opts.groupId,
        type: opts.type ?? 'article',
        title: opts.title,
        body: opts.body,
        type_fields: {},
        agent_ids: opts.agentIds ?? [],
        is_personal: opts.isPersonal ?? true,
        force_replace: opts.forceReplace ?? false,
        allow_duplicate: opts.allowDuplicate ?? true,
        lifecycle: opts.lifecycle ?? 'draft'
      })
    })
    const docId = Number(data?.document_id ?? data?.doc_id ?? data?.id)
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new Error('AiMY API succeeded but did not return a document_id.')
    }
    return { documentId: docId, raw: data }
  }

  async uploadAudioRecording(opts: UploadAudioOptions): Promise<{ documentId: number; status: number; raw: unknown }> {
    const token = await this.requireToken()
    const fileName = opts.fileName || basename(opts.filePath)
    const inputsPayload = {
      group_id: opts.groupId,
      name: sanitizeDocName(opts.name || fileName),
      type: 'audio-recording',
      agent_ids: opts.agentIds ?? [],
      is_personal: opts.isPersonal ?? true,
      force_replace: opts.forceReplace ?? false,
      allow_duplicate: opts.allowDuplicate ?? true,
      body_edited: false,
      lifecycle: opts.lifecycle ?? 'draft',
      type_fields: {}
    }

    try {
      return await this.streamMultipartUpload(
        '/processing/audio',
        token,
        opts.filePath,
        fileName,
        { inputs: JSON.stringify(inputsPayload) },
        opts.onProgress
      )
    } catch (err) {
      if (err instanceof AimyApiError && (err.status === 404 || err.status === 405)) {
        return this.streamMultipartUpload(
          '/processing',
          token,
          opts.filePath,
          fileName,
          { inputs: JSON.stringify(inputsPayload) },
          opts.onProgress
        )
      }
      throw err
    }
  }

  async transcribeVoiceClip(filePath: string): Promise<string> {
    const token = await this.requireToken()
    const res = await this.streamMultipartUploadRaw(
      '/v2/voice/transcriptions',
      token,
      filePath,
      basename(filePath),
      {}
    )
    const text = (res.data as { text?: string } | null)?.text
    if (typeof text !== 'string') {
      throw new Error('Transcription response did not contain text.')
    }
    return text
  }

  async indexDocument(docId: number): Promise<Record<string, unknown>> {
    return this.jsonRequest<Record<string, unknown>>(`/v2/documents/${docId}/index`, {
      method: 'POST'
    })
  }

  async getDocumentsByIds(docIds: number[], includeBody = true): Promise<Map<number, RemoteAimyDocument>> {
    const map = new Map<number, RemoteAimyDocument>()
    if (docIds.length === 0) return map

    const params = new URLSearchParams()
    for (const id of docIds) {
      params.append('ids', String(id))
    }
    if (includeBody) params.set('include_body', 'true')
    params.set('page', '1')
    params.set('page_size', String(Math.min(100, Math.max(20, docIds.length))))

    const res = await this.jsonRequest<{ items?: RemoteAimyDocument[] }>(
      `/retrieve_docs_by_group_id/all?${params.toString()}`
    )
    for (const item of res?.items ?? []) {
      map.set(item.doc_id, item)
    }

    // Check personal documents for any IDs not returned in shared group scope
    const missing = docIds.filter((id) => !map.has(id))
    if (missing.length > 0) {
      try {
        const personal = await this.jsonRequest<{ items?: RemoteAimyDocument[] }>(
          `/retrieve_docs/personal?page=1&page_size=100`
        )
        for (const item of personal?.items ?? []) {
          if (missing.includes(item.doc_id)) {
            map.set(item.doc_id, item)
          }
        }
      } catch {
        // Ignore personal lookup failure if endpoint is restricted
      }
    }

    return map
  }

  private async streamMultipartUpload(
    path: string,
    token: string,
    filePath: string,
    fileName: string,
    fields: Record<string, string>,
    onProgress?: (percent: number) => void
  ): Promise<{ documentId: number; status: number; raw: unknown }> {
    const { status, data } = await this.streamMultipartUploadRaw(
      path,
      token,
      filePath,
      fileName,
      fields,
      onProgress
    )
    const record = data as Record<string, unknown> | null
    const docId = Number(record?.document_id ?? record?.doc_id ?? record?.id)
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new Error(`Upload succeeded (HTTP ${status}) but response had no document_id.`)
    }
    return { documentId: docId, status, raw: data }
  }

  private streamMultipartUploadRaw(
    path: string,
    token: string,
    filePath: string,
    fileName: string,
    fields: Record<string, string>,
    onProgress?: (percent: number) => void
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(this.url(path))
      const boundary = `----AimyMeetingsBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
      const mimeType = guessAudioMime(filePath)
      const safeFileName = fileName.replace(/"/g, '_')
      const fileSize = statSync(filePath).size

      const fieldChunks: Buffer[] = []
      for (const [key, value] of Object.entries(fields)) {
        fieldChunks.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
            'utf8'
          )
        )
      }
      const fileHeader = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
        'utf8'
      )
      const closing = Buffer.from(`\r\n--${boundary}--`, 'utf8')

      const fieldsBuf = Buffer.concat(fieldChunks)
      const totalLength = fieldsBuf.length + fileHeader.length + fileSize + closing.length

      const transport = targetUrl.protocol === 'https:' ? https : http
      const req = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || undefined,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(totalLength)
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const rawText = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown = null
            try {
              parsed = rawText ? JSON.parse(rawText) : null
            } catch {
              parsed = rawText
            }
            const status = res.statusCode ?? 0
            if (status >= 200 && status < 300) {
              onProgress?.(100)
              resolve({ status, data: parsed })
            } else {
              const detail =
                parsed &&
                typeof parsed === 'object' &&
                'detail' in parsed &&
                typeof (parsed as { detail: unknown }).detail === 'string'
                  ? (parsed as { detail: string }).detail
                  : typeof parsed === 'string' && parsed
                    ? parsed
                    : `Upload failed with HTTP ${status}`
              reject(new AimyApiError(status, detail))
            }
          })
        }
      )

      req.on('error', (err) => reject(err))

      let uploadedBytes = 0
      let lastPercent = -1
      const report = (delta: number): void => {
        uploadedBytes += delta
        const pct = Math.min(99, Math.round((uploadedBytes / totalLength) * 100))
        if (pct !== lastPercent) {
          lastPercent = pct
          onProgress?.(pct)
        }
      }

      if (fieldsBuf.length > 0) {
        req.write(fieldsBuf)
        report(fieldsBuf.length)
      }
      req.write(fileHeader)
      report(fileHeader.length)

      const fileStream = createReadStream(filePath)
      fileStream.on('data', (chunk: Buffer | string) => {
        report(Buffer.byteLength(chunk))
      })
      fileStream.on('error', (err) => {
        req.destroy(err)
        reject(err)
      })
      fileStream.on('end', () => {
        req.end(closing)
      })
      fileStream.pipe(req, { end: false })
    })
  }
}
