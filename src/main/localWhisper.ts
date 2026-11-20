import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from 'fs'
import http from 'http'
import https from 'https'
import net from 'net'
import { cpus, tmpdir } from 'os'
import { join } from 'path'
import type {
  LiveTranscriptSegment,
  WhisperLanguage,
  WhisperModelId,
  WhisperModelStatus
} from '@shared/types'

interface WhisperModelDef {
  id: WhisperModelId
  name: string
  fileName: string
  sizeLabel: string
  sizeBytes: number
  description: string
  url: string
}

const WHISPER_MODELS: WhisperModelDef[] = [
  {
    id: 'egyptian-turbo-q5_0',
    name: 'Whisper Large v3 Turbo — Egyptian AR + EN (Q5)',
    fileName: 'ggml-large-v3-turbo-egyptian-q5_0.bin',
    sizeLabel: '547 MB',
    sizeBytes: 574_041_195,
    description:
      'Fine-tuned for Egyptian Arabic (ar-EG) + English code-switching — writes English words in Latin script inside Egyptian Arabic sentences.',
    url: 'https://huggingface.co/mohammedaly22/whisper-large-v3-turbo-egyptian-code-switching/resolve/main/model.safetensors'
  },
  {
    id: 'large-v3-turbo-q5_0',
    name: 'Whisper Large v3 Turbo — Base (Q5)',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    sizeLabel: '547 MB',
    sizeBytes: 574_041_195,
    description: 'Standard OpenAI Whisper Large v3 Turbo quantized to 5-bit.',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
  },
  {
    id: 'small-q5_1',
    name: 'Whisper Small (Q5)',
    fileName: 'ggml-small-q5_1.bin',
    sizeLabel: '181 MB',
    sizeBytes: 190_085_487,
    description: 'Lightweight fallback model for low-VRAM devices.',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin'
  }
]

const HALLUCINATION_PATTERNS = [
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^[\s.,!?;:\-–—♪♫*]+$/,
  /^(thank you|thanks for watching|subtitles by|subscribe|you)\.?$/i,
  /^(اشتركوا في القناة|ترجمة نانسي|شكرا للمشاهدة|لا تنسوا الاشتراك)\.?$/i
]

// Non-Arabic / non-English scripts that must never appear when locked to en + ar-EG:
// CJK, Hiragana/Katakana, Hangul, Cyrillic, Thai, Devanagari, Hebrew, Greek, or Nordic/Baltic diacritics
const FORBIDDEN_SCRIPT_GLOBAL_RE =
  /[\u0370-\u05FF\u0900-\u0E7F\u1100-\u11FF\u3040-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]|[äöåøæüõÄÖÅØÆÜÕ]/g

const ARABIC_CHAR_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
const LATIN_CHAR_RE = /[A-Za-z]/

export function cleanAndValidateTranscript(
  rawText: string,
  language: WhisperLanguage = 'ar-eg-en'
): string | null {
  // 1. Strip any forbidden foreign scripts (Chinese, Cyrillic, Korean, Hebrew, Nordic diacritics, etc.)
  let cleaned = rawText.replace(FORBIDDEN_SCRIPT_GLOBAL_RE, ' ')

  // 2. Collapse elongated characters repeated 4+ times (e.g. "ايهيييييي" -> "ايهي")
  cleaned = cleaned.replace(/(.)\1{3,}/gu, '$1')

  // 3. Collapse Whisper stuttering dots ("ال .. ال .. ال بتاع" -> "ال بتاع")
  cleaned = cleaned.replace(/(?:\bال\s*\.\.\s*){1,}/gu, '')

  // 4. Collapse 1-to-5-word phrases repeated 3+ times consecutively
  cleaned = cleaned.replace(
    /(\S+(?:\s+\S+){0,4})(?:[\s،,.!؟?\-]+?\1){2,}/gu,
    '$1'
  )

  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  if (cleaned.length < 2) return null
  if (HALLUCINATION_PATTERNS.some((re) => re.test(cleaned))) return null

  const hasArabic = ARABIC_CHAR_RE.test(cleaned)
  const hasLatin = LATIN_CHAR_RE.test(cleaned)
  if (!hasArabic && !hasLatin) return null

  if (language === 'en' && hasArabic) return null
  return cleaned
}

function resolveWhisperLangFlag(language: WhisperLanguage): 'ar' | 'en' {
  if (language === 'en') return 'en'
  // Both 'ar-eg-en', 'ar', and legacy 'auto' use 'ar' on the Egyptian code-switching model
  // so it strictly emits Egyptian Arabic + English Latin script and never runs 99-language guessing
  return 'ar'
}

function execFileAsync(
  cmd: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        env: { ...process.env, OPENBLAS_NUM_THREADS: '1' },
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      }
    )
  })
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Wraps 16kHz 16-bit mono PCM bytes with a standard 44-byte RIFF WAV header in memory. */
function wrapPcm16AsWav(pcm16: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44)
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm16.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm16.length, 40)

  return Buffer.concat([header, pcm16])
}

function resolveWhisperBinary(
  name: 'whisper-server' | 'whisper-cli' | 'whisper-quantize'
): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const roots = [
    join(app.getAppPath(), 'resources', 'bin', 'whisper'),
    join(__dirname, '../../resources/bin/whisper'),
    join(process.resourcesPath, 'bin', 'whisper')
  ]
  for (const root of roots) {
    const direct = join(root, exe)
    if (existsSync(direct)) return direct
    const release = join(root, 'Release', exe)
    if (existsSync(release)) return release
  }
  return null
}

function resolveSileroVadModel(): string | null {
  const file = 'ggml-silero-v5.1.2.bin'
  const candidates = [
    join(app.getAppPath(), 'resources', 'models', file),
    join(__dirname, '../../resources/models', file),
    join(process.resourcesPath, 'models', file),
    join(app.getPath('userData'), 'models', file)
  ]
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).size > 100_000) return p
  }
  return null
}

function downloadWithRedirects(
  urlStr: string,
  destPath: string,
  expectedBytes: number,
  onProgress: (pct: number) => void,
  extraHeaders: Record<string, string> = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestUrl = (currentUrl: string, redirectsLeft: number): void => {
      const parsed = new URL(currentUrl)
      const transport = parsed.protocol === 'https:' ? https : http
      const req = transport.get(
        currentUrl,
        {
          headers: {
            'User-Agent': 'AiMY-Meetings-Desktop/1.0',
            ...extraHeaders
          }
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (
            (status === 301 ||
              status === 302 ||
              status === 303 ||
              status === 307 ||
              status === 308) &&
            res.headers.location
          ) {
            res.resume()
            if (redirectsLeft <= 0) {
              reject(new Error('Too many redirects while downloading Whisper model.'))
              return
            }
            const nextUrl = new URL(res.headers.location, currentUrl).toString()
            requestUrl(nextUrl, redirectsLeft - 1)
            return
          }
          if (status !== 200 && status !== 206) {
            res.resume()
            reject(new Error(`Model download failed with HTTP ${status}`))
            return
          }

          const total = Number(res.headers['content-length']) || expectedBytes
          let downloaded = 0
          let lastPct = -1
          const out = createWriteStream(destPath)

          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length
            const pct = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0
            if (pct !== lastPct) {
              lastPct = pct
              onProgress(pct)
            }
          })
          res.on('error', (err) => {
            out.destroy()
            reject(err)
          })
          out.on('error', (err) => {
            res.destroy()
            reject(err)
          })
          out.on('finish', () => {
            out.close(() => {
              onProgress(100)
              resolve()
            })
          })
          res.pipe(out)
        }
      )
      req.on('error', reject)
    }

    requestUrl(urlStr, 8)
  })
}

function ggmlToHfDecoderName(ggmlName: string): string | null {
  if (ggmlName === 'decoder.positional_embedding') return 'model.decoder.embed_positions.weight'
  if (ggmlName === 'decoder.token_embedding.weight') return 'model.decoder.embed_tokens.weight'
  if (ggmlName === 'decoder.ln.weight') return 'model.decoder.layer_norm.weight'
  if (ggmlName === 'decoder.ln.bias') return 'model.decoder.layer_norm.bias'

  const m = ggmlName.match(/^decoder\.blocks\.(\d+)\.(.+)$/)
  if (!m) return null
  const layer = m[1]
  const rest = m[2]
  const map: Record<string, string> = {
    'attn_ln.weight': 'self_attn_layer_norm.weight',
    'attn_ln.bias': 'self_attn_layer_norm.bias',
    'attn.query.weight': 'self_attn.q_proj.weight',
    'attn.query.bias': 'self_attn.q_proj.bias',
    'attn.key.weight': 'self_attn.k_proj.weight',
    'attn.value.weight': 'self_attn.v_proj.weight',
    'attn.value.bias': 'self_attn.v_proj.bias',
    'attn.out.weight': 'self_attn.out_proj.weight',
    'attn.out.bias': 'self_attn.out_proj.bias',
    'cross_attn_ln.weight': 'encoder_attn_layer_norm.weight',
    'cross_attn_ln.bias': 'encoder_attn_layer_norm.bias',
    'cross_attn.query.weight': 'encoder_attn.q_proj.weight',
    'cross_attn.query.bias': 'encoder_attn.q_proj.bias',
    'cross_attn.key.weight': 'encoder_attn.k_proj.weight',
    'cross_attn.value.weight': 'encoder_attn.v_proj.weight',
    'cross_attn.value.bias': 'encoder_attn.v_proj.bias',
    'cross_attn.out.weight': 'encoder_attn.out_proj.weight',
    'cross_attn.out.bias': 'encoder_attn.out_proj.bias',
    'mlp_ln.weight': 'final_layer_norm.weight',
    'mlp_ln.bias': 'final_layer_norm.bias',
    'mlp.0.weight': 'fc1.weight',
    'mlp.0.bias': 'fc1.bias',
    'mlp.2.weight': 'fc2.weight',
    'mlp.2.bias': 'fc2.bias'
  }
  return map[rest] ? `model.decoder.layers.${layer}.${map[rest]}` : null
}

function bf16BufferToF32Buffer(bf16Buf: Buffer): Buffer {
  const count = bf16Buf.byteLength / 2
  const srcU16 = new Uint16Array(bf16Buf.buffer, bf16Buf.byteOffset, count)
  const dstF32Buf = Buffer.allocUnsafe(count * 4)
  const dstU32 = new Uint32Array(dstF32Buf.buffer, dstF32Buf.byteOffset, count)
  for (let i = 0; i < count; i++) {
    dstU32[i] = srcU16[i] << 16
  }
  return dstF32Buf
}

function getGgmlTensorByteSize(dims: number[], ftype: number): number {
  const ne = dims.reduce((a, b) => a * b, 1)
  if (ftype === 0) return ne * 4
  if (ftype === 1) return ne * 2
  if (ftype === 6 || ftype === 8) return (ne / 32) * 22
  if (ftype === 7 || ftype === 9) return (ne / 32) * 24
  throw new Error(`Unsupported ggml ftype: ${ftype}`)
}

interface ParsedGgmlTensor {
  name: string
  n_dims: number
  dims: number[]
  ftype: number
  totalSlice: Buffer
}

function parseGgmlTensors(buf: Buffer, startOffset: number): ParsedGgmlTensor[] {
  let off = startOffset
  const tensors: ParsedGgmlTensor[] = []
  while (off < buf.length) {
    const hdrStart = off
    const n_dims = buf.readInt32LE(off)
    off += 4
    const name_len = buf.readInt32LE(off)
    off += 4
    const ftype = buf.readInt32LE(off)
    off += 4
    const dims: number[] = []
    for (let d = 0; d < n_dims; d++) {
      dims.push(buf.readInt32LE(off))
      off += 4
    }
    const name = buf.toString('utf8', off, off + name_len)
    off += name_len
    const byteLen = getGgmlTensorByteSize(dims, ftype)
    off += byteLen
    tensors.push({
      name,
      n_dims,
      dims,
      ftype,
      totalSlice: buf.subarray(hdrStart, off)
    })
  }
  return tensors
}

export class LocalWhisperManager {
  private serverProc: ChildProcess | null = null
  private serverPort: number | null = null
  private activeModelId: WhisperModelId | null = null
  private activeLanguage: WhisperLanguage = 'ar-eg-en'
  private downloads = new Map<WhisperModelId, number>()
  private downloadListeners = new Set<(models: WhisperModelStatus[]) => void>()
  private segmentListeners = new Set<(segment: LiveTranscriptSegment) => void>()
  private chunkQueue: Array<{ pcm16: Buffer; atSeconds: number }> = []
  private processingQueue = false

  private get primaryModelsDir(): string {
    const candidates = [
      join(app.getAppPath(), 'resources', 'models'),
      join(__dirname, '../../resources/models'),
      join(process.resourcesPath, 'models')
    ]
    for (const dir of candidates) {
      if (existsSync(dir)) return dir
    }
    const fallback = join(app.getPath('userData'), 'models')
    mkdirSync(fallback, { recursive: true })
    return fallback
  }

  onDownloadProgress(listener: (models: WhisperModelStatus[]) => void): () => void {
    this.downloadListeners.add(listener)
    return () => this.downloadListeners.delete(listener)
  }

  onLiveSegment(listener: (segment: LiveTranscriptSegment) => void): () => void {
    this.segmentListeners.add(listener)
    return () => this.segmentListeners.delete(listener)
  }

  private emitModels(): void {
    const snapshot = this.listModels()
    for (const listener of this.downloadListeners) {
      listener(snapshot)
    }
  }

  private emitSegment(seg: LiveTranscriptSegment): void {
    for (const listener of this.segmentListeners) {
      listener(seg)
    }
  }

  private modelPath(def: WhisperModelDef): string {
    const candidates = [
      join(app.getAppPath(), 'resources', 'models', def.fileName),
      join(__dirname, '../../resources/models', def.fileName),
      join(process.resourcesPath, 'models', def.fileName),
      join(app.getPath('userData'), 'models', def.fileName)
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    return join(this.primaryModelsDir, def.fileName)
  }

  private isModelInstalled(def: WhisperModelDef): boolean {
    const p = this.modelPath(def)
    if (!existsSync(p)) return false
    try {
      return statSync(p).size > def.sizeBytes * 0.85
    } catch {
      return false
    }
  }

  listModels(): WhisperModelStatus[] {
    return WHISPER_MODELS.map((def) => {
      const pct = this.downloads.get(def.id)
      const downloading = pct !== undefined
      return {
        id: def.id,
        name: def.name,
        fileName: def.fileName,
        sizeLabel: def.sizeLabel,
        sizeBytes: def.sizeBytes,
        description: def.description,
        installed: !downloading && this.isModelInstalled(def),
        downloading,
        downloadProgress: pct ?? 0
      }
    })
  }

  async downloadModel(modelId: WhisperModelId): Promise<WhisperModelStatus[]> {
    const def = WHISPER_MODELS.find((m) => m.id === modelId)
    if (!def) throw new Error(`Unknown Whisper model: ${modelId}`)
    if (this.downloads.has(modelId)) return this.listModels()

    const finalPath = join(this.primaryModelsDir, def.fileName)
    const partPath = `${finalPath}.part`
    this.downloads.set(modelId, 0)
    this.emitModels()

    try {
      if (modelId === 'egyptian-turbo-q5_0') {
        await this.buildEgyptianCodeSwitchingModel(finalPath, (pct) => {
          this.downloads.set(modelId, pct)
          this.emitModels()
        })
      } else {
        await downloadWithRedirects(def.url, partPath, def.sizeBytes, (pct) => {
          this.downloads.set(modelId, pct)
          this.emitModels()
        })
        if (existsSync(finalPath)) unlinkSync(finalPath)
        renameSync(partPath, finalPath)
      }
    } catch (err) {
      if (existsSync(partPath)) {
        try {
          unlinkSync(partPath)
        } catch {
          // ignore
        }
      }
      throw err
    } finally {
      this.downloads.delete(modelId)
      this.emitModels()
    }

    return this.listModels()
  }

  private async buildEgyptianCodeSwitchingModel(
    outModelPath: string,
    onProgress: (pct: number) => void
  ): Promise<void> {
    const baseDef = WHISPER_MODELS.find((m) => m.id === 'large-v3-turbo-q5_0')!
    let baseTurboPath = this.modelPath(baseDef)
    if (!this.isModelInstalled(baseDef)) {
      baseTurboPath = join(this.primaryModelsDir, baseDef.fileName)
      await downloadWithRedirects(baseDef.url, baseTurboPath, baseDef.sizeBytes, (pct) =>
        onProgress(Math.round(pct * 0.5))
      )
    } else {
      onProgress(50)
    }

    const slicePath = join(this.primaryModelsDir, 'eg-turbo-decoder.safetensors.slice')
    const decF32Path = join(this.primaryModelsDir, 'eg-dec-f32.bin')
    const decQ5Path = join(this.primaryModelsDir, 'eg-dec-q5_0.bin')
    const quantizeBin = resolveWhisperBinary('whisper-quantize')
    if (!quantizeBin) {
      throw new Error('whisper-quantize binary not found.')
    }

    try {
      await downloadWithRedirects(
        'https://huggingface.co/mohammedaly22/whisper-large-v3-turbo-egyptian-code-switching/resolve/main/model.safetensors',
        slicePath,
        343_887_531,
        (pct) => onProgress(50 + Math.round(pct * 0.4)),
        { Range: 'bytes=0-343887530' }
      )

      onProgress(92)
      const baseBuf = readFileSync(baseTurboPath)
      const HEADER_END = 611057
      const baseHeader = Buffer.from(baseBuf.subarray(0, HEADER_END))
      const baseTensors = parseGgmlTensors(baseBuf, HEADER_END)

      const stBuf = readFileSync(slicePath)
      const stHeaderLen = Number(stBuf.readBigUInt64LE(0))
      const stHeader = JSON.parse(
        stBuf.subarray(8, 8 + stHeaderLen).toString('utf8')
      ) as Record<string, { data_offsets: [number, number] }>
      const stDataOffset = 8 + stHeaderLen

      const f32Header = Buffer.from(baseHeader)
      f32Header.writeInt32LE(0, 44)
      const fd = openSync(decF32Path, 'w')
      writeSync(fd, f32Header)

      for (const t of baseTensors) {
        if (!t.name.startsWith('decoder.')) continue
        const hfName = ggmlToHfDecoderName(t.name)
        if (!hfName || !stHeader[hfName]) {
          throw new Error(`Missing fine-tuned decoder tensor for ${t.name}`)
        }
        const [s, e] = stHeader[hfName].data_offsets
        const f32Data = bf16BufferToF32Buffer(stBuf.subarray(stDataOffset + s, stDataOffset + e))
        const nameBuf = Buffer.from(t.name, 'utf8')
        const tHdr = Buffer.alloc(12 + t.n_dims * 4 + nameBuf.length)
        tHdr.writeInt32LE(t.n_dims, 0)
        tHdr.writeInt32LE(nameBuf.length, 4)
        tHdr.writeInt32LE(0, 8)
        for (let d = 0; d < t.n_dims; d++) {
          tHdr.writeInt32LE(t.dims[d], 12 + d * 4)
        }
        nameBuf.copy(tHdr, 12 + t.n_dims * 4)
        writeSync(fd, tHdr)
        writeSync(fd, f32Data)
      }
      closeSync(fd)

      onProgress(95)
      await execFileAsync(quantizeBin, [decF32Path, decQ5Path, 'q5_0'], join(quantizeBin, '..'))

      onProgress(98)
      const q5DecBuf = readFileSync(decQ5Path)
      const q5Map = new Map(parseGgmlTensors(q5DecBuf, HEADER_END).map((t) => [t.name, t]))

      const outFd = openSync(outModelPath, 'w')
      writeSync(outFd, baseHeader)
      for (const t of baseTensors) {
        if (t.name.startsWith('decoder.')) {
          const qt = q5Map.get(t.name)
          if (!qt) throw new Error(`Missing quantized tensor ${t.name}`)
          writeSync(outFd, qt.totalSlice)
        } else {
          writeSync(outFd, t.totalSlice)
        }
      }
      closeSync(outFd)
      onProgress(100)
    } finally {
      for (const f of [slicePath, decF32Path, decQ5Path]) {
        if (existsSync(f)) {
          try {
            unlinkSync(f)
          } catch {
            // ignore
          }
        }
      }
    }
  }

  deleteModel(modelId: WhisperModelId): WhisperModelStatus[] {
    const def = WHISPER_MODELS.find((m) => m.id === modelId)
    if (!def) return this.listModels()
    if (this.activeModelId === modelId) {
      this.stopLiveServer()
    }
    const p = this.modelPath(def)
    if (existsSync(p)) {
      try {
        unlinkSync(p)
      } catch {
        // ignore
      }
    }
    this.emitModels()
    return this.listModels()
  }

  private pickInstalledModel(preferred: WhisperModelId): WhisperModelDef | null {
    const pref = WHISPER_MODELS.find((m) => m.id === preferred)
    if (pref && this.isModelInstalled(pref)) return pref
    return WHISPER_MODELS.find((m) => this.isModelInstalled(m)) ?? null
  }

  async startLiveServer(
    preferredModel: WhisperModelId,
    language: WhisperLanguage
  ): Promise<{ ready: boolean; reason?: string }> {
    const serverBin = resolveWhisperBinary('whisper-server')
    if (!serverBin) {
      return { ready: false, reason: 'whisper-server binary not found.' }
    }

    const model = this.pickInstalledModel(preferredModel)
    if (!model) {
      return {
        ready: false,
        reason: 'Download a Whisper model in Settings to enable on-device live transcription.'
      }
    }

    if (
      this.serverProc &&
      this.serverPort &&
      this.activeModelId === model.id &&
      this.activeLanguage === language
    ) {
      return { ready: true }
    }

    this.stopLiveServer()
    const port = await getFreePort()
    const vadModel = resolveSileroVadModel()
    const threads = Math.min(4, Math.max(2, Math.floor(cpus().length / 2)))
    const effectiveLang = resolveWhisperLangFlag(language)

    const args = [
      '-m',
      this.modelPath(model),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-dev',
      '0',
      '-t',
      String(threads),
      '-bs',
      '1',
      '-bo',
      '1',
      '-ac',
      '512',
      '-mc',
      '0',
      '-nf',
      '-l',
      effectiveLang,
      '--suppress-nst',
      '--no-timestamps'
    ]
    if (vadModel) {
      args.push(
        '--vad',
        '--vad-model',
        vadModel,
        '--vad-threshold',
        '0.45',
        '--vad-min-speech-duration-ms',
        '220',
        '--vad-min-silence-duration-ms',
        '260'
      )
    }

    const proc = spawn(serverBin, args, {
      cwd: join(serverBin, '..'),
      env: { ...process.env, OPENBLAS_NUM_THREADS: '1' },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    this.serverProc = proc
    this.serverPort = port
    this.activeModelId = model.id
    this.activeLanguage = language

    proc.on('exit', () => {
      if (this.serverProc === proc) {
        this.serverProc = null
        this.serverPort = null
        this.activeModelId = null
      }
    })

    // Poll until whisper-server is listening
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (!this.serverProc || this.serverProc.killed) {
        return { ready: false, reason: 'Local Whisper server stopped unexpectedly.' }
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) })
        if (res.ok || res.status === 404) {
          return { ready: true }
        }
      } catch {
        // still starting up
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    this.stopLiveServer()
    return { ready: false, reason: 'Timed out waiting for local Whisper server.' }
  }

  stopLiveServer(): void {
    this.chunkQueue = []
    this.processingQueue = false
    if (this.serverProc) {
      try {
        this.serverProc.kill()
      } catch {
        // ignore
      }
      this.serverProc = null
    }
    this.serverPort = null
    this.activeModelId = null
  }

  enqueueLiveChunk(pcm16Bytes: Uint8Array, atSeconds: number): void {
    if (!this.serverPort || !this.serverProc || pcm16Bytes.byteLength < 6400) return
    if (this.chunkQueue.length >= 4) {
      this.chunkQueue.shift()
    }
    this.chunkQueue.push({ pcm16: Buffer.from(pcm16Bytes), atSeconds })
    if (!this.processingQueue) {
      void this.drainQueue()
    }
  }

  private async drainQueue(): Promise<void> {
    this.processingQueue = true
    try {
      while (this.chunkQueue.length > 0 && this.serverPort) {
        const next = this.chunkQueue.shift()!
        try {
          const rawText = await this.sendChunkToServer(
            next.pcm16,
            this.serverPort,
            this.activeLanguage
          )
          const cleaned = rawText ? cleanAndValidateTranscript(rawText, this.activeLanguage) : null
          if (cleaned) {
            this.emitSegment({
              id: randomUUID(),
              atSeconds: next.atSeconds,
              text: cleaned
            })
          }
        } catch (err) {
          console.debug(
            '[LocalWhisper] Live chunk skipped:',
            err instanceof Error ? err.message : err
          )
        }
      }
    } finally {
      this.processingQueue = false
    }
  }

  private sendChunkToServer(
    pcm16: Buffer,
    port: number,
    language: WhisperLanguage
  ): Promise<string> {
    const wav = wrapPcm16AsWav(pcm16, 16000)
    const boundary = `----WhisperChunk${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
    const effectiveLang = resolveWhisperLangFlag(language)

    const parts: Buffer[] = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
        'utf8'
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0\r\n`,
        'utf8'
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${effectiveLang}\r\n`,
        'utf8'
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
        'utf8'
      ),
      wav,
      Buffer.from(`\r\n--${boundary}--`, 'utf8')
    ]
    const body = Buffer.concat(parts)

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/inference',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length)
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
              reject(new Error(`whisper-server HTTP ${res.statusCode}: ${raw}`))
              return
            }
            try {
              const parsed = JSON.parse(raw) as { text?: string }
              resolve((parsed.text || '').trim())
            } catch {
              resolve(raw.trim())
            }
          })
        }
      )
      req.setTimeout(25_000, () => {
        req.destroy(new Error('Chunk transcription timed out'))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  async transcribeFile(
    audioPath: string,
    preferredModel: WhisperModelId,
    language: WhisperLanguage
  ): Promise<{ text: string; segments: LiveTranscriptSegment[] }> {
    const cliBin = resolveWhisperBinary('whisper-cli')
    if (!cliBin) {
      throw new Error('whisper-cli binary is missing from resources/bin/whisper.')
    }
    const model = this.pickInstalledModel(preferredModel)
    if (!model) {
      throw new Error('No Whisper model is installed yet. Download one in Settings first.')
    }

    const workDir = join(tmpdir(), `aimy-whisper-${randomUUID()}`)
    mkdirSync(workDir, { recursive: true })
    const wavPath = join(workDir, 'audio_16k.wav')
    const outPrefix = join(workDir, 'transcript')

    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        audioPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wavPath
      ])

      const vadModel = resolveSileroVadModel()
      const threads = Math.min(6, Math.max(2, Math.floor(cpus().length / 2)))
      const effectiveLang = resolveWhisperLangFlag(language)

      const args = [
        '-m',
        this.modelPath(model),
        '-f',
        wavPath,
        '-l',
        effectiveLang,
        '-dev',
        '0',
        '-t',
        String(threads),
        '-bs',
        '1',
        '-bo',
        '1',
        '-mc',
        '0',
        '-nf',
        '--suppress-nst',
        '-oj',
        '-of',
        outPrefix
      ]
      if (vadModel) {
        args.push(
          '--vad',
          '--vad-model',
          vadModel,
          '--vad-threshold',
          '0.45',
          '--vad-min-speech-duration-ms',
          '250',
          '--vad-min-silence-duration-ms',
          '300'
        )
      }

      await execFileAsync(cliBin, args, join(cliBin, '..'))

      const jsonFile = `${outPrefix}.json`
      if (!existsSync(jsonFile)) {
        throw new Error('Whisper finished without producing a transcript JSON file.')
      }
      const parsed = JSON.parse(readFileSync(jsonFile, 'utf8')) as {
        transcription?: Array<{
          offsets?: { from?: number; to?: number }
          text?: string
        }>
      }

      const segments: LiveTranscriptSegment[] = []
      for (const item of parsed.transcription ?? []) {
        const fromMs = item.offsets?.from ?? 0
        const toMs = item.offsets?.to ?? 0
        // Skip 100ms window-boundary phantom glitch segments
        if (toMs > fromMs && toMs - fromMs <= 220) continue

        const cleaned = cleanAndValidateTranscript(item.text || '', language)
        if (!cleaned) continue
        const atSeconds = Math.max(0, Math.floor(fromMs / 1000))
        segments.push({
          id: randomUUID(),
          atSeconds,
          text: cleaned
        })
      }

      const text = segments
        .map((s) => {
          const m = Math.floor(s.atSeconds / 60)
          const sec = s.atSeconds % 60
          return `[${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}] ${s.text}`
        })
        .join('\n')

      return { text, segments }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup error
      }
    }
  }
}
