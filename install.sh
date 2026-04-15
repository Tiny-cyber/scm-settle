#!/bin/bash
# SCM 一键结算 - 安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/Tiny-cyber/scm-settle/main/install.sh | bash

set -e

echo "=============================="
echo "  SCM 一键结算 - 安装"
echo "=============================="
echo ""

# 1. 检查 Node.js，没有就自动装 nvm + node
if command -v node &>/dev/null; then
  echo "✓ Node.js: $(node -v)"
else
  echo "安装 Node.js..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install --lts
  echo "✓ Node.js 已安装: $(node -v)"
fi

# 2. 检查 Chrome
if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "✓ Chrome 已安装"
else
  echo "✗ 请先安装 Google Chrome: https://www.google.com/chrome/"
  exit 1
fi

# 3. 下载项目
INSTALL_DIR="$HOME/Projects/scm-settle"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "✓ 项目已存在，更新中..."
  cd "$INSTALL_DIR"
  git pull
else
  echo "下载项目..."
  mkdir -p "$HOME/Projects"
  git clone https://github.com/Tiny-cyber/scm-settle.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 4. 安装依赖
echo "安装依赖..."
npm install --silent
npx playwright install chromium
echo "✓ 依赖安装完成"

# 5. Chrome 调试模式（开机自启，独立 profile）
PROFILE_DIR="$HOME/.chrome-debug-profile"
PLIST_FILE="$HOME/Library/LaunchAgents/com.chrome-debug.plist"

if [ ! -f "$PLIST_FILE" ]; then
  echo "配置 Chrome 调试模式..."
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chrome-debug</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</string>
        <string>--remote-debugging-port=9222</string>
        <string>--user-data-dir=${PROFILE_DIR}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/chrome-debug-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/chrome-debug-stderr.log</string>
</dict>
</plist>
EOF
  echo "✓ Chrome 调试模式已配置（开机自启）"
fi

# 6. 启动调试 Chrome（如果没在跑）
if ! curl -s http://127.0.0.1:9222/json/version &>/dev/null; then
  echo "启动调试 Chrome..."
  launchctl load "$PLIST_FILE" 2>/dev/null || true
  sleep 3
fi

# 7. 创建工作台 + 双击运行文件
mkdir -p "$HOME/Desktop/工作台/电商/每日结算报告"
COMMAND_FILE="$HOME/Desktop/工作台/电商/一键结算.command"
NODE_BIN="$(dirname "$(which node)")"
cat > "$COMMAND_FILE" << SCRIPT
#!/bin/bash
export PATH="${NODE_BIN}:\$PATH"
cd "${INSTALL_DIR}"

echo "=============================="
echo "  SCM 一键结算"
echo "=============================="
echo ""

YESTERDAY=\$(date -v-1d +%Y-%m-%d)
echo "请输入要结算的日期（回车默认昨天 \$YESTERDAY）："
echo "  格式: 2026-03-19（单日）或 2026-03（整月）"
echo ""
read -p "> " INPUT_DATE
DATE=\${INPUT_DATE:-\$YESTERDAY}

echo ""
echo "开始结算: \$DATE"
echo ""

node settle-all.js "\$DATE"

echo ""
echo "按回车关闭窗口..."
read
SCRIPT
chmod +x "$COMMAND_FILE"

# 完成
echo ""
echo "=============================="
echo "  ✓ 安装完成！"
echo "=============================="
echo ""
echo "还差最后一步（只需做一次）："
echo "  在弹出的 Chrome 窗口里打开 https://zyhx.scm.xinwuyun.com 并登录"
echo ""
echo "之后每次使用："
echo "  双击 ~/Desktop/工作台/电商/一键结算.command"
echo "  报告自动保存到 ~/Desktop/工作台/电商/每日结算报告/"
