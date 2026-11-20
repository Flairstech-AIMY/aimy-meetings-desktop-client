import {
  AimyMark,
  Button,
  Dialog,
  DialogContent,
  Notice,
  Tag
} from '@flairstech-aimy/ui'
import {
  AppWindow,
  ExternalLink,
  HardDrive,
  Loader2,
  UploadCloud,
  WifiOff
} from 'lucide-react'
import type { AuthStateReason, SignInMethod } from '@shared/types'

interface SignInPromptDialogProps {
  open: boolean
  reason?: AuthStateReason
  lastUserEmail?: string
  pendingCount: number
  online: boolean
  signingInMethod: SignInMethod | null
  error: string | null
  onSignIn: (method: SignInMethod) => Promise<void>
  onCancelSignIn: () => Promise<void>
  onContinueLocalOnly: () => void
}

function copyForReason(reason?: AuthStateReason, lastUserEmail?: string): {
  title: string
  description: string
  badge?: { label: string; tone: 'warn' | 'accent' | 'neutral' }
} {
  if (reason === 'expired') {
    return {
      title: 'Your AiMY session expired',
      description: lastUserEmail
        ? `Sign in again as ${lastUserEmail} to resume syncing with AiMY Knowledge. Your local recordings remain safely stored on this computer.`
        : 'Sign in again to resume syncing with AiMY Knowledge. Your local recordings remain safely stored on this computer.',
      badge: { label: 'Session expired', tone: 'warn' }
    }
  }
  if (reason === 'signed-out') {
    return {
      title: 'You signed out of AiMY',
      description:
        'Sign back in to sync meeting recordings and transcripts to AiMY Knowledge, or continue recording locally and sync later.',
      badge: { label: 'Signed out', tone: 'neutral' }
    }
  }
  return {
    title: 'Sign in to AiMY Knowledge',
    description:
      'Connect your AiMY account to automatically sync recordings, transcripts, and notes. You can also work locally first and sync whenever you are ready.',
    badge: { label: 'Sync ready', tone: 'accent' }
  }
}

export function SignInPromptDialog({
  open,
  reason,
  lastUserEmail,
  pendingCount,
  online,
  signingInMethod,
  error,
  onSignIn,
  onCancelSignIn,
  onContinueLocalOnly
}: SignInPromptDialogProps) {
  const copy = copyForReason(reason, lastUserEmail)
  const isWaitingBrowser = signingInMethod === 'browser'
  const isWaitingEmbedded = signingInMethod === 'embedded'
  const isWaiting = Boolean(signingInMethod)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      if (isWaiting) {
        void onCancelSignIn()
      }
      onContinueLocalOnly()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        title={
          <span className="inline-flex items-center gap-2.5">
            <AimyMark variant="icon" title="" className="h-5 w-5" />
            <span>{copy.title}</span>
          </span>
        }
        description={copy.description}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (isWaiting) {
                  void onCancelSignIn()
                }
                onContinueLocalOnly()
              }}
            >
              <HardDrive className="size-3.5" />
              Continue local-only
            </Button>

            <div className="flex items-center gap-2">
              {isWaiting ? (
                <>
                  {isWaitingBrowser && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!online}
                      onClick={() => void onSignIn('embedded')}
                    >
                      <AppWindow className="size-3.5" />
                      Use built-in window
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onCancelSignIn()}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!online}
                    onClick={() => void onSignIn('embedded')}
                  >
                    <AppWindow className="size-3.5" />
                    Built-in window
                  </Button>
                  <Button
                    variant="brand"
                    size="sm"
                    disabled={!online}
                    onClick={() => void onSignIn('browser')}
                  >
                    <ExternalLink className="size-3.5" />
                    Sign in in browser
                  </Button>
                </>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3 py-1">
          <div className="flex flex-wrap items-center gap-2">
            {copy.badge && <Tag tone={copy.badge.tone}>{copy.badge.label}</Tag>}
            {!online && (
              <Tag tone="warn">
                <WifiOff className="size-3" />
                Offline
              </Tag>
            )}
            {pendingCount > 0 && (
              <Tag tone="info">
                <UploadCloud className="size-3" />
                {pendingCount} local {pendingCount === 1 ? 'recording' : 'recordings'} waiting to sync
              </Tag>
            )}
          </div>

          {!online && (
            <Notice tone="warn" title="No internet connection detected">
              You can keep recording and taking notes locally. AiMY Meetings Desktop Client will prompt you to
              sign in and sync once you are back online.
            </Notice>
          )}

          {isWaitingBrowser && (
            <div className="flex items-start gap-3 rounded-xl border border-hairline bg-sunken p-3.5">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-ink-secondary" />
              <div className="min-w-0">
                <p className="m-0 text-xs font-semibold text-ink">
                  Waiting for sign-in in your default browser…
                </p>
                <p className="m-0 mt-1 text-2xs text-ink-secondary">
                  Use your browser&apos;s saved credentials or autofill, then allow the redirect
                  back to AiMY Meetings Desktop Client. If your browser doesn&apos;t redirect back, switch to the
                  built-in sign-in window below.
                </p>
              </div>
            </div>
          )}

          {isWaitingEmbedded && (
            <div className="flex items-start gap-3 rounded-xl border border-hairline bg-sunken p-3.5">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-ink-secondary" />
              <div className="min-w-0">
                <p className="m-0 text-xs font-semibold text-ink">
                  Complete sign-in in the AiMY window…
                </p>
                <p className="m-0 mt-1 text-2xs text-ink-secondary">
                  This dialog will close automatically as soon as your session is active.
                </p>
              </div>
            </div>
          )}

          {!isWaiting && online && (
            <div className="rounded-xl border border-hairline bg-sunken p-3.5 text-2xs text-ink-secondary">
              <strong className="font-semibold text-ink">Sign in in browser</strong> opens your
              system browser so password managers, autofill, and existing SSO sessions work
              automatically. Or use <strong className="font-semibold text-ink">Built-in window</strong>{' '}
              as a fallback.
            </div>
          )}

          {error && (
            <Notice
              tone="err"
              title="Sign-in did not complete"
              action={
                online && !isWaiting ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onSignIn('embedded')}
                  >
                    Try built-in window
                  </Button>
                ) : undefined
              }
            >
              {error}
            </Notice>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
