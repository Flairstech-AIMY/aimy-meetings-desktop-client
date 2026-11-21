# Changelog

All notable changes to **AiMY Meetings Desktop Client** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-11-21

### Added
- **Tauri v2 Native Desktop Client (Rust + WebView2)**:
  - Rewrote the desktop host from Electron 35 to **Tauri v2**, dramatically reducing app size (~15 MB Windows installer), memory footprint, and startup time while preserving `%APPDATA%\AiMY Meetings` data and transparently decrypting legacy Electron sessions.
  - Added a dedicated **Windows NSIS Installer** (`AiMY-Meetings-Desktop-Client-v<version>-win-x64-setup.exe`, no admin privileges required) alongside the portable ZIP archive.
  - Added automated CI release publishing on push to `main` (`.github/workflows/release.yml`) with automatic version resolution and GitHub Releases upload.
- **Native Windows WASAPI Audio Capture**:
  - Added native Rust system loopback + microphone capture (`cpal` + `hound`) with real-time 48 kHz mixing and a soft-knee broadcast limiter — no screen-sharing permission popups.
- **DeepFilterNet3 Tuning & Built-In Audio Tester**:
  - Added an adjustable **Noise filtering strength** slider (`0–100%` with Light 25%, Balanced 50%, Strong 75%, and Max 100% presets) and a **Post-filter (`--pf`)** toggle in **Settings → Calls & Audio**.
  - Added an interactive **Before / After Audio Tester** (`DeepFilterAudioTester`) using either an embedded noisy speech sample (`resources/deepfilter-test-sample.mp3`) or a quick 6-second microphone test clip.
- **Interactive Waveform Audio Player**:
  - Added `RecordingAudioPlayer` with smooth 60fps waveform progress, click-and-drag scrubbing, and ±10s skip controls.
- **Non-Technical User Documentation**:
  - Revamped `README.md`, `docs/INSTALLATION.md`, `docs/ARCHITECTURE.md`, and `docs/RELEASES.md` with plain-English Windows installer instructions, SmartScreen guidance, friendly FFmpeg setup steps, and FAQ troubleshooting.

### Improved & Fixed
- **Hardened Automatic Meeting Detection**:
  - Replaced background PowerShell polling with native Win32 (`EnumWindows`, `DwmGetWindowAttribute`, and Registry `ConsentStore`) detection plus a 2-poll confirmation debounce and Rust unit tests.
  - Eliminated false positives from idle Microsoft Teams windows (`Chat`, `Calendar`, `Store`, `Settings`), popped-out chats, pre-join device previews, and DWM-cloaked ghost windows.
- **Playback Stability**:
  - Prevented background sync status polling from resetting the active audio player position.
- **Workspace Defaults & Modal Layering**:
  - Defaulted target group selection to **Personal / Meetings** when available, enforced Personal visibility and Draft lifecycle defaults, and fixed Select dropdown z-index layering above Dialog modals.
- **Release & Dev Fixes**:
  - Included `WebView2Loader.dll` in portable releases when dynamically linked, untracked local Cargo config for clean CI builds, and standardized the Tauri dev server port to `1420`.

---

## [1.0.0] - 2026-11-20

### Added
- **Automatic Meeting Detection**:
  - Background Windows (`CapabilityAccessManager\ConsentStore` + Win32 `EnumWindows`) and macOS (`osascript`) detector for **Microsoft Teams**, **Zoom**, **Google Meet**, **Slack Huddles**, **Cisco Webex**, and **Discord**.
  - Smart filtering for Microsoft Teams idle tabs (`Chat`, `Calendar`, `Activity`) and pre-join audio/video setup screens.
  - Non-intrusive Notion-style bottom-right floating prompt with one-click **Start recording** or **Dismiss**, plus optional **Auto-record** and **Auto-stop on meeting end**.
- **System + Microphone Audio Capture & Neural Enhancement**:
  - Zero-prompt Windows WASAPI system audio loopback combined with microphone capture through a 48 kHz mixer and broadcast limiter.
  - Built-in **DeepFilterNet3** (`resources/bin/deep-filter.exe`) 48 kHz full-band neural speech enhancement pipeline with 80 Hz high-pass filtering and FFmpeg `dynaudnorm` loudness normalization before encoding to 128 kbps `.mp3`.
  - Automatic fallback to FFmpeg spectral FFT denoiser (`afftdn`) when DeepFilterNet3 is disabled or unavailable.
  - On-demand **Enhance Audio** action and support for importing existing `.mp3`, `.wav`, `.m4a`, `.mp4`, `.mov`, `.webm`, and `.ogg` recordings.
- **Direct AiMY Knowledge Authentication, Offline Queue & Sync Dashboard**:
  - Cognito OAuth login with OS-level encryption, automatic background token refresh, and contextual sign-in prompt dialog.
  - Real-time network connectivity monitor that queues recordings while offline (`LOCAL_PENDING`) and auto-syncs once connectivity and authentication are restored.
  - Full sync lifecycle supporting both **Audio Recording Upload** (`POST /processing/audio`) with live upload progress `%` and **Notes Document Upload** (`POST /processing/json`).
  - Background status polling, one-click **Add to Knowledge** (`POST /v2/documents/{id}/index`), desktop completion notifications, and direct deep links to the AiMY Knowledge Console.
- **Packaging, Documentation & Release Tooling**:
  - Standalone Windows x64 release packaging script (`scripts/package-release.ps1` / `pnpm release:pack`) and GitHub Actions release workflow (`.github/workflows/release.yml`).
  - Comprehensive [Architecture Documentation](docs/ARCHITECTURE.md), [Installation Guide](docs/INSTALLATION.md), and [Releases Guide](docs/RELEASES.md).
