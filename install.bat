@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if not %ERRORLEVEL%==0 (
    echo 未检测到 Node.js，请先安装: https://nodejs.org/
    pause
    exit /b 1
)

set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
node install.js
pause
