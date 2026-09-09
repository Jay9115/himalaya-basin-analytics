@echo off
echo ============================================
echo  Temperature Visualization System Launcher
echo ============================================
echo.

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH
    echo Please install Python 3.8 or higher
    pause
    exit /b 1
)

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH
    echo Please install Node.js 16 or higher
    pause
    exit /b 1
)

echo [1/4] Checking Python dependencies...
cd backend
if not exist "venv\" (
    echo Creating virtual environment...
    python -m venv venv
)

echo Activating virtual environment...
call venv\Scripts\activate.bat

echo Installing/Updating Python packages...
pip install -q -r requirements.txt

echo.
echo [2/4] Checking dataset files...
cd ..\
set "CURRENT_DATASET_DIR="
if exist "dataset_path.txt" (
    set /p CURRENT_DATASET_DIR=<"dataset_path.txt"
)
if not defined CURRENT_DATASET_DIR (
    if exist "backend\dataset_path.txt" (
        set /p CURRENT_DATASET_DIR=<"backend\dataset_path.txt"
    )
)

set "ACTIVE_DB_DIR=%cd%\Database"
if defined CURRENT_DATASET_DIR (
    if exist "%CURRENT_DATASET_DIR%" (
        set "ACTIVE_DB_DIR=%CURRENT_DATASET_DIR%"
    )
)

set total_db_count=0
if exist "%ACTIVE_DB_DIR%" (
    for /r "%ACTIVE_DB_DIR%" %%f in (*.parquet *.tif *.tiff) do (
        set /a total_db_count+=1
    )
)

if %total_db_count% equ 0 (
    echo [WARNING] No dataset files (.parquet / .tif) found in: %ACTIVE_DB_DIR%
    echo.
    echo If your dataset folder is in another directory, enter the path below
    echo (or press Enter to skip and configure later in browser):
    set /p USER_DB_PATH="Dataset Folder Path: "
    if defined USER_DB_PATH (
        set "USER_DB_PATH=%USER_DB_PATH:"=%"
    )
    if defined USER_DB_PATH (
        if exist "%USER_DB_PATH%" (
            echo %USER_DB_PATH%> dataset_path.txt
            echo %USER_DB_PATH%> backend\dataset_path.txt
            set "DATABASE_DIR=%USER_DB_PATH%"
            echo Connected to: %USER_DB_PATH%
        ) else (
            echo [WARNING] Directory not found: %USER_DB_PATH%
        )
    )
) else (
    echo Found %total_db_count% dataset files in: %ACTIVE_DB_DIR%
    if defined CURRENT_DATASET_DIR (
        set "DATABASE_DIR=%CURRENT_DATASET_DIR%"
    )
)

echo.
echo [3/4] Checking frontend dependencies...
cd frontend
if not exist "node_modules\" (
    echo Installing Node.js packages (this may take a few minutes)...
    call npm install
) else (
    echo Node modules already installed
)

echo.
echo [4/4] Starting servers...
echo.
echo ============================================
echo  Starting Backend Server...
echo ============================================

cd ..\backend
start "Backend - FastAPI" cmd /k "call venv\Scripts\activate.bat && python main.py"

timeout /t 3 /nobreak >nul

echo.
echo ============================================
echo  Starting Frontend Server...
echo ============================================

cd ..\frontend
start "Frontend - Vite" cmd /k "npm run dev"

timeout /t 3 /nobreak >nul

echo.
echo ============================================
echo  System Started Successfully!
echo ============================================
echo.
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://localhost:5173
echo.
echo Two new terminal windows have opened.
echo Keep them running while using the application.
echo.
echo Opening browser in 5 seconds...
timeout /t 5 /nobreak >nul

start http://localhost:5173

echo.
echo Press any key to exit this launcher...
echo (Backend and Frontend will continue running)
pause >nul
