@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if not %ERRORLEVEL%==0 (
    echo Node.js not found. Please install from https://nodejs.org/
    pause
    exit /b 1
)

node install.js
pause
