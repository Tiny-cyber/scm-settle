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

  // 按来源单号分组，收集所有入库单号
  const orderMap = {};
  for (const item of filtered) {
    const sourceNo = item.source_no;
    if (!orderMap[sourceNo]) {
      orderMap[sourceNo] = {
        sourceNo,
        supplier: item.supplier_short_name || item.supplier_company_name,
        storageNos: [],
        settlementType: item.settlement_types === 'current' ? '现结' : item.settlement_types === 'monthly' ? '月结' : '',
      };
    }
    orderMap[sourceNo].storageNos.push(item.storage_no);
  }

  return Object.values(orderMap);
}

// ============ 第二步：浏览器 UI 结算 ============

/** 清理页面残留弹窗，防止脏状态影响下一单 */
async function cleanupPage(page) {
  try {
    await page.evaluate(() => {
      // 关闭 v-modal 弹窗
      document.querySelectorAll('.v--modal-overlay').forEach(overlay => {
        const bg = overlay.querySelector('.v--modal-background-click');
        if (bg) bg.click();
      });
      // 关闭 el-message-box
      const msgBox = document.querySelector('.el-message-box__wrapper');
      if (msgBox && getComputedStyle(msgBox).display !== 'none') {
        const btn = msgBox.querySelector('.el-message-box__btns button');
        if (btn) btn.click();
      }
      // 关闭 el-dialog
      document.querySelectorAll('.el-dialog__wrapper').forEach(el => {
        if (getComputedStyle(el).display !== 'none') {
          const btn = el.querySelector('.el-dialog__headerbtn');
          if (btn) btn.click();
        }
      });
    });
  } catch (_) {}
  await sleep(500);
}

async function stepClickNew(page) {
  await cleanupPage(page);

  // 用 domcontentloaded 替代 networkidle（SPA 长连接会导致 networkidle 永远超时）
  // 失败时用 goto about:blank 再重新导航兜底
  for (let retry = 0; retry < 3; retry++) {
    try {
      if (!page.url().includes('/finance/settlement')) {
        await page.goto(CONFIG.scmUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      break;
    } catch (e) {
      if (retry === 2) throw new Error(`页面刷新失败: ${e.message}`);
      // frame detached 或 timeout → 导航到空白页再重新加载
      await sleep(1000);
      try { await page.goto('about:blank', { timeout: 5000 }); } catch (_) {}
      await sleep(500);
      await page.goto(CONFIG.scmUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    }
  }

  // 等"新增"按钮出现并点击（最多30秒）
  let clicked = false;
  for (let i = 0; i < 30; i++) {
    clicked = await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        if (btn.textContent.trim().includes('新增') && !btn.closest('.v--modal') && !btn.closest('.el-dialog')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) break;
    await sleep(1000);
  }
  if (!clicked) throw new Error('页面加载超时：找不到"新增"按钮');
  await sleep(2000);
}

async function stepHandlePopup(page) {
  // 检查弹窗（可能立刻出现也可能延迟出现）
  for (let i = 0; i < 3; i++) {
    try {
      const popup = page.locator('.el-message-box');
      if (await popup.isVisible({ timeout: 2000 })) {
        await popup.locator('button:has-text("确定")').click();
        await sleep(500);
        break;
      }
    } catch (e) { break; }
  }

  await page.waitForSelector('.v--modal .el-form', { timeout: 15000 });
}

async function stepSelectCompany(page) {
  let selected = false;

  for (let attempt = 0; attempt < 5 && !selected; attempt++) {
    // 点击采购公司下拉框
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

    // 尝试选择
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

    if (!selected) {
      // 点空白处关闭可能打开的其他下拉框，再重试
      await page.evaluate(() => { document.body.click(); });
      await sleep(500);
    }
  }

  if (!selected) throw new Error('选不到采购公司');
  await sleep(500);
}

async function stepFillSupplier(page, supplierName) {
  // 关闭可能残留的下拉框
  await page.keyboard.press('Escape');
  await sleep(300);

  // 给供应商输入框打标记
  await page.evaluate(() => {
    const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
    if (!form) return;
    const items = form.querySelectorAll('.el-form-item');
    for (const item of items) {
      if (item.textContent.includes('供应商') && !item.textContent.includes('供应商全称')) {
        const input = item.querySelector('input');
        if (input) input.setAttribute('data-test', 'supplier-input');
        return;
      }
    }
  });
  await sleep(300);

  // 点击输入框激活搜索，用 keyboard.type 输入（不受 readonly 限制）
  let clicked = false;
  for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
    // 点击输入框让 ElSelect 进入可编辑模式
    await page.evaluate(() => {
      const inp = document.querySelector('[data-test=supplier-input]');
      if (inp) { inp.removeAttribute('readonly'); inp.click(); inp.focus(); }
    });
    await sleep(500);
    // 清空 + 输入供应商名
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(200);
    await page.keyboard.type(supplierName, { delay: 50 });
    await sleep(4000);

    // 精确匹配供应商（避免"东宏通"选成"东宏通--纽扣"）
    clicked = await page.evaluate((name) => {
    const candidates = [];
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length === 0) {
        const text = el.textContent.trim();
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && text.includes(name) && text.includes('SP')) {
          const exactMatch = text.startsWith(name + '(SP') || text.startsWith(name + ' (SP');
          candidates.push({ el, exactMatch, len: text.length });
        }
      }
    }
    candidates.sort((a, b) => {
      if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
      return a.len - b.len;
    });
    if (candidates.length > 0) { candidates[0].el.click(); return true; }
    return false;
  }, supplierName);
  }

  if (!clicked) throw new Error(`下拉列表中找不到供应商: ${supplierName}`);
  await sleep(500);
}

async function stepSelectSettlementType(page, settlementType) {
  if (!settlementType) return;

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

async function stepSelectStorageRecords(page, storageNos) {
  await page.evaluate(() => {
    const modals = document.querySelectorAll('.v--modal');
    for (const m of modals) {
      const btn = Array.from(m.querySelectorAll('button')).find(b => b.textContent.includes('选择出入库明细'));
      if (btn) { btn.click(); return; }
    }
  });
  await sleep(3000);

  // 处理可能弹出的提示框
  await page.evaluate(() => {
    const msgBox = document.querySelector('.el-message-box');
    if (msgBox && msgBox.offsetHeight > 0) {
      const btn = msgBox.querySelector('.el-message-box__btns .el-button--primary');
      if (btn) btn.click();
    }
  });
  await sleep(1000);

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
  await sleep(3000);

  // 等待数据加载
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const ready = await page.evaluate(() => {
      for (const m of document.querySelectorAll('.v--modal')) {
        if (m.textContent.includes('采购出入库明细')) {
          return m.querySelectorAll('.ag-center-cols-container .ag-row').length > 0;
        }
      }
      return false;
    });
    if (ready) break;
  }

  // 不搜索，直接在所有行中勾选匹配的入库单号
  const storageSet = new Set(storageNos);
  const result = await page.evaluate((storageNosArr) => {
    let modal = null;
    for (const m of document.querySelectorAll('.v--modal')) {
      if (m.textContent.includes('采购出入库明细')) { modal = m; break; }
    }
    if (!modal) return { error: 'no modal' };

    const centerRows = modal.querySelectorAll('.ag-center-cols-container .ag-row');
    const pinnedRows = modal.querySelectorAll('.ag-pinned-left-cols-container .ag-row');
    let checkedCount = 0;

    for (const row of centerRows) {
      const text = row.innerText;
      const matched = storageNosArr.some(sno => text.includes(sno));
      if (matched) {
        const rowIndex = row.getAttribute('row-index');
        for (const pr of pinnedRows) {
          if (pr.getAttribute('row-index') === rowIndex) {
            const cb = pr.querySelector('.ag-checkbox-input');
            if (cb) { cb.click(); checkedCount++; break; }
          }
        }
      }
    }

    const selectedMatch = modal.innerText.match(/已选\s*(\d+)\s*条/);
    return {
      totalRows: centerRows.length,
      checkedCount,
      selected: selectedMatch ? parseInt(selectedMatch[1]) : 0,
    };
  }, storageNos);

  if (result.checkedCount === 0) {
    throw new Error(`在出入库明细中找不到匹配的入库单号（共 ${result.totalRows} 行）`);
  }
  if (result.checkedCount < storageNos.length) {
    console.log(`  ⚠ 勾选 ${result.checkedCount}/${storageNos.length} 条（可能有分页未显示的记录）`);
  }
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

  // 反复全选+删除直到清空（处理分页只删当前页的问题）
  for (let attempt = 0; attempt < 5; attempt++) {
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

    if (!hasRows) break;

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
    await sleep(1000);
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
  await sleep(2000);

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
  for (let i = 0; i < 10; i++) {
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

// 按月/周自动归档（跟打样单一样的结构）
function getDatedOutputDir() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const weekNum = Math.floor((day - 1) / 7) + 1;
  const weekNames = ['第一个星期', '第二个星期', '第三个星期', '第四个星期', '第五个星期'];
  const weekName = weekNames[weekNum - 1] || weekNames[4];
  const dir = path.join(
    os.homedir(), 'Desktop', '工作台', '电商', '一键结算系统',
    '结算报告', `${month}月份`, `${month}月${weekName}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 日志
const REPORT_DIR = getDatedOutputDir();
const LOG_FILE = path.join(REPORT_DIR, `settle-log_${new Date().toISOString().slice(0,10)}.txt`);
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// 单笔结算（直接用提取阶段拿到的信息，不再重复查询）
async function settleOne(page, order) {
  const remark = `${today()} 结算`;
  const tag = `${order.sourceNo} (${order.supplier})`;
  log(`--- 开始: ${tag} ---`);

  await stepClickNew(page);
  await stepHandlePopup(page);
  await stepSelectCompany(page);
  // 验证采购公司是否真的选上了
  const companyOk = await page.evaluate(() => {
    const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
    if (!form) return false;
    for (const item of form.querySelectorAll('.el-form-item')) {
      if (item.textContent.includes('采购公司')) {
        const input = item.querySelector('input');
        return input && input.value && input.value !== '';
      }
    }
    return false;
  });
  if (!companyOk) {
    log('  ✗ 采购公司未选上');
    throw new Error('选不到采购公司');
  }
  log(`  ✓ 采购公司`);
  await stepFillSupplier(page, order.supplier);
  log(`  ✓ 供应商: ${order.supplier}`);
  await stepSelectSettlementType(page, order.settlementType);
  await stepFillRemark(page, remark);
  await stepSelectStorageRecords(page, order.storageNos);
  log(`  ✓ 入库单: ${order.storageNos.join(', ')}`);
  await stepDeleteDeductions(page);
  await stepSaveAndSubmit(page);
  log(`  ✓ 完成: ${tag}`);
}

// ============ 主流程 ============

async function main() {
  const date = process.argv[2];
  const date2 = process.argv[3];
  if (!date) {
    console.log('用法: node settle-all.js <日期>');
    console.log('例如: node settle-all.js 2026-03-19              （单日）');
    console.log('      node settle-all.js 2026-03                 （整月）');
    console.log('      node settle-all.js 2026-03-24 2026-04-03   （日期范围）');
    process.exit(1);
  }

  // 解析日期
  let dateMin, dateMax;
  if (date2 && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}-\d{2}-\d{2}$/.test(date2)) {
    dateMin = date;
    dateMax = date2;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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
    await page.goto(CONFIG.scmUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
  let interrupted = false;

  function onInterrupt() {
    interrupted = true;
    console.log('\n\n⚠ 检测到中断，正在生成已完成部分的报告...');
  }
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const progress = `[${i + 1}/${orders.length}]`;
    process.stdout.write(`${progress} ${order.sourceNo} (${order.supplier})...`);

    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        if (attempt > 0) process.stdout.write(' 重试...');
        await settleOne(page, order);
        report.push({ ...order, status: 'ok', msg: '成功' });
        console.log(' ✓');
        done = true;
      } catch (e) {
        if (attempt === 0) {
          // 第一次失败：清理页面状态后重试
          await cleanupPage(page);
          await sleep(2000);
        } else {
          // 第二次还失败：记录错误，清理后继续下一单
          report.push({ ...order, status: 'fail', msg: e.message });
          console.log(` ✗ ${e.message}`);
          await cleanupPage(page);
        }
      }
    }

    if (interrupted) break;
    if (i < orders.length - 1) {
      await sleep(2000);
    }
  }

  // 报告
  const ok = report.filter(r => r.status === 'ok');
  const fail = report.filter(r => r.status === 'fail');
  const unsettled = orders.slice(report.length);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`结算报告 | ${dateMin} ~ ${dateMax}${interrupted ? '（中断）' : ''}`);
  console.log('='.repeat(60));
  console.log(`总计: ${orders.length} 个 | 已结算: ${ok.length} | 失败: ${fail.length} | 未结算: ${unsettled.length}\n`);

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

  // 保存报告到结算报告目录（按月/周归档）
  const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 16);
  const suffix = interrupted ? '_中断' : '';
  const reportFile = path.join(REPORT_DIR, `结算报告_${date}_${timestamp}${suffix}.csv`);
  const csvHeader = '序号,来源单号,供应商,结算方式,结果,详情\n';
  const csvRows = [];
  for (let i = 0; i < report.length; i++) {
    const r = report[i];
    csvRows.push(`${i + 1},"${r.sourceNo}","${r.supplier}","${r.settlementType}","${r.status === 'ok' ? '成功' : '失败'}","${r.status === 'ok' ? '' : r.msg}"`);
  }
  for (let i = 0; i < unsettled.length; i++) {
    const r = unsettled[i];
    csvRows.push(`${report.length + i + 1},"${r.sourceNo}","${r.supplier}","${r.settlementType}","未结算",""`);
  }
  csvRows.push('');
  csvRows.push(`,"总计: ${orders.length} 个","已结算: ${ok.length}","失败: ${fail.length}","未结算: ${unsettled.length}",""`);
  fs.writeFileSync(reportFile, '\ufeff' + csvHeader + csvRows.join('\n'), 'utf8');
  console.log(`\n报告已保存: ${reportFile}`);
}

main().catch(e => {
  console.error('脚本出错:', e.message);
  process.exit(1);
});
