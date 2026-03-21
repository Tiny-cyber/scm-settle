const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const projectDir = __dirname;

console.log('==============================');
console.log('  SCM 一键结算 - 安装');
console.log('==============================\n');

// 1. 检查浏览器
const browserPaths = [
  { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', name: 'Chrome' },
  { path: path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'), name: 'Chrome' },
  { path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', name: 'Edge' },
  { path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', name: 'Edge' },
];

let browser = null;
for (const b of browserPaths) {
  if (fs.existsSync(b.path)) {
    browser = b;
    break;
  }
}

if (!browser) {
  console.log('× 未检测到 Chrome 或 Edge');
  process.exit(1);
}
console.log(`√ 检测到 ${browser.name}`);

// 2. 安装依赖（跳过 Playwright 浏览器下载，脚本连接已有的 Edge/Chrome）
console.log('\n安装依赖...');
execSync('npm install --silent', {
  cwd: projectDir,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
});
console.log('√ 依赖安装完成');

// 3. 创建工作台目录
const reportDir = path.join(home, 'Desktop', '工作台', '电商', '每日结算报告');
fs.mkdirSync(reportDir, { recursive: true });
console.log('√ 工作台目录已创建');

// 4. 创建浏览器调试模式启动脚本
const debugBat = path.join(home, 'Desktop', '工作台', '电商', '启动调试浏览器.bat');
fs.writeFileSync(debugBat, [
  '@echo off',
  `title 调试浏览器 - ${browser.name}`,
  `start "" "${browser.path}" --remote-debugging-port=9222 --user-data-dir="${path.join(home, '.chrome-debug-profile')}"`,
  'exit',
].join('\r\n'), 'utf8');
console.log(`√ 调试浏览器启动脚本已创建（使用 ${browser.name}）`);

// 5. 创建一键结算脚本
const settleBat = path.join(home, 'Desktop', '工作台', '电商', '一键结算.bat');
fs.writeFileSync(settleBat, [
  '@echo off',
  'chcp 65001 >nul',
  'title SCM 一键结算',
  `cd /d "${projectDir}"`,
  '',
  'echo ==============================',
  'echo   SCM 一键结算',
  'echo ==============================',
  'echo.',
  '',
  'for /f "usebackq" %%a in (`powershell -command "(Get-Date).AddDays(-1).ToString(\'yyyy-MM-dd\')"`) do set YESTERDAY=%%a',
  '',
  'echo 请输入要结算的日期（直接回车默认昨天 %YESTERDAY%）：',
  'echo   格式: 2026-03-19（单日）或 2026-03（整月）',
  'echo.',
  'set /p "INPUT_DATE=> "',
  'if "%INPUT_DATE%"=="" set "INPUT_DATE=%YESTERDAY%"',
  '',
  'echo 开始结算: %INPUT_DATE%',
  'echo.',
  'node settle-all.js "%INPUT_DATE%"',
  'echo.',
  'pause',
].join('\r\n'), 'utf8');
console.log('√ 一键结算脚本已创建');

// 完成
console.log('\n==============================');
console.log('  √ 安装完成！');
console.log('==============================\n');
console.log('还差最后一步（只需做一次）：');
console.log('  1. 双击 桌面\\工作台\\电商\\启动调试浏览器.bat');
console.log('  2. 在弹出的浏览器里打开 https://zyhx.scm.xinwuyun.com 并登录\n');
console.log('之后每次使用：');
console.log('  双击 桌面\\工作台\\电商\\一键结算.bat');
console.log('  报告自动保存到 桌面\\工作台\\电商\\每日结算报告\\\n');
