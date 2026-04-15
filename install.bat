@echo off
cd /d "%~dp0"
where node >nul 2>nul
if not %ERRORLEVEL%==0 (
    echo Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
node install.js
pause
