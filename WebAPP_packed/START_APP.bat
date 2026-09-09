@echo off
setlocal enabledelayedexpansion
title Himalaya Basin Analytics Launcher

set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%webapp_backend"

cd /d "%BACKEND_DIR%"
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

REM Check existing configured dataset path
set "CURRENT_DATASET_DIR="
if exist "%ROOT_DIR%dataset_path.txt" (
  set /p CURRENT_DATASET_DIR=<"%ROOT_DIR%dataset_path.txt"
)
if not defined CURRENT_DATASET_DIR (
  if exist "%BACKEND_DIR%\dataset_path.txt" (
    set /p CURRENT_DATASET_DIR=<"%BACKEND_DIR%\dataset_path.txt"
  )
)

REM Check whether current dataset path or default Database folder has files
set "DATASET_COUNT=0"
if defined CURRENT_DATASET_DIR (
  if exist "!CURRENT_DATASET_DIR!" (
    for /r "!CURRENT_DATASET_DIR!" %%f in (*.parquet *.tif *.tiff) do (
      set /a DATASET_COUNT+=1
      goto :found_files
    )
  )
)

if exist "%BACKEND_DIR%\Database" (
  for /r "%BACKEND_DIR%\Database" %%f in (*.parquet *.tif *.tiff) do (
    set /a DATASET_COUNT+=1
    goto :found_files
  )
)

:found_files
if !DATASET_COUNT! equ 0 (
  echo.
  echo ================================================================
  echo   Himalaya Basin Analytics - Dataset Setup
  echo ================================================================
  echo  No dataset files (.parquet / .tif) were detected in the
  echo  default Database directory.
  echo.
  echo  If you have your datasets on another drive or folder, please
  echo  enter the full path below (e.g. D:\ISRO-SWOT\Database):
  echo.
  echo  Or press [ENTER] to skip and configure it later in the WebApp.
  echo ----------------------------------------------------------------
  set /p USER_PATH="Enter Dataset Path: "
  if defined USER_PATH (
    set "USER_PATH=!USER_PATH:"=!"
  )
  if defined USER_PATH (
    if exist "!USER_PATH!" (
      echo [OK] Valid path entered: !USER_PATH!
      echo !USER_PATH!> "%ROOT_DIR%dataset_path.txt"
      echo !USER_PATH!> "%BACKEND_DIR%\dataset_path.txt"
      set "DATABASE_DIR=!USER_PATH!"
      echo Configured successfully.
    ) else (
      echo [WARNING] Directory not found: !USER_PATH!
      echo Starting with default settings (configure anytime in browser).
      timeout /t 3 >nul
    )
  ) else (
    echo Starting with default settings (configure anytime in browser).
  )
  echo.
) else (
  if defined CURRENT_DATASET_DIR (
    set "DATABASE_DIR=!CURRENT_DATASET_DIR!"
  )
)

echo Starting backend services...
start "Himalaya Basin Analytics" "webapp_backend.exe"
timeout /t 4 >nul
start "" "http://127.0.0.1:8000"
echo =======================================================
echo  Himalaya Basin Analytics WebApp is running!
echo  URL: http://127.0.0.1:8000
echo  Press any key or run STOP_APP.bat to stop the app.
echo =======================================================
pause
