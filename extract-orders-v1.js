#!/usr/bin/env node
/**
 * SCM 采购入库 - 提取待结算单号
 * 从采购入库页面按条件筛选，输出待结算的来源单号列表
 *
 * 前置条件：Chrome 已打开并登录 SCM 系统（端口 9222）
 * 用法：node extract-orders.js <日期>
 * 例如：node extract-orders.js 2026-03-19
 */

const { chromium } = require('playwright');

const CONFIG = {
  cdpUrl: 'http://127.0.0.1:9222',
  scmUrl: 'https://zyhx.scm.xinwuyun.com/#/finance/settlement',
  pageSize: 500,
  // 内部仓库（调拨用，不需要结算）
  internalSuppliers: [
    '佛山主仓', '经纬总仓', '染色仓',
    '虚拟仓-自由呼吸民乐厂', '自由呼吸',
  ],
};

function isInternal(item) {
  const name = (item.supplier_short_name || item.supplier_company_name || '')
    .replace(/[^\u4e00-\u9fffa-zA-Z0-9\-_（）()]/g, '');
  return CONFIG.internalSuppliers.some(w => name.includes(w));
}

async function main() {
  const date = process.argv[2];
  if (!date) {
    console.log('用法: node extract-orders.js <日期>');
    console.log('例如: node extract-orders.js 2026-03-19');
    console.log('      node extract-orders.js 2026-03   （整月）');
    process.exit(1);
  }

  // 判断是单日还是整月
  let dateMin, dateMax;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    dateMin = date;
    dateMax = date;
  } else if (/^\d{4}-\d{2}$/.test(date)) {
    const [year, mon] = date.split('-');
    const lastDay = new Date(parseInt(year), parseInt(mon), 0).getDate();
    dateMin = `${date}-01`;
    dateMax = `${date}-${lastDay}`;
  } else {
    console.error('日期格式不对，应该是 YYYY-MM-DD 或 YYYY-MM');
    process.exit(1);
  }

  console.log('=== SCM 采购入库 - 提取待结算单号 ===\n');
  console.log(`筛选条件: 业务日期 ${dateMin} ~ ${dateMax} | 已核对 | 未结算\n`);

  // 连接 Chrome
  console.log('连接 Chrome（端口 9222）...');
  let browser;
  try {
    browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
  } catch (e) {
    console.error('连接 Chrome 失败。确保 Chrome 已启动且开启了远程调试（端口 9222）');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const pages = context.pages();
  let page = pages.find(p => p.url().includes('zyhx.scm.xinwuyun.com'));
  if (!page) {
    page = await context.newPage();
    await page.goto(CONFIG.scmUrl, { waitUntil: 'networkidle' });
  }

  // 通过浏览器页面调 API（自动带 Cookie）
  console.log('查询采购入库单...');
  const allItems = [];
  let pageNum = 1;

  while (true) {
    const result = await page.evaluate(async ({ pageNum, pageSize }) => {
      const res = await fetch('/biz-scm/purchase-storage/pageDto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conditions: [
            { group: 'master', field: 'status', operator: 'in', value: ['2'], not: false },
            { group: 'master', field: 'is_settlement', operator: 'eq', value: '0', not: false },
          ],
          sorts: [],
          pagger: { page: pageNum, limit: pageSize },
          extra: {},
        })
      });
      return await res.json();
    }, { pageNum, pageSize: CONFIG.pageSize });

    if (result.code !== 200) {
      console.error(`查询失败: ${result.msg || JSON.stringify(result)}`);
      process.exit(1);
    }

    const items = result.data.items || [];
    const total = result.data.total || 0;
    allItems.push(...items);
    console.log(`  第 ${pageNum} 页: +${items.length} 条（已获取 ${allItems.length}/${total}）`);

    if (allItems.length >= total || items.length === 0) break;
    pageNum++;
  }

  if (allItems.length === 0) {
    console.log('\n没有符合条件的入库单。');
    process.exit(0);
  }

  // API 的日期条件不生效，在本地按 stock_date 过滤
  console.log(`\n查询到 ${allItems.length} 条（全部已核对未结算）`);
  const filtered = allItems.filter(item => {
    const checkedDate = (item.checked || '').slice(0, 10);
    return checkedDate >= dateMin && checkedDate <= dateMax;
  });
  console.log(`按日期 ${dateMin} ~ ${dateMax} 过滤后: ${filtered.length} 条\n`);

  // 按来源单号去重（一个来源单号可能有多条入库明细）
  const orderMap = {};
  if (filtered.length === 0) {
    console.log('该日期没有需要结算的入库单。');
    process.exit(0);
  }

  for (const item of filtered) {
    const sourceNo = item.source_no;
    if (!orderMap[sourceNo]) {
      orderMap[sourceNo] = {
        sourceNo,
        supplier: item.supplier_short_name || item.supplier_company_name,
        storageNo: item.storage_no,
        settlementType: item.settlement_types === 'current' ? '现结' : '月结',
        count: 0,
      };
    }
    orderMap[sourceNo].count++;
  }

  const orders = Object.values(orderMap);

  // 输出结果
  console.log(`共 ${orders.length} 个来源单号:\n`);
  console.log('序号  来源单号                 供应商              结算方式  明细数');
  console.log('-'.repeat(80));
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    console.log(
      `${String(i + 1).padStart(3)}   ${o.sourceNo.padEnd(24)} ${o.supplier.padEnd(18)} ${o.settlementType.padEnd(8)} ${o.count}`
    );
  }

  // 输出可直接粘贴到 settle-browser.js 的单号列表
  const orderNos = orders.map(o => o.sourceNo);
  console.log(`\n${'='.repeat(80)}`);
  console.log('复制以下命令直接结算:\n');
  console.log(`node settle-browser.js ${orderNos.join(' ')}`);
  console.log(`\n共 ${orderNos.length} 个单号`);
}

main().catch(e => {
  console.error('脚本出错:', e.message);
  process.exit(1);
});
