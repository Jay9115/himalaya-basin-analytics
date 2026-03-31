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
echo [2/4] Checking Parquet files...
cd ..\
set "ERA5_DIR=%cd%\Database\Full_Shape_ERA5"
set "CMIP_DIR=%cd%\Database\Full_shape_CMIP6"
set era5_count=0
set cmip_count=0

if exist "%ERA5_DIR%" (
    for %%f in ("%ERA5_DIR%\*.parquet") do set /a era5_count+=1
)
if exist "%CMIP_DIR%" (
    for %%f in ("%CMIP_DIR%\*.parquet") do set /a cmip_count+=1
)

echo ERA5 parquet files: %era5_count%
echo CMIP6 parquet files: %cmip_count%

if %era5_count% equ 0 (
    if %cmip_count% equ 0 (
        echo [WARNING] No Parquet files found for ERA5 or CMIP6.
        echo.
        set /p continue="Convert ERA5 + CMIP6 CSV files to Parquet now? (y/n): "
        if /i "%continue%"=="y" (
            cd backend
            python convert_csv_to_parquet.py --source-dir "%ERA5_DIR%"
            python convert_csv_to_parquet.py --source-dir "%CMIP_DIR%"
            cd ..
        )
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
