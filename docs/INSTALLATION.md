# AiMY Meetings — Installation & Setup Guide

This guide covers both **End-User Installation** (running the pre-built desktop release) and **Developer Installation** (building and running from source).

---

## Part 1: End-User Installation (Windows x64)

### 1. System Requirements
- **Operating System**: Windows 10 (version 1903+) or Windows 11 (64-bit)
- **RAM**: 4 GB minimum (8 GB+ recommended for on-device `Whisper Large v3 Turbo Q5` live transcription)
- **Disk Space**:
  - ~350 MB for the core application, DeepFilterNet3 neural denoiser, and `whisper.cpp` runtime
  - ~190 MB to ~550 MB per optional on-device Whisper model downloaded in Settings
- **FFmpeg**: Required on system `PATH` for MP3 encoding, DeepFilterNet3 audio pre/post-processing, and Whisper 16 kHz audio conversion.

### 2. Install FFmpeg (One-Time Prerequisite)
Open **PowerShell** or **Windows Terminal** and install FFmpeg via Winget:

```powershell
winget install Gyan.FFmpeg
```

*(Restart your terminal or sign out/in once so `ffmpeg` and `ffprobe` are available on your `PATH`. You can verify with `ffmpeg -version`.)*

### 3. Download & Extract AiMY Meetings
1. Go to the [**GitHub Releases**](../../releases) page of this repository.
2. Download the latest **`AiMY-Meetings-v1.0.0-win-x64.zip`** archive from the release assets.
3. Extract the `.zip` archive to a folder of your choice (for example, `C:\Users\<you>\Apps\AiMY-Meetings\`).
4. Double-click **`AiMY Meetings.exe`** to launch the application.
   - *Tip*: Right-click `AiMY Meetings.exe` → **Send to** → **Desktop (create shortcut)** or **Pin to taskbar** for quick access.

### 4. First-Time Setup in the App
1. **Sign in to AiMY Knowledge**:
   - Click **Sign in with AiMY** in the top navigation bar.
   - Log in with your AiMY credentials in the secure pop-up window (or paste a manual Cognito JWT token in **Settings → AiMY Connection**).
2. **Select Your Target Group & Agents**:
   - Open **Settings** (gear icon in the top-right).
   - Select your default **Target group** (required for syncing) and optional **Assigned agents**.
3. **Download an On-Device Whisper Model (For Live & Offline Transcription)**:
   - In **Settings → On-Device Live Transcription (Whisper + Silero VAD)**, click **Download** next to:
     - **Whisper Large v3 Turbo — Egyptian AR + EN (Q5)** (~547 MB) — *Recommended for Egyptian Arabic + English code-switching meetings*.
     - **Whisper Large v3 Turbo — Base (Q5)** (~547 MB) — *Standard multilingual Whisper Large v3 Turbo*.
     - **Whisper Small (Q5)** (~181 MB) — *Fast, lightweight fallback for low-memory laptops*.
   - *(Optional Offline Model Install)*: If you downloaded a pre-built `.bin` model directly from GitHub Releases, place it inside `resources/models/` (next to `ggml-silero-v5.1.2.bin`) and restart the app.

---

## Part 2: Developer Installation (From Source)

### 1. Prerequisites
- **Node.js**: `v20.11+` or `v22+` (LTS recommended)
- **pnpm**: `v9+` or `v10+` (`npm install -g pnpm`)
- **FFmpeg**: Installed and available on `PATH` (`ffmpeg -version` and `ffprobe -version`)
- **Git**: `v2.40+`

### 2. Clone the Repository

```bash
git clone https://github.com/mhsFlairs/aimy-meetings.git
cd aimy-meetings
```

### 3. Configure the FlairsTech AiMY UI Registry
The project uses `@flairstech-aimy/ui` and `@flairstech-aimy/tokens`. The repository includes an `.npmrc` file pre-configured for the FlairsTech private registry:

```ini
@flairstech-aimy:registry=https://aimy-ui-lib.aimy.flairstech.com/npm/
```

Ensure you have network access to `https://aimy-ui-lib.aimy.flairstech.com/npm/` before installing dependencies.

### 4. Install Dependencies

```bash
pnpm install
```

> **Note**: `.npmrc` and `package.json` (`pnpm.onlyBuiltDependencies`) automatically allow `electron` and `esbuild` postinstall scripts to download the Electron runtime binary.

### 5. Verify Native Binaries & VAD Model
Ensure the following bundled native files are present in your working tree:
- `resources/bin/deep-filter.exe` — DeepFilterNet3 CLI binary
- `resources/bin/whisper/Release/whisper-server.exe` — Local live transcription HTTP inference server
- `resources/bin/whisper/Release/whisper-cli.exe` — Full-file local Whisper CLI
- `resources/bin/whisper/Release/whisper-quantize.exe` — GGUF/GGML Q5_0 model quantizer
- `resources/models/ggml-silero-v5.1.2.bin` — Silero VAD v5.1.2 voice activity detection weights

*(In the app's **Settings** dialog, green status badges confirm that `FFmpeg`, `DeepFilterNet3`, and `Whisper + Silero VAD` are detected.)*

### 6. Run in Development Mode

```bash
pnpm dev
```

This runs `electron-vite dev` with Hot Module Replacement (HMR) for the React renderer and automatic reloads for the main/preload bundles.

### 7. Typecheck & Build Production Bundles

```bash
# Run TypeScript validation across both Node (main/preload) and Web (renderer) configs
pnpm typecheck

# Compile production bundles to out/main, out/preload, and out/renderer
pnpm build

# Preview the production build locally in Electron
pnpm start
```

### 8. Package a Standalone Windows Release

```bash
pnpm release:pack
```

This runs `scripts/package-release.ps1` and creates a self-contained portable Windows x64 release archive in `release/AiMY-Meetings-v<version>-win-x64.zip` along with `release/SHA256SUMS.txt`.

---

## Part 3: Troubleshooting

| Symptom | Cause | Resolution |
| :--- | :--- | :--- |
| **"FFmpeg missing" badge in Settings** | `ffmpeg` is not on the system `PATH`. | Run `winget install Gyan.FFmpeg` and restart AiMY Meetings. |
| **Audio saves as `.webm` instead of `.mp3`** | FFmpeg was unavailable when recording stopped. | Install FFmpeg, open the recording in AiMY Meetings, and click **Enhance Audio** to transcode and denoise to `.mp3`. |
| **Live transcription says "Download a Whisper model in Settings"** | No `.bin` Whisper model is installed yet. | Open **Settings → On-Device Live Transcription** and click **Download** on one of the three models. |
| **Sync fails with "Select a target AiMY Group first"** | No default group is selected. | Sign in to AiMY, open **Settings** (or the recording detail pane), and choose a **Target group**. |
| **Sync fails with HTTP 401** | Cognito session token expired and could not be refreshed. | Click **Sign in with AiMY** in the top bar to re-authenticate. |
| **Teams meeting not triggering popup** | Teams is on an idle tab (`Chat`, `Calendar`, `Activity`) or the pre-join preview screen. | Join the active call; the detector intentionally waits until you leave the pre-join screen or activate your mic/camera. |
