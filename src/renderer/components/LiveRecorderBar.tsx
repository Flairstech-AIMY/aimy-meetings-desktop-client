import { useState } from 'react'
import { Button, Input, Orb, StatusPill, Textarea } from '@flairstech-aimy/ui'
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Pause,
  Play,
  Square
} from 'lucide-react'
import { formatDuration } from '@renderer/lib/format'

interface LiveRecorderBarProps {
  title: string
  meetingApp: string
  elapsedSeconds: number
  audioLevel: number
  isPaused: boolean
  hasSystemAudio: boolean
  hasMicAudio: boolean
  notes: string
  onTitleChange: (next: string) => void
  onNotesChange: (next: string) => void
  onTogglePause: () => void
  onStop: () => void
  stopping: boolean
}

export function LiveRecorderBar({
  title,
  elapsedSeconds,
  audioLevel,
  isPaused,
  notes,
  onTitleChange,
  onNotesChange,
  onTogglePause,
  onStop,
  stopping
}: LiveRecorderBarProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <section
      aria-label="Active recording studio"
      className="border-b border-hairline bg-card/80 px-8 py-3.5"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {/* Clean Single-Line Live Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="relative size-8 shrink-0">
              <Orb
                phase={isPaused ? 'muted' : 'listening'}
                level={isPaused ? 0 : audioLevel}
                running={!isPaused}
                className="size-8"
              />
            </div>

            <StatusPill state={isPaused ? 'away' : 'busy'}>
              {isPaused ? 'Paused' : 'Recording'}
            </StatusPill>

            <span className="font-mono text-xs font-bold text-ink">
              {formatDuration(elapsedSeconds)}
            </span>

            <div className="min-w-40 flex-1">
              <Input
                variant="line"
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                placeholder="Name this meeting…"
                aria-label="Meeting title"
                className="border-transparent hover:border-edge-hover focus-visible:border-brand text-xs font-semibold"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
              <FileText className="size-3.5 text-ai-ink" />
              {expanded ? 'Hide notes' : 'Live notes'}
              {expanded ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>

            <Button variant="ghost" size="sm" onClick={onTogglePause} disabled={stopping}>
              {isPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {isPaused ? 'Resume' : 'Pause'}
            </Button>

            <Button variant="err" size="sm" onClick={onStop} loading={stopping}>
              <Square className="size-3.5" />
              Stop &amp; save
            </Button>
          </div>
        </div>

        {/* Optional Expandable Notes Drawer */}
        {expanded && (
          <div className="pt-1">
            <Textarea
              rows={4}
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="Jot quick meeting notes while recording…"
              aria-label="Live meeting notes"
              className="h-32 resize-none text-xs leading-relaxed"
            />
          </div>
        )}
      </div>
    </section>
  )
}
