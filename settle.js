#!/usr/bin/env node
/**
 * SCM 采购结算自动化脚本
 * 替代影刀 RPA，直接调用 API 批量生成结算单
 *
 * 用法：node settle.js
 * 跨平台：Mac / Windows 都能跑
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ============ 配置 ============
const CONFIG = {
  host: 'zyhx.scm.xinwuyun.com',
  companyId: '2420420446834944', // 佛山市自由呼吸服饰有限公司
  pageSize: 500,
  // 内部仓库（调拨用，不需要结算）
  internalSuppliers: [
    '佛山主仓', '经纬总仓', '染色仓',
    '虚拟仓-自由呼吸民乐厂', '自由呼吸',
  ],
};

// ============ HTTP 请求封装 ============
function request(path, body, cookie, contentType = 'json') {
  return new Promise((resolve, reject) => {
    const payload = contentType === 'json' ? JSON.stringify(body) : body;
    const options = {
      hostname: CONFIG.host,
      path,
      method: 'POST',
      headers: {
        'Content-Type': contentType === 'json'
          ? 'application/json'
          : 'application/x-www-form-urlencoded',
        'Cookie': cookie,
        'Accept': 'application/json',
        'Origin': `https://${CONFIG.host}`,
        'Referer': `https://${CONFIG.host}/`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`返回数据解析失败: ${data.substring(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============ API 函数 ============

// 查询采购入库单（单页）
function queryPurchaseStorage(cookie, month, page = 1) {
  const [year, mon] = month.split('-');
  const lastDay = new Date(parseInt(year), parseInt(mon), 0).getDate();

  return request('/biz-scm/purchase-storage/pageDto', {
    conditions: [
      { group: 'master', field: 'status', operator: 'in', value: ['2'], not: false },
      { group: 'master', field: 'is_settlement', operator: 'eq', value: '0', not: false },
      { group: 'master', field: 'biz_date', operator: 'range',
        value: { min: `${month}-01`, max: `${month}-${lastDay}` }, not: false },
    ],
    sorts: [],
    pagger: { page, limit: CONFIG.pageSize },
    extra: {},
  }, cookie);
}

// 查询所有页
async function queryAll(cookie, month) {
  const all = [];
  let page = 1;

  while (true) {
    const res = await queryPurchaseStorage(cookie, month, page);
    if (res.code !== 200) throw new Error(`查询失败: ${res.msg || JSON.stringify(res)}`);

    const items = res.data.items || [];
    const total = res.data.total || 0;
    all.push(...items);
    console.log(`  第 ${page} 页: +${items.length} 条（已获取 ${all.length}/${total}）`);

    if (all.length >= total || items.length === 0) break;
    page++;
  }

  return all;
}

// 调用自动结算 API
function autoSettle(cookie, supplierId, storageIds, settlementType = '') {
  const params = new URLSearchParams();
  params.append('supplierId', supplierId);
  params.append('companyId', CONFIG.companyId);
  params.append('settlementType', settlementType);
  params.append('storageIds', storageIds.join(','));

  return request('/biz-finance/settlement/auto-settlement',
    params.toString(), cookie, 'form');
}

// ============ 工具函数 ============

function isInternal(item) {
  // 去掉不可见字符再匹配，数据库里有些名字带乱码
  const name = (item.supplier_short_name || item.supplier_company_name || '')
    .replace(/[^\u4e00-\u9fffa-zA-Z0-9\-_（）()]/g, '');
  return CONFIG.internalSuppliers.some(w => name.includes(w));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function saveCsv(filePath, rows) {
  const header = '供应商,入库单数,状态,详情\n';
  const body = rows
    .map(r => `"${r.name}",${r.count},"${r.ok ? '成功' : '失败'}","${r.msg}"`)
    .join('\n');
  // BOM 让 Windows Excel 正确识别 UTF-8 中文
  fs.writeFileSync(filePath, '\ufeff' + header + body, 'utf8');
}

// ============ 主流程 ============

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('=== SCM 采购结算自动化 ===');
  console.log('替代影刀，直接调 API 批量结算\n');

  // 获取参数
  const cookie = (await ask('粘贴 Cookie（XWERPSSIONID=...）:\n> ')).trim();
  if (!cookie.includes('XWERPSSIONID')) {
    console.error('Cookie 格式不对，应该包含 XWERPSSIONID=...');
    rl.close();
    return;
  }

  const month = (await ask('\n结算月份（如 2026-02）:\n> ')).trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.error('月份格式不对，应该是 YYYY-MM');
    rl.close();
    return;
  }

  // [1/4] 查询
  console.log(`\n[1/4] 查询 ${month} 已核对+未结算的入库单...`);
  let allItems;
  try {
    allItems = await queryAll(cookie, month);
  } catch (e) {
    console.error('查询失败:', e.message);
    console.error('→ 可能 Cookie 过期了，重新从浏览器复制');
    rl.close();
    return;
  }

  if (allItems.length === 0) {
    console.log('没有符合条件的入库单。');
    rl.close();
    return;
  }

  // [2/4] 排除内部调拨
  console.log(`\n[2/4] 排除内部调拨仓库...`);
  const external = allItems.filter(item => !isInternal(item));
  console.log(`  总计 ${allItems.length} 条，排除内部 ${allItems.length - external.length} 条`);
  console.log(`  需要结算: ${external.length} 条`);

  if (external.length === 0) {
    console.log('排除内部调拨后没有需要结算的入库单。');
    rl.close();
    return;
  }

  // [3/4] 按供应商分组
  console.log(`\n[3/4] 按供应商分组...`);
  const groups = {};
  for (const item of external) {
    const sid = item.supplier_id;
    if (!groups[sid]) {
      groups[sid] = {
        supplierId: sid,
        name: item.supplier_short_name || item.supplier_company_name,
        storageIds: [],
        count: 0,
      };
    }
    if (!groups[sid].storageIds.includes(item.id)) {
      groups[sid].storageIds.push(item.id);
    }
    groups[sid].count++;
  }

  const suppliers = Object.values(groups);
  console.log(`  共 ${suppliers.length} 个供应商:\n`);
  for (const s of suppliers) {
    console.log(`    ${s.name}: ${s.count} 条`);
  }

  // 确认
  const confirm = await ask(`\n对以上 ${suppliers.length} 个供应商执行结算？(y/n) `);
  if (confirm.trim().toLowerCase() !== 'y') {
    console.log('已取消。');
    rl.close();
    return;
  }

  // [4/4] 执行结算
  console.log('\n[4/4] 执行结算...\n');
  const report = [];

  for (let i = 0; i < suppliers.length; i++) {
    const s = suppliers[i];
    const progress = `[${i + 1}/${suppliers.length}]`;
    process.stdout.write(`  ${progress} ${s.name} (${s.count}单)...`);

    try {
      const res = await autoSettle(cookie, s.supplierId, s.storageIds);
      if (res.code === 200) {
        console.log(' ✓ 成功');
        report.push({ name: s.name, count: s.count, ok: true, msg: '成功' });
      } else {
        const msg = res.msg || '未知错误';
        console.log(` ✗ ${msg}`);
        report.push({ name: s.name, count: s.count, ok: false, msg });
      }
    } catch (e) {
      console.log(` ✗ ${e.message}`);
      report.push({ name: s.name, count: s.count, ok: false, msg: e.message });
    }

    await sleep(200); // 避免请求太快
  }

  // 结果汇总
  const ok = report.filter(r => r.ok).length;
  const fail = report.filter(r => !r.ok).length;

  console.log('\n========== 结算报告 ==========');
  console.log(`成功: ${ok} 家`);
  console.log(`失败: ${fail} 家`);

  if (fail > 0) {
    console.log('\n失败详情:');
    for (const r of report.filter(r => !r.ok)) {
      console.log(`  ${r.name}: ${r.msg}`);
    }
  }

  // 保存 CSV
  const csvFile = path.join(process.cwd(), `结算报告_${month}.csv`);
  saveCsv(csvFile, report);
  console.log(`\nCSV 报告: ${csvFile}`);
  console.log('（Mac 用 Numbers 打开，Windows 用 Excel 打开）');

  rl.close();
}

main().catch(e => {
  console.error('脚本出错:', e.message);
  process.exit(1);
});
