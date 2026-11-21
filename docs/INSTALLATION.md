# AiMY Meetings Desktop Client — Installation & Setup Guide

Welcome! This guide is split into two parts:
- **[Part 1: Easy Installation for Everyone (Windows)](#part-1-easy-installation-for-everyone-windows)** — No coding or technical background required.
- **[Part 2: Developer Installation (From Source)](#part-2-developer-installation-from-source)** — For engineers building or contributing to the app.

---

## Part 1: Easy Installation for Everyone (Windows)

### What You Need
- A Windows PC running **Windows 10** (version 1903 or newer) or **Windows 11** (64-bit).
- About **150 MB** of free disk space.
- Your **AiMY** account login (email & password / SSO).
- No administrator password is required to install the app.

---

### Step 1: Download the App

1. Open the [**AiMY Meetings Latest Release**](https://github.com/Flairstech-AIMY/aimy-meetings-desktop-client/releases/latest) page in your web browser.
2. Scroll down to the **Assets** section at the bottom of the latest release.
3. Choose **one** of the two download options:
   - **Option A — Standard Installer (Recommended for most people):**
     Click **`AiMY-Meetings-Desktop-Client-vX.Y.Z-win-x64-setup.exe`** (about 15 MB).
     *This installs the app like any normal Windows program and adds it to your Start Menu.*
   - **Option B — Portable ZIP (No installer needed):**
     Click **`AiMY-Meetings-Desktop-Client-vX.Y.Z-win-x64.zip`**.
     *Choose this if you prefer not to run an installer — just unzip and run directly.*

---

### Step 2: Install (or Unzip) the App

#### If you downloaded the Installer (`...-setup.exe` — Recommended)
1. Open your **Downloads** folder and double-click **`AiMY-Meetings-Desktop-Client-vX.Y.Z-win-x64-setup.exe`**.
2. **If Windows shows a blue box saying *"Windows protected your PC"*:**
   - Don't worry — this appears because the app is an internal FlairsTech tool not yet signed with a public Microsoft Store certificate.
   - Click **More info**, then click **Run anyway**.
3. Follow the on-screen steps (**Next → Install → Finish**).
4. The app will be added to your **Start Menu** (and **Desktop** if selected) and can launch immediately.

#### If you downloaded the Portable ZIP (`...-win-x64.zip`)
1. Open your **Downloads** folder, right-click **`AiMY-Meetings-Desktop-Client-vX.Y.Z-win-x64.zip`**, and choose **Extract All…**.
2. Pick a permanent folder you won't accidentally delete — for example, `C:\Users\<YourName>\Apps\AiMY Meetings\` — and click **Extract**.
3. Open that extracted folder and double-click **`AiMY Meetings Desktop Client.exe`**.
   - *Tip:* Right-click **`AiMY Meetings Desktop Client.exe`** → **Pin to taskbar** (or **Create shortcut**) so it's always easy to find.
   - *Important:* Keep the `bin` folder (and `WebView2Loader.dll` if present) in the same folder next to the `.exe` file — do not move the `.exe` out by itself.

---

### Step 3: Install FFmpeg (One-Time Audio Setup)

**What is FFmpeg?** It is a free, industry-standard audio helper that converts your recordings into small MP3 files and lets the AI noise cancellation run. You only need to install it once.

1. Press the **Windows key** on your keyboard (or click the **Start** button at the bottom of your screen).
2. Type **`Terminal`** (on Windows 11) or **`PowerShell`** (on Windows 10) and press **Enter**.
3. A dark text window will open. Copy the line below, right-click inside that window to paste it, and press **Enter**:

   ```powershell
   winget install Gyan.FFmpeg
   ```

4. If it asks *"Do you agree to all the source agreements terms?"*, type **`Y`** and press **Enter**.
5. Wait a minute until you see **`Successfully installed`**.
6. Close the Terminal window. *(If AiMY Meetings Desktop Client was already open, close it completely from the system tray and open it again so it detects FFmpeg.)*

> **Don't have `winget`?** Open the **Microsoft Store**, search for **App Installer** by Microsoft, click **Update / Install**, and then repeat Step 3 — or ask your IT support team to install FFmpeg for you.

---

### Step 4: First-Time Setup Inside the App

1. **Launch the app** from your Start Menu or Desktop shortcut.
2. **Sign in to AiMY:**
   - Click **Sign in with AiMY** in the top bar (or in the welcome sign-in popup).
   - Your normal web browser will open to the AiMY sign-in page. Log in as you usually do.
   - When your browser asks *"Open AiMY Meetings Desktop Client?"*, click **Open** to finish signing in.
   - *(Tip: If your browser doesn't redirect back automatically, you can choose **Use built-in sign-in window** inside the sign-in dialog instead.)*
3. **Check Your Target Group:**
   - Click the **Settings** (gear) icon in the top-right corner.
   - Under **AiMY Workspace**, confirm your **Target group** (the app automatically selects your default *Personal / Meetings* group if available) and optionally choose **Assigned agents**.
   - Click **Save**.
4. **Optional — Test Meeting Detection & Noise Cancellation:**
   - Open **Settings → Calls & Audio**.
   - Click **Test meeting banner** to preview the small bottom-right popup that appears when a call starts.
   - Scroll to **DeepFilterNet3 tuning** and click **Play** in the **Audio Tester** to hear a noisy clip before and after AI noise cancellation. You can even record a quick 6-second test with your own microphone and adjust the **Noise filtering strength** slider (default: **50% Balanced**).

---

### Step 5: Everyday Use Tips

- **Automatic Meeting Recording:** Just join a **Microsoft Teams**, **Zoom**, **Google Meet**, **Slack Huddle**, **Webex**, or **Discord** call. A small card will appear in the bottom-right corner — click **Start recording** (or enable *Auto-start recording without asking* in Settings).
- **Manual Recording & Importing Files:** Click **New recording** anytime to record immediately, or click **Import** to enhance and sync an existing `.mp3`, `.wav`, `.m4a`, `.mp4`, `.mov`, `.webm`, or `.ogg` file.
- **Closing the Window Keeps It Running in the Background:** Clicking the **`X`** button hides the app to your **system tray** (the small icons near your clock at the bottom-right of your taskbar) so it can still detect upcoming meetings. Click the tray icon to reopen the window, or right-click the tray icon → **Quit AiMY Meetings Desktop Client** to exit completely.
- **Updating to a New Version:** Simply download and run the newest `...-setup.exe` from the [Latest Release](https://github.com/Flairstech-AIMY/aimy-meetings-desktop-client/releases/latest) page. Your existing recordings, notes, settings, and login are kept safely in your user profile.

---

## Part 2: Developer Installation (From Source)

### 1. Prerequisites
- **Node.js**: `v20.11+` or `v22+` (LTS recommended)
- **pnpm**: `v10+` (`corepack enable` or `npm install -g pnpm`)
- **Rust Toolchain**: `1.80+` via [rustup](https://rustup.rs/)
- **Windows C++ Build Tools**: Visual Studio 2022 Build Tools with the **"Desktop development with C++"** workload (for MSVC builds) and **Microsoft Edge WebView2 Runtime** (pre-installed on Windows 10/11)
- **FFmpeg**: Installed and available on `PATH` (`ffmpeg -version` and `ffprobe -version`)
- **Git**: `v2.40+`

### 2. Clone the Repository

```bash
git clone https://github.com/Flairstech-AIMY/aimy-meetings-desktop-client.git
cd aimy-meetings-desktop-client
```

### 3. Verify the FlairsTech AiMY UI Registry
The frontend uses `@flairstech-aimy/ui` and `@flairstech-aimy/tokens`. The repository includes `.npmrc` pre-configured for the FlairsTech registry:

```ini
@flairstech-aimy:registry=https://aimy-ui-lib.aimy.flairstech.com/npm/
```

Ensure you have network access to `https://aimy-ui-lib.aimy.flairstech.com/npm/` before running `pnpm install`.

### 4. Install Dependencies

```bash
pnpm install
```

### 5. Verify Bundled Resources
Confirm these files are present in your working tree:
- `resources/bin/deep-filter.exe` — Bundled DeepFilterNet3 48 kHz CLI binary
- `resources/deepfilter-test-sample.mp3` — Built-in noisy sample embedded into the Rust binary for the Settings audio tester

### 6. Run in Development Mode

```bash
pnpm dev
```

This runs `tauri dev`, starting the Vite frontend dev server on `http://localhost:1420` with Hot Module Replacement (HMR) and compiling/launching the native Rust Tauri host.

### 7. Typecheck, Test & Build

```bash
# TypeScript typechecking (renderer + shared types)
pnpm typecheck

# Rust backend unit tests (DeepFilter mapping + meeting detection rules)
(cd src-tauri && cargo test)

# Frontend production bundle only (dist/)
pnpm build:web

# Full Tauri production build (binary + NSIS installer)
pnpm build
```

### 8. Package Release Artifacts Locally

```bash
pnpm release:pack
```

This runs `scripts/package-release.ps1` and outputs:
- `release/AiMY-Meetings-Desktop-Client-v<version>-win-x64-setup.exe` (Windows NSIS installer)
- `release/AiMY-Meetings-Desktop-Client-v<version>-win-x64.zip` (Portable ZIP)
- `release/SHA256SUMS.txt` (SHA-256 checksums)

---

## Part 3: Frequently Asked Questions & Troubleshooting

| Issue / Question | Why It Happens | How to Fix It |
| :--- | :--- | :--- |
| **"Windows protected your PC" blue popup when running the installer** | Windows SmartScreen warns on internal apps without a commercial code-signing certificate. | Click **More info** → **Run anyway**. |
| **"FFmpeg not detected on PATH" warning in Settings** | FFmpeg hasn't been installed yet, or the app was already open before you installed it. | Run `winget install Gyan.FFmpeg` in Terminal/PowerShell, then fully quit the app (from the system tray) and reopen it. |
| **Where did the app go when I clicked `X`?** | Closing the window hides it to the system tray so automatic meeting detection stays active. | Look near the clock at the bottom-right of your taskbar (click the `^` arrow if hidden) and click the **AiMY Meetings** icon. |
| **Sign-in in browser didn't return to the app** | Some browsers block custom `aimy-meetings://` protocol redirects until approved. | Click **Open** on the browser prompt, or click **Use built-in sign-in window** inside the app's sign-in dialog. |
| **Microsoft Teams meeting didn't trigger the popup** | The app intentionally ignores idle Teams tabs (`Chat`, `Calendar`, `Store`, `Settings`) and the pre-join preview screen. | Join the active call; the popup appears ~5 seconds after the live call starts. |
| **Recorded while offline — did I lose my meeting?** | No! The app is local-first. | Offline recordings are saved safely on your PC as **Pending** and upload automatically once your internet reconnects. |
| **Voice sounds slightly muffled or background noise remains** | Noise-cancellation strength may be too high or too low for your mic/room. | Open **Settings → Calls & Audio → DeepFilterNet3 tuning**, test your mic with the built-in **Audio Tester**, and adjust the strength slider (try **50% Balanced** or turn off **Post-filter** for a more natural voice). |
| **Sync fails with "Select a target AiMY Group first"** | No default AiMY Target group is chosen. | Sign in to AiMY, open **Settings → AiMY Workspace**, pick a **Target group**, and click **Save**. |
| **Sync fails with HTTP 401 / Session expired** | Your login session expired and could not refresh automatically. | Click **Sign in with AiMY** in the top bar to re-authenticate, then click **Retry Sync**. |
