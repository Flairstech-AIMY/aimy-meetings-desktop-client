# AiMY Meetings Desktop Client — Releases & Packaging Guide

This guide explains how **AiMY Meetings Desktop Client** is versioned, packaged into Windows installers and portable archives, and automatically published to **GitHub Releases**.

---

## 1. Versioning Strategy

AiMY Meetings Desktop Client follows **Semantic Versioning (`MAJOR.MINOR.PATCH`)**:
- **MAJOR (`v2.0.0`)**: Breaking changes to local storage schema, AiMY API contract, or OS compatibility.
- **MINOR (`v1.1.0`)**: New user-facing features (e.g., new audio tuning tools, architecture upgrades, new platforms).
- **PATCH (`v1.1.1`)**: Bug fixes, detection tuning, UI polish, or dependency updates.

All release tags are prefixed with `v` (for example, `v1.1.0`). Version numbers live in three files:
- [`package.json`](../package.json)
- [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json)
- [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml)

---

## 2. Release Artifacts

Each GitHub Release publishes the following Windows x64 artifacts:

| Artifact Name | Recommended For | Description |
| :--- | :--- | :--- |
| **`AiMY-Meetings-Desktop-Client-v<version>-win-x64-setup.exe`** | **End Users (Recommended)** | Lightweight (~15 MB) Windows NSIS installer (`currentUser` mode — no admin rights needed). Installs the native Tauri v2 app, bundles `deep-filter.exe`, registers `aimy-meetings://`, and creates Start Menu / Desktop shortcuts. |
| **`AiMY-Meetings-Desktop-Client-v<version>-win-x64.zip`** | Portable / No-Install Users | Self-contained portable Windows x64 archive containing `AiMY Meetings Desktop Client.exe`, `bin/deep-filter.exe`, `WebView2Loader.dll` (when required), and documentation. |
| **`SHA256SUMS.txt`** | Verification / Security | SHA-256 cryptographic checksums for every artifact in the release. |

---

## 3. Automated Releases on Push to `main` (GitHub Actions)

This repository includes [`.github/workflows/release.yml`](../.github/workflows/release.yml), which automatically builds and publishes a new Windows x64 GitHub Release on **every push to `main`** (and can also be triggered manually via **Actions → Build & Publish Release → Run workflow**).

### How Version Resolution Works in CI
1. If triggered manually with a `tag` input (e.g., `v1.2.0`), CI uses that exact version.
2. Otherwise, CI compares the version in `package.json` against the highest existing `v*.*.*` Git tag:
   - If `package.json` has a **higher** version (e.g., bumped to `1.1.0` when the latest tag is `v1.0.0`), CI publishes **`v1.1.0`**.
   - If `package.json` is equal to or lower than the latest tag, CI automatically bumps the **patch** version (e.g., `v1.1.0` → `v1.1.1`) and updates `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` during the build.
3. CI then installs Rust stable, Node.js 22, and `pnpm 10`, runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, and `pnpm release:pack`, and publishes the GitHub Release with auto-generated release notes and all three artifacts attached.

---

## 4. Building & Packaging a Release Locally

### Step 1: Verify Typecheck & Rust Unit Tests
```bash
pnpm typecheck
(cd src-tauri && cargo test)
```

### Step 2: Run the Release Packager
```bash
pnpm release:pack
```

Or invoke the PowerShell script directly (pass `-SkipBuild` to repackage an already-compiled Tauri release):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

#### What `scripts/package-release.ps1` Does:
1. Runs `pnpm tauri build`, which compiles the React 19 frontend (`dist/`), compiles the optimized Rust Tauri binary (`AiMY Meetings.exe`), and generates the NSIS installer (`bundle/nsis/*.exe`).
2. Stages a clean portable directory at `release/AiMY-Meetings-Desktop-Client-win32-x64/` containing:
   - `AiMY Meetings Desktop Client.exe`
   - `WebView2Loader.dll` (when dynamically linked)
   - `bin/deep-filter.exe`
   - `README.md`, `CHANGELOG.md`, and `docs/`
3. Compresses the staging folder into `release/AiMY-Meetings-Desktop-Client-v<version>-win-x64.zip`.
4. Copies the NSIS setup executable to `release/AiMY-Meetings-Desktop-Client-v<version>-win-x64-setup.exe`.
5. Computes SHA-256 hashes for both artifacts and writes `release/SHA256SUMS.txt`.

---

## 5. Pre-Release Verification Checklist

Before pushing a release to `main`, verify:

- [ ] `pnpm typecheck` passes with zero TypeScript errors.
- [ ] `cd src-tauri && cargo test` passes all unit tests.
- [ ] `CHANGELOG.md` and `docs/` reflect all user-facing changes.
- [ ] If cutting a MINOR or MAJOR release, `"version"` is bumped consistently in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
- [ ] On Windows, both the NSIS installer (`...-setup.exe`) and portable ZIP launch cleanly, detect bundled `deep-filter.exe`, render the Settings Audio Tester, and sign in via `aimy-meetings://`.
- [ ] After pushing to `main`, confirm the **Build & Publish Release** GitHub Actions workflow turns green and publishes the new release under [**GitHub Releases**](../../releases).
