import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@flairstech-aimy/ui'
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react'
import { formatDuration } from '@renderer/lib/format'

const BARS = 56
const SKIP_SECONDS = 10

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h | 0
}

function buildWave(id: string): number[] {
  return Array.from({ length: BARS }, (_, b) => 18 + (Math.abs(hash(`${id}:w${b}`)) % 79))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface RecordingAudioPlayerProps {
  id: string
  seconds: number
  src?: string
  className?: string
}

interface DragState {
  pointerId: number
  startX: number
  moved: boolean
  wasPlaying: boolean
  targetTime: number
}

interface PendingSeek {
  time: number
  autoPlay: boolean
}

export function RecordingAudioPlayer({
  id,
  seconds,
  src,
  className
}: RecordingAudioPlayerProps) {
  const fallbackDuration = Math.max(1, Number.isFinite(seconds) && seconds > 0 ? seconds : 1)

  const [playing, setPlaying] = useState(false)
  const [audioDuration, setAudioDuration] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [scrubTime, setScrubTime] = useState<number | null>(null)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const pendingSeekRef = useRef<PendingSeek | null>(null)
  const isSeekingRef = useRef(false)
  const seekTimeoutRef = useRef<number | null>(null)

  const effectiveDuration =
    audioDuration != null && Number.isFinite(audioDuration) && audioDuration > 0
      ? audioDuration
      : fallbackDuration

  const bars = useMemo(() => buildWave(id), [id])

  const updateFillClip = useCallback((time: number, total: number) => {
    const el = fillRef.current
    if (!el) return
    const pct = total > 0 ? clamp((time / total) * 100, 0, 100) : 0
    el.style.clipPath = `inset(0 ${100 - pct}% 0 0)`
  }, [])

  const clearSeekGuard = useCallback(() => {
    isSeekingRef.current = false
    if (seekTimeoutRef.current !== null) {
      window.clearTimeout(seekTimeoutRef.current)
      seekTimeoutRef.current = null
    }
  }, [])

  const startPlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !src) return
    const playPromise = audio.play()
    if (playPromise) {
      playPromise.catch(() => {
        setPlaying(false)
      })
    }
  }, [src])

  const seekTo = useCallback(
    (rawTarget: number, shouldPlay?: boolean) => {
      const audio = audioRef.current
      if (!audio || !src) return

      const maxSeek = shouldPlay ? Math.max(0, effectiveDuration - 0.15) : Math.max(0, effectiveDuration)
      const target = clamp(rawTarget, 0, maxSeek)

      setCurrentTime(target)
      updateFillClip(target, effectiveDuration)

      if (audio.readyState >= 1) {
        pendingSeekRef.current = null
        if (Math.abs(audio.currentTime - target) >= 0.01) {
          isSeekingRef.current = true
          if (seekTimeoutRef.current !== null) {
            window.clearTimeout(seekTimeoutRef.current)
          }
          seekTimeoutRef.current = window.setTimeout(() => {
            isSeekingRef.current = false
            seekTimeoutRef.current = null
          }, 500)
          try {
            audio.currentTime = target
          } catch {
            clearSeekGuard()
          }
        }

        if (shouldPlay === true && audio.paused) {
          startPlay()
        } else if (shouldPlay === false && !audio.paused) {
          audio.pause()
        }
      } else {
        pendingSeekRef.current = {
          time: target,
          autoPlay: shouldPlay ?? playing
        }
        audio.load()
      }
    },
    [clearSeekGuard, effectiveDuration, playing, src, startPlay, updateFillClip]
  )

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !src) return

    if (!audio.paused) {
      audio.pause()
      return
    }

    if (audio.ended || (effectiveDuration > 0 && currentTime >= effectiveDuration - 0.1)) {
      seekTo(0, true)
      return
    }

    startPlay()
  }, [currentTime, effectiveDuration, seekTo, src, startPlay])

  const skipBy = useCallback(
    (delta: number) => {
      const base = scrubTime ?? currentTime
      seekTo(base + delta)
    },
    [currentTime, scrubTime, seekTo]
  )

  // Keep clipPath synced smoothly at 60fps during playback
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    const step = () => {
      const audio = audioRef.current
      if (audio && dragRef.current === null && !isSeekingRef.current) {
        updateFillClip(audio.currentTime, effectiveDuration)
      }
      rafRef.current = window.requestAnimationFrame(step)
    }

    rafRef.current = window.requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [effectiveDuration, playing, updateFillClip])

  // Sync fill clip whenever paused state / scrub / duration changes
  useEffect(() => {
    if (playing && scrubTime === null) return
    const display = scrubTime ?? currentTime
    updateFillClip(display, effectiveDuration)
  }, [currentTime, effectiveDuration, playing, scrubTime, updateFillClip])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSeekGuard()
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      const audio = audioRef.current
      if (audio) {
        audio.pause()
      }
    }
  }, [clearSeekGuard])

  const ratioFromClientX = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return clamp((clientX - rect.left) / rect.width, 0, 1)
  }, [])

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !src) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)

    const ratio = ratioFromClientX(e.clientX)
    const targetTime = ratio * effectiveDuration
    const audio = audioRef.current

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      moved: false,
      wasPlaying: Boolean(audio && !audio.paused),
      targetTime
    }

    setHoverRatio(ratio)
    setScrubTime(targetTime)
    updateFillClip(targetTime, effectiveDuration)
  }

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ratio = ratioFromClientX(e.clientX)
    setHoverRatio(ratio)

    const drag = dragRef.current
    if (drag && drag.pointerId === e.pointerId) {
      if (Math.abs(e.clientX - drag.startX) > 4) {
        drag.moved = true
      }
      const targetTime = ratio * effectiveDuration
      drag.targetTime = targetTime
      setScrubTime(targetTime)
      updateFillClip(targetTime, effectiveDuration)
    }
  }

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return

    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }

    dragRef.current = null
    setScrubTime(null)

    const track = trackRef.current
    if (track) {
      const rect = track.getBoundingClientRect()
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      if (!inside) {
        setHoverRatio(null)
      }
    }

    if (cancelled) {
      updateFillClip(currentTime, effectiveDuration)
      return
    }

    // Clicking a spot starts playback from there; dragging while paused seeks in place;
    // clicking or dragging while playing continues playing from the new spot.
    const shouldPlay = drag.wasPlaying || !drag.moved
    seekTo(drag.targetTime, shouldPlay)
  }

  const handleTrackKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!src) return
    const step = e.shiftKey ? 15 : 5
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        skipBy(-step)
        break
      case 'ArrowRight':
        e.preventDefault()
        skipBy(step)
        break
      case 'Home':
        e.preventDefault()
        seekTo(0)
        break
      case 'End':
        e.preventDefault()
        seekTo(effectiveDuration)
        break
      case ' ':
      case 'Enter':
        e.preventDefault()
        togglePlay()
        break
    }
  }

  const applyPendingSeekIfReady = (audio: HTMLAudioElement) => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setAudioDuration(audio.duration)
    }
    const pending = pendingSeekRef.current
    if (!pending) return

    pendingSeekRef.current = null
    const dur =
      Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration
    const clamped = clamp(pending.time, 0, dur)
    try {
      audio.currentTime = clamped
    } catch {
      // ignore if media isn't seekable yet
    }
    setCurrentTime(clamped)
    updateFillClip(clamped, dur)
    if (pending.autoPlay) {
      startPlay()
    }
  }

  const displayTime = scrubTime ?? currentTime
  const progressPct =
    effectiveDuration > 0 ? clamp((displayTime / effectiveDuration) * 100, 0, 100) : 0
  const hoverPct = hoverRatio !== null ? clamp(hoverRatio * 100, 0, 100) : null
  const hoverTime = hoverRatio !== null ? hoverRatio * effectiveDuration : null
  const isDragging = scrubTime !== null

  const drawBars = (tone: 'idle' | 'hover' | 'played') =>
    bars.map((h, b) => (
      <i
        key={b}
        style={{ height: `${h}%` }}
        className={cn(
          'min-w-0 flex-1 rounded-pill',
          tone === 'played' && 'bg-accent-text',
          tone === 'hover' &&
            'bg-[color-mix(in_srgb,var(--accent)_52%,transparent)] in-data-[theme=light]:bg-[color-mix(in_srgb,var(--accent)_44%,transparent)]',
          tone === 'idle' &&
            'bg-[color-mix(in_srgb,var(--accent)_28%,transparent)] in-data-[theme=light]:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]'
        )}
      />
    ))

  return (
    <div
      data-slot="recording-audio-player"
      className={cn(
        'flex h-11 w-full items-center gap-2 rounded-pill px-2.5 pr-3.5 select-none',
        'bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]',
        'ring-1 ring-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
        className
      )}
    >
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => applyPendingSeekIfReady(e.currentTarget)}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d) && d > 0) {
              setAudioDuration(d)
            }
          }}
          onCanPlay={(e) => {
            if (pendingSeekRef.current) {
              applyPendingSeekIfReady(e.currentTarget)
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onSeeked={(e) => {
            clearSeekGuard()
            if (dragRef.current === null) {
              const t = e.currentTarget.currentTime
              setCurrentTime(t)
              updateFillClip(t, effectiveDuration)
            }
          }}
          onTimeUpdate={(e) => {
            if (dragRef.current !== null || isSeekingRef.current) return
            const t = e.currentTarget.currentTime
            setCurrentTime(t)
            updateFillClip(t, effectiveDuration)
          }}
          onEnded={() => {
            clearSeekGuard()
            setPlaying(false)
            setCurrentTime(0)
            updateFillClip(0, effectiveDuration)
            const audio = audioRef.current
            if (audio) {
              audio.currentTime = 0
            }
          }}
        />
      )}

      {/* Play / Pause */}
      <button
        type="button"
        disabled={!src}
        aria-pressed={playing}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        onClick={togglePlay}
        className={cn(
          'flex size-7 flex-none cursor-pointer items-center justify-center rounded-pill bg-accent-text text-(--body-bg)',
          'transition-transform duration-(--t-fast) ease-out hover:scale-105 active:scale-95',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text',
          'disabled:cursor-not-allowed disabled:opacity-45'
        )}
      >
        {playing ? (
          <Pause aria-hidden="true" className="size-3.5 fill-current stroke-0" />
        ) : (
          <Play aria-hidden="true" className="ml-0.5 size-3.5 fill-current stroke-0" />
        )}
      </button>

      {/* Skip back 10s */}
      <button
        type="button"
        disabled={!src}
        title={`Back ${SKIP_SECONDS}s`}
        aria-label={`Skip back ${SKIP_SECONDS} seconds`}
        onClick={() => skipBy(-SKIP_SECONDS)}
        className={cn(
          'flex size-6 flex-none cursor-pointer items-center justify-center rounded-pill text-ink-secondary',
          'transition-colors duration-(--t-fast) hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-text',
          'disabled:cursor-not-allowed disabled:opacity-40'
        )}
      >
        <RotateCcw aria-hidden="true" className="size-3.5" />
      </button>

      {/* Interactive Seekable Waveform */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={src ? 0 : -1}
        aria-label="Seek recording playback"
        aria-valuemin={0}
        aria-valuemax={Math.round(effectiveDuration)}
        aria-valuenow={Math.round(displayTime)}
        aria-valuetext={`${formatDuration(displayTime)} of ${formatDuration(effectiveDuration)}`}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={(e) => finishDrag(e, false)}
        onPointerCancel={(e) => finishDrag(e, true)}
        onPointerLeave={() => {
          if (dragRef.current === null) {
            setHoverRatio(null)
          }
        }}
        onKeyDown={handleTrackKeyDown}
        className={cn(
          'group/wave relative flex h-full min-w-0 flex-1 items-center py-2 touch-none outline-none',
          'focus-visible:ring-2 focus-visible:ring-accent-text/60 focus-visible:rounded-md',
          src ? (isDragging ? 'cursor-grabbing' : 'cursor-pointer') : 'cursor-default opacity-60'
        )}
      >
        {/* Floating time indicator on hover / drag */}
        {src && hoverPct !== null && hoverTime !== null && (
          <span
            aria-hidden="true"
            style={{ left: `${clamp(hoverPct, 6, 94)}%` }}
            className="pointer-events-none absolute -top-6 z-10 -translate-x-1/2 rounded-md border border-hairline bg-raised px-1.5 py-0.5 font-mono text-2xs font-medium text-ink shadow-sm tabular-nums"
          >
            {formatDuration(isDragging ? displayTime : hoverTime)}
          </span>
        )}

        <span aria-hidden="true" className="relative h-6 w-full">
          {/* Base unplayed waveform */}
          <span className="absolute inset-0 flex items-center gap-[2.5px]">
            {drawBars('idle')}
          </span>

          {/* Hover preview fill */}
          {src && hoverPct !== null && !isDragging && (
            <span
              style={{ clipPath: `inset(0 ${100 - hoverPct}% 0 0)` }}
              className="pointer-events-none absolute inset-0 flex items-center gap-[2.5px]"
            >
              {drawBars('hover')}
            </span>
          )}

          {/* Played waveform fill (clip-path driven imperatively for 60fps smooth updates) */}
          <span
            ref={fillRef}
            className="pointer-events-none absolute inset-0 flex items-center gap-[2.5px] [clip-path:inset(0_100%_0_0)]"
          >
            {drawBars('played')}
          </span>

          {/* Playhead hairline while hovering or dragging */}
          {src && (hoverPct !== null || isDragging) && (
            <span
              style={{ left: `${isDragging ? progressPct : hoverPct}%` }}
              className="pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-pill bg-accent-text shadow-[0_0_6px_var(--accent)]"
            />
          )}
        </span>
      </div>

      {/* Skip forward 10s */}
      <button
        type="button"
        disabled={!src}
        title={`Forward ${SKIP_SECONDS}s`}
        aria-label={`Skip forward ${SKIP_SECONDS} seconds`}
        onClick={() => skipBy(SKIP_SECONDS)}
        className={cn(
          'flex size-6 flex-none cursor-pointer items-center justify-center rounded-pill text-ink-secondary',
          'transition-colors duration-(--t-fast) hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-text',
          'disabled:cursor-not-allowed disabled:opacity-40'
        )}
      >
        <RotateCw aria-hidden="true" className="size-3.5" />
      </button>

      {/* Current / Total Time */}
      <span className="flex-none text-right text-2xs font-semibold tabular-nums">
        <span className="text-ink">{formatDuration(displayTime)}</span>
        <span className="text-ink-quiet"> / {formatDuration(effectiveDuration)}</span>
      </span>
    </div>
  )
}
