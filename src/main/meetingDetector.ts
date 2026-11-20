import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type { DetectedMeeting } from '@shared/types'

interface WindowCandidate {
  processName: string
  title: string
}

interface ProbeSnapshot {
  micApps: string[]
  camApps: string[]
  windows: WindowCandidate[]
}

const DISMISS_COOLDOWN_MS = 30 * 60 * 1000
const MAC_POLL_INTERVAL_MS = 4000

const TEAMS_IDLE_TABS =
  /^(activity|chat|teams|calendar|calls|files|apps|workflows|notifications|microsoft teams)(\s*\|\s*microsoft teams)?$/i

const TEAMS_PREJOIN_PATTERN =
  /^(meeting join|join a meeting|choose your audio|pre-join)\b/i

const WINDOWS_WORKER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$winCode = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class AimyWinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  public static List<string[]> GetVisibleWindows() {
    var list = new List<string[]>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      var title = sb.ToString().Trim();
      if (title.Length > 0) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        list.Add(new string[] { pid.ToString(), title });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
Add-Type -TypeDefinition $winCode -ErrorAction SilentlyContinue

function Get-ActiveConsentApps($capability) {
  $active = @()
  $paths = @(
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\$capability",
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\$capability\\NonPackaged"
  )
  foreach ($bp in $paths) {
    if (Test-Path $bp) {
      Get-ChildItem $bp | ForEach-Object {
        $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($props -and $props.LastUsedTimeStop -eq 0 -and $props.LastUsedTimeStart -gt 0) {
          $active += $_.PSChildName
        }
      }
    }
  }
  return $active
}

while ($true) {
  try {
    $micApps = @(Get-ActiveConsentApps 'microphone')
    $camApps = @(Get-ActiveConsentApps 'webcam')
    $procs = @{}
    Get-Process | ForEach-Object { $procs[$_.Id.ToString()] = $_.ProcessName }
    $wins = @()
    foreach ($entry in [AimyWinEnum]::GetVisibleWindows()) {
      $pn = $procs[$entry[0]]
      if ($pn) {
        $wins += [PSCustomObject]@{ processName = $pn; title = $entry[1] }
      }
    }
    $payload = [PSCustomObject]@{
      micApps = $micApps
      camApps = $camApps
      windows = $wins
    } | ConvertTo-Json -Depth 3 -Compress
    [Console]::Out.WriteLine($payload)
    [Console]::Out.Flush()
  } catch {}
  Start-Sleep -Milliseconds 2500
}
`

function runMacProbe(): Promise<ProbeSnapshot> {
  const script = `
    tell application "System Events"
      set outList to ""
      repeat with p in (every application process whose visible is true)
        try
          set pname to name of p
          repeat with w in (every window of p)
            set wname to name of w
            if wname is not "" then
              set outList to outList & pname & "|||" & wname & linefeed
            end if
          end repeat
        end try
      end repeat
      return outList
    end tell
  `
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve({ micApps: [], camApps: [], windows: [] })
        return
      }
      const windows: WindowCandidate[] = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [processName, ...rest] = line.split('|||')
          return { processName: processName || '', title: rest.join('|||') || '' }
        })
      resolve({ micApps: [], camApps: [], windows })
    })
  })
}

function isOwnApp(appKey: string): boolean {
  const lower = appKey.toLowerCase()
  return lower.includes('aimy meetings') || lower.includes('aimy-meetings') || lower.endsWith('electron.exe')
}

function cleanTeamsTitle(rawTitle: string): string {
  const parts = rawTitle
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^microsoft teams$/i.test(p) && !/^meeting join$/i.test(p))
  if (parts.length > 0) {
    return parts[0]
  }
  return rawTitle
    .replace(/\s*\|\s*Microsoft Teams.*$/i, '')
    .replace(/^Meeting\s*[-–—|]\s*/i, '')
    .trim()
}

export interface MeetingDetectorCallbacks {
  onDetected: (meeting: DetectedMeeting) => void
  onEnded?: (info: { app: string; wasRecording: boolean }) => void
}

export class MeetingDetector {
  private worker: ChildProcess | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private macTimer: NodeJS.Timeout | null = null
  private macChecking = false
  private isRecording = false
  private recordingTracksMeeting = false
  private recordingStartedAt = 0
  private recordingApp: string | null = null
  private enabled = true
  private stopped = false
  private activeMeetingKey: string | null = null
  private activeMeetingApp: string | null = null
  private missedPolls = 0
  private dismissedUntil = new Map<string, number>()

  constructor(private callbacks: MeetingDetectorCallbacks) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.activeMeetingKey = null
      this.activeMeetingApp = null
    }
  }

  setRecordingActive(recording: boolean, meetingApp?: string | null, title?: string): void {
    this.isRecording = recording
    if (recording) {
      this.recordingStartedAt = Date.now()
      this.missedPolls = 0
      const isSimulated = Boolean(title && title.includes('(Simulated)'))
      const fromMeetingApp =
        !isSimulated &&
        Boolean(meetingApp && meetingApp !== 'Manual' && meetingApp !== 'Imported Audio')
      this.recordingTracksMeeting = fromMeetingApp || Boolean(this.activeMeetingKey)
      this.recordingApp = fromMeetingApp ? meetingApp ?? null : this.activeMeetingApp
    } else {
      this.recordingTracksMeeting = false
      this.recordingStartedAt = 0
      this.recordingApp = null
      this.missedPolls = 0
    }
  }

  dismiss(meetingKeyOrId: string): void {
    this.dismissedUntil.set(meetingKeyOrId, Date.now() + DISMISS_COOLDOWN_MS)
    if (this.activeMeetingKey) {
      this.dismissedUntil.set(this.activeMeetingKey, Date.now() + DISMISS_COOLDOWN_MS)
    }
  }

  start(): void {
    this.stopped = false
    if (process.platform === 'win32') {
      this.startWindowsWorker()
    } else if (process.platform === 'darwin') {
      if (!this.macTimer) {
        this.macTimer = setInterval(() => void this.tickMac(), MAC_POLL_INTERVAL_MS)
      }
    }
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.macTimer) {
      clearInterval(this.macTimer)
      this.macTimer = null
    }
    if (this.worker) {
      try {
        this.worker.kill()
      } catch {
        // ignore
      }
      this.worker = null
    }
  }

  simulateMeeting(): DetectedMeeting {
    const meeting: DetectedMeeting = {
      id: randomUUID(),
      app: 'Microsoft Teams',
      title: 'Weekly Product Sync (Simulated)',
      detectedAt: new Date().toISOString(),
      micActive: true
    }
    this.callbacks.onDetected(meeting)
    return meeting
  }

  private startWindowsWorker(): void {
    if (this.worker || this.stopped) return

    const encoded = Buffer.from(WINDOWS_WORKER_SCRIPT, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    this.worker = child

    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('{')) {
          this.handleSnapshotLine(line)
        }
        nl = buffer.indexOf('\n')
      }
    })

    child.on('exit', () => {
      this.worker = null
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          this.startWindowsWorker()
        }, 4000)
      }
    })
  }

  private async tickMac(): Promise<void> {
    if (!this.enabled || this.macChecking) return
    if (this.isRecording && !this.recordingTracksMeeting) return
    this.macChecking = true
    try {
      const snapshot = await runMacProbe()
      this.processSnapshot(snapshot)
    } finally {
      this.macChecking = false
    }
  }

  private handleSnapshotLine(line: string): void {
    if (!this.enabled) return
    if (this.isRecording && !this.recordingTracksMeeting) return
    try {
      const parsed = JSON.parse(line) as {
        micApps?: string[] | string
        camApps?: string[] | string
        windows?: WindowCandidate[] | WindowCandidate
      }
      const normalizeArr = <T>(v: T[] | T | undefined): T[] =>
        Array.isArray(v) ? v : v ? [v] : []

      this.processSnapshot({
        micApps: normalizeArr(parsed.micApps).filter((a) => !isOwnApp(a)),
        camApps: normalizeArr(parsed.camApps).filter((a) => !isOwnApp(a)),
        windows: normalizeArr(parsed.windows)
      })
    } catch {
      // ignore malformed JSON chunk
    }
  }

  private processSnapshot(snapshot: ProbeSnapshot): void {
    const matched = this.findMeeting(snapshot)

    if (!matched) {
      if (this.isRecording && this.recordingTracksMeeting) {
        // Wait at least 8 seconds after starting and 3 consecutive missed polls (~7.5s) before ending
        if (Date.now() - this.recordingStartedAt < 8000) return
        this.missedPolls += 1
        if (this.missedPolls >= 3) {
          const endedApp = this.recordingApp || this.activeMeetingApp || 'Meeting'
          this.activeMeetingKey = null
          this.activeMeetingApp = null
          this.recordingTracksMeeting = false
          this.missedPolls = 0
          this.callbacks.onEnded?.({ app: endedApp, wasRecording: true })
        }
        return
      }

      if (this.activeMeetingKey) {
        this.missedPolls += 1
        if (this.missedPolls >= 2) {
          const endedApp = this.activeMeetingApp || 'Meeting'
          this.activeMeetingKey = null
          this.activeMeetingApp = null
          this.missedPolls = 0
          this.callbacks.onEnded?.({ app: endedApp, wasRecording: false })
        }
      }
      return
    }

    this.missedPolls = 0
    const key = matched.sessionKey

    if (this.isRecording) {
      this.activeMeetingKey = key
      this.activeMeetingApp = matched.app
      return
    }

    const now = Date.now()
    const dismissedUntil = this.dismissedUntil.get(key)
    if (dismissedUntil && dismissedUntil > now) {
      return
    }

    if (this.activeMeetingKey === key) {
      return
    }

    this.activeMeetingKey = key
    this.activeMeetingApp = matched.app
    this.callbacks.onDetected({
      id: key,
      app: matched.app,
      title: matched.title,
      detectedAt: new Date().toISOString(),
      micActive: matched.micActive
    })
  }

  private findMeeting(
    snapshot: ProbeSnapshot
  ): { app: string; title: string; sessionKey: string; micActive: boolean } | null {
    const activeDevices = [...new Set([...snapshot.micApps, ...snapshot.camApps])]
    const micSet = new Set(snapshot.micApps.map((s) => s.toLowerCase()))

    // 1. Direct desktop meeting app actively using microphone or webcam
    for (const rawApp of activeDevices) {
      const lower = rawApp.toLowerCase()
      const hasMic = micSet.has(lower)

      if (lower.includes('msteams') || lower.includes('ms-teams') || lower.endsWith('teams.exe')) {
        // Don't pop up while the user is still on the pre-join audio/camera setup screen
        const hasPreJoin = snapshot.windows.some(
          (w) =>
            (/ms-teams|teams/i.test(w.processName) || /microsoft teams/i.test(w.title)) &&
            TEAMS_PREJOIN_PATTERN.test(w.title.trim())
        )
        const teamsTitle = this.findBestTeamsWindowTitle(snapshot.windows)
        if (hasPreJoin && !teamsTitle) {
          continue
        }
        const title = teamsTitle || 'Microsoft Teams Meeting'
        return {
          app: 'Microsoft Teams',
          title,
          sessionKey: `teams::${title.toLowerCase().slice(0, 64)}`,
          micActive: hasMic
        }
      }

      if (lower.includes('zoom.exe') || lower.includes('cpthost.exe') || lower.includes('zoomus')) {
        const win = snapshot.windows.find(
          (w) => /zoom/i.test(w.processName) && /meeting/i.test(w.title)
        )
        const title = win?.title || 'Zoom Meeting'
        return {
          app: 'Zoom',
          title,
          sessionKey: `zoom::${title.toLowerCase().slice(0, 64)}`,
          micActive: hasMic
        }
      }

      if (lower.includes('slack.exe')) {
        const win = snapshot.windows.find(
          (w) => /slack/i.test(w.processName) || /huddle/i.test(w.title)
        )
        const title = win?.title || 'Slack Huddle'
        return {
          app: 'Slack Huddle',
          title,
          sessionKey: `slack::${title.toLowerCase().slice(0, 64)}`,
          micActive: hasMic
        }
      }

      if (lower.includes('webex') || lower.includes('ciscocollab') || lower.includes('atmgr.exe')) {
        const win = snapshot.windows.find((w) => /webex/i.test(w.title) || /webex|cisco/i.test(w.processName))
        const title = win?.title || 'Webex Meeting'
        return {
          app: 'Webex',
          title,
          sessionKey: `webex::${title.toLowerCase().slice(0, 64)}`,
          micActive: hasMic
        }
      }

      if (lower.includes('discord.exe')) {
        const win = snapshot.windows.find((w) => /discord/i.test(w.processName))
        const title = win?.title || 'Discord Call'
        return {
          app: 'Discord',
          title,
          sessionKey: `discord::${title.toLowerCase().slice(0, 64)}`,
          micActive: hasMic
        }
      }
    }

    // 2. Browser actively using microphone or webcam (Google Meet, Teams Web, Zoom Web, Slack Web)
    const activeBrowser = activeDevices.find((a) =>
      /(chrome|msedge|brave|firefox|opera|arc|vivaldi)\.exe/i.test(a)
    )
    if (activeBrowser) {
      const browserMic = micSet.has(activeBrowser.toLowerCase())
      const browserWindows = snapshot.windows.filter((w) =>
        /chrome|msedge|brave|firefox|opera|arc|vivaldi/i.test(w.processName)
      )

      for (const w of browserWindows) {
        if (/meet\s*[-–—]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}|google meet/i.test(w.title)) {
          return {
            app: 'Google Meet',
            title: w.title.replace(/\s*[-–—]\s*(Google Chrome|Microsoft Edge|Brave|Firefox).*$/i, '').trim(),
            sessionKey: `gmeet::${w.title.toLowerCase().slice(0, 64)}`,
            micActive: browserMic
          }
        }
        if (/microsoft teams/i.test(w.title) && !TEAMS_PREJOIN_PATTERN.test(w.title.trim())) {
          const title = cleanTeamsTitle(w.title) || 'Microsoft Teams (Web)'
          return {
            app: 'Microsoft Teams',
            title,
            sessionKey: `teams-web::${title.toLowerCase().slice(0, 64)}`,
            micActive: browserMic
          }
        }
        if (/zoom/i.test(w.title)) {
          return {
            app: 'Zoom',
            title: w.title.replace(/\s*[-–—]\s*(Google Chrome|Microsoft Edge).*$/i, '').trim(),
            sessionKey: `zoom-web::${w.title.toLowerCase().slice(0, 64)}`,
            micActive: browserMic
          }
        }
        if (/huddle|slack/i.test(w.title)) {
          return {
            app: 'Slack Huddle',
            title: w.title.replace(/\s*[-–—]\s*(Google Chrome|Microsoft Edge).*$/i, '').trim(),
            sessionKey: `slack-web::${w.title.toLowerCase().slice(0, 64)}`,
            micActive: browserMic
          }
        }
      }
    }

    // 3. Fallback: Visible window title match even when mic/cam are not active yet (listen-only / muted join)
    // For Teams desktop, require a separate popped-out meeting window (>= 2 Teams windows) so an idle chat tab never looks like an active call
    const teamsWindows = snapshot.windows.filter(
      (w) => /teams/i.test(w.processName) || /\|\s*microsoft teams/i.test(w.title)
    )
    const teamsMeetingTitle = this.findBestTeamsWindowTitle(teamsWindows)
    if (teamsMeetingTitle && teamsWindows.length >= 2) {
      return {
        app: 'Microsoft Teams',
        title: teamsMeetingTitle,
        sessionKey: `teams-win::${teamsMeetingTitle.toLowerCase().slice(0, 64)}`,
        micActive: false
      }
    }

    for (const w of snapshot.windows) {
      if (/zoom/i.test(w.processName) && /zoom meeting/i.test(w.title)) {
        return {
          app: 'Zoom',
          title: w.title,
          sessionKey: `zoom-win::${w.title.toLowerCase().slice(0, 64)}`,
          micActive: false
        }
      }
      if (/meet\s*[-–—]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(w.title)) {
        return {
          app: 'Google Meet',
          title: w.title.replace(/\s*[-–—]\s*(Google Chrome|Microsoft Edge|Brave|Firefox).*$/i, '').trim(),
          sessionKey: `gmeet-win::${w.title.toLowerCase().slice(0, 64)}`,
          micActive: false
        }
      }
      if (/huddle/i.test(w.title) && /slack/i.test(w.processName + ' ' + w.title)) {
        return {
          app: 'Slack Huddle',
          title: w.title,
          sessionKey: `slack-win::${w.title.toLowerCase().slice(0, 64)}`,
          micActive: false
        }
      }
    }

    return null
  }

  private findBestTeamsWindowTitle(windows: WindowCandidate[]): string | null {
    const candidates = windows.filter(
      (w) =>
        (/ms-teams|teams/i.test(w.processName) || /microsoft teams/i.test(w.title)) &&
        w.title.trim().length > 0 &&
        !TEAMS_IDLE_TABS.test(w.title.trim()) &&
        !TEAMS_PREJOIN_PATTERN.test(w.title.trim())
    )
    if (candidates.length === 0) return null
    // Prefer windows that explicitly mention meeting/call or have a pipe separator
    const preferred =
      candidates.find((w) => /meeting|call/i.test(w.title)) ??
      candidates.find((w) => /\|\s*microsoft teams/i.test(w.title)) ??
      candidates[0]
    const cleaned = cleanTeamsTitle(preferred.title)
    return cleaned && !TEAMS_IDLE_TABS.test(cleaned) ? cleaned : preferred.title
  }
}
