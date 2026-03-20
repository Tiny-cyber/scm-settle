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
    pause
    exit /b 1
)

:: 2. 检查 Chrome
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    echo √ Chrome 已安装
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    echo √ Chrome 已安装
) else (
    echo × 未检测到 Chrome
    echo   请先安装: https://www.google.com/chrome/
    pause
    exit /b 1
)

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

:: 5. 创建 Chrome 调试模式启动脚本
set "CHROME_DEBUG=%USERPROFILE%\Desktop\工作台\电商\启动调试Chrome.bat"
(
echo @echo off
echo title Chrome 调试模式
echo start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-debug-profile"
echo exit
) > "%CHROME_DEBUG%"
echo √ Chrome 调试模式启动脚本已创建

:: 6. 创建双击运行文件
set "COMMAND_FILE=%USERPROFILE%\Desktop\工作台\电商\一键结算.bat"
(
echo @echo off
echo chcp 65001 ^>nul
echo title SCM 一键结算
echo cd /d "%~dp0..\..\..\..\Projects\scm-settle"
echo echo ==============================
echo echo   SCM 一键结算
echo echo ==============================
echo echo.
echo.
echo :: 计算昨天日期
echo for /f "tokens=1-3 delims=/" %%%%a in ('powershell -command "(Get-Date^).AddDays(-1^).ToString('yyyy/MM/dd')"'^) do set YESTERDAY=%%%%a-%%%%b-%%%%c
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
) > "%COMMAND_FILE%"
echo √ 双击运行文件已创建

:: 完成
echo.
echo ==============================
echo   √ 安装完成！
echo ==============================
echo.
echo 还差最后一步（只需做一次）：
echo   1. 双击 桌面\工作台\电商\启动调试Chrome.bat
echo   2. 在弹出的 Chrome 里打开 https://zyhx.scm.xinwuyun.com 并登录
echo.
echo 之后每次使用：
echo   双击 桌面\工作台\电商\一键结算.bat
echo   报告自动保存到 桌面\工作台\电商\每日结算报告\
echo.
pause
