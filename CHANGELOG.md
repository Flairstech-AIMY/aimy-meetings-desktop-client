# Changelog

All notable changes to **AiMY Meetings Desktop Client** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-11-20

### Added
- **Automatic Meeting Detection**:
  - Background Windows (`CapabilityAccessManager\ConsentStore` + Win32 `EnumWindows`) and macOS (`osascript`) detector for **Microsoft Teams**, **Zoom**, **Google Meet**, **Slack Huddles**, **Cisco Webex**, and **Discord**.
  - Smart filtering for Microsoft Teams idle tabs (`Chat`, `Calendar`, `Activity`) and pre-join audio/video setup screens.
  - Non-intrusive Notion-style bottom-right floating prompt (`PromptWindowManager`) with one-click **Start recording** or **Dismiss**, plus optional **Auto-record** and **Auto-stop on meeting end**.
- **System + Microphone Audio Capture & Neural Enhancement**:
  - Zero-prompt Windows WASAPI system audio loopback combined with microphone capture through a 48 kHz WebAudio mixer and broadcast limiter (`DynamicsCompressorNode`).
  - Built-in **DeepFilterNet3** (`resources/bin/deep-filter.exe`) 48 kHz full-band neural speech enhancement pipeline with 80 Hz high-pass filtering and FFmpeg `dynaudnorm` loudness normalization before encoding to 128 kbps `.mp3`.
  - Automatic fallback to FFmpeg spectral FFT denoiser (`afftdn`) when DeepFilterNet3 is disabled or unavailable.
  - On-demand **Enhance Audio** action and support for importing existing `.mp3`, `.wav`, `.m4a`, `.mp4`, `.mov`, `.webm`, and `.ogg` recordings.
- **Direct AiMY Knowledge Authentication, Offline Queue & Sync Dashboard**:
  - Embedded **Sign in with AiMY** Cognito OAuth login window with automatic JWT/OIDC extraction, OS-level `safeStorage` encryption, automatic background token refresh, and sign-in prompt dialog (`SignInPromptDialog`).
  - Real-time network connectivity monitor (`ConnectivityMonitor`) that automatically queues recordings while offline (`LOCAL_PENDING`) and auto-syncs pending recordings as soon as connectivity and authentication are restored.
  - Full sync lifecycle supporting both **Audio Recording Upload** (`POST /processing/audio`) with live upload progress `%` and **Notes Document Upload** (`POST /processing/json`).
  - Background status polling (`SyncManager`), one-click **Add to Knowledge** (`POST /v2/documents/{id}/index`), desktop completion notifications, and direct deep links to `https://staging-knowledge.aimy.flairstech.com/console?doc=<id>`.
- **Packaging, Documentation & Release Tooling**:
  - Standalone Windows x64 release packaging script (`scripts/package-release.ps1` / `pnpm release:pack`) and GitHub Actions release workflow (`.github/workflows/release.yml`).
  - Comprehensive [Architecture Documentation](docs/ARCHITECTURE.md), [Installation Guide](docs/INSTALLATION.md), and [Releases Guide](docs/RELEASES.md).
