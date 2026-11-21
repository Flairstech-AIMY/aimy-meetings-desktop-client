import { useEffect, useState } from 'react'
import {
  Button,
  Chip,
  CopyButton,
  Dialog,
  DialogContent,
  Divider,
  Field,
  Input,
  Notice,
  PasswordField,
  Segmented,
  Select,
  SelectItem,
  Switch,
  Tab,
  Tabs,
  TabsList,
  Tag,
  toast
} from '@flairstech-aimy/ui'
import {
  AudioLines,
  BellRing,
  Check,
  Cloud,
  KeyRound,
  Link2,
  SlidersHorizontal
} from 'lucide-react'
import type {
  AimyGroup,
  AppSettings,
  UploadMode
} from '@shared/types'
import { DeepFilterAudioTester } from './DeepFilterAudioTester'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: AppSettings
  groups: AimyGroup[]
  isAuthenticated: boolean
  authCallbackUrl: string
  ffmpegAvailable: boolean
  deepFilterAvailable: boolean
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>
  onManualToken: (token: string) => Promise<void>
  onSimulateMeeting: () => Promise<void>
}

type SettingsTab = 'sync' | 'audio' | 'connection'

const DEEP_FILTER_PRESETS = [
  { label: 'Light', value: 25 },
  { label: 'Balanced', value: 50 },
  { label: 'Strong', value: 75 },
  { label: 'Max', value: 100 }
] as const

function formatAttenuationReadout(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  if (clamped <= 0) return '0% · Off'
  if (clamped >= 100) return '100% · Max'
  const db = Math.round(clamped * 0.4 * 10) / 10
  const dbText = Number.isInteger(db) ? String(db) : db.toFixed(1)
  return `${clamped}% · ${dbText} dB`
}

function describeDeepFilterStrength(percent: number): string {
  if (percent <= 0) {
    return 'Bypassed — audio will be encoded to MP3 without noise suppression.'
  }
  if (percent <= 35) {
    return 'Light cleanup — reduces subtle hum and hiss while preserving natural room ambience.'
  }
  if (percent <= 65) {
    return 'Balanced — cleans fans, AC, and keyboard clicks while keeping speech warm and natural.'
  }
  if (percent < 100) {
    return 'Strong suppression — ideal for noisy offices and loud background distractions.'
  }
  return 'Maximum suppression — full DeepFilterNet3 attenuation with no attenuation limit.'
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  groups,
  isAuthenticated,
  authCallbackUrl,
  ffmpegAvailable,
  deepFilterAvailable,
  onSaveSettings,
  onManualToken,
  onSimulateMeeting
}: SettingsDialogProps) {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [manualToken, setManualToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [applyingToken, setApplyingToken] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('sync')

  useEffect(() => {
    setDraft(settings)
  }, [settings, open])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSaveSettings(draft)
      toast('Settings saved', { sub: 'Your recording and AiMY sync defaults are updated.' })
      onOpenChange(false)
    } catch (err) {
      toast('Could not save settings', {
        tone: 'err',
        sub: err instanceof Error ? err.message : 'Unexpected error'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleApplyToken = async (): Promise<void> => {
    if (!manualToken.trim()) return
    setApplyingToken(true)
    try {
      await onManualToken(manualToken)
      setManualToken('')
      toast('Token applied', { sub: 'Signed in using your Cognito JWT.' })
    } catch (err) {
      toast('Invalid token', {
        tone: 'err',
        sub: err instanceof Error ? err.message : 'Check that you copied a valid Cognito JWT.'
      })
    } finally {
      setApplyingToken(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Preferences"
        description="Configure AiMY Knowledge sync defaults, automatic meeting detection, and audio capture."
        size="wide"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="brand" onClick={() => void handleSave()} loading={saving}>
              <Check className="size-3.5" />
              Save changes
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Clean Settings Navigation Tabs */}
          <div className="border-b border-hairline pb-2">
            <Tabs
              size="section"
              value={tab}
              onValueChange={(v) => setTab(v as SettingsTab)}
            >
              <TabsList>
                <Tab value="sync">
                  <Cloud className="size-3.5" />
                  Knowledge Sync
                </Tab>
                <Tab value="audio">
                  <AudioLines className="size-3.5" />
                  Calls &amp; Audio
                </Tab>
                <Tab value="connection">
                  <Link2 className="size-3.5" />
                  Connection &amp; Auth
                </Tab>
              </TabsList>
            </Tabs>
          </div>

          {/* Tab 1: Knowledge Sync Defaults */}
          {tab === 'sync' && (
            <div className="flex flex-col gap-4 py-1">
              <div className="grid grid-cols-1 gap-4 column:grid-cols-2">
                <Field
                  label="Default target group"
                  help={
                    isAuthenticated
                      ? 'New recordings will sync into this AiMY group automatically.'
                      : 'Sign in with AiMY to load your accessible workspace groups.'
                  }
                >
                  <Select
                    value={draft.defaultGroupId != null ? String(draft.defaultGroupId) : undefined}
                    onValueChange={(val) =>
                      setDraft((d) => ({ ...d, defaultGroupId: Number(val) || null }))
                    }
                    placeholder="Select default group"
                    disabled={!isAuthenticated || groups.length === 0}
                  >
                    {groups.map((g) => (
                      <SelectItem key={g.group_id} value={String(g.group_id)}>
                        {g.client_name ? `${g.client_name} · ${g.group_name}` : g.group_name}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Default upload format"
                  help="Upload audio for AiMY cloud transcription, or push meeting notes directly."
                >
                  <Segmented
                    label="Default upload format"
                    value={draft.defaultUploadMode}
                    onValueChange={(v) =>
                      setDraft((d) => ({ ...d, defaultUploadMode: v as UploadMode }))
                    }
                    options={[
                      { value: 'audio-recording', label: 'Audio file' },
                      { value: 'transcript-json', label: 'Notes / JSON' }
                    ]}
                  />
                </Field>
              </div>

              <div className="rounded-xl border border-hairline bg-sunken p-4">
                <h4 className="m-0 mb-3 text-xs font-semibold text-ink">
                  Automation &amp; visibility rules
                </h4>
                <div className="grid grid-cols-1 gap-3 column:grid-cols-2">
                  <Switch
                    label="Auto-sync recording to AiMY when stopped"
                    checked={draft.autoSyncAfterRecording}
                    onCheckedChange={(checked) =>
                      setDraft((d) => ({ ...d, autoSyncAfterRecording: checked }))
                    }
                  />
                  <Switch
                    label="Auto-index to Knowledge after transcription"
                    checked={draft.autoIndexAfterTranscription}
                    onCheckedChange={(checked) =>
                      setDraft((d) => ({ ...d, autoIndexAfterTranscription: checked }))
                    }
                  />
                  <Switch
                    label="Mark new recordings as Personal by default"
                    checked={true}
                    disabled
                    lockedReason="Enforced by default — can only be changed from AiMY Knowledge."
                  />
                  <Switch
                    label="Upload as Draft lifecycle by default"
                    checked={true}
                    disabled
                    lockedReason="Enforced by default — can only be changed from AiMY Knowledge."
                  />
                </div>
                <p className="m-0 mt-2.5 text-2xs text-ink-quiet">
                  Personal visibility and Draft lifecycle are locked as defaults and can only be changed in AiMY Knowledge.
                </p>
              </div>
            </div>
          )}

          {/* Tab 2: Calls & Audio */}
          {tab === 'audio' && (
            <div className="flex flex-col gap-4 py-1">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline bg-sunken px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-ink">
                      Automatic meeting detection
                    </span>
                    {deepFilterAvailable && <Tag tone="ai">DeepFilterNet3 active</Tag>}
                  </div>
                  <p className="m-0 mt-0.5 text-2xs text-ink-secondary">
                    Monitors Zoom, Microsoft Teams, Google Meet, Slack Huddles, Webex, and Discord.
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void onSimulateMeeting()}>
                  <BellRing className="size-3.5" />
                  Test meeting banner
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 rounded-xl border border-hairline bg-sunken p-4 column:grid-cols-2">
                <Switch
                  label="Detect active calls automatically"
                  checked={draft.detectMeetings}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, detectMeetings: checked }))
                  }
                />
                <Switch
                  label="Auto-start recording without asking"
                  checked={draft.autoRecordOnMeeting}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, autoRecordOnMeeting: checked }))
                  }
                />
                <Switch
                  label="Auto-stop recording when call ends"
                  checked={draft.autoStopOnMeetingEnd}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, autoStopOnMeetingEnd: checked }))
                  }
                />
                <Switch
                  label="Neural noise cancellation (DeepFilterNet3)"
                  checked={draft.enhanceAudio}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, enhanceAudio: checked }))
                  }
                />
                <Switch
                  label="Capture system / meeting audio (loopback)"
                  checked={draft.captureSystemAudio}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, captureSystemAudio: checked }))
                  }
                />
                <Switch
                  label="Capture microphone audio"
                  checked={draft.captureMicrophone}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, captureMicrophone: checked }))
                  }
                />
              </div>

              {draft.enhanceAudio && (() => {
                const strength = Math.max(0, Math.min(100, draft.deepFilterStrength ?? 50))
                const postFilter = draft.deepFilterPostFilter ?? true
                return (
                  <div className="flex flex-col gap-3 rounded-xl border border-hairline bg-sunken p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <SlidersHorizontal className="size-3.5 text-ai-ink" />
                        <span className="text-xs font-semibold text-ink">
                          DeepFilterNet3 tuning
                        </span>
                      </div>
                      <Tag tone={strength > 0 ? 'ai' : 'neutral'} className="font-mono">
                        {formatAttenuationReadout(strength)}
                      </Tag>
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label
                          htmlFor="deepfilter-strength-slider"
                          className="text-2xs font-medium text-ink-secondary"
                        >
                          Noise filtering strength
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {DEEP_FILTER_PRESETS.map((preset) => (
                            <Chip
                              key={preset.value}
                              selected={strength === preset.value}
                              onClick={() =>
                                setDraft((d) => ({ ...d, deepFilterStrength: preset.value }))
                              }
                            >
                              {preset.label} ({preset.value}%)
                            </Chip>
                          ))}
                        </div>
                      </div>

                      <input
                        id="deepfilter-strength-slider"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={strength}
                        aria-label="DeepFilterNet3 noise filtering strength percentage"
                        aria-valuetext={formatAttenuationReadout(strength)}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            deepFilterStrength: Number(e.target.value)
                          }))
                        }
                        className="aimy-range my-1"
                        style={{
                          background: `linear-gradient(to right, var(--brand) 0%, var(--brand) ${strength}%, var(--w14) ${strength}%, var(--w14) 100%)`
                        }}
                      />

                      <div className="flex items-center justify-between font-mono text-2xs text-ink-quiet">
                        <span>0%</span>
                        <span>25%</span>
                        <span>50%</span>
                        <span>75%</span>
                        <span>100%</span>
                      </div>

                      <p className="m-0 text-2xs text-ink-secondary">
                        {describeDeepFilterStrength(strength)}
                      </p>
                    </div>

                    <Divider />

                    <div className="flex flex-col gap-1">
                      <Switch
                        label="Post-filter for residual noise (--pf)"
                        checked={postFilter}
                        disabled={strength === 0}
                        onCheckedChange={(checked) =>
                          setDraft((d) => ({ ...d, deepFilterPostFilter: checked }))
                        }
                      />
                      <p className="m-0 text-2xs text-ink-quiet">
                        Applies extra attenuation to quiet background noise. Turn off for a more natural voice timbre.
                      </p>
                    </div>

                    <Divider />

                    <DeepFilterAudioTester
                      open={open && tab === 'audio'}
                      strengthPercent={strength}
                      postFilter={postFilter}
                      ffmpegAvailable={ffmpegAvailable}
                    />
                  </div>
                )
              })()}

              {!ffmpegAvailable && (
                <Notice tone="warn" title="FFmpeg not detected on PATH">
                  Live browser recordings are captured as WebM and converted to MP3 using FFmpeg so
                  AiMY accepts them. Install FFmpeg or import MP3/WAV/M4A files directly.
                </Notice>
              )}
            </div>
          )}

          {/* Tab 3: Connection & Authentication */}
          {tab === 'connection' && (
            <div className="flex flex-col gap-4 py-1">
              <div className="grid grid-cols-1 gap-3 column:grid-cols-2">
                <Field label="PEX Upload API URL">
                  <Input
                    value={draft.apiBaseUrl}
                    onChange={(e) => setDraft((d) => ({ ...d, apiBaseUrl: e.target.value }))}
                  />
                </Field>
                <Field label="AiMY Knowledge Console URL">
                  <Input
                    value={draft.consoleBaseUrl}
                    onChange={(e) => setDraft((d) => ({ ...d, consoleBaseUrl: e.target.value }))}
                  />
                </Field>
              </div>

              <div className="rounded-xl border border-hairline bg-sunken p-4">
                <Field
                  label="Browser sign-in callback URL"
                  help="Register this URI under Allowed callback URLs on the AWS Cognito App Client to enable system-browser PKCE sign-in with autofill."
                >
                  <div className="flex items-center gap-2 pt-1">
                    <Input value={authCallbackUrl} readOnly className="font-mono text-xs" />
                    <CopyButton value={authCallbackUrl} what="the OAuth callback URL" />
                  </div>
                </Field>
              </div>

              <div className="rounded-xl border border-hairline bg-sunken p-4">
                <Field
                  label="Manual Cognito JWT token"
                  optional
                  help="Normally you sign in with the top-bar button. Paste a Cognito id_token here only when testing a custom token directly."
                >
                  <div className="flex items-center gap-2 pt-1">
                    <PasswordField
                      secretName="the Cognito JWT token"
                      value={manualToken}
                      onChange={(e) => setManualToken(e.target.value)}
                      placeholder="eyJhbGciOiJSUzI1NiIs..."
                    />
                    <Button
                      variant="ghost"
                      size="md"
                      loading={applyingToken}
                      disabled={!manualToken.trim()}
                      onClick={() => void handleApplyToken()}
                    >
                      <KeyRound className="size-3.5" />
                      Apply token
                    </Button>
                  </div>
                </Field>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
