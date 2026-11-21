import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Segmented, Tag, toast } from '@flairstech-aimy/ui'
import {
  Mic,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Volume2
} from 'lucide-react'

interface DeepFilterAudioTesterProps {
  open: boolean
  strengthPercent: number
  postFilter: boolean
  ffmpegAvailable: boolean
}

type PreviewTrack = 'original' | 'filtered'

interface CustomSample {
  base64: string
  ext: string
  key: string
}

interface RenderedPreview {
  originalUrl: string
  filteredUrl: string
  strengthPercent: number
  postFilter: boolean
  engine: string | null
  sourceKey: string
}

function base64ToBlobUrl(base64: string, mime = 'audio/mpeg'): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const blob = new Blob([bytes], { type: mime })
  return URL.createObjectURL(blob)
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read audio clip.'))
    reader.readAsDataURL(blob)
  })
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const total = Math.floor(sec)
  const mins = Math.floor(total / 60)
  const rem = total % 60
  return `${mins}:${rem.toString().padStart(2, '0')}`
}

const MAX_MIC_SAMPLE_SECONDS = 6

export function DeepFilterAudioTester({
  open,
  strengthPercent,
  postFilter,
  ffmpegAvailable
}: DeepFilterAudioTesterProps) {
  const [preview, setPreview] = useState<RenderedPreview | null>(null)
  const [customSample, setCustomSample] = useState<CustomSample | null>(null)
  const [activeTrack, setActiveTrack] = useState<PreviewTrack>('filtered')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [recordingMic, setRecordingMic] = useState(false)
  const [micElapsed, setMicElapsed] = useState(0)

  const originalAudioRef = useRef<HTMLAudioElement | null>(null)
  const filteredAudioRef = useRef<HTMLAudioElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const micTimerRef = useRef<number | null>(null)
  const previewRef = useRef<RenderedPreview | null>(null)

  const currentSourceKey = customSample ? customSample.key : 'builtin'

  const stopPlayback = useCallback(() => {
    const orig = originalAudioRef.current
    const filt = filteredAudioRef.current
    if (orig) orig.pause()
    if (filt) filt.pause()
    setIsPlaying(false)
  }, [])

  const stopMicCapture = useCallback((cancel = false) => {
    if (micTimerRef.current !== null) {
      window.clearInterval(micTimerRef.current)
      micTimerRef.current = null
    }
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      if (cancel) {
        recorder.ondataavailable = null
        recorder.onstop = null
      }
      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null
    const stream = mediaStreamRef.current
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      mediaStreamRef.current = null
    }
    setRecordingMic(false)
    setMicElapsed(0)
  }, [])

  // Pause and clean up when Settings dialog closes
  useEffect(() => {
    if (!open) {
      stopPlayback()
      stopMicCapture(true)
    }
  }, [open, stopPlayback, stopMicCapture])

  // Revoke blob URLs on unmount
  useEffect(() => {
    return () => {
      stopPlayback()
      stopMicCapture(true)
      const prev = previewRef.current
      if (prev) {
        URL.revokeObjectURL(prev.originalUrl)
        URL.revokeObjectURL(prev.filteredUrl)
      }
    }
  }, [stopPlayback, stopMicCapture])

  const getAudioEl = useCallback((track: PreviewTrack): HTMLAudioElement | null => {
    return track === 'original' ? originalAudioRef.current : filteredAudioRef.current
  }, [])

  const runPreview = useCallback(
    async (
      targetStrength: number,
      targetPostFilter: boolean,
      sampleOverride?: CustomSample | null,
      autoPlay = true
    ): Promise<void> => {
      stopPlayback()
      setProcessing(true)
      const sample = sampleOverride !== undefined ? sampleOverride : customSample
      try {
        const res = await window.aimyDesktop.previewDeepFilter({
          strengthPercent: targetStrength,
          postFilter: targetPostFilter,
          customAudioBase64: sample ? sample.base64 : null,
          customExt: sample ? sample.ext : null
        })

        const nextOriginalUrl = base64ToBlobUrl(res.originalBase64, 'audio/mpeg')
        const nextFilteredUrl = base64ToBlobUrl(res.filteredBase64, 'audio/mpeg')

        const prev = previewRef.current
        if (prev) {
          URL.revokeObjectURL(prev.originalUrl)
          URL.revokeObjectURL(prev.filteredUrl)
        }

        const nextPreview: RenderedPreview = {
          originalUrl: nextOriginalUrl,
          filteredUrl: nextFilteredUrl,
          strengthPercent: res.strengthPercent,
          postFilter: res.postFilter,
          engine: res.engine ?? null,
          sourceKey: sample ? sample.key : 'builtin'
        }
        previewRef.current = nextPreview
        setPreview(nextPreview)
        setCurrentTime(0)
        setDuration(0)

        const preferredTrack: PreviewTrack = targetStrength > 0 ? 'filtered' : 'original'
        setActiveTrack(preferredTrack)

        if (autoPlay) {
          // Wait one animation frame for audio elements to bind the new blob URLs
          window.requestAnimationFrame(() => {
            const el =
              preferredTrack === 'original'
                ? originalAudioRef.current
                : filteredAudioRef.current
            if (el) {
              el.currentTime = 0
              void el.play().then(
                () => setIsPlaying(true),
                () => setIsPlaying(false)
              )
            }
          })
        }
      } catch (err) {
        toast('Audio preview failed', {
          tone: 'err',
          sub: err instanceof Error ? err.message : 'Could not generate DeepFilterNet3 preview.'
        })
      } finally {
        setProcessing(false)
      }
    },
    [customSample, stopPlayback]
  )

  const handleTogglePlay = async (): Promise<void> => {
    if (!preview || isStale) {
      await runPreview(strengthPercent, postFilter, customSample, true)
      return
    }

    const activeEl = getAudioEl(activeTrack)
    if (!activeEl) return

    if (isPlaying) {
      activeEl.pause()
      setIsPlaying(false)
      return
    }

    if (activeEl.ended || (duration > 0 && currentTime >= duration - 0.05)) {
      activeEl.currentTime = 0
      setCurrentTime(0)
    }
    try {
      await activeEl.play()
      setIsPlaying(true)
    } catch {
      setIsPlaying(false)
    }
  }

  const handleTrackSwitch = (nextTrack: PreviewTrack): void => {
    if (nextTrack === activeTrack) return
    const prevEl = getAudioEl(activeTrack)
    const nextEl = getAudioEl(nextTrack)
    const wasPlaying = isPlaying
    const timestamp = prevEl ? prevEl.currentTime : currentTime

    if (prevEl) prevEl.pause()
    setActiveTrack(nextTrack)

    if (nextEl) {
      const clampedTime =
        Number.isFinite(nextEl.duration) && nextEl.duration > 0
          ? Math.min(timestamp, Math.max(0, nextEl.duration - 0.05))
          : timestamp
      nextEl.currentTime = clampedTime
      setCurrentTime(clampedTime)
      if (wasPlaying) {
        void nextEl.play().then(
          () => setIsPlaying(true),
          () => setIsPlaying(false)
        )
      }
    }
  }

  const handleSeek = (nextTime: number): void => {
    setCurrentTime(nextTime)
    if (originalAudioRef.current) originalAudioRef.current.currentTime = nextTime
    if (filteredAudioRef.current) filteredAudioRef.current.currentTime = nextTime
  }

  const handleStartMicTest = async (): Promise<void> => {
    if (recordingMic) {
      stopMicCapture(false)
      return
    }

    stopPlayback()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      mediaStreamRef.current = stream

      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream)
      const chunks: Blob[] = []

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data)
      }

      recorder.onstop = () => {
        const mime = recorder.mimeType || 'audio/webm'
        const blob = new Blob(chunks, { type: mime })
        const ext = mime.includes('ogg') ? '.ogg' : '.webm'
        if (blob.size < 256) {
          toast('Mic test too short', {
            sub: 'Speak for at least 1–2 seconds to test noise filtering.'
          })
          return
        }
        void blobToBase64(blob).then((base64) => {
          const nextSample: CustomSample = {
            base64,
            ext,
            key: `mic-${Date.now()}`
          }
          setCustomSample(nextSample)
          void runPreview(strengthPercent, postFilter, nextSample, true)
        })
      }

      mediaRecorderRef.current = recorder
      recorder.start(200)
      setRecordingMic(true)
      setMicElapsed(0)

      const startedAt = Date.now()
      micTimerRef.current = window.setInterval(() => {
        const elapsed = Math.min(
          MAX_MIC_SAMPLE_SECONDS,
          Math.floor((Date.now() - startedAt) / 1000)
        )
        setMicElapsed(elapsed)
        if (Date.now() - startedAt >= MAX_MIC_SAMPLE_SECONDS * 1000) {
          stopMicCapture(false)
        }
      }, 200)
    } catch (err) {
      stopMicCapture(true)
      toast('Microphone unavailable', {
        tone: 'err',
        sub: err instanceof Error ? err.message : 'Check microphone permissions and try again.'
      })
    }
  }

  const handleResetToBuiltin = (): void => {
    stopPlayback()
    setCustomSample(null)
    void runPreview(strengthPercent, postFilter, null, false)
  }

  const isStale =
    preview !== null &&
    (preview.strengthPercent !== strengthPercent ||
      preview.postFilter !== postFilter ||
      preview.sourceKey !== currentSourceKey)

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Volume2 className="size-3.5 text-ink-secondary" />
          <span className="text-2xs font-semibold text-ink">Audio test sample</span>
          <Tag tone="neutral">
            {customSample ? 'Your mic clip' : 'Built-in noisy voice'}
          </Tag>
        </div>

        <div className="flex items-center gap-1.5">
          {customSample && !recordingMic && (
            <Button
              variant="ghost"
              size="sm"
              disabled={processing}
              onClick={handleResetToBuiltin}
            >
              <RotateCcw className="size-3" />
              Built-in sample
            </Button>
          )}
          <Button
            variant={recordingMic ? 'err' : 'ghost'}
            size="sm"
            disabled={processing || !ffmpegAvailable}
            onClick={() => void handleStartMicTest()}
          >
            {recordingMic ? (
              <>
                <Square className="size-3" />
                Stop ({MAX_MIC_SAMPLE_SECONDS - micElapsed}s)
              </>
            ) : (
              <>
                <Mic className="size-3.5" />
                Record mic test
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Hidden dual audio elements for zero-gap instant A/B switching */}
      <audio
        ref={originalAudioRef}
        src={preview?.originalUrl}
        preload="auto"
        onLoadedMetadata={(e) => {
          if (activeTrack === 'original' || duration === 0) {
            setDuration(e.currentTarget.duration || 0)
          }
        }}
        onTimeUpdate={(e) => {
          if (activeTrack === 'original') {
            setCurrentTime(e.currentTarget.currentTime)
          }
        }}
        onEnded={() => {
          if (activeTrack === 'original') setIsPlaying(false)
        }}
      />
      <audio
        ref={filteredAudioRef}
        src={preview?.filteredUrl}
        preload="auto"
        onLoadedMetadata={(e) => {
          if (activeTrack === 'filtered' || duration === 0) {
            setDuration(e.currentTarget.duration || 0)
          }
        }}
        onTimeUpdate={(e) => {
          if (activeTrack === 'filtered') {
            setCurrentTime(e.currentTarget.currentTime)
          }
        }}
        onEnded={() => {
          if (activeTrack === 'filtered') setIsPlaying(false)
        }}
      />

      <div className="flex flex-col gap-2.5 rounded-lg border border-hairline bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant={preview && !isStale ? 'brand' : 'accent'}
              size="sm"
              loading={processing}
              disabled={recordingMic || (!ffmpegAvailable && strengthPercent > 0)}
              onClick={() => void handleTogglePlay()}
            >
              {isPlaying ? (
                <>
                  <Pause className="size-3.5" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="size-3.5" />
                  {preview && !isStale
                    ? 'Play sample'
                    : isStale
                      ? `Preview at ${strengthPercent}%`
                      : `Test sample (${strengthPercent}%)`}
                </>
              )}
            </Button>

            {preview && isStale && (
              <Button
                variant="ghost"
                size="sm"
                loading={processing}
                disabled={recordingMic || (!ffmpegAvailable && strengthPercent > 0)}
                onClick={() => void runPreview(strengthPercent, postFilter, customSample, true)}
              >
                <RefreshCw className="size-3" />
                Re-filter
              </Button>
            )}
          </div>

          {preview && (
            <Segmented
              label="Compare original and filtered audio"
              value={activeTrack}
              onValueChange={(v) => handleTrackSwitch(v as PreviewTrack)}
              options={[
                { value: 'original', label: 'Original' },
                {
                  value: 'filtered',
                  label: `Filtered (${preview.strengthPercent}%)`
                }
              ]}
            />
          )}
        </div>

        {preview ? (
          <div className="flex items-center gap-2.5">
            <span className="w-8 shrink-0 font-mono text-2xs text-ink-quiet">
              {formatClock(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 1}
              step={0.05}
              value={Math.min(currentTime, duration > 0 ? duration : 1)}
              aria-label="Test sample playback position"
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="aimy-range"
              style={{
                background: `linear-gradient(to right, var(--brand) 0%, var(--brand) ${progressPct}%, var(--w14) ${progressPct}%, var(--w14) 100%)`
              }}
            />
            <span className="w-8 shrink-0 text-right font-mono text-2xs text-ink-quiet">
              {formatClock(duration)}
            </span>
          </div>
        ) : (
          <p className="m-0 text-2xs text-ink-quiet">
            Click <strong>Test sample</strong> to hear a built-in noisy speech clip, or record a 6-second test from your mic and switch between <strong>Original</strong> and <strong>Filtered</strong> live.
          </p>
        )}
      </div>
    </div>
  )
}
