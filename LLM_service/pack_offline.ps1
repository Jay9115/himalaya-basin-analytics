# Updated offline_build.ps1
# NOTE:
# This script is based on your original version with recommended improvements.
# Replace your existing offline_build.ps1 with this version.

param(
    [string]$SourceRoot = (Split-Path -Parent $PSCommandPath),
    [string]$PackageRoot = "D:\ISRO-SWOT\V5_llm_packed",
    [string]$BuiltRuntime = "",
    [switch]$SkipBackendBuild,
    [switch]$KeepBuildArtifacts,
    [string]$BuilderVenvPath = ""
)

$ErrorActionPreference = "Stop"

function Require-Path {
    param([string]$PathValue,[string]$Label)
    if(!(Test-Path $PathValue)){ throw "$Label not found: $PathValue" }
}

function Ensure-Folder{
    param([string]$PathValue)
    New-Item -ItemType Directory -Force -Path $PathValue | Out-Null
}

function Sync-Folder{
    param([string]$From,[string]$To)
    Ensure-Folder $To
    robocopy $From $To /MIR /R:2 /W:2 /NFL /NDL /NP | Out-Host
    if($LASTEXITCODE -gt 7){ throw "robocopy failed."}
}

function Invoke-Checked{
    param([string]$Command,[string]$Label="Command")
    Write-Host ">> $Command" -ForegroundColor DarkGray
    cmd /d /c $Command | Out-Host
    if($LASTEXITCODE -ne 0){ throw "$Label failed."}
}

function Ensure-BuilderPython{
    param([string]$BuildRootPath,[string]$RequirementsFile,[string]$RequestedVenvPath)

    if([string]::IsNullOrWhiteSpace($RequestedVenvPath)){
        $RequestedVenvPath = Join-Path $BuildRootPath "builder_venv"
    }

    $py = Join-Path $RequestedVenvPath "Scripts\python.exe"

    if(!(Test-Path $py)){
        Invoke-Checked "python -m venv `"$RequestedVenvPath`"" "Create venv"
    }

    Invoke-Checked "`"$py`" -m pip install --upgrade pip setuptools wheel" "Upgrade pip"
    Invoke-Checked "`"$py`" -m pip install -r `"$RequirementsFile`" pyinstaller==6.19.0" "Install deps"

    return $py
}

$buildRoot = Join-Path $PackageRoot "_build"
$distRoot  = Join-Path $buildRoot "dist"
$workRoot  = Join-Path $buildRoot "work"
$specRoot  = Join-Path $buildRoot "spec"

$runtimeOut = Join-Path $PackageRoot "llm_service"

$serviceEntry = Join-Path $SourceRoot "main.py"
$requirements = Join-Path $SourceRoot "requirements.txt"

Require-Path $serviceEntry "main.py"
Require-Path $requirements "requirements.txt"

if([string]::IsNullOrWhiteSpace($BuiltRuntime)){
    $BuiltRuntime = Join-Path $distRoot "llm_service"
}

if(!$SkipBackendBuild){

    Ensure-Folder $distRoot
    Ensure-Folder $workRoot
    Ensure-Folder $specRoot

    $builderPy = Ensure-BuilderPython $buildRoot $requirements $BuilderVenvPath

    Push-Location $SourceRoot

    $cmd = @(
    "`"$builderPy`" -m PyInstaller",
    "--clean",
    "--noconfirm",
    "--onedir",
    "--name llm_service",
    "--distpath `"$distRoot`"",
    "--workpath `"$workRoot`"",
    "--specpath `"$specRoot`"",
    "--collect-all llama_cpp",
    "--collect-all fastapi",
    "--collect-all starlette",
    "--collect-all uvicorn",
    "--hidden-import llama_cpp",
    "--hidden-import uvicorn",
    "--hidden-import anyio",
    "--hidden-import pydantic",
    "--hidden-import requests",
    "`"$serviceEntry`""
    ) -join " "

    Invoke-Checked $cmd "PyInstaller"

    Pop-Location
}

Require-Path $BuiltRuntime "Built runtime"

Sync-Folder $BuiltRuntime $runtimeOut

Ensure-Folder (Join-Path $runtimeOut "Models")

$env = Join-Path $runtimeOut ".env"

@'
LLM_BACKEND=embedded
MODEL_FILENAME=qwen2.5-coder-7b-instruct-q4_k_m.gguf
HOST=127.0.0.1
PORT=8010
N_GPU_LAYERS=0
N_THREADS=0
N_CTX=8192
'@ | Set-Content $env -Encoding ASCII

$start = @'
@echo off
cd /d "%~dp0llm_service"

if not exist llm_service.exe (
 echo ERROR: llm_service.exe missing
 pause
 exit /b
)

if not exist Models (
 echo Models folder missing
 pause
 exit /b
)

if not exist Models\qwen2.5-coder-7b-instruct-q4_k_m.gguf (
 echo.
 echo GGUF model not found.
 echo Copy:
 echo qwen2.5-coder-7b-instruct-q4_k_m.gguf
 echo into:
 echo Models\
 pause
 exit /b
)

start "" llm_service.exe

echo.
echo Waiting for server...
timeout /t 3 >nul

start http://127.0.0.1:8010/docs

echo.
echo LLM service started.
pause
'@

Set-Content (Join-Path $PackageRoot "START_LLM.bat") $start -Encoding ASCII

@'
@echo off
taskkill /IM llm_service.exe /F >nul 2>&1
echo Stopped.
pause
'@ | Set-Content (Join-Path $PackageRoot "STOP_LLM.bat") -Encoding ASCII

@'
Offline LLM Bundle

1. Copy GGUF into llm_service\Models
2. Run START_LLM.bat
3. API:
   GET /health
   GET /models
   POST /chat
   POST /generate

Frontend:
http://localhost:8000
LLM:
http://127.0.0.1:8010

If browser blocks requests, ensure CORS middleware exists in main.py.
'@ | Set-Content (Join-Path $PackageRoot "README_OFFLINE.txt") -Encoding ASCII

if(!$KeepBuildArtifacts){
    if(Test-Path $buildRoot){
        Remove-Item $buildRoot -Force -Recurse
    }
}

Write-Host ""
Write-Host "Offline package ready." -ForegroundColor Green