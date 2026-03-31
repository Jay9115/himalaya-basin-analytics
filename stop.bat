@echo off
echo ============================================
echo  Stopping Temperature Visualization System
echo ============================================
echo.

echo Stopping backend server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo Stopping frontend server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo.
echo Servers stopped successfully!
echo.
pause
