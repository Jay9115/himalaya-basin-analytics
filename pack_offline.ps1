param(
    [string]$SourceRoot = (Split-Path -Parent $PSCommandPath),
    [string]$PackageRoot = "D:\ISRO-SWOT\Webapp_packed",
    [string]$BuiltRuntime = "",
    [switch]$SkipFrontendBuild,
    [switch]$SkipBackendBuild,
    [switch]$KeepBuildArtifacts,
    [string]$BuilderVenvPath = ""
)

$ErrorActionPreference = "Stop"

function Require-Path {
    param(
        [Parameter(Mandatory = $true)][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $PathValue)) {
        throw "$Label not found: $PathValue"
    }
}

function Sync-Folder {
    param(
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$To
    )

    New-Item -ItemType Directory -Force -Path $To | Out-Null
    robocopy $From $To /MIR /R:2 /W:2 /NFL /NDL /NP | Out-Host
    $code = $LASTEXITCODE
    if ($code -gt 7) {
        throw "robocopy failed (exit code $code): $From -> $To"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter()][string]$Label = "Command"
    )

    Write-Host ">> $Command" -ForegroundColor DarkGray
    & cmd.exe /d /c $Command | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Ensure-BuilderPython {
    param(
        [Parameter(Mandatory = $true)][string]$BuildRootPath,
        [Parameter(Mandatory = $true)][string]$RequirementsFile,
        [Parameter()][string]$RequestedVenvPath = ""
    )

    $venvPath = $RequestedVenvPath
    if ([string]::IsNullOrWhiteSpace($venvPath)) {
        $venvPath = Join-Path $BuildRootPath "builder_venv"
    }

    $pythonExe = Join-Path $venvPath "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $pythonExe)) {
        Write-Host "Creating isolated build venv: $venvPath" -ForegroundColor Cyan
        Invoke-Checked -Command "python -m venv `"$venvPath`"" -Label "Create build venv"
    }

    Write-Host "Installing backend build dependencies in isolated venv..." -ForegroundColor Cyan
    Invoke-Checked -Command "`"$pythonExe`" -m pip install --upgrade pip setuptools wheel" -Label "Upgrade build venv pip tooling"
    try {
        Invoke-Checked -Command "`"$pythonExe`" -m pip install -r `"$RequirementsFile`" pyinstaller==6.19.0" -Label "Install build dependencies"
    }
    catch {
        Write-Host "Standard dependency resolution failed, using compatibility install fallback..." -ForegroundColor Yellow
        Invoke-Checked -Command "`"$pythonExe`" -m pip install fastapi==0.104.1 uvicorn[standard]==0.24.0 pandas==2.1.3 pyarrow==14.0.1 python-multipart==0.0.6 netCDF4==1.7.4 pyinstaller==6.19.0" -Label "Install fallback dependencies"
        Invoke-Checked -Command "`"$pythonExe`" -m pip install xarray==2025.11.0 --no-deps" -Label "Install xarray fallback"
    }

    return $pythonExe
}

$buildRoot = Join-Path $PackageRoot "_build"
$distRoot = Join-Path $buildRoot "dist"
$workRoot = Join-Path $buildRoot "work"
$specRoot = Join-Path $buildRoot "spec"
$runtimeOut = Join-Path $PackageRoot "webapp_backend"

$backendDir = Join-Path $SourceRoot "backend"
$backendEntry = Join-Path $backendDir "main.py"
$backendRequirements = Join-Path $backendDir "requirements.txt"
$frontendDir = Join-Path $SourceRoot "frontend"
$frontendDist = Join-Path $frontendDir "dist"
$databaseDir = Join-Path $SourceRoot "Database"
$mapHandleDir = Join-Path $SourceRoot "Map_handle"

Require-Path -PathValue $SourceRoot -Label "SourceRoot"
Require-Path -PathValue $backendDir -Label "Backend folder"
Require-Path -PathValue $backendEntry -Label "Backend entrypoint"
Require-Path -PathValue $backendRequirements -Label "Backend requirements"
Require-Path -PathValue $frontendDir -Label "Frontend folder"
Require-Path -PathValue $databaseDir -Label "Database folder"
Require-Path -PathValue $mapHandleDir -Label "Map_handle folder"

if ([string]::IsNullOrWhiteSpace($BuiltRuntime)) {
    $BuiltRuntime = Join-Path $distRoot "webapp_backend"
}

if (-not $SkipFrontendBuild) {
    Write-Host "Building frontend..." -ForegroundColor Cyan
    Push-Location $frontendDir
    try {
        Invoke-Checked -Command "npm run build" -Label "Frontend build"
    }
    finally {
        Pop-Location
    }
}

if (-not $SkipBackendBuild) {
    Write-Host "Building backend executable (PyInstaller)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $specRoot | Out-Null

    $builderPy = Ensure-BuilderPython -BuildRootPath $buildRoot -RequirementsFile $backendRequirements -RequestedVenvPath $BuilderVenvPath

    Push-Location $SourceRoot
    try {
        $pyi = @(
            "`"$builderPy`" -m PyInstaller",
            "--noconfirm",
            "--clean",
            "--onedir",
            "--name webapp_backend",
            "--distpath `"$distRoot`"",
            "--workpath `"$workRoot`"",
            "--specpath `"$specRoot`"",
            "--hidden-import xarray",
            "--hidden-import netCDF4",
            "--hidden-import cftime",
            "--collect-all pyarrow",
            "--collect-all pandas",
            "`"$backendEntry`""
        ) -join " "
        Invoke-Checked -Command $pyi -Label "PyInstaller build"
    }
    finally {
        Pop-Location
    }
}

Require-Path -PathValue $BuiltRuntime -Label "Built runtime"
Require-Path -PathValue $frontendDist -Label "Frontend dist output"

Write-Host "Syncing backend runtime..." -ForegroundColor Cyan
Sync-Folder -From $BuiltRuntime -To $runtimeOut

Write-Host "Syncing frontend dist..." -ForegroundColor Cyan
Sync-Folder -From $frontendDist -To (Join-Path $runtimeOut "frontend_dist")

Write-Host "Syncing database..." -ForegroundColor Cyan
Sync-Folder -From $databaseDir -To (Join-Path $runtimeOut "Database")

Write-Host "Syncing map assets..." -ForegroundColor Cyan
Sync-Folder -From $mapHandleDir -To (Join-Path $runtimeOut "Map_handle")

$startBat = @"
@echo off
setlocal
cd /d "%~dp0webapp_backend"
if not exist "webapp_backend.exe" (
  echo ERROR: webapp_backend.exe not found.
  pause
  exit /b 1
)
start "" "webapp_backend.exe"
timeout /t 3 >nul
start "" "http://127.0.0.1:8000"
echo App started at http://127.0.0.1:8000
"@

$stopBat = @"
@echo off
taskkill /IM webapp_backend.exe /F >nul 2>&1
echo App stopped.
"@

$readmeTxt = @"
Himalaya Basin Analytics - Offline Portable Bundle
==================================================

Run:
  1) Double-click START_APP.bat
  2) Use STOP_APP.bat to close backend when finished

Folder structure:
  webapp_backend\            <- backend executable + runtime
  webapp_backend\frontend_dist
  webapp_backend\Database
  webapp_backend\Map_handle

Notes:
  - No Python/Node installation is required on target Windows machine.
  - Keep Database and Map_handle folders together with webapp_backend.exe.
"@

Set-Content -Path (Join-Path $PackageRoot "START_APP.bat") -Value $startBat -Encoding ASCII
Set-Content -Path (Join-Path $PackageRoot "STOP_APP.bat") -Value $stopBat -Encoding ASCII
Set-Content -Path (Join-Path $PackageRoot "README_OFFLINE.txt") -Value $readmeTxt -Encoding ASCII

if (-not $KeepBuildArtifacts) {
    if (Test-Path -LiteralPath $buildRoot) {
        Write-Host "Removing build artifacts folder: $buildRoot" -ForegroundColor Cyan
        Remove-Item -LiteralPath $buildRoot -Recurse -Force
    }
}

Write-Host ""
Write-Host "Offline package ready." -ForegroundColor Green
Write-Host "Source        : $SourceRoot"
Write-Host "Build runtime : $BuiltRuntime"
Write-Host "Package       : $PackageRoot"
Write-Host "Run           : $PackageRoot\START_APP.bat"
