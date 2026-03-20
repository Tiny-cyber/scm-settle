@echo off
chcp 65001 >nul
title SCM 一键结算 - 安装

echo ==============================
echo   SCM 一键结算 - 安装
echo ==============================
echo.

:: 1. 检查 Node.js
where node >nul 2>nul
if %ERRORLEVEL%==0 (
    echo √ Node.js 已安装
    node -v
) else (
    echo × 未检测到 Node.js
    echo   请先安装: https://nodejs.org/
    echo   下载 LTS 版本，安装时勾选 "Add to PATH"
    echo   装完后重新运行此脚本
    pause
    exit /b 1
)

:: 2. 检查浏览器（Chrome 或 Edge）
set "BROWSER_PATH="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Chrome"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Chrome"
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Edge"
) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Edge"
) else (
    echo × 未检测到 Chrome 或 Edge
    echo   请安装其中一个（推荐 Chrome）
    pause
    exit /b 1
)
echo √ 检测到 %BROWSER_NAME%

:: 3. 安装依赖
echo.
echo 安装依赖...
cd /d "%~dp0"
call npm install --silent
call npx playwright install chromium
echo √ 依赖安装完成

:: 4. 创建工作台目录
mkdir "%USERPROFILE%\Desktop\工作台\电商\每日结算报告" 2>nul
echo √ 工作台目录已创建

:: 5. 创建浏览器调试模式启动脚本
set "BROWSER_DEBUG=%USERPROFILE%\Desktop\工作台\电商\启动调试浏览器.bat"
> "%BROWSER_DEBUG%" (
echo @echo off
echo title 调试浏览器 - %BROWSER_NAME%
echo start "" "%BROWSER_PATH%" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-debug-profile"
echo exit
)
echo √ 调试浏览器启动脚本已创建（使用 %BROWSER_NAME%）

:: 6. 创建双击运行文件
set "SETTLE_DIR=%~dp0"
set "COMMAND_FILE=%USERPROFILE%\Desktop\工作台\电商\一键结算.bat"
> "%COMMAND_FILE%" (
echo @echo off
echo chcp 65001 ^>nul
echo title SCM 一键结算
echo cd /d "%SETTLE_DIR%"
echo.
echo echo ==============================
echo echo   SCM 一键结算
echo echo ==============================
echo echo.
echo.
echo for /f "usebackq" %%%%a in ^(`powershell -command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"`^) do set YESTERDAY=%%%%a
echo.
echo echo 请输入要结算的日期（直接回车默认昨天 %%YESTERDAY%%）：
echo echo   格式: 2026-03-19（单日）或 2026-03（整月）
echo echo.
echo set /p "INPUT_DATE=^> "
echo if "%%INPUT_DATE%%"=="" set "INPUT_DATE=%%YESTERDAY%%"
echo.
echo echo 开始结算: %%INPUT_DATE%%
echo echo.
echo node settle-all.js "%%INPUT_DATE%%"
echo echo.
echo pause
)
echo √ 一键结算脚本已创建

:: 完成
echo.
echo ==============================
echo   √ 安装完成！
echo ==============================
echo.
echo 还差最后一步（只需做一次）：
echo   1. 双击 桌面\工作台\电商\启动调试浏览器.bat
echo   2. 在弹出的浏览器里打开 https://zyhx.scm.xinwuyun.com 并登录
echo.
echo 之后每次使用：
echo   双击 桌面\工作台\电商\一键结算.bat
echo   报告自动保存到 桌面\工作台\电商\每日结算报告\
echo.
pause
