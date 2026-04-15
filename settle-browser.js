#!/usr/bin/env node
/**
 * SCM 采购结算 - 浏览器自动化脚本
 * 完全复刻影刀 RPA 流程，通过浏览器 UI 操作完成结算
 *
 * 前置条件：Chrome 已打开并登录 SCM 系统（端口 9222）
 * 用法：node settle-browser.js <来源单号>
 */

const { chromium } = require('playwright');

const CONFIG = {
  cdpUrl: 'http://127.0.0.1:9222',
  scmUrl: 'https://zyhx.scm.xinwuyun.com/#/finance/settlement',
};

// ============ 工具函数 ============

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 在 v--modal 表单中，通过标签文字找到旁边的 input 并点击
function clickInputByLabel(labelText) {
  const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
  if (!form) return false;
  const items = form.querySelectorAll('.el-form-item');
  for (const item of items) {
    if (item.textContent.includes(labelText)) {
      const input = item.querySelector('input');
      if (input) { input.click(); return true; }
    }
  }
  return false;
}

// ============ 浏览器操作步骤 ============

// 影刀步骤 1-4：打开结算页面，点新增
async function stepClickNew(page) {
  console.log('  [步骤 1-4] 打开结算页面，点新增...');

  // 先确保回到干净的列表页（关掉可能残留的弹窗/表单）
  await page.goto(CONFIG.scmUrl, { waitUntil: 'networkidle' });
  await sleep(500);
  // 如果有 v--modal 残留，点关闭
  await page.evaluate(() => {
    const closeBtn = document.querySelector('.v--modal .el-card button[aria-label="Close"], .v--modal .detail-header .el-button');
    if (closeBtn) closeBtn.click();
  });
  await sleep(500);
  // 再次导航确保干净
  await page.goto(CONFIG.scmUrl, { waitUntil: 'networkidle' });
  await sleep(1000);

  // 点新增（用工具栏里的那个按钮，排除其他同名按钮）
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

// 影刀步骤 6-8：处理弹窗（如果有）
async function stepHandlePopup(page) {
  console.log('  [步骤 6-8] 检查弹窗...');
  try {
    const popup = page.locator('.el-message-box');
    if (await popup.isVisible({ timeout: 1500 })) {
      await popup.locator('button:has-text("确定")').click();
      console.log('    → 关闭了一个弹窗');
      await sleep(500);
    }
  } catch (e) {
    // 没有弹窗，正常
  }

  // 等待表单出现（v--modal 里的表单）
  await page.waitForSelector('.v--modal .el-form', { timeout: 10000 });
  console.log('    → 新建结算表单已打开');
}

// 影刀步骤 9-17：选采购公司
async function stepSelectCompany(page) {
  console.log('  [步骤 9-17] 选采购公司: 佛山市自由呼吸服饰有限公司...');

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

  // 选中目标公司
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

  // 重试（影刀步骤 13-16）
  if (!selected) {
    console.log('    → 下拉没弹出，重试...');
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

  if (!selected) {
    throw new Error('选不到采购公司，请检查页面状态');
  }
  await sleep(500);
  console.log('    → 采购公司已选');
}

// 影刀步骤 18-21：填入供应商名称
async function stepFillSupplier(page, supplierName) {
  console.log(`  [步骤 18-21] 填入供应商: ${supplierName}...`);

  // 获取 CDP session，用于绕过 readonly 限制直接注入文本
  const client = await page.context().newCDPSession(page);

  // 点击供应商输入框（xw-selector 自定义组件，readonly）
  await page.evaluate(() => {
    const form = document.querySelector('.v--modal .el-form') || document.querySelector('.el-form');
    if (!form) return;
    const items = form.querySelectorAll('.el-form-item');
    for (const item of items) {
      if (item.textContent.includes('供应商') && !item.textContent.includes('供应商全称')) {
        const input = item.querySelector('input');
        if (input) {
          input.click();
          input.focus();
          return;
        }
      }
    }
  });
  await sleep(800);

  // 用 CDP Input.insertText 直接注入文本（绕过 readonly，等同于 MCP fill）
  await client.send('Input.insertText', { text: supplierName });
  console.log('    → CDP insertText 已发送');
  await sleep(2000);

  // 在下拉结果中点击匹配的供应商（格式如"红豆辅料(SP25060084)"）
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

  if (!clicked) {
    throw new Error(`下拉列表中找不到供应商: ${supplierName}`);
  }
  await sleep(500);
  await client.detach();
  console.log('    → 供应商已选中');
}

// 影刀步骤 22-27：选结算方式
async function stepSelectSettlementType(page, settlementType) {
  console.log(`  [步骤 22-27] 选结算方式: ${settlementType}...`);

  // 点击结算方式下拉框
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

  // 点击下拉选项
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

  if (!selected) {
    throw new Error(`找不到结算方式选项: ${settlementType}`);
  }
  await sleep(300);
  console.log('    → 结算方式已选');
}

// 影刀步骤 28-29：填备注
async function stepFillRemark(page, remark) {
  console.log(`  [步骤 28-29] 填备注: ${remark}...`);
  // 点击 textarea 然后用 Playwright 输入
  await page.evaluate(() => {
    const textarea = document.querySelector('.v--modal textarea') || document.querySelector('.detail-container textarea');
    if (textarea) {
      textarea.click();
      textarea.focus();
    }
  });
  await page.keyboard.type(remark, { delay: 20 });
  await sleep(300);
  console.log('    → 备注已填');
}

// 影刀步骤 30-34：选择出入库明细
async function stepSelectStorageRecords(page, storageNo) {
  console.log(`  [步骤 30-34] 选择出入库明细: ${storageNo}...`);

  // 点击"选择出入库明细"
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

  // 重置筛选条件（弹窗也是 v--modal）
  console.log('    → 重置筛选条件...');
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

  // 搜索入库单号 RK（用 CDP insertText，确保 Vue 组件能识别）
  console.log(`    → 搜索入库单号: ${storageNo}...`);
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

  // 点"查询"按钮
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

  // 轮询等待数据加载，每 5 秒检查一次，最多 1 分钟
  console.log('    → 等待数据加载并勾选记录...');
  let found = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const debug = await page.evaluate((storageNo) => {
      // 在出入库弹窗的 v--modal 内搜索
      let modal = null;
      const modals = document.querySelectorAll('.v--modal');
      for (const m of modals) {
        if (m.textContent.includes('采购出入库明细')) { modal = m; break; }
      }
      if (!modal) return { modalFound: false, matched: false };

      // 数据行在 center-cols，checkbox 在 pinned-left-cols，通过 row-index 对应
      const centerRows = modal.querySelectorAll('.ag-center-cols-container .ag-row');
      const pinnedRows = modal.querySelectorAll('.ag-pinned-left-cols-container .ag-row');
      let matched = false;

      // 方法1：找到包含 storageNo 的行，取 row-index，到 pinned 区点 checkbox
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

      // 方法2：如果只有少量行，直接勾第一行
      if (!matched && pinnedRows.length > 0 && pinnedRows.length <= 5) {
        const cb = pinnedRows[0].querySelector('.ag-checkbox-input');
        if (cb) { cb.click(); matched = true; }
      }

      return { modalFound: true, centerRows: centerRows.length, pinnedRows: pinnedRows.length, matched };
    }, storageNo);
    console.log(`    → 第 ${i + 1} 次: modal=${debug.modalFound} center=${debug.centerRows} pinned=${debug.pinnedRows} matched=${debug.matched}`);
    if (debug.matched) { found = true; break; }
  }

  if (!found) {
    throw new Error(`在出入库明细中找不到: ${storageNo}，检查单号是否正确或记录是否已被结算`);
  }
  await sleep(500);

  // 点"确认选择"
  console.log('    → 确认选择...');
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
  console.log('    → 出入库明细已关联');
}

// 删除扣补款明细（如果有）
async function stepDeleteDeductions(page) {
  console.log('  [额外步骤] 检查并删除扣补款...');

  // 点击"扣补款明细" tab
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('.el-tabs__item, [role="tab"]');
    for (const tab of tabs) {
      if (tab.textContent.includes('扣补款明细')) {
        tab.click();
        return;
      }
    }
  });
  await sleep(500);

  // 检查是否有扣补款数据行
  const hasRows = await page.evaluate(() => {
    // 找到扣补款区域的表格
    const grids = document.querySelectorAll('.ag-root-wrapper');
    // 扣补款的表格通常是第二个 ag-grid（第一个是结算明细）
    for (const grid of grids) {
      const rows = grid.querySelectorAll('.ag-center-cols-container .ag-row');
      // 检查这个 grid 的 header 是否包含"事件类型"或"原因"（扣补款表特有列）
      const headers = grid.querySelectorAll('.ag-header-cell-text');
      for (const h of headers) {
        if (h.textContent.includes('事件类型') || h.textContent.includes('原因')) {
          return rows.length > 0;
        }
      }
    }
    return false;
  });

  if (!hasRows) {
    console.log('    → 没有扣补款，跳过');
  } else {
    // 全选扣补款行
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

    // 点删除按钮
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
    console.log('    → 扣补款已删除');
  }

  // 不管有没有扣补款，都切回结算明细 tab，等数据加载完再往下走
  console.log('    → 切回结算明细，等待数据加载...');
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

  // 轮询等结算明细表格里有数据行
  let ready = false;
  for (let i = 0; i < 30; i++) {
    ready = await page.evaluate(() => {
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
  if (ready) {
    console.log('    → 结算明细已加载');
  } else {
    console.log('    → 警告: 结算明细可能未完全加载，继续提交');
  }
}

// 保存并提交
async function stepSaveAndSubmit(page) {
  console.log('  [最终步骤] 保存并提交...');
  // 用 evaluate 点击，避免被 v--modal header 遮挡导致 Playwright 超时
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

  // 处理确认弹窗（如"结算价不等于入库价，确认继续吗？"）
  const hasConfirm = await page.evaluate(() => {
    const msgBox = document.querySelector('.el-message-box');
    if (msgBox && msgBox.offsetHeight > 0) {
      const btn = msgBox.querySelector('.el-message-box__btns .el-button--primary');
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
  if (hasConfirm) {
    console.log('    → 确认弹窗已处理');
    await sleep(3000);
  }

  // 轮询等待提交完成（v--modal 消失 = 回到列表页 = 成功）
  let success = false;
  for (let i = 0; i < 6; i++) {
    // 先检查有没有新的确认弹窗需要处理
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

  if (success) {
    console.log('    → 保存并提交成功！');
  } else {
    const errorMsg = await page.evaluate(() => {
      const msg = document.querySelector('.el-message--error');
      return msg ? msg.textContent.trim() : null;
    });
    throw new Error(`提交失败: ${errorMsg || '未知错误，请查看浏览器'}`);
  }
}

// ============ 通过 API 查询单号信息 ============

async function lookupOrder(page, orderNo) {
  console.log(`查询单号 ${orderNo} 的信息...`);

  const currentUrl = page.url();
  if (!currentUrl.includes('zyhx.scm.xinwuyun.com')) {
    await page.goto(CONFIG.scmUrl);
    await page.waitForLoadState('networkidle');
  }

  const result = await page.evaluate(async (orderNo) => {
    const res = await fetch('/biz-scm/purchase-storage/pageDto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conditions: [
          { group: 'master', field: 'source_no', operator: 'like', value: orderNo }
        ],
        sorts: [],
        pagger: { page: 1, limit: 10 },
        extra: {}
      })
    });
    const data = await res.json();
    if (data.data && data.data.items && data.data.items.length > 0) {
      const item = data.data.items[0];
      return {
        supplier: item.supplier_short_name,
        settlementType: item.settlement_types === 'current' ? '现结' : '月结',
        storageNo: item.storage_no,
        status: item.status,
        isSettlement: item.is_settlement
      };
    }
    return null;
  }, orderNo);

  if (!result) {
    throw new Error(`找不到单号: ${orderNo}`);
  }
  if (result.isSettlement === 1) {
    throw new Error(`${orderNo} 已经结算过了`);
  }
  if (result.status !== 2) {
    throw new Error(`${orderNo} 状态不是"已核对"，无法结算`);
  }

  console.log(`  → 供应商: ${result.supplier}`);
  console.log(`  → 结算方式: ${result.settlementType}`);
  console.log(`  → 入库单号: ${result.storageNo}`);
  return result;
}

// ============ 单笔结算流程 ============

async function settleOne(page, orderNo) {
  const info = await lookupOrder(page, orderNo);
  const remark = `${today()} 结算`;

  console.log(`\n开始结算: ${info.supplier} | ${orderNo} | ${info.settlementType}\n`);

  await stepClickNew(page);
  await stepHandlePopup(page);
  await stepSelectCompany(page);
  await stepFillSupplier(page, info.supplier);
  await stepSelectSettlementType(page, info.settlementType);
  await stepFillRemark(page, remark);
  await stepSelectStorageRecords(page, info.storageNo);
  await stepDeleteDeductions(page);
  await stepSaveAndSubmit(page);

  return info;
}

// ============ 主流程 ============

async function main() {
  const rawOrderNos = process.argv.slice(2);
  if (rawOrderNos.length === 0) {
    console.log('用法: node settle-browser.js <来源单号> [来源单号2] [来源单号3] ...');
    console.log('单个: node settle-browser.js QO26022511942-P03');
    console.log('批量: node settle-browser.js QO26020611878-P04 QO26020611882-P02 ...');
    process.exit(1);
  }

  // 去重
  const orderNos = [...new Set(rawOrderNos)];
  if (orderNos.length < rawOrderNos.length) {
    console.log(`去重: ${rawOrderNos.length} → ${orderNos.length} 个（去掉 ${rawOrderNos.length - orderNos.length} 个重复）`);
  }

  console.log('=== SCM 采购结算 - 浏览器自动化 ===\n');
  console.log(`共 ${orderNos.length} 个单号待结算\n`);

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
  }

  const report = [];

  for (let i = 0; i < orderNos.length; i++) {
    const orderNo = orderNos[i];
    const progress = `[${i + 1}/${orderNos.length}]`;
    console.log(`\n${progress} 处理: ${orderNo}`);

    let didUIWork = false;
    try {
      const info = await settleOne(page, orderNo);
      didUIWork = true;
      report.push({ orderNo, supplier: info.supplier, status: 'ok', msg: '结算成功' });
      console.log(`${progress} ✓ ${orderNo} 结算成功`);
    } catch (e) {
      const msg = e.message;
      if (msg.includes('已经结算过了')) {
        report.push({ orderNo, supplier: '-', status: 'skipped', msg: '已结算，跳过' });
        console.log(`${progress} ⊘ ${orderNo} 已结算，跳过`);
      } else {
        report.push({ orderNo, supplier: '-', status: 'fail', msg });
        console.error(`${progress} ✗ ${orderNo} 失败: ${msg}`);
      }
    }

    // 只有真正操作了 UI 才需要等待 + 重置页面
    if (didUIWork && i < orderNos.length - 1) {
      console.log(`  等待 5 秒，确保后台处理完成...`);
      await sleep(5000);
      await page.goto(CONFIG.scmUrl, { waitUntil: 'networkidle' });
      await sleep(2000);
      console.log('  → 页面已重置，开始下一个');
    }
  }

  // 汇总报告
  const settled = report.filter(r => r.status === 'ok');
  const skipped = report.filter(r => r.status === 'skipped');
  const failed = report.filter(r => r.status === 'fail');

  console.log(`\n${'='.repeat(50)}`);
  console.log('批量结算报告');
  console.log('='.repeat(50));
  console.log(`总计: ${report.length} 个 | 成功: ${settled.length} | 已结算跳过: ${skipped.length} | 失败: ${failed.length}\n`);

  for (const r of report) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'skipped' ? '⊘' : '✗';
    console.log(`  ${icon} ${r.orderNo} | ${r.supplier} | ${r.msg}`);
  }

  if (skipped.length === report.length) {
    console.log('\n全部已结算，无需操作。');
  }

  if (failed.length > 0) {
    console.log('\n失败的单号可以单独重跑:');
    const failedNos = failed.map(r => r.orderNo).join(' ');
    console.log(`  node settle-browser.js ${failedNos}`);
  }
}

main().catch(e => {
  console.error('脚本出错:', e.message);
  process.exit(1);
});
