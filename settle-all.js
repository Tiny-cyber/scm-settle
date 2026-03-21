#!/usr/bin/env node
/**
 * SCM 采购结算 - 一键提取+结算
 * 按日期提取已核对未结算的采购单，自动逐个结算，最后输出报告
 *
 * 前置条件：Chrome 已打开并登录 SCM 系统（端口 9222）
 * 用法：node settle-all.js <日期>
 * 例如：node settle-all.js 2026-03-19      （单日）
 *       node settle-all.js 2026-03          （整月）
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG = {
  cdpUrl: 'http://127.0.0.1:9222',
  scmUrl: 'https://zyhx.scm.xinwuyun.com/#/finance/settlement',
  pageSize: 500,
};

// ============ 工具函数 ============

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ============ 第一步：提取待结算单号 ============

async function extractOrders(page, dateMin, dateMax) {
  console.log('查询采购入库单...');
  const allItems = [];
  let pageNum = 1;

  while (true) {
    const result = await page.evaluate(async ({ pageNum, pageSize, dateMin, dateMax }) => {
      const res = await fetch('/biz-scm/purchase-storage/pageDto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conditions: [
            { group: 'master', field: 'status', operator: 'in', value: ['2'], not: false },
            { group: 'master', field: 'is_settlement', operator: 'eq', value: '0', not: false },
            { group: 'master', field: 'checked', operator: 'gte', value: dateMin + ' 00:00:00', not: false },
            { group: 'master', field: 'checked', operator: 'lte', value: dateMax + ' 23:59:59', not: false },
          ],
          sorts: [],
          pagger: { page: pageNum, limit: pageSize },
          extra: {},
        })
      });
      return await res.json();
    }, { pageNum, pageSize: CONFIG.pageSize, dateMin, dateMax });

    if (result.code !== 200) {
      throw new Error(`查询失败: ${result.msg || JSON.stringify(result)}`);
    }

    const items = result.data.items || [];
    const total = result.data.total || 0;
    allItems.push(...items);
    console.log(`  第 ${pageNum} 页: +${items.length} 条（已获取 ${allItems.length}/${total}）`);

    if (allItems.length >= total || items.length === 0) break;
    pageNum++;
  }

  // 二次校验：确保日期范围准确
  const filtered = allItems.filter(item => {
    const checkedDate = (item.checked || '').slice(0, 10);
    return checkedDate >= dateMin && checkedDate <= dateMax;
  });
  console.log(`API 返回 ${allItems.length} 条，校验后: ${filtered.length} 条`);

  // 按来源单号去重
  const orderMap = {};
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

  return Object.values(orderMap);
}

// ============ 第二步：浏览器 UI 结算 ============

async function stepClickNew(page) {
  await page.goto(CONFIG.scmUrl, { waitUntil: 'networkidle' });
  await sleep(500);
  await page.evaluate(() => {
    const closeBtn = document.querySelector('.v--modal .el-card button[aria-label="Close"], .v--modal .detail-header .el-button');
    if (closeBtn) closeBtn.click();
  });
  await sleep(500);
  await page.goto(CONFIG.scmUrl, { waitUntil: 'networkidle' });
  await sleep(1000);

  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent.trim().includes('新增') && !btn.closest('.v--modal') && !btn.closest('.el-dialog')) {
        btn.click();
        return;
      }
    }
  });
  await sleep(1500);
}

async function stepHandlePopup(page) {
  try {
    const popup = page.locator('.el-message-box');
    if (await popup.isVisible({ timeout: 1500 })) {
      await popup.locator('button:has-text("确定")').click();
      await sleep(500);
    }
  } catch (e) { /* 没有弹窗 */ }

  await page.waitForSelector('.v--modal .el-form', { timeout: 10000 });
}

async function stepSelectCompany(page) {
  await page.evaluate(() => {
    const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
    if (!form) return;
    const items = form.querySelectorAll('.el-form-item');
    for (const item of items) {
      if (item.textContent.includes('采购公司')) {
        const input = item.querySelector('input');
        if (input) { input.click(); return; }
      }
    }
  });
  await sleep(1500);

  let selected = await page.evaluate(() => {
    const items = document.querySelectorAll('li.el-select-dropdown__item');
    for (const item of items) {
      if (item.textContent.includes('佛山市自由呼吸服饰有限公司')) {
        item.click();
        return true;
      }
    }
    return false;
  });

  if (!selected) {
    await page.evaluate(() => {
      const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
      if (!form) return;
      const items = form.querySelectorAll('.el-form-item');
      for (const item of items) {
        if (item.textContent.includes('采购公司')) {
          const input = item.querySelector('input');
          if (input) { input.click(); input.click(); return; }
        }
      }
    });
    await sleep(1500);
    selected = await page.evaluate(() => {
      const items = document.querySelectorAll('li.el-select-dropdown__item');
      for (const item of items) {
        if (item.textContent.includes('佛山市自由呼吸服饰有限公司')) {
          item.click();
          return true;
        }
      }
      return false;
    });
  }

  if (!selected) throw new Error('选不到采购公司');
  await sleep(500);
}

async function stepFillSupplier(page, supplierName) {
  const client = await page.context().newCDPSession(page);

  await page.evaluate(() => {
    const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
    if (!form) return;
    const items = form.querySelectorAll('.el-form-item');
    for (const item of items) {
      if (item.textContent.includes('供应商') && !item.textContent.includes('供应商全称')) {
        const input = item.querySelector('input');
        if (input) { input.click(); input.focus(); return; }
      }
    }
  });
  await sleep(800);

  await client.send('Input.insertText', { text: supplierName });
  await sleep(2000);

  const clicked = await page.evaluate((name) => {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length === 0 && el.textContent.includes(name + '(SP')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }, supplierName);

  if (!clicked) throw new Error(`下拉列表中找不到供应商: ${supplierName}`);
  await sleep(500);
  await client.detach();
}

async function stepSelectSettlementType(page, settlementType) {
  await page.evaluate(() => {
    const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
    if (!form) return;
    const items = form.querySelectorAll('.el-form-item');
    for (const item of items) {
      if (item.textContent.includes('结算方式')) {
        const input = item.querySelector('input');
        if (input) { input.click(); return; }
      }
    }
  });
  await sleep(500);

  const selected = await page.evaluate((type) => {
    const items = document.querySelectorAll('li.el-select-dropdown__item');
    for (const item of items) {
      if (item.textContent.trim() === type) {
        item.click();
        return true;
      }
    }
    return false;
  }, settlementType);

  if (!selected) throw new Error(`找不到结算方式选项: ${settlementType}`);
  await sleep(300);
}

async function stepFillRemark(page, remark) {
  await page.evaluate(() => {
    const textarea = document.querySelector('.v--modal textarea') || document.querySelector('.detail-container textarea');
    if (textarea) { textarea.click(); textarea.focus(); }
  });
  await page.keyboard.type(remark, { delay: 20 });
  await sleep(300);
}

async function stepSelectStorageRecords(page, storageNo) {
  await page.evaluate(() => {
    const modals = document.querySelectorAll('.v--modal');
    for (const m of modals) {
      const btn = Array.from(m.querySelectorAll('button')).find(b => b.textContent.includes('选择出入库明细'));
      if (btn) { btn.click(); return; }
    }
  });
  await sleep(2000);
  await page.waitForLoadState('networkidle');
  await sleep(2000);

  // 重置筛选条件
  await page.evaluate(() => {
    const modals = document.querySelectorAll('.v--modal');
    for (const m of modals) {
      if (m.textContent.includes('采购出入库明细')) {
        const btns = m.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.textContent.trim() === '重置') { btn.click(); return; }
        }
      }
    }
  });
  await sleep(2000);
  await page.waitForLoadState('networkidle');
  await sleep(2000);

  // 搜索入库单号
  const searchClient = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const modals = document.querySelectorAll('.v--modal');
    for (const m of modals) {
      if (m.textContent.includes('采购出入库明细')) {
        const inputs = m.querySelectorAll('input');
        for (const input of inputs) {
          if (!input.readOnly && input.type !== 'checkbox') {
            input.value = '';
            input.click();
            input.focus();
            return;
          }
        }
      }
    }
  });
  await sleep(300);
  await searchClient.send('Input.insertText', { text: storageNo });
  await sleep(500);
  await searchClient.detach();

  // 点查询
  await page.evaluate(() => {
    const modals = document.querySelectorAll('.v--modal');
    for (const m of modals) {
      if (m.textContent.includes('采购出入库明细')) {
        const btns = m.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.textContent.trim() === '查询') { btn.click(); return; }
        }
      }
    }
  });
  await sleep(2000);
  await page.waitForLoadState('networkidle');

  // 轮询等待数据加载并勾选
  let found = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const debug = await page.evaluate((storageNo) => {
      let modal = null;
      const modals = document.querySelectorAll('.v--modal');
      for (const m of modals) {
        if (m.textContent.includes('采购出入库明细')) { modal = m; break; }
      }
      if (!modal) return { modalFound: false, matched: false };

      const centerRows = modal.querySelectorAll('.ag-center-cols-container .ag-row');
      const pinnedRows = modal.querySelectorAll('.ag-pinned-left-cols-container .ag-row');
      let matched = false;

      for (const row of centerRows) {
        if (row.innerText.includes(storageNo)) {
          const rowIndex = row.getAttribute('row-index');
          for (const pr of pinnedRows) {
            if (pr.getAttribute('row-index') === rowIndex) {
              const cb = pr.querySelector('.ag-checkbox-input');
              if (cb) { cb.click(); matched = true; break; }
            }
          }
          if (matched) break;
        }
      }

      if (!matched && pinnedRows.length > 0 && pinnedRows.length <= 5) {
        const cb = pinnedRows[0].querySelector('.ag-checkbox-input');
        if (cb) { cb.click(); matched = true; }
      }

      return { modalFound: true, centerRows: centerRows.length, pinnedRows: pinnedRows.length, matched };
    }, storageNo);
    if (debug.matched) { found = true; break; }
  }

  if (!found) throw new Error(`在出入库明细中找不到: ${storageNo}`);
  await sleep(500);

  // 确认选择
  await page.evaluate(() => {
    const modals = document.querySelectorAll('.v--modal');
    for (const m of modals) {
      if (m.textContent.includes('采购出入库明细')) {
        const btns = m.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.textContent.trim() === '确认选择') { btn.click(); return; }
        }
      }
    }
  });
  await sleep(1000);
}

async function stepDeleteDeductions(page) {
  // 点扣补款明细 tab
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('.el-tabs__item, [role="tab"]');
    for (const tab of tabs) {
      if (tab.textContent.includes('扣补款明细')) { tab.click(); return; }
    }
  });
  await sleep(500);

  const hasRows = await page.evaluate(() => {
    const grids = document.querySelectorAll('.ag-root-wrapper');
    for (const grid of grids) {
      const rows = grid.querySelectorAll('.ag-center-cols-container .ag-row');
      const headers = grid.querySelectorAll('.ag-header-cell-text');
      for (const h of headers) {
        if (h.textContent.includes('事件类型') || h.textContent.includes('原因')) {
          return rows.length > 0;
        }
      }
    }
    return false;
  });

  if (hasRows) {
    await page.evaluate(() => {
      const grids = document.querySelectorAll('.ag-root-wrapper');
      for (const grid of grids) {
        const headers = grid.querySelectorAll('.ag-header-cell-text');
        for (const h of headers) {
          if (h.textContent.includes('事件类型') || h.textContent.includes('原因')) {
            const headerCheckbox = grid.querySelector('.ag-header-select-all .ag-checkbox-input');
            if (headerCheckbox) headerCheckbox.click();
            return;
          }
        }
      }
    });
    await sleep(300);

    await page.evaluate(() => {
      const btns = document.querySelectorAll('.v--modal button, .detail-container button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '删除' &&
            (btn.classList.contains('el-button--danger') ||
             getComputedStyle(btn).backgroundColor.includes('245'))) {
          btn.click();
          return;
        }
      }
    });
    await sleep(500);
  }

  // 切回结算明细 tab
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('.el-tabs__item, [role="tab"]');
    for (const tab of tabs) {
      if (tab.textContent.includes('结算明细') && !tab.textContent.includes('扣补款')) {
        tab.click();
        return;
      }
    }
  });
  await sleep(1000);
  await page.waitForLoadState('networkidle');

  // 等结算明细加载
  for (let i = 0; i < 30; i++) {
    const ready = await page.evaluate(() => {
      const grids = document.querySelectorAll('.ag-root-wrapper');
      for (const grid of grids) {
        const headers = grid.querySelectorAll('.ag-header-cell-text');
        for (const h of headers) {
          if (h.textContent.includes('来源单号') || h.textContent.includes('出入库单号')) {
            const rows = grid.querySelectorAll('.ag-center-cols-container .ag-row');
            return rows.length > 0;
          }
        }
      }
      return false;
    });
    if (ready) break;
    await sleep(2000);
  }
}

async function stepSaveAndSubmit(page) {
  await page.evaluate(() => {
    const modals = document.querySelectorAll('.v--modal');
    for (const m of modals) {
      const btns = m.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '保存并提交') { btn.click(); return; }
      }
    }
  });
  await sleep(2000);

  const hasConfirm = await page.evaluate(() => {
    const msgBox = document.querySelector('.el-message-box');
    if (msgBox && msgBox.offsetHeight > 0) {
      const btn = msgBox.querySelector('.el-message-box__btns .el-button--primary');
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
  if (hasConfirm) await sleep(3000);

  let success = false;
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const msgBox = document.querySelector('.el-message-box');
      if (msgBox && msgBox.offsetHeight > 0) {
        const btn = msgBox.querySelector('.el-message-box__btns .el-button--primary');
        if (btn) btn.click();
      }
    });
    await sleep(3000);

    success = await page.evaluate(() => {
      const modal = document.querySelector('.v--modal');
      return !modal;
    });
    if (success) break;
  }

  if (!success) {
    const errorMsg = await page.evaluate(() => {
      const msg = document.querySelector('.el-message--error');
      return msg ? msg.textContent.trim() : null;
    });
    throw new Error(`提交失败: ${errorMsg || '未知错误，请查看浏览器'}`);
  }
}

// 单笔结算（直接用提取阶段拿到的信息，不再重复查询）
async function settleOne(page, order) {
  const remark = `${today()} 结算`;

  await stepClickNew(page);
  await stepHandlePopup(page);
  await stepSelectCompany(page);
  await stepFillSupplier(page, order.supplier);
  await stepSelectSettlementType(page, order.settlementType);
  await stepFillRemark(page, remark);
  await stepSelectStorageRecords(page, order.storageNo);
  await stepDeleteDeductions(page);
  await stepSaveAndSubmit(page);
}

// ============ 主流程 ============

async function main() {
  const date = process.argv[2];
  if (!date) {
    console.log('用法: node settle-all.js <日期>');
    console.log('例如: node settle-all.js 2026-03-19      （单日）');
    console.log('      node settle-all.js 2026-03          （整月）');
    process.exit(1);
  }

  // 解析日期
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

  console.log(`=== SCM 一键结算 ===`);
  console.log(`核对日期: ${dateMin} ~ ${dateMax}\n`);

  // 连接 Chrome
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

  // 第一步：提取
  const orders = await extractOrders(page, dateMin, dateMax);
  if (orders.length === 0) {
    console.log('\n没有需要结算的单号。');
    process.exit(0);
  }
  console.log(`\n提取到 ${orders.length} 个待结算单号，开始结算...\n`);

  // 第二步：逐个结算
  const report = [];

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const progress = `[${i + 1}/${orders.length}]`;
    process.stdout.write(`${progress} ${order.sourceNo} (${order.supplier})...`);

    try {
      await settleOne(page, order);
      report.push({ ...order, status: 'ok', msg: '成功' });
      console.log(' ✓');
    } catch (e) {
      report.push({ ...order, status: 'fail', msg: e.message });
      console.log(` ✗ ${e.message}`);
    }

    // 重置页面准备下一个
    if (i < orders.length - 1) {
      await sleep(5000);
      await page.goto(CONFIG.scmUrl, { waitUntil: 'networkidle' });
      await sleep(2000);
    }
  }

  // 最终报告
  const ok = report.filter(r => r.status === 'ok');
  const fail = report.filter(r => r.status === 'fail');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`结算报告 | ${dateMin} ~ ${dateMax}`);
  console.log('='.repeat(60));
  console.log(`提取: ${orders.length} 个 | 成功: ${ok.length} | 失败: ${fail.length}\n`);

  console.log('来源单号                 供应商                     结算方式  结果');
  console.log('-'.repeat(60));
  for (const r of report) {
    const icon = r.status === 'ok' ? '✓' : '✗';
    console.log(`${icon} ${r.sourceNo.padEnd(24)} ${r.supplier.padEnd(26)} ${r.settlementType.padEnd(8)} ${r.status === 'ok' ? '成功' : r.msg}`);
  }

  if (fail.length > 0) {
    console.log(`\n失败 ${fail.length} 个，可以用 settle-browser.js 单独重跑:`);
    console.log(`  node settle-browser.js ${fail.map(r => r.sourceNo).join(' ')}`);
  }

  // 保存报告到桌面
  const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 16);
  const reportDir = path.join(os.homedir(), 'Desktop', '工作台', '电商', '每日结算报告');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, `结算报告_${date}_${timestamp}.csv`);
  const csvHeader = '序号,来源单号,供应商,结算方式,结果,详情\n';
  const csvBody = report.map((r, i) =>
    `${i + 1},"${r.sourceNo}","${r.supplier}","${r.settlementType}","${r.status === 'ok' ? '成功' : '失败'}","${r.status === 'ok' ? '' : r.msg}"`
  ).join('\n');
  fs.writeFileSync(reportFile, '\ufeff' + csvHeader + csvBody, 'utf8');
  console.log(`\n报告已保存: ${reportFile}`);
}

main().catch(e => {
  console.error('脚本出错:', e.message);
  process.exit(1);
});
