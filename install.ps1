# SCM 一键结算 - Windows 安装脚本
# 用法: powershell -c "irm https://raw.githubusercontent.com/Tiny-cyber/scm-settle/main/install.ps1 | iex"

$ErrorActionPreference = "Stop"

# 解除脚本执行限制（仅当前进程，不影响系统设置）
Set-ExecutionPolicy Bypass -Scope Process -Force

Write-Host "=============================="
Write-Host "  SCM 一键结算 - Windows 安装"
Write-Host "==============================`n"

# 1. 检查 Node.js，没有就引导安装
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "[OK] Node.js: $(node -v)"
} else {
    Write-Host "Node.js 未安装，正在自动安装..."
    # 用 winget 装（Windows 10 1709+ 自带）
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # 刷新 PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (Get-Command node -ErrorAction SilentlyContinue) {
            Write-Host "[OK] Node.js 已安装: $(node -v)"
        } else {
            Write-Host "[!] Node.js 安装完成，但需要重新打开终端才能生效"
            Write-Host "    请关掉这个窗口，重新运行安装命令"
            Read-Host "按回车退出"
            exit 1
        }
    } else {
        Write-Host "[!] 请手动安装 Node.js: https://nodejs.org/"
        Read-Host "按回车退出"
        exit 1
    }
}

# 2. 检查 Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "[OK] Git: $(git --version)"
} else {
    Write-Host "Git 未安装，正在自动安装..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Git.Git --accept-source-agreements --accept-package-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (Get-Command git -ErrorAction SilentlyContinue) {
            Write-Host "[OK] Git 已安装"
        } else {
            Write-Host "[!] Git 安装完成，但需要重新打开终端才能生效"
            Write-Host "    请关掉这个窗口，重新运行安装命令"
            Read-Host "按回车退出"
            exit 1
        }
    } else {
        Write-Host "[!] 请手动安装 Git: https://git-scm.com/"
        Read-Host "按回车退出"
        exit 1
    }
}

# 3. 检查浏览器（Chrome 或 Edge）
$browserPaths = @(
    @{ Path = "C:\Program Files\Google\Chrome\Application\chrome.exe"; Name = "Chrome" },
    @{ Path = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"; Name = "Chrome" },
    @{ Path = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"; Name = "Edge" },
    @{ Path = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"; Name = "Edge" }
)

$browser = $null
foreach ($b in $browserPaths) {
    if (Test-Path $b.Path) {
        $browser = $b
        break
    }
}

if ($browser) {
    Write-Host "[OK] 检测到 $($browser.Name)"
} else {
    Write-Host "[!] 未检测到 Chrome 或 Edge，请安装其中一个"
    Read-Host "按回车退出"
    exit 1
}

# 4. 下载项目
$installDir = "$HOME\Projects\scm-settle"
if (Test-Path "$installDir\.git") {
    Write-Host "[OK] 项目已存在，更新中..."
    Set-Location $installDir
    git pull
} else {
    # 如果文件夹存在但不是 git 项目（旧版手动拷贝的），先删掉再 clone
    if (Test-Path $installDir) {
        Write-Host "检测到旧版本（非 git），清理后重新下载..."
        Remove-Item -Recurse -Force $installDir
    }
    Write-Host "下载项目..."
    New-Item -ItemType Directory -Path "$HOME\Projects" -Force | Out-Null
    git clone https://github.com/Tiny-cyber/scm-settle.git $installDir
    Set-Location $installDir
}

# 5. 安装依赖（跳过 Playwright 浏览器下载，直连本地 Chrome/Edge）
Write-Host "安装依赖..."
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
npm install --silent
Write-Host "[OK] 依赖安装完成"

# 6. 创建工作台目录
$desktopPath = [Environment]::GetFolderPath("Desktop")
$reportDir = "$desktopPath\工作台\电商\每日结算报告"
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
Write-Host "[OK] 工作台目录已创建"

# 7. 创建调试浏览器启动脚本
$profileDir = "$HOME\.chrome-debug-profile"
$debugBat = "$desktopPath\工作台\电商\启动调试浏览器.bat"
$debugContent = @"
@echo off
title 调试浏览器 - $($browser.Name)
start "" "$($browser.Path)" --remote-debugging-port=9222 --user-data-dir="$profileDir"
exit
"@
Set-Content -Path $debugBat -Value $debugContent -Encoding UTF8
Write-Host "[OK] 调试浏览器启动脚本已创建（使用 $($browser.Name)）"

# 8. 创建一键结算脚本
$nodePath = (Get-Command node).Source | Split-Path
$settleBat = "$desktopPath\工作台\电商\一键结算.bat"
$settleContent = @"
@echo off
chcp 65001 >nul
title SCM 一键结算
cd /d "$installDir"

echo ==============================
echo   SCM 一键结算
echo ==============================
echo.

for /f "usebackq" %%a in (`powershell -command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"`) do set YESTERDAY=%%a

echo 请输入要结算的日期（直接回车默认昨天 %YESTERDAY%）：
echo   格式: 2026-03-19（单日）或 2026-03（整月）
echo.
set /p "INPUT_DATE=> "
if "%INPUT_DATE%"=="" set "INPUT_DATE=%YESTERDAY%"

echo 开始结算: %INPUT_DATE%
echo.
node settle-all.js "%INPUT_DATE%"
echo.
pause
"@
Set-Content -Path $settleBat -Value $settleContent -Encoding UTF8
Write-Host "[OK] 一键结算脚本已创建"

# 完成
Write-Host "`n=============================="
Write-Host "  [OK] 安装完成！"
Write-Host "==============================`n"
Write-Host "还差最后一步（只需做一次）："
Write-Host "  1. 双击 桌面\工作台\电商\启动调试浏览器.bat"
Write-Host "  2. 在弹出的浏览器里打开 https://zyhx.scm.xinwuyun.com 并登录`n"
Write-Host "之后每次使用："
Write-Host "  双击 桌面\工作台\电商\一键结算.bat"
Write-Host "  报告自动保存到 桌面\工作台\电商\每日结算报告\`n"
Read-Host "按回车关闭"
