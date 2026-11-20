# AiMY Meetings — Architecture & Technical Documentation

**AiMY Meetings** is a desktop meeting recorder, neural audio enhancer, and **AiMY Knowledge** synchronization companion built with **Electron 35**, **React 19**, **TypeScript 5.8**, **Tailwind CSS 4**, and the official **AiMY UI** design system (`@flairstech-aimy/ui` + `@flairstech-aimy/tokens`).

---

## 1. System Architecture Overview

```mermaid
flowchart TB
    subgraph Renderer["Renderer Process (React 19 + @flairstech-aimy/ui)"]
        UI["Dashboard & Recording Detail UI"]
        PromptUI["Floating Meeting Prompt (?mode=prompt)"]
        Capture["WebAudio Mixer (System Loopback + Mic + Limiter)"]
    end

    subgraph Preload["Preload Bridge (contextIsolation: true)"]
        API["window.aimyDesktop IPC Bridge"]
    end

    subgraph Main["Electron Main Process (Node.js)"]
        Index["App Lifecycle, Custom Protocol (aimy-media://) & Tray"]
        Detector["MeetingDetector (Windows ConsentStore + Win32 / macOS)"]
        Store["RecorderStore (JSON DB + Audio Files)"]
        Enhancer["AudioEnhancer (DeepFilterNet3 + FFmpeg)"]
        Auth["AuthManager (Cognito OAuth + safeStorage Encryption)"]
        Sync["SyncManager & AimyApiClient"]
    end

    subgraph Native["Bundled Native Binaries (resources/)"]
        DF["resources/bin/deep-filter.exe (DeepFilterNet3)"]
    end

    subgraph Cloud["AiMY Knowledge Cloud"]
        Cognito["AWS Cognito OAuth2 / OIDC"]
        AimyAPI["AiMY Documents & Voice API"]
        AimyConsole["AiMY Knowledge Web Console"]
    end

    UI <--> API
    PromptUI <--> API
    Capture --> API
    API <--> Index
    Index --> Detector
    Index --> Store
    Index --> Auth
    Index --> Sync
    Store --> Enhancer
    Enhancer --> DF
    Auth <--> Cognito
    Auth <--> AimyConsole
    Sync <--> AimyAPI
```

---

## 2. Project Directory Layout

```text
aimy-meetings/
├── .github/
│   └── workflows/
│       └── release.yml                 # Automated GitHub Release workflow on v* tags
├── docs/
│   ├── ARCHITECTURE.md                 # System architecture & internal technical reference
│   ├── INSTALLATION.md                 # End-user & developer installation guide
│   └── RELEASES.md                     # Packaging, versioning & release publishing guide
├── resources/
│   ├── icon.ico / icon.png / icon.svg  # Application branding icons
│   ├── tray-idle.png / tray-recording.png
│   └── bin/
│       └── deep-filter.exe             # DeepFilterNet3 48kHz full-band neural speech enhancer
├── scripts/
│   └── package-release.ps1             # Standalone Windows x64 release packager & SHA256 generator
├── src/
│   ├── main/
│   │   ├── index.ts                    # Electron entry point, tray, custom media protocol & IPC
│   │   ├── aimyApi.ts                  # Streaming multipart & JSON client for AiMY Knowledge API
│   │   ├── appIcons.ts                 # NativeImage icon loader for window, tray & notifications
│   │   ├── audioEnhancer.ts            # DeepFilterNet3 + FFmpeg loudness normalization pipeline
│   │   ├── auth.ts                     # System-browser PKCE OAuth, embedded fallback, expiry monitor & safeStorage
│   │   ├── connectivity.ts             # Online/offline & wake reachability monitor for local-first sync
│   │   ├── meetingDetector.ts          # Active call detector (Teams, Zoom, Meet, Slack, Webex, Discord)
│   │   ├── promptWindow.ts             # Always-on-top bottom-right meeting detection banner window
│   │   ├── recorderStore.ts            # Persistent recordings/settings store & crash recovery
│   │   └── syncManager.ts              # Background upload, transcription polling & indexing manager
│   ├── preload/
│   │   └── index.ts                    # Type-safe contextBridge exposing window.aimyDesktop
│   ├── renderer/
│   │   ├── App.tsx                     # Main dashboard & meeting prompt router
│   │   ├── components/
│   │   │   ├── LiveRecorderBar.tsx     # Active recording controls, waveform & live notes drawer
│   │   │   ├── MeetingPrompt.tsx       # Notion-style bottom-right meeting detection banner
│   │   │   ├── RecordingCard.tsx       # Sidebar list item with live status badges & progress
│   │   │   ├── RecordingDetail.tsx     # Audio player, notes editor & AiMY sync actions
│   │   │   ├── SettingsDialog.tsx      # Workspace targets & audio devices
│   │   │   └── SignInPromptDialog.tsx  # Contextual sign-in modal with browser PKCE, built-in fallback & local-only mode
│   │   └── lib/
│   │       ├── audioCapture.ts         # WebAudio loopback + microphone mixer
│   │       └── format.ts               # Timestamp, duration & file-size formatters
│   └── shared/
│       └── types.ts                    # Shared TypeScript interfaces, sync states & default settings
├── CHANGELOG.md
├── electron.vite.config.ts
├── package.json
└── README.md
```

---

## 3. Core Subsystems

### 3.1 Dual-Source Audio Capture & Broadcast Limiter (`src/renderer/lib/audioCapture.ts`)
1. **System Loopback Capture**: Uses Electron's `session.defaultSession.setDisplayMediaRequestHandler` to grant Windows WASAPI loopback audio (`audio: 'loopback'`) via `navigator.mediaDevices.getDisplayMedia` without prompting the user for a screen picker.
2. **Microphone Capture**: Requests the user's selected microphone with browser echo cancellation, noise suppression, and auto-gain control enabled.
3. **Mixing & Broadcast Limiting**: Both streams feed into a 48 kHz `AudioContext` through per-channel gain nodes and a master `DynamicsCompressorNode` to prevent clipping when multiple participants speak simultaneously.
4. **Output**: `MediaRecorder` encodes the mixed stream (`audio/webm;codecs=opus`).

### 3.2 Neural Speech Enhancement Pipeline (`src/main/audioEnhancer.ts`)
When a recording finishes (or when an audio file is imported or manually enhanced), `RecorderStore` runs a three-stage mastering pipeline:
1. **Pre-Conditioning (FFmpeg)**: Converts raw audio to 48 kHz 16-bit mono PCM WAV with an 80 Hz high-pass filter (`highpass=f=80`) and `-2 dB` headroom (`volume=-2dB`) to eliminate low-end rumble and prevent neural clipping.
2. **Full-Band Neural Denoising (`DeepFilterNet3`)**: Executes `resources/bin/deep-filter.exe --pf --compensate-delay` to remove background noise (fans, typing, street noise, room reverb) while preserving speech formants.
3. **Speech Loudness Normalization & MP3 Encoding (FFmpeg)**: Applies dynamic audio normalization (`dynaudnorm=f=150:g=15:p=0.9:m=10`) and encodes to a clean 44.1 kHz mono `128 kbps` `.mp3` ready for AiMY ingestion.
4. **Automatic Fallback**: If `deep-filter.exe` is unavailable, gracefully falls back to FFmpeg spectral FFT denoising (`highpass=f=80,afftdn=nf=-25,dynaudnorm=f=150:g=15:p=0.9:m=10`).

### 3.3 Automatic Meeting Detection (`src/main/meetingDetector.ts`)
- **Windows Detection Worker**: Spawns a hidden background PowerShell worker that polls every 2.5 seconds:
  1. Reads `HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{microphone,webcam}` (both packaged and `NonPackaged` apps) where `LastUsedTimeStop == 0`.
  2. Enumerates visible top-level windows and their owning process names via P/Invoke `user32.dll` (`EnumWindows`, `IsWindowVisible`, `GetWindowText`, `GetWindowThreadProcessId`).
- **macOS Detection Worker**: Uses `osascript` (`System Events`) to inspect visible application windows every 4 seconds.
- **Supported Meeting Platforms**:
  - **Microsoft Teams** (Desktop & Web — automatically ignores idle chat/calendar tabs and pre-join setup screens)
  - **Zoom** (Desktop & Web)
  - **Google Meet** (Chrome, Edge, Brave, Firefox, Arc, Opera, Vivaldi)
  - **Slack Huddles** (Desktop & Web)
  - **Cisco Webex**
  - **Discord Voice Calls**
- **Auto-Start & Auto-Stop**:
  - Displays a non-intrusive bottom-right floating prompt (`PromptWindowManager`) or automatically starts recording if `autoRecordOnMeeting` is enabled.
  - Automatically stops recording when the meeting call ends (`autoStopOnMeetingEnd`) after 3 consecutive end-of-call polls (~7.5 seconds).

### 3.4 AiMY Knowledge Authentication, Offline-First & Sync State Machine (`src/main/auth.ts`, `src/main/connectivity.ts`, `src/main/syncManager.ts`)
- **Authentication**:
  - **System Browser PKCE OAuth (Default)**: Registers the `aimy-meetings://` custom protocol (`aimy-meetings://auth/callback`) and opens AWS Cognito Hosted UI in the user's default browser using OAuth2 Authorization Code + PKCE (`S256`) so browser autofill, password managers, and existing SSO sessions work seamlessly.
  - **Built-in Window Fallback**: Also supports an isolated `persist:aimy-auth` Electron `BrowserWindow` pointed at `${consoleBaseUrl}/console` (capturing tokens via `webRequest.onBeforeSendHeaders` and OIDC storage) in case the custom protocol callback isn't registered in Cognito yet.
  - **Session Lifecycle & Auto-Prompt**: Encrypts credentials at `%APPDATA%/aimy-meetings/auth-session.dat` using OS-level `safeStorage`, proactively refreshes tokens 60 seconds before expiry, retries once on `401`, and prompts the user via an in-app modal on startup (when unauthenticated), sign-out, or token expiry — suppressed automatically while offline so local-first recording is never interrupted.
  - **Local-First & Reconnect Sync**: `ConnectivityMonitor` combines `net.isOnline()`, reachability probes, and OS wake events. Recordings captured offline or while signed out remain `LOCAL_PENDING` and sync automatically once back online and authenticated.
  - Also supports manual JWT token entry in Settings.
- **Sync Modes**:
  1. **`audio-recording` (Default)**: Streams the enhanced `.mp3` via multipart upload to `POST /processing/audio` (with automatic fallback to `POST /processing`) with real-time byte progress (`uploadProgress: 0..100`).
  2. **`transcript-json`**: Uploads structured Markdown containing meeting metadata and user notes to `POST /processing/json`.
- **Recording Sync Lifecycle (`RecordingSyncStatus`)**:

```mermaid
stateDiagram-v2
    [*] --> RECORDING: Start recording
    RECORDING --> ENCODING: Stop recording
    ENCODING --> LOCAL_PENDING: DeepFilterNet3 + MP3 ready
    LOCAL_PENDING --> UPLOADING: Sync triggered (Auto or Manual)
    UPLOADING --> TRANSCRIBING: HTTP 202 (Async AiMY processing)
    UPLOADING --> SYNCED: HTTP 200 (Immediate ingestion)
    UPLOADING --> FAILED: Network / Auth error
    TRANSCRIBING --> READY_FOR_REVIEW: Remote status = READY_FOR_REVIEW
    TRANSCRIBING --> SYNCED: Remote status = INGESTED
    TRANSCRIBING --> FAILED: Remote status = FAILED
    READY_FOR_REVIEW --> INDEXING: Add to Knowledge (POST /v2/documents/{id}/index)
    INDEXING --> SYNCED: Indexing complete
    FAILED --> UPLOADING: Retry Sync
```

---

## 4. Local Data & Custom Media Protocol

All user data is stored in Electron's `app.getPath('userData')` directory (`%APPDATA%\aimy-meetings` on Windows):

| File / Directory | Purpose |
| :--- | :--- |
| `settings.json` | Persisted `AppSettings` (target group, agents, audio devices) |
| `recordings.json` | Metadata, sync status, and notes for all recordings |
| `recordings/<id>.mp3` | Enhanced mono 128 kbps MP3 audio files |
| `auth-session.dat` | DPAPI / Keychain `safeStorage`-encrypted Cognito OAuth tokens |

Audio playback in the renderer uses the custom privileged protocol `aimy-media://recording/<id>`, handled by `net.fetch(pathToFileURL(item.audioPath))` in the main process with full HTTP Range header support for instant scrubbing.
