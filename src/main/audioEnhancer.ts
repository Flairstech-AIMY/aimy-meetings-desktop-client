import { app } from 'electron'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

export type EnhancementEngine = 'deepfilternet3' | 'ffmpeg-denoise' | null

export interface EnhanceResult {
  enhanced: boolean
  engine: EnhancementEngine
}

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

export function resolveDeepFilterBinary(): string | null {
  const binName = process.platform === 'win32' ? 'deep-filter.exe' : 'deep-filter'
  const candidates = [
    join(app.getAppPath(), 'resources', 'bin', binName),
    join(__dirname, '../../resources/bin', binName),
    join(process.resourcesPath, 'bin', binName)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export async function checkDeepFilterAvailable(): Promise<boolean> {
  const local = resolveDeepFilterBinary()
  if (local) return true
  try {
    await execFileAsync('deep-filter', ['--version'])
    return true
  } catch {
    return false
  }
}

export async function enhanceAndEncodeToMp3(
  inputPath: string,
  outputMp3Path: string,
  enableEnhancement: boolean
): Promise<EnhanceResult> {
  if (!enableEnhancement) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-ar',
      '44100',
      '-ac',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      outputMp3Path
    ])
    return { enhanced: false, engine: null }
  }

  const dfBin = resolveDeepFilterBinary() ?? ((await checkDeepFilterAvailable()) ? 'deep-filter' : null)

  if (dfBin) {
    const workDir = join(tmpdir(), `aimy-df-${randomUUID()}`)
    const outDir = join(workDir, 'out')
    mkdirSync(outDir, { recursive: true })
    const wavIn = join(workDir, 'input_48k.wav')
    const wavEnhanced = join(outDir, basename(wavIn))

    try {
      // 1. Prepare 48kHz mono WAV with 80Hz high-pass and -2dB headroom to prevent clipping inside DeepFilterNet3
      await execFileAsync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-vn',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-af',
        'highpass=f=80,volume=-2dB',
        '-c:a',
        'pcm_s16le',
        wavIn
      ])

      // 2. Run DeepFilterNet3 full-band neural speech enhancement + post-filter
      await execFileAsync(dfBin, ['--pf', '--compensate-delay', '--output-dir', outDir, wavIn])

      if (existsSync(wavEnhanced) && statSync(wavEnhanced).size > 0) {
        // 3. Apply gentle speech loudness normalization and encode to clean MP3 for AiMY ingestion
        await execFileAsync('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          wavEnhanced,
          '-vn',
          '-ar',
          '44100',
          '-ac',
          '1',
          '-af',
          'dynaudnorm=f=150:g=15:p=0.9:m=10',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          outputMp3Path
        ])
        return { enhanced: true, engine: 'deepfilternet3' }
      }
    } catch (err) {
      console.error('[AudioEnhancer] DeepFilterNet3 failed, falling back to FFmpeg denoiser:', err)
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // ignore temp cleanup errors
      }
    }
  }

  // Fallback: FFmpeg spectral denoise + high-pass + dynamic speech normalization
  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-ar',
    '44100',
    '-ac',
    '1',
    '-af',
    'highpass=f=80,afftdn=nf=-25,dynaudnorm=f=150:g=15:p=0.9:m=10',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    outputMp3Path
  ])
  return { enhanced: true, engine: 'ffmpeg-denoise' }
}
