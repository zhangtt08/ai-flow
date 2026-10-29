@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0AI Flow Launcher.ps1"
if errorlevel 1 pause
exit /b
