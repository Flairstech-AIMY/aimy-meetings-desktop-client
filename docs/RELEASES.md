# AiMY Meetings — Releases & Packaging Guide

This guide explains how **AiMY Meetings** is versioned, packaged into standalone distributable artifacts, and published to **GitHub Releases**.

---

## 1. Versioning Strategy

AiMY Meetings follows **Semantic Versioning (`MAJOR.MINOR.PATCH`)**:
- **MAJOR (`v2.0.0`)**: Breaking changes to local storage schema, AiMY API contract, or OS compatibility.
- **MINOR (`v1.1.0`)**: New features (e.g., new Whisper models, new meeting platforms, new sync modes).
- **PATCH (`v1.0.1`)**: Bug fixes, UI polish, hallucination filter tuning, or dependency updates.

All official release tags are prefixed with `v` (for example, `v1.0.0`).

---

## 2. Release Artifacts

Each GitHub Release publishes the following artifacts:

| Artifact Name | Description |
| :--- | :--- |
| **`AiMY-Meetings-v<version>-win-x64.zip`** | Complete standalone Windows x64 portable desktop application. Includes `AiMY Meetings.exe` (Electron 35 runtime), compiled main/preload/renderer bundles, and `deep-filter.exe` (DeepFilterNet3). |
| **`SHA256SUMS.txt`** | SHA-256 cryptographic checksums for all release assets. |

---

## 3. Building & Packaging a Release Locally

### Step 1: Bump the Version
Update the `"version"` field in [`package.json`](../package.json) and add a new section to [`CHANGELOG.md`](../CHANGELOG.md).

```bash
# Example: verify type safety first
pnpm typecheck
```

### Step 2: Run the Release Packager
Run the automated packaging script:

```bash
pnpm release:pack
```

Or invoke the PowerShell script directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

#### What `scripts/package-release.ps1` Does:
1. Runs `pnpm typecheck` and `pnpm build` (`electron-vite build`) to produce clean production bundles in `out/main`, `out/preload`, and `out/renderer`.
2. Creates a clean staging directory at `release/AiMY-Meetings-win32-x64/`.
3. Copies the Windows x64 Electron runtime from `node_modules/electron/dist/`, removes `resources/default_app.asar`, and renames `electron.exe` to `AiMY Meetings.exe`.
4. Assembles `resources/app/` containing:
   - `package.json` (stripped of dev-only metadata)
   - `out/` (compiled main, preload, and renderer bundles)
   - `resources/icon.*`, `resources/mark.svg`, `resources/tray-*.png`
   - `resources/bin/deep-filter.exe`
5. Compresses the staging folder into `release/AiMY-Meetings-v<version>-win-x64.zip`.
6. Generates `release/SHA256SUMS.txt` containing the SHA-256 hash of every generated release artifact.

---

## 4. Publishing a Release to GitHub

### Option A: Using GitHub CLI (`gh`)

1. **Commit and tag the release**:
   ```bash
   git add -A
   git commit -m "chore(release): v1.0.0"
   git tag -a v1.0.0 -m "AiMY Meetings v1.0.0"
   git push origin main --tags
   ```

2. **Create the GitHub Release and upload artifacts**:
   ```bash
   gh release create v1.0.0 \
     "release/AiMY-Meetings-v1.0.0-win-x64.zip" \
     "release/SHA256SUMS.txt" \
     --title "AiMY Meetings v1.0.0" \
     --notes-file CHANGELOG.md
   ```

### Option B: Automated GitHub Actions Workflow
This repository includes [`.github/workflows/release.yml`](../.github/workflows/release.yml). Pushing any tag matching `v*.*.*` automatically:
1. Checks out the repository on `windows-latest`.
2. Installs Node.js 22 and `pnpm`.
3. Runs `pnpm install`, `pnpm typecheck`, and `pnpm release:pack`.
4. Publishes a new GitHub Release with `AiMY-Meetings-v<version>-win-x64.zip` and `SHA256SUMS.txt` attached.

---

## 5. Pre-Release Verification Checklist

Before publishing a new release, verify the following on a clean Windows session:

- [ ] `pnpm typecheck` passes with zero TypeScript errors.
- [ ] `pnpm release:pack` completes and outputs `release/AiMY-Meetings-v<version>-win-x64.zip`.
- [ ] Extracting the `.zip` and launching `AiMY Meetings.exe` opens the main window and creates the system tray icon.
- [ ] **Settings → Calls & Audio** shows the **DeepFilterNet3 active** badge (and **FFmpeg** when installed on system `PATH`).
- [ ] Clicking **Test meeting banner** in Settings pops the bottom-right meeting detection prompt.
- [ ] **Sign in with AiMY** opens the AiMY Cognito login window and persists the encrypted session across app restarts.
- [ ] Recording a test clip mixes system + microphone audio, enhances with DeepFilterNet3, and syncs to AiMY Knowledge.
