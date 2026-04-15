#!/usr/bin/env node
/**
 * 打样打卡系统
 *
 * 局域网内师傅用手机扫码，输入样品编码，点"完成"记录时间。
 * 替代微信群手动报备 + 人工记录的流程。
 *
 * 用法：node checkin-server.js
 * 端口：5680
 * 数据：./checkin-data/YYYY-MM-DD.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PORT = 5680;
const DATA_DIR = path.join(__dirname, 'checkin-data');
const QR_FILE = path.join(__dirname, 'checkin-qr.png');
const QR_HOST_FILE = path.join(__dirname, '.checkin-qr-hostname');

// 师傅名单（来自节点时效.xlsx "节点操作人" sheet）
const WORKERS = [
  '崔景卿', '房毅', '胡林松', '李超',
  '张得财',
  '曾兰燕', '贺建华', '李雪梅', '李晓燕', '王海', '王雷', '郑得强',
  '彭林丽', '彭海兵', '罗志强',
  '梁卫婷', '梁卫芬', '薛惠分', '周念',
  '欧阳颖冰', '赵娇', '覃小姬',
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ 网络工具 ============

function getLocalHostname() {
  let h = os.hostname();
  if (!h.endsWith('.local')) h += '.local';
  return h;
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// ============ 二维码生成 ============

function generateQR(url) {
  const script = `
import Cocoa
import CoreImage

let url = "${url}"
guard let data = url.data(using: .utf8),
      let filter = CIFilter(name: "CIQRCodeGenerator") else { exit(1) }
filter.setValue(data, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let output = filter.outputImage else { exit(1) }
let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
let rep = NSBitmapImageRep(ciImage: scaled)
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: "${QR_FILE}"))
`;
  fs.writeFileSync('/tmp/checkin-qr.swift', script);
  try {
    execSync('swift /tmp/checkin-qr.swift', { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

function ensureQR() {
  const hostname = getLocalHostname();
  const url = `http://${hostname}:${PORT}`;
  let needRegen = !fs.existsSync(QR_FILE);

  if (!needRegen && fs.existsSync(QR_HOST_FILE)) {
    if (fs.readFileSync(QR_HOST_FILE, 'utf8').trim() !== hostname) needRegen = true;
  } else {
    needRegen = true;
  }

  if (needRegen) {
    console.log('生成二维码...');
    if (generateQR(url)) {
      fs.writeFileSync(QR_HOST_FILE, hostname);
      console.log(`✓ 二维码: ${QR_FILE}`);
    } else {
      console.error('⚠ 二维码生成失败');
    }
  }
  return url;
}

// ============ 数据存储 ============

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function nowLocal() {
  const n = new Date();
  const off = -n.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const om = String(Math.abs(off) % 60).padStart(2, '0');
  const p = (v) => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}${sign}${oh}:${om}`;
}

function dataFile(date) { return path.join(DATA_DIR, `${date}.json`); }

function loadRecords(date) {
  const f = dataFile(date);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return []; }
}

function saveRecord(record) {
  const date = record.completed_at.slice(0, 10);
  const records = loadRecords(date);
  record.id = Date.now();
  records.push(record);
  fs.writeFileSync(dataFile(date), JSON.stringify(records, null, 2), 'utf8');
  return record;
}

function deleteRecord(date, id) {
  const records = loadRecords(date);
  const filtered = records.filter(r => r.id !== id);
  if (filtered.length === records.length) return false;
  fs.writeFileSync(dataFile(date), JSON.stringify(filtered, null, 2), 'utf8');
  return true;
}

// ============ HTTP 工具 ============

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function htmlRes(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
}

// ============ HTML 页面 ============

function setupPage(url) {
  return `<!DOCTYPE html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>打样打卡 - 设置</title>
<style>
body{font-family:-apple-system,sans-serif;text-align:center;padding:40px 20px;background:#f5f5f5}
h1{font-size:24px;margin-bottom:20px}
img{max-width:280px;border:8px solid white;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1)}
.url{margin-top:20px;font-size:14px;color:#666;word-break:break-all}
.url a{color:#007aff}
</style></head><body>
<h1>打样打卡系统</h1>
<p>用手机浏览器扫码打开（不要用微信扫）：</p>
<img src="/qr.png" alt="QR">
<div class="url">
  <p><a href="${url}">${url}</a></p>
  <p>备用: <a href="http://${getLocalIP()}:${PORT}">http://${getLocalIP()}:${PORT}</a></p>
</div>
</body></html>`;
}

function mainPage() {
  return `<!DOCTYPE html><html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<title>打样打卡</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f5f7;min-height:100vh;
  -webkit-tap-highlight-color:transparent}
.container{max-width:420px;margin:0 auto;padding:20px 16px}

/* 选人界面 */
.picker{display:none}
.picker h2{text-align:center;font-size:22px;padding:24px 0 16px;color:#1d1d1f}
.picker .list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.picker .item{padding:14px 8px;background:white;border-radius:12px;text-align:center;
  font-size:16px;font-weight:500;cursor:pointer;border:2px solid transparent;
  box-shadow:0 1px 3px rgba(0,0,0,.06);transition:all .15s;user-select:none}
.picker .item:active{border-color:#007aff;background:#f0f7ff}

/* 主界面 */
.header{text-align:center;padding:24px 0 8px}
.worker-name{font-size:28px;font-weight:700;color:#1d1d1f}
.switch-btn{font-size:13px;color:#007aff;background:none;border:none;margin-top:8px;
  cursor:pointer;padding:4px 12px}

.input-area{background:white;border-radius:16px;padding:20px;margin:12px 0;
  box-shadow:0 1px 3px rgba(0,0,0,.06)}
.input-area label{display:block;font-size:15px;color:#86868b;margin-bottom:8px}
.input-area input{width:100%;font-size:24px;font-weight:600;padding:12px;
  border:2px solid #e5e5ea;border-radius:12px;text-align:center;
  -webkit-appearance:none;appearance:none;background:white}
.input-area input:focus{outline:none;border-color:#007aff}
.input-area input::placeholder{color:#c7c7cc;font-weight:400}
.note-input input{font-size:16px;font-weight:400}

.complete-btn{width:100%;padding:16px;font-size:20px;font-weight:600;
  background:#34c759;color:white;border:none;border-radius:14px;
  cursor:pointer;margin-top:12px;transition:transform .1s,opacity .1s;user-select:none}
.complete-btn:active{transform:scale(.97);opacity:.8}
.complete-btn:disabled{background:#c7c7cc}

/* 成功提示 */
.toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.8);
  background:rgba(0,0,0,.8);color:white;border-radius:20px;padding:32px 40px;
  text-align:center;opacity:0;transition:all .25s;pointer-events:none;z-index:100}
.toast.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.toast .icon{font-size:48px}
.toast .msg{font-size:18px;font-weight:600;margin-top:8px}
.toast .sub{font-size:14px;color:rgba(255,255,255,.7);margin-top:4px}

/* 历史记录 */
.history{margin-top:24px}
.history h3{font-size:15px;color:#86868b;margin-bottom:12px;padding:0 4px;
  display:flex;justify-content:space-between;align-items:center}
.history h3 a{font-size:13px;color:#007aff;text-decoration:none}
.record{background:white;border-radius:12px;padding:14px 16px;margin-bottom:8px;
  display:flex;justify-content:space-between;align-items:center;
  box-shadow:0 1px 2px rgba(0,0,0,.04)}
.record .left .sample{font-size:17px;font-weight:600;color:#1d1d1f}
.record .left .note{font-size:13px;color:#86868b;margin-top:2px}
.record .right{text-align:right}
.record .right .time{font-size:15px;color:#34c759;font-weight:500}
.record .right .del{font-size:12px;color:#c7c7cc;background:none;border:none;
  cursor:pointer;margin-top:4px;padding:2px 6px}
.record .right .del:active{color:#ff3b30}

.empty{text-align:center;color:#c7c7cc;padding:20px;font-size:15px}
.all-link{text-align:center;margin-top:16px}
.all-link a{font-size:14px;color:#007aff;text-decoration:none}
</style>
</head><body>

<div class="container">
  <div class="picker" id="picker">
    <h2>选择你的名字</h2>
    <div class="list" id="workerList"></div>
  </div>

  <div id="main" style="display:none">
    <div class="header">
      <div class="worker-name" id="workerName"></div>
      <button class="switch-btn" onclick="switchWorker()">切换身份</button>
    </div>

    <div class="input-area">
      <label>样品编码</label>
      <input type="tel" id="sampleNo" placeholder="输入编码" inputmode="numeric" autocomplete="off">
    </div>

    <div class="input-area note-input">
      <label>备注（选填）</label>
      <input type="text" id="note" placeholder="如：拍照样交裁" autocomplete="off">
    </div>

    <button class="complete-btn" id="completeBtn" onclick="doComplete()">完成 ✅</button>

    <div class="history" id="history">
      <h3><span>今日记录</span><a href="/all" target="_blank">查看全部</a></h3>
      <div id="records"></div>
    </div>
  </div>
</div>

<!-- 成功浮层 -->
<div class="toast" id="toast">
  <div class="icon">✅</div>
  <div class="msg" id="toastMsg"></div>
  <div class="sub" id="toastSub"></div>
</div>

<script>
const WORKERS = ${JSON.stringify(WORKERS)};
let currentWorker = null;

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---- 设备绑定 ----
function getWorker() {
  const m = document.cookie.match(/checkin_worker=([^;]+)/);
  if (m) { const v = decodeURIComponent(m[1]); if (WORKERS.includes(v)) return v; }
  const ls = localStorage.getItem('checkin_worker');
  if (ls && WORKERS.includes(ls)) return ls;
  return null;
}
function setWorker(name) {
  currentWorker = name;
  document.cookie = 'checkin_worker=' + encodeURIComponent(name) + ';path=/;max-age=31536000';
  localStorage.setItem('checkin_worker', name);
}

// ---- 初始化 ----
function init() {
  const saved = getWorker();
  if (saved) { currentWorker = saved; showMain(); }
  else showPicker();
}

function showPicker() {
  document.getElementById('picker').style.display = 'block';
  document.getElementById('main').style.display = 'none';
  const list = document.getElementById('workerList');
  list.innerHTML = '';
  WORKERS.forEach(name => {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = name;
    d.onclick = () => { setWorker(name); showMain(); };
    list.appendChild(d);
  });
}

function showMain() {
  document.getElementById('picker').style.display = 'none';
  document.getElementById('main').style.display = 'block';
  document.getElementById('workerName').textContent = currentWorker;
  document.getElementById('sampleNo').value = '';
  document.getElementById('note').value = '';
  loadHistory();
  setTimeout(() => document.getElementById('sampleNo').focus(), 100);
}

function switchWorker() { showPicker(); }

// ---- 提交完成 ----
async function doComplete() {
  const sampleNo = document.getElementById('sampleNo').value.trim();
  if (!sampleNo) { document.getElementById('sampleNo').focus(); return; }

  const note = document.getElementById('note').value.trim();
  const btn = document.getElementById('completeBtn');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    const res = await fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker: currentWorker, sample_no: sampleNo, note }),
    });
    const data = await res.json();

    if (data.ok) {
      const t = new Date(data.record.completed_at);
      const ts = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
      showToast(ts + ' 已记录', sampleNo + (note ? ' · ' + note : ''));
      if (navigator.vibrate) navigator.vibrate(50);

      setTimeout(() => {
        document.getElementById('sampleNo').value = '';
        document.getElementById('note').value = '';
        btn.disabled = false;
        btn.textContent = '完成 ✅';
        loadHistory();
        document.getElementById('sampleNo').focus();
      }, 1200);
    } else {
      alert('提交失败: ' + (data.error || '未知错误'));
      btn.disabled = false;
      btn.textContent = '完成 ✅';
    }
  } catch (e) {
    alert('网络错误: ' + e.message);
    btn.disabled = false;
    btn.textContent = '完成 ✅';
  }
}

function showToast(msg, sub) {
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastSub').textContent = sub;
  const el = document.getElementById('toast');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1200);
}

// ---- 撤销 ----
async function delRecord(id) {
  if (!confirm('确定撤销这条记录？')) return;
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (data.ok) loadHistory();
    else alert('撤销失败');
  } catch (e) { alert('网络错误'); }
}

// ---- 历史记录 ----
async function loadHistory() {
  try {
    const res = await fetch('/api/today?worker=' + encodeURIComponent(currentWorker));
    const data = await res.json();
    const el = document.getElementById('records');

    if (!data.records || data.records.length === 0) {
      el.innerHTML = '<div class="empty">暂无记录</div>';
      return;
    }

    el.innerHTML = data.records.slice().reverse().map(r => {
      const t = new Date(r.completed_at);
      const ts = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
      return '<div class="record"><div class="left">' +
        '<div class="sample">' + esc(r.sample_no) + '</div>' +
        (r.note ? '<div class="note">' + esc(r.note) + '</div>' : '') +
        '</div><div class="right">' +
        '<div class="time">' + ts + '</div>' +
        '<button class="del" onclick="delRecord(' + r.id + ')">撤销</button>' +
        '</div></div>';
    }).join('');
  } catch {}
}

// ---- 键盘支持 ----
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const active = document.activeElement;
    if (active && (active.id === 'sampleNo' || active.id === 'note')) doComplete();
  }
});

init();
</script>
</body></html>`;
}

function allPage() {
  return `<!DOCTYPE html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日全部记录</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f5f7;min-height:100vh}
.container{max-width:600px;margin:0 auto;padding:20px 16px}
h1{font-size:20px;text-align:center;padding:16px 0;color:#1d1d1f}
.date{text-align:center;font-size:14px;color:#86868b;margin-bottom:16px}
.stat{display:flex;justify-content:center;gap:24px;margin-bottom:20px}
.stat .n{font-size:28px;font-weight:700;color:#1d1d1f}
.stat .label{font-size:13px;color:#86868b}
.stat .box{text-align:center}
table{width:100%;border-collapse:collapse;background:white;border-radius:12px;
  overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}
th{background:#f5f5f7;padding:10px 12px;font-size:13px;color:#86868b;font-weight:500;
  text-align:left;border-bottom:1px solid #e5e5ea}
td{padding:10px 12px;font-size:15px;border-bottom:1px solid #f2f2f7}
tr:last-child td{border-bottom:none}
.time-cell{color:#34c759;font-weight:500}
.note-cell{color:#86868b;font-size:13px}
.empty{text-align:center;color:#c7c7cc;padding:40px;font-size:15px}
.refresh{text-align:center;margin-top:16px}
.refresh button{font-size:14px;color:#007aff;background:none;border:none;cursor:pointer;padding:8px 16px}
</style>
</head><body>
<div class="container">
  <h1>打样打卡 - 全部记录</h1>
  <div class="date" id="date"></div>
  <div class="stat">
    <div class="box"><div class="n" id="totalCount">0</div><div class="label">总记录</div></div>
    <div class="box"><div class="n" id="workerCount">0</div><div class="label">师傅</div></div>
  </div>
  <div id="content"></div>
  <div class="refresh"><button onclick="load()">刷新</button></div>
</div>
<script>
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

async function load() {
  const res = await fetch('/api/today');
  const data = await res.json();
  document.getElementById('date').textContent = data.date;

  const records = data.records || [];
  document.getElementById('totalCount').textContent = records.length;
  const workers = new Set(records.map(r => r.worker));
  document.getElementById('workerCount').textContent = workers.size;

  if (records.length === 0) {
    document.getElementById('content').innerHTML = '<div class="empty">暂无记录</div>';
    return;
  }

  const sorted = records.slice().sort((a, b) =>
    new Date(b.completed_at) - new Date(a.completed_at));

  let html = '<table><thead><tr><th>时间</th><th>师傅</th><th>样品编码</th><th>备注</th></tr></thead><tbody>';
  for (const r of sorted) {
    const t = new Date(r.completed_at);
    const ts = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0') +
               ':' + t.getSeconds().toString().padStart(2,'0');
    html += '<tr><td class="time-cell">' + ts + '</td><td>' + esc(r.worker) +
            '</td><td>' + esc(r.sample_no) + '</td><td class="note-cell">' +
            esc(r.note || '') + '</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('content').innerHTML = html;
}

load();
setInterval(load, 15000);
</script>
</body></html>`;
}

// ============ 服务器 ============

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 页面
  if (p === '/') return htmlRes(res, mainPage());
  if (p === '/setup') return htmlRes(res, setupPage(serviceUrl));
  if (p === '/all') return htmlRes(res, allPage());

  if (p === '/qr.png') {
    if (fs.existsSync(QR_FILE)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(QR_FILE));
    }
    res.writeHead(404); return res.end('QR not found');
  }

  // API
  if (p === '/api/workers') return json(res, { workers: WORKERS });

  if (p === '/api/complete' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.sample_no || !body.worker) return json(res, { ok: false, error: '缺少必填字段' }, 400);

    const record = saveRecord({
      worker: body.worker,
      sample_no: String(body.sample_no).trim(),
      note: (body.note || '').trim(),
      completed_at: nowLocal(),
    });
    console.log(`✓ ${record.worker} 完成 ${record.sample_no} @ ${record.completed_at.slice(11, 16)}`);
    return json(res, { ok: true, record });
  }

  if (p === '/api/delete' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.id) return json(res, { ok: false, error: '缺少 id' }, 400);
    const ok = deleteRecord(todayStr(), body.id);
    return json(res, { ok });
  }

  if (p === '/api/today') {
    const worker = url.searchParams.get('worker');
    let records = loadRecords(todayStr());
    if (worker) records = records.filter(r => r.worker === worker);
    return json(res, { date: todayStr(), records });
  }

  if (p === '/api/records') {
    const date = url.searchParams.get('date') || todayStr();
    return json(res, { date, records: loadRecords(date) });
  }

  res.writeHead(404); res.end('Not found');
});

// ============ 启动 ============

const serviceUrl = ensureQR();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏭 打样打卡系统已启动`);
  console.log(`   地址: ${serviceUrl}`);
  console.log(`   备用: http://${getLocalIP()}:${PORT}`);
  console.log(`   设置页（二维码）: ${serviceUrl}/setup`);
  console.log(`   全部记录: ${serviceUrl}/all`);
  console.log(`   数据目录: ${DATA_DIR}/`);
  console.log('');
});
