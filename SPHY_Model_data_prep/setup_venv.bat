@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "VENV_DIR=%SCRIPT_DIR%.venv"

if not exist "%VENV_DIR%\Scripts\python.exe" (
    py -3 -m venv "%VENV_DIR%"
    if errorlevel 1 (
        python -m venv "%VENV_DIR%"
        if errorlevel 1 exit /b 1
    )
)

call "%VENV_DIR%\Scripts\activate.bat"
python -m pip install --upgrade pip
if errorlevel 1 exit /b 1

python -m pip install -r "%SCRIPT_DIR%requirements.txt"
if errorlevel 1 exit /b 1

echo Virtual environment ready at %VENV_DIR%
exit /b 0