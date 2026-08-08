param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$ServiceRoot = Split-Path -Parent $PSCommandPath
Set-Location $ServiceRoot

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter()][string]$Label = "Command"
    )

    Write-Host ">> $Command" -ForegroundColor DarkGray
    & cmd.exe /d /c $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

$venvPath = Join-Path $ServiceRoot ".venv"
$pythonExe = Join-Path $venvPath "Scripts\python.exe"
$pipExe = Join-Path $venvPath "Scripts\pip.exe"

if (-not (Test-Path -LiteralPath $pythonExe)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    Invoke-Step -Command "python -m venv `"$venvPath`"" -Label "Create venv"
}

if (-not $SkipInstall) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    Invoke-Step -Command "`"$pythonExe`" -m pip install --upgrade pip" -Label "Upgrade pip"
    Invoke-Step -Command "`"$pipExe`" install -r requirements.txt" -Label "Install requirements"
}

if (-not (Test-Path -LiteralPath (Join-Path $ServiceRoot ".env"))) {
    Copy-Item -LiteralPath (Join-Path $ServiceRoot ".env.example") -Destination (Join-Path $ServiceRoot ".env")
    Write-Host "Created .env from .env.example" -ForegroundColor Yellow
}

Write-Host "Starting LLM service..." -ForegroundColor Green
& $pythonExe main.py
