@echo off
REM Double-click to launch OmniList (starts the local server + opens your browser)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
echo Server stopped.
pause
