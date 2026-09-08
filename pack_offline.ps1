param(
    [string]$SourceRoot = (Split-Path -Parent $PSCommandPath),
    [string]$PackageRoot = "D:\ISRO-SWOT\V5_webapp_packed",
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

function Ensure-Folder {
    param(
        [Parameter(Mandatory = $true)][string]$PathValue
    )

    New-Item -ItemType Directory -Force -Path $PathValue | Out-Null
}

function Ensure-EmptyDatabaseLayout {
    param(
        [Parameter(Mandatory = $true)][string]$Root
    )

    $folders = @(
        "Full_Shape_ERA5",
        "Full_shape_CMIP6",
        "SPHY_Model",
        "MOD10A1_Monthly_GeoTIFF",
        "Discharge_Geopar",
        "Uploaded_NC\_uploads"
    )
    foreach ($folder in $folders) {
        Ensure-Folder -PathValue (Join-Path $Root $folder)
    }

    $manifestPath = Join-Path $Root "Uploaded_NC\uploaded_nc_datasets.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        @'
{
  "version": 1,
  "datasets": []
}
'@ | Set-Content -Path $manifestPath -Encoding UTF8
    }
}

function Ensure-EmptyOutcomesLayout {
    param(
        [Parameter(Mandatory = $true)][string]$Root
    )

    Ensure-Folder -PathValue (Join-Path $Root "Long_term_hotspot\Outputs")
    Ensure-Folder -PathValue (Join-Path $Root "Long_term_hotspot\Scripts")
}

function Ensure-WorkspaceLayout {
    param(
        [Parameter(Mandatory = $true)][string]$Root
    )

    Ensure-Folder -PathValue (Join-Path $Root "HBapi\workspace\custom_operations\jobs")
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
        Invoke-Checked -Command "`"$pythonExe`" -m pip install fastapi==0.104.1 uvicorn[standard]==0.24.0 pandas==2.1.3 pyarrow==14.0.1 python-multipart==0.0.6 netCDF4==1.7.4 geopandas==1.0.1 pyogrio==0.11.0 shapely==2.1.2 rasterio==1.4.3 pyinstaller==6.19.0" -Label "Install fallback dependencies"
        Invoke-Checked -Command "`"$pythonExe`" -m pip install xarray==2025.11.0 --no-deps" -Label "Install xarray fallback"
    }

    return $pythonExe
}

function Get-PyInstallerCommonArgs {
    param(
        [Parameter(Mandatory = $true)][string]$DistPath,
        [Parameter(Mandatory = $true)][string]$WorkPath,
        [Parameter(Mandatory = $true)][string]$SpecPath
    )

    return @(
        "--noconfirm",
        "--clean",
        "--onedir",
        "--distpath `"$DistPath`"",
        "--workpath `"$WorkPath`"",
        "--specpath `"$SpecPath`"",
        "--hidden-import xarray",
        "--hidden-import netCDF4",
        "--hidden-import cftime",
        "--hidden-import geopandas",
        "--hidden-import pyogrio",
        "--hidden-import shapely",
        "--hidden-import rasterio",
        "--hidden-import custom_operations.runtime",
        "--collect-all pyarrow",
        "--collect-all pandas",
        "--collect-all pyogrio",
        "--collect-all rasterio",
        "--collect-all scipy",
        "--collect-all statsmodels",
        "--collect-all matplotlib"
    )
}

function Invoke-PyInstallerBuild {
    param(
        [Parameter(Mandatory = $true)][string]$BuilderPy,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$EntryScript,
        [Parameter(Mandatory = $true)][string]$DistPath,
        [Parameter(Mandatory = $true)][string]$WorkPath,
        [Parameter(Mandatory = $true)][string]$SpecPath,
        [Parameter()][string]$WorkingDirectory = "",
        [Parameter()][string[]]$ExtraArgs = @()
    )

    $commonArgs = Get-PyInstallerCommonArgs -DistPath $DistPath -WorkPath $WorkPath -SpecPath $SpecPath
    $args = @(
        "`"$BuilderPy`" -m PyInstaller"
        ($commonArgs -join " ")
        "--name $Name"
        ($ExtraArgs -join " ")
        "`"$EntryScript`""
    ) -join " "

    if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        Invoke-Checked -Command $args -Label "PyInstaller build ($Name)"
        return
    }

    Push-Location $WorkingDirectory
    try {
        Invoke-Checked -Command $args -Label "PyInstaller build ($Name)"
    }
    finally {
        Pop-Location
    }
}

$buildRoot = Join-Path $PackageRoot "_build"
$distRoot = Join-Path $buildRoot "dist"
$workRoot = Join-Path $buildRoot "work"
$specRoot = Join-Path $buildRoot "spec"
$runtimeOut = Join-Path $PackageRoot "webapp_backend"

$backendDir = Join-Path $SourceRoot "backend"
$backendEntry = Join-Path $backendDir "main.py"
$backendRequirements = Join-Path $backendDir "requirements.txt"
$customOpsDir = Join-Path $backendDir "custom_operations"
$sandboxWorkerEntry = Join-Path $customOpsDir "worker.py"
$largeWorkerEntry = Join-Path $customOpsDir "large_worker.py"
$frontendDir = Join-Path $SourceRoot "frontend"
$frontendDist = Join-Path $frontendDir "dist"
$mapHandleDir = Join-Path $SourceRoot "Map_handle"
$glacierDir = Join-Path $SourceRoot "Glacier_shp"

Require-Path -PathValue $SourceRoot -Label "SourceRoot"
Require-Path -PathValue $backendDir -Label "Backend folder"
Require-Path -PathValue $backendEntry -Label "Backend entrypoint"
Require-Path -PathValue $backendRequirements -Label "Backend requirements"
Require-Path -PathValue $customOpsDir -Label "Custom operations folder"
Require-Path -PathValue $sandboxWorkerEntry -Label "Sandbox worker entrypoint"
Require-Path -PathValue $largeWorkerEntry -Label "Large worker entrypoint"
Require-Path -PathValue $frontendDir -Label "Frontend folder"
Require-Path -PathValue $mapHandleDir -Label "Map_handle folder"

if ([string]::IsNullOrWhiteSpace($BuiltRuntime)) {
    $BuiltRuntime = Join-Path $distRoot "webapp_backend"
}

if (-not $SkipFrontendBuild) {
    Write-Host "Building frontend for offline localhost API..." -ForegroundColor Cyan
    Push-Location $frontendDir
    try {
        $env:VITE_API_URL = "http://127.0.0.1:8000"
        $env:VITE_LLM_URL = "http://127.0.0.1:8010"
        Invoke-Checked -Command "npm run build" -Label "Frontend build"
    }
    finally {
        Remove-Item Env:VITE_API_URL -ErrorAction SilentlyContinue
        Remove-Item Env:VITE_LLM_URL -ErrorAction SilentlyContinue
        Pop-Location
    }
}

if (-not $SkipBackendBuild) {
    Write-Host "Building backend and sandbox worker executables (PyInstaller)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $specRoot | Out-Null

    $builderPy = Ensure-BuilderPython -BuildRootPath $buildRoot -RequirementsFile $backendRequirements -RequestedVenvPath $BuilderVenvPath

    Invoke-PyInstallerBuild `
        -BuilderPy $builderPy `
        -Name "webapp_backend" `
        -EntryScript $backendEntry `
        -DistPath $distRoot `
        -WorkPath $workRoot `
        -SpecPath $specRoot `
        -WorkingDirectory $SourceRoot

    Invoke-PyInstallerBuild `
        -BuilderPy $builderPy `
        -Name "sandbox_worker" `
        -EntryScript $sandboxWorkerEntry `
        -DistPath $distRoot `
        -WorkPath (Join-Path $workRoot "sandbox_worker") `
        -SpecPath $specRoot `
        -WorkingDirectory $customOpsDir `
        -ExtraArgs @(
            "--hidden-import worker",
            "--collect-all numpy"
        )

    Invoke-PyInstallerBuild `
        -BuilderPy $builderPy `
        -Name "large_worker" `
        -EntryScript $largeWorkerEntry `
        -DistPath $distRoot `
        -WorkPath (Join-Path $workRoot "large_worker") `
        -SpecPath $specRoot `
        -WorkingDirectory $customOpsDir `
        -ExtraArgs @(
            "--hidden-import worker",
            "--collect-all numpy",
            "--collect-all duckdb"
        )
}

Require-Path -PathValue $BuiltRuntime -Label "Built runtime"
Require-Path -PathValue $frontendDist -Label "Frontend dist output"
Require-Path -PathValue (Join-Path $distRoot "sandbox_worker") -Label "Built sandbox worker runtime"
Require-Path -PathValue (Join-Path $distRoot "large_worker") -Label "Built large worker runtime"

Write-Host "Syncing backend runtime..." -ForegroundColor Cyan
Sync-Folder -From $BuiltRuntime -To $runtimeOut

Write-Host "Syncing sandbox worker runtime..." -ForegroundColor Cyan
Sync-Folder -From (Join-Path $distRoot "sandbox_worker") -To (Join-Path $runtimeOut "sandbox_worker")

Write-Host "Syncing large worker runtime..." -ForegroundColor Cyan
Sync-Folder -From (Join-Path $distRoot "large_worker") -To (Join-Path $runtimeOut "large_worker")

Write-Host "Syncing frontend dist..." -ForegroundColor Cyan
Sync-Folder -From $frontendDist -To (Join-Path $runtimeOut "frontend_dist")

Write-Host "Syncing map assets..." -ForegroundColor Cyan
Sync-Folder -From $mapHandleDir -To (Join-Path $runtimeOut "Map_handle")

if (Test-Path -LiteralPath $glacierDir) {
    Write-Host "Syncing glacier assets..." -ForegroundColor Cyan
    Sync-Folder -From $glacierDir -To (Join-Path $runtimeOut "Glacier_shp")
}
else {
    Write-Host "Creating empty Glacier_shp folder..." -ForegroundColor Cyan
    Ensure-Folder -PathValue (Join-Path $runtimeOut "Glacier_shp")
}

Write-Host "Creating empty Database layout..." -ForegroundColor Cyan
Ensure-EmptyDatabaseLayout -Root (Join-Path $runtimeOut "Database")

Write-Host "Creating empty Outcomes layout..." -ForegroundColor Cyan
Ensure-EmptyOutcomesLayout -Root (Join-Path $runtimeOut "Outcomes")

Write-Host "Creating custom operations workspace layout..." -ForegroundColor Cyan
Ensure-WorkspaceLayout -Root $runtimeOut

$startBat = @"
@echo off
setlocal
cd /d "%~dp0webapp_backend"
if not exist "webapp_backend.exe" (
  echo ERROR: webapp_backend.exe not found.
  pause
  exit /b 1
)
if not exist "sandbox_worker\sandbox_worker.exe" (
  echo ERROR: sandbox_worker.exe not found.
  pause
  exit /b 1
)
if not exist "large_worker\large_worker.exe" (
  echo ERROR: large_worker.exe not found.
  pause
  exit /b 1
)
start "Himalaya Backend" "webapp_backend.exe"
timeout /t 4 >nul
start "" "http://127.0.0.1:8000"
echo App started at http://127.0.0.1:8000
pause
"@

$stopBat = @"
@echo off
taskkill /IM webapp_backend.exe /F >nul 2>&1
taskkill /IM sandbox_worker.exe /F >nul 2>&1
taskkill /IM large_worker.exe /F >nul 2>&1
echo App stopped.
"@

$readmeTxt = @"
Himalaya Basin Analytics V5 - Offline Portable Bundle
=====================================================

Run:
  1) Double-click START_APP.bat
  2) Browser opens http://127.0.0.1:8000
  3) Use STOP_APP.bat to close the app

Included:
  - Compiled backend executable and runtime
  - Monaco sandbox worker executables (sandbox_worker, large_worker)
  - Built frontend files
  - Offline map assets from Map_handle
  - Glacier_shp assets when present in source build
  - Empty Database and Outcomes folders for later data copy

Not included:
  - Dataset parquet/geotiff payloads (copy into webapp_backend\Database)
  - Precomputed outcome payloads (copy into webapp_backend\Outcomes)

Folder structure:
  webapp_backend\
    webapp_backend.exe
    sandbox_worker\sandbox_worker.exe
    large_worker\large_worker.exe
    frontend_dist\
    Map_handle\
    Glacier_shp\
    Database\
    Outcomes\
    HBapi\workspace\custom_operations\

Notes:
  - No Python/Node installation is required on target Windows machine.
  - Keep runtime folders together with webapp_backend.exe.
  - Custom Python code from the Monaco editor runs through the bundled worker executables.
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
