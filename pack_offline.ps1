param(
    [string]$SourceRoot = (Split-Path -Parent $PSCommandPath),
    [string]$PackageRoot = "D:\ISRO-SWOT\Webapp_packed",
    [string]$BuiltRuntime = "",
    [switch]$SkipFrontendBuild
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

$runtimeOut = Join-Path $PackageRoot "webapp_backend"
if ([string]::IsNullOrWhiteSpace($BuiltRuntime)) {
    $BuiltRuntime = Join-Path $PackageRoot "_build\dist\webapp_backend"
}

$frontendDir = Join-Path $SourceRoot "frontend"
$frontendDist = Join-Path $frontendDir "dist"
$databaseDir = Join-Path $SourceRoot "Database"
$mapHandleDir = Join-Path $SourceRoot "Map_handle"

Require-Path -PathValue $SourceRoot -Label "SourceRoot"
Require-Path -PathValue $BuiltRuntime -Label "Built runtime"
Require-Path -PathValue $frontendDir -Label "Frontend folder"
Require-Path -PathValue $databaseDir -Label "Database folder"
Require-Path -PathValue $mapHandleDir -Label "Map_handle folder"

if (-not $SkipFrontendBuild) {
    Write-Host "Building frontend..." -ForegroundColor Cyan
    Push-Location $frontendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend build failed."
        }
    }
    finally {
        Pop-Location
    }
}

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
start "" "webapp_backend.exe"
timeout /t 2 >nul
start "" "http://127.0.0.1:8000"
echo App started at http://127.0.0.1:8000
"@

$stopBat = @"
@echo off
taskkill /IM webapp_backend.exe /F >nul 2>&1
echo App stopped.
"@

Set-Content -Path (Join-Path $PackageRoot "START_APP.bat") -Value $startBat -Encoding ASCII
Set-Content -Path (Join-Path $PackageRoot "STOP_APP.bat") -Value $stopBat -Encoding ASCII

Write-Host ""
Write-Host "Offline package sync complete." -ForegroundColor Green
Write-Host "Source : $SourceRoot"
Write-Host "Package: $PackageRoot"
Write-Host "Run    : $PackageRoot\START_APP.bat"
