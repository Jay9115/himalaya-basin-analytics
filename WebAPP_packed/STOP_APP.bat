@echo off
echo Stopping Himalaya Basin Analytics WebApp...
taskkill /IM webapp_backend.exe /F >nul 2>&1
taskkill /IM sandbox_worker.exe /F >nul 2>&1
taskkill /IM large_worker.exe /F >nul 2>&1
echo App stopped.
timeout /t 2 >nul
