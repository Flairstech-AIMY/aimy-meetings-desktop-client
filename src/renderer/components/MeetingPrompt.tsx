import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AimyMark, Button, IconButton, Orb, Progress, Tag } from '@flairstech-aimy/ui'
import { Mic, Radio, X } from 'lucide-react'
import type { DetectedMeeting } from '@shared/types'

const dragRegion = { WebkitAppRegion: 'drag' } as CSSProperties
const noDragRegion = { WebkitAppRegion: 'no-drag' } as CSSProperties
const AUTO_DISMISS_MS = 15_000
const TICK_MS = 100

export function MeetingPromptWindow() {
  const [meeting, setMeeting] = useState<DetectedMeeting | null>(null)
  const [remainingMs, setRemainingMs] = useState(AUTO_DISMISS_MS)
  const [hovered, setHovered] = useState(false)
  const hoveredRef = useRef(false)
  hoveredRef.current = hovered

  useEffect(() => {
    void window.aimyDesktop.getActiveMeetingPrompt().then((m) => {
      if (m) {
        setMeeting(m)
        setRemainingMs(AUTO_DISMISS_MS)
      }
    })
    return window.aimyDesktop.onMeetingDetected((m) => {
      setMeeting(m)
      setRemainingMs(AUTO_DISMISS_MS)
    })
  }, [])

  // Auto-hide notification after 15s (paused while hovering); meeting remains visible inside the app
  useEffect(() => {
    if (!meeting) return
    const timer = window.setInterval(() => {
      if (hoveredRef.current) return
      setRemainingMs((prev) => {
        const next = prev - TICK_MS
        if (next <= 0) {
          clearInterval(timer)
          void window.aimyDesktop.hideMeetingPrompt()
          return 0
        }
        return next
      })
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [meeting?.id])

  if (!meeting) {
    return null
  }

  const pct = Math.max(0, Math.round((remainingMs / AUTO_DISMISS_MS) * 100))

  return (
    <div className="flex h-full w-full items-center justify-center p-2.5">
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex w-full flex-col gap-2.5 rounded-2xl border border-edge-focus bg-float p-4 shadow-xl"
      >
        <div
          style={dragRegion}
          className="flex cursor-grab items-center justify-between gap-2 active:cursor-grabbing"
        >
          <div className="flex min-w-0 items-center gap-2">
            <AimyMark variant="icon" title="AiMY Meetings Desktop Client" className="h-4 w-4 shrink-0" />
            <span className="text-2xs font-bold text-ink">Meeting detected</span>
            <Tag tone="accent">{meeting.app}</Tag>
            {meeting.micActive && (
              <Tag tone="ok">
                <Mic className="size-3" />
                Live
              </Tag>
            )}
          </div>
          <div style={noDragRegion}>
            <IconButton
              label="Dismiss meeting prompt"
              size="sm"
              onClick={() => void window.aimyDesktop.dismissMeetingPrompt(meeting.id)}
            >
              <X className="size-3.5" />
            </IconButton>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative size-8 shrink-0">
            <Orb phase="listening" level={0.35} running className="size-8" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-xs font-semibold text-ink">{meeting.title}</p>
            <p className="m-0 mt-0.5 text-2xs text-ink-secondary">
              Capture audio &amp; transcribe directly to AiMY Knowledge.
            </p>
          </div>
        </div>

        <div style={noDragRegion} className="flex items-center justify-between gap-2 pt-0.5">
          <span className="font-mono text-2xs text-ink-quiet">
            {hovered ? 'Timer paused' : `Auto-hides in ${Math.ceil(remainingMs / 1000)}s`}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void window.aimyDesktop.dismissMeetingPrompt(meeting.id)}
            >
              Not now
            </Button>
            <Button
              variant="brand"
              size="sm"
              onClick={() => void window.aimyDesktop.acceptMeetingPrompt(meeting)}
            >
              <Radio className="size-3.5" />
              Record
            </Button>
          </div>
        </div>

        <Progress size="thin" value={pct} max={100} label="Time before notification hides" />
      </div>
    </div>
  )
}
