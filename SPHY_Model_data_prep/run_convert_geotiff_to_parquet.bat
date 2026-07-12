@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "VENV_DIR=%SCRIPT_DIR%.venv"

if not exist "%VENV_DIR%\Scripts\python.exe" (
    call "%SCRIPT_DIR%setup_venv.bat"
    if errorlevel 1 exit /b 1
)

call "%VENV_DIR%\Scripts\activate.bat"
python "%SCRIPT_DIR%convert_geotiff_to_parquet.py" %*