param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$pkg = Get-Content -Raw -Path (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$version = $pkg.version
Write-Host "==> Packaging AiMY Meetings v$version (win-x64)..." -ForegroundColor Cyan

if (-not $SkipBuild) {
  Write-Host "==> Running production build (electron-vite build)..." -ForegroundColor Cyan
  & pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw "Production build failed with exit code $LASTEXITCODE"
  }
}

$electronDist = Join-Path $projectRoot 'node_modules\electron\dist'
if (-not (Test-Path $electronDist)) {
  throw "Electron runtime not found at $electronDist. Run 'pnpm install' first."
}

$releaseRoot = Join-Path $projectRoot 'release'
$stageDir = Join-Path $releaseRoot 'AiMY-Meetings-win32-x64'
$zipName = "AiMY-Meetings-v$version-win-x64.zip"
$zipPath = Join-Path $releaseRoot $zipName
$sumsPath = Join-Path $releaseRoot 'SHA256SUMS.txt'

if (Test-Path $stageDir) {
  Remove-Item -Path $stageDir -Recurse -Force
}
if (Test-Path $zipPath) {
  Remove-Item -Path $zipPath -Force
}
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

Write-Host "==> Copying Electron runtime..." -ForegroundColor Cyan
Copy-Item -Path (Join-Path $electronDist '*') -Destination $stageDir -Recurse -Force

$defaultAsar = Join-Path $stageDir 'resources\default_app.asar'
if (Test-Path $defaultAsar) {
  Remove-Item -Path $defaultAsar -Force
}

$electronExe = Join-Path $stageDir 'electron.exe'
$appExe = Join-Path $stageDir 'AiMY Meetings.exe'
if (Test-Path $electronExe) {
  Rename-Item -Path $electronExe -NewName 'AiMY Meetings.exe'
}

$appDir = Join-Path $stageDir 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

# Write clean production package.json
$prodPkg = [ordered]@{
  name        = $pkg.name
  productName = 'AiMY Meetings'
  version     = $pkg.version
  description = $pkg.description
  author      = 'FlairsTech AiMY Team'
  main        = './out/main/index.js'
}
$prodPkg | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $appDir 'package.json') -Encoding UTF8

Write-Host "==> Copying compiled application bundles (out/)..." -ForegroundColor Cyan
Copy-Item -Path (Join-Path $projectRoot 'out') -Destination (Join-Path $appDir 'out') -Recurse -Force

Write-Host "==> Copying icons and DeepFilterNet3..." -ForegroundColor Cyan
$resDest = Join-Path $appDir 'resources'
$binDest = Join-Path $resDest 'bin'

New-Item -ItemType Directory -Path $binDest -Force | Out-Null

# Copy top-level icons
Get-ChildItem -Path (Join-Path $projectRoot 'resources') -File | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $resDest $_.Name) -Force
}

# Copy DeepFilterNet3 binary
$deepFilterSrc = Join-Path $projectRoot 'resources\bin\deep-filter.exe'
if (Test-Path $deepFilterSrc) {
  Copy-Item -Path $deepFilterSrc -Destination (Join-Path $binDest 'deep-filter.exe') -Force
}

# Include user documentation at root of portable folder
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

Write-Host "==> Creating zip archive: $zipPath ..." -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stageDir,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$zipStream = [System.IO.File]::OpenRead($zipPath)
try {
  $hashBytes = $sha256.ComputeHash($zipStream)
  $hash = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
} finally {
  $zipStream.Dispose()
  $sha256.Dispose()
}
$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
[System.IO.File]::WriteAllText($sumsPath, "$hash  $zipName`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "==> Release package ready!" -ForegroundColor Green
Write-Host "    Archive : $zipPath ($sizeMB MB)"
Write-Host "    SHA-256 : $hash"
Write-Host "    Sums    : $sumsPath"
