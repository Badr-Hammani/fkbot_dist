#Requires -Version 5.1
<#
.SYNOPSIS
    Auto-installs ICT_GoldTrader and SMC_GoldTrader EAs into MetaTrader 5.
    Run by right-clicking this file and selecting "Run with PowerShell".
#>

$ErrorActionPreference = "Stop"
$REPO = "https://github.com/badr-hammani/fkbot_dist.git"
$BRANCH = "claude/gold-trading-eas-ict-smartmoney-56xzgw"
$JASON_URL = "https://raw.githubusercontent.com/vivazzi/JAson/master/JAson.mqh"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "`n[FAILED] $msg" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  Gold EA Auto-Installer for MetaTrader 5  " -ForegroundColor White
Write-Host "============================================" -ForegroundColor White

# ── Step 1: Find MT5 data folder ─────────────────────────────────────────
Write-Step "Locating MetaTrader 5 data folder..."

$mt5DataFolder = $null

# Search %APPDATA%\MetaQuotes\Terminal\* for a folder containing MQL5\
$terminalRoot = Join-Path $env:APPDATA "MetaQuotes\Terminal"
if (Test-Path $terminalRoot) {
    $candidates = Get-ChildItem $terminalRoot -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "MQL5\Experts") } |
        Select-Object -First 1
    if ($candidates) {
        $mt5DataFolder = $candidates.FullName
    }
}

# Fallback: common install paths
if (-not $mt5DataFolder) {
    $fallbacks = @(
        "C:\Program Files\MetaTrader 5\MQL5",
        "C:\Program Files (x86)\MetaTrader 5\MQL5",
        "$env:USERPROFILE\AppData\Roaming\MetaQuotes\Terminal"
    )
    foreach ($f in $fallbacks) {
        if (Test-Path $f) { $mt5DataFolder = Split-Path $f; break }
    }
}

if (-not $mt5DataFolder) {
    Write-Warn "Could not auto-detect MT5 data folder."
    Write-Host ""
    Write-Host "  In MetaTrader 5: File -> Open Data Folder" -ForegroundColor White
    Write-Host "  Paste the path here:" -ForegroundColor White
    $mt5DataFolder = Read-Host "  MT5 data folder path"
    if (-not (Test-Path $mt5DataFolder)) {
        Write-Fail "Path does not exist: $mt5DataFolder"
    }
}

$mql5 = Join-Path $mt5DataFolder "MQL5"
Write-OK "MT5 data folder: $mt5DataFolder"

# ── Step 2: Clone / update repo ───────────────────────────────────────────
Write-Step "Downloading EA files from GitHub..."

$tmpDir = Join-Path $env:TEMP "fkbot_install"
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }

# Check for git
$gitAvail = $null -ne (Get-Command git -ErrorAction SilentlyContinue)

if ($gitAvail) {
    git clone --depth 1 --branch $BRANCH $REPO $tmpDir 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "git clone failed. Check your internet connection." }
    Write-OK "Repository cloned via git."
} else {
    Write-Warn "git not found — downloading ZIP from GitHub..."
    $zipUrl = "https://github.com/badr-hammani/fkbot_dist/archive/refs/heads/$BRANCH.zip"
    $zipPath = Join-Path $env:TEMP "fkbot.zip"
    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    } catch {
        Write-Fail "Download failed: $_`n  Check internet or install git from https://git-scm.com"
    }
    Expand-Archive $zipPath -DestinationPath $env:TEMP -Force
    # GitHub names the extracted folder <repo>-<branch>
    $extracted = Get-ChildItem $env:TEMP -Directory | Where-Object { $_.Name -like "fkbot_dist*" } | Select-Object -First 1
    if (-not $extracted) { Write-Fail "Could not find extracted folder." }
    Rename-Item $extracted.FullName $tmpDir
    Remove-Item $zipPath -Force
    Write-OK "Repository downloaded and extracted."
}

# ── Step 3: Download JAson.mqh ────────────────────────────────────────────
Write-Step "Downloading JAson.mqh (JSON parser required by news API)..."

$includeDir = Join-Path $mql5 "Include"
if (-not (Test-Path $includeDir)) { New-Item $includeDir -ItemType Directory | Out-Null }
$jasonDest = Join-Path $includeDir "JAson.mqh"

if (Test-Path $jasonDest) {
    Write-OK "JAson.mqh already present — skipping."
} else {
    try {
        Invoke-WebRequest -Uri $JASON_URL -OutFile $jasonDest -UseBasicParsing
        Write-OK "JAson.mqh downloaded."
    } catch {
        Write-Warn "Could not download JAson.mqh automatically."
        Write-Warn "Download manually from: https://github.com/vivazzi/JAson"
        Write-Warn "Place it at: $jasonDest"
    }
}

# ── Step 4: Copy EA and include files ─────────────────────────────────────
Write-Step "Copying EA files into MetaTrader 5..."

function CopyFile($src, $destDir) {
    if (-not (Test-Path $destDir)) { New-Item $destDir -ItemType Directory -Force | Out-Null }
    $dest = Join-Path $destDir (Split-Path $src -Leaf)
    Copy-Item $src $dest -Force
    Write-OK "Copied: $(Split-Path $src -Leaf) -> $destDir"
}

function CopyDir($srcDir, $destDir) {
    if (-not (Test-Path $srcDir)) { Write-Warn "Source not found: $srcDir"; return }
    if (-not (Test-Path $destDir)) { New-Item $destDir -ItemType Directory -Force | Out-Null }
    Copy-Item "$srcDir\*" $destDir -Recurse -Force
    Write-OK "Copied folder: $(Split-Path $srcDir -Leaf)"
}

$experts  = Join-Path $mql5 "Experts"
$includes = Join-Path $mql5 "Include"

# ICT EA
CopyFile (Join-Path $tmpDir "ICT_EA\ICT_GoldTrader.mq5")    $experts
CopyFile (Join-Path $tmpDir "ICT_EA\ICT_SignalEngine.mqh")   $experts

# SMC EA
CopyFile (Join-Path $tmpDir "SmartMoney_EA\SMC_GoldTrader.mq5")  $experts
CopyFile (Join-Path $tmpDir "SmartMoney_EA\SMC_SignalEngine.mqh") $experts

# Shared includes
CopyDir (Join-Path $tmpDir "Shared")      (Join-Path $includes "Shared")
CopyDir (Join-Path $tmpDir "Backtesting") (Join-Path $includes "Backtesting")

# ── Step 5: Cleanup temp ──────────────────────────────────────────────────
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

# ── Step 6: Open MetaEditor to compile ────────────────────────────────────
Write-Step "Opening MetaEditor for compilation..."

# Find MetaEditor executable
$meEditor = $null
$searchPaths = @(
    "C:\Program Files\MetaTrader 5\metaeditor64.exe",
    "C:\Program Files (x86)\MetaTrader 5\metaeditor64.exe",
    "C:\Program Files\MetaTrader 5\metaeditor.exe"
)
foreach ($p in $searchPaths) { if (Test-Path $p) { $meEditor = $p; break } }

if (-not $meEditor) {
    # Search registry for MT5 install path
    try {
        $regPath = "HKLM:\SOFTWARE\MetaQuotes\MetaTrader 5"
        $installDir = (Get-ItemProperty $regPath -ErrorAction Stop).InstallPath
        $meEditor = Join-Path $installDir "metaeditor64.exe"
        if (-not (Test-Path $meEditor)) { $meEditor = $null }
    } catch {}
}

$ictFile = Join-Path $experts "ICT_GoldTrader.mq5"
$smcFile = Join-Path $experts "SMC_GoldTrader.mq5"

if ($meEditor) {
    Write-OK "Found MetaEditor: $meEditor"
    Write-Host "    Compiling ICT_GoldTrader..." -ForegroundColor Gray
    & $meEditor /compile:"$ictFile" /log 2>&1 | Out-Null
    Write-Host "    Compiling SMC_GoldTrader..." -ForegroundColor Gray
    & $meEditor /compile:"$smcFile" /log 2>&1 | Out-Null
    Write-OK "Compilation triggered. Check MetaEditor for any errors."
} else {
    Write-Warn "MetaEditor not found in default locations."
    Write-Warn "Open MetaEditor manually (F4 in MT5) and press F7 on each EA file."
}

# ── Done ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor White
Write-Host ""
Write-Host "  Files installed to:" -ForegroundColor White
Write-Host "    $experts" -ForegroundColor Gray
Write-Host "    $includes\Shared" -ForegroundColor Gray
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "    1. Open MetaTrader 5" -ForegroundColor Gray
Write-Host "    2. Press F4 to open MetaEditor and verify no compile errors" -ForegroundColor Gray
Write-Host "    3. Press Ctrl+R in MT5 to run Strategy Tester on XAUUSD M15" -ForegroundColor Gray
Write-Host "    4. Attach the EA to a chart only after backtesting is satisfactory" -ForegroundColor Gray
Write-Host ""
Write-Host "  IMPORTANT: Never run on a live account without backtesting first." -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter to close"
