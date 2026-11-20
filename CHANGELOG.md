# Changelog

All notable changes to **AiMY Meetings** are documented in this file.

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
- **On-Device Live & Full-File Transcription (`whisper.cpp` + Silero VAD v5.1.2)**:
  - Native `whisper-server.exe` and `whisper-cli.exe` integration gated by **Silero VAD v5.1.2** (`ggml-silero-v5.1.2.bin`) with zero RAM consumption when idle.
  - One-click in-app model downloader and on-device hybrid builder for **Whisper Large v3 Turbo — Egyptian AR + EN (Q5)** (`ggml-large-v3-turbo-egyptian-q5_0.bin`), **Whisper Large v3 Turbo — Base (Q5)** (`ggml-large-v3-turbo-q5_0.bin`), and **Whisper Small (Q5)** (`ggml-small-q5_1.bin`).
  - Strict Arabic + English script-lock and anti-hallucination filter (`cleanAndValidateTranscript`) that strips foreign script glitches, stuttering repetitions, and silence hallucinations.
- **Direct AiMY Knowledge Authentication & Sync Dashboard**:
  - Embedded **Sign in with AiMY** Cognito OAuth login window with automatic JWT/OIDC extraction, OS-level `safeStorage` encryption, and automatic background token refresh (plus manual token support).
  - Full sync lifecycle supporting both **Audio Recording Upload** (`POST /processing/audio`) with live upload progress `%` and **Transcript + Notes Document Upload** (`POST /processing/json`).
  - Background status polling (`SyncManager`), one-click **Add to Knowledge** (`POST /v2/documents/{id}/index`), desktop completion notifications, and direct deep links to `https://staging-knowledge.aimy.flairstech.com/console?doc=<id>`.
- **Packaging, Documentation & Release Tooling**:
  - Standalone Windows x64 release packaging script (`scripts/package-release.ps1` / `pnpm release:pack`) and GitHub Actions release workflow (`.github/workflows/release.yml`).
  - Comprehensive [Architecture Documentation](docs/ARCHITECTURE.md), [Installation Guide](docs/INSTALLATION.md), and [Releases Guide](docs/RELEASES.md).
