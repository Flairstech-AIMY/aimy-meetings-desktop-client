param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

# Ensure Cargo and MinGW are on PATH
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$mingwBin = Join-Path $env:USERPROFILE 'scoop\apps\mingw\current\bin'
foreach ($extraBin in @($mingwBin, $cargoBin)) {
  if ((Test-Path $extraBin) -and ($env:PATH -notlike "*$extraBin*")) {
    $env:PATH = "$extraBin;$env:PATH"
  }
}

$pkg = Get-Content -Raw -Path (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$version = $pkg.version
Write-Host "==> Packaging AiMY Meetings Desktop Client v$version (Tauri win-x64)..." -ForegroundColor Cyan

if (-not $SkipBuild) {
  Write-Host "==> Running production Tauri build (pnpm tauri build)..." -ForegroundColor Cyan
  & pnpm tauri build
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri production build failed with exit code $LASTEXITCODE"
  }
}

$targetRelease = Join-Path $env:USERPROFILE '.cargo-targets\aimy-meetings\release'
if (-not (Test-Path $targetRelease)) {
  $targetRelease = Join-Path $projectRoot 'src-tauri\target\release'
}
$builtExe = Join-Path $targetRelease 'AiMY Meetings.exe'
if (-not (Test-Path $builtExe)) {
  $builtExe = Join-Path $targetRelease 'aimy-meetings.exe'
}
if (-not (Test-Path $builtExe)) {
  throw "Compiled Tauri binary not found in $targetRelease."
}

$releaseRoot = Join-Path $projectRoot 'release'
$stageDir = Join-Path $releaseRoot 'AiMY-Meetings-Desktop-Client-win32-x64'
$zipName = "AiMY-Meetings-Desktop-Client-v$version-win-x64.zip"
$zipPath = Join-Path $releaseRoot $zipName
$setupName = "AiMY-Meetings-Desktop-Client-v$version-win-x64-setup.exe"
$setupDestPath = Join-Path $releaseRoot $setupName
$sumsPath = Join-Path $releaseRoot 'SHA256SUMS.txt'

if (Test-Path $stageDir) {
  Remove-Item -Path $stageDir -Recurse -Force
}
if (Test-Path $zipPath) {
  Remove-Item -Path $zipPath -Force
}
if (Test-Path $setupDestPath) {
  Remove-Item -Path $setupDestPath -Force
}
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

Write-Host "==> Staging portable executable and resources..." -ForegroundColor Cyan
Copy-Item -Path $builtExe -Destination (Join-Path $stageDir 'AiMY Meetings Desktop Client.exe') -Force

$binDest = Join-Path $stageDir 'bin'
New-Item -ItemType Directory -Path $binDest -Force | Out-Null
$deepFilterSrc = Join-Path $projectRoot 'resources\bin\deep-filter.exe'
if (Test-Path $deepFilterSrc) {
  Copy-Item -Path $deepFilterSrc -Destination (Join-Path $binDest 'deep-filter.exe') -Force
}

foreach ($docFile in @('README.md', 'CHANGELOG.md')) {
  $srcDoc = Join-Path $projectRoot $docFile
  if (Test-Path $srcDoc) {
    Copy-Item -Path $srcDoc -Destination (Join-Path $stageDir $docFile) -Force
  }
}
$docsSrcDir = Join-Path $projectRoot 'docs'
if (Test-Path $docsSrcDir) {
  Copy-Item -Path $docsSrcDir -Destination (Join-Path $stageDir 'docs') -Recurse -Force
}

Write-Host "==> Creating portable zip archive: $zipPath ..." -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stageDir,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

$nsisDir = Join-Path $targetRelease 'bundle\nsis'
if (Test-Path $nsisDir) {
  $nsisInstaller = Get-ChildItem -Path $nsisDir -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($nsisInstaller) {
    Write-Host "==> Copying NSIS installer: $setupDestPath ..." -ForegroundColor Cyan
    Copy-Item -Path $nsisInstaller.FullName -Destination $setupDestPath -Force
  }
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$sumLines = @()
foreach ($artifact in @($zipPath, $setupDestPath)) {
  if (Test-Path $artifact) {
    $stream = [System.IO.File]::OpenRead($artifact)
    try {
      $hashBytes = $sha256.ComputeHash($stream)
      $hash = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
      $leaf = Split-Path $artifact -Leaf
      $sumLines += "$hash  $leaf"
    } finally {
      $stream.Dispose()
    }
  }
}
$sha256.Dispose()
[System.IO.File]::WriteAllText($sumsPath, ($sumLines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))

$zipSizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "==> Release packages ready!" -ForegroundColor Green
Write-Host "    Portable Zip : $zipPath ($zipSizeMB MB)"
if (Test-Path $setupDestPath) {
  $setupSizeMB = [math]::Round((Get-Item $setupDestPath).Length / 1MB, 2)
  Write-Host "    NSIS Setup   : $setupDestPath ($setupSizeMB MB)"
}
Write-Host "    SHA-256 Sums : $sumsPath"
