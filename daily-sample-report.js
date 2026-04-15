#!/usr/bin/env node
/**
 * 打样单节点完成报表
 *
 * 功能：
 * 1. 从 SCM 系统查询指定日期（范围）节点完成的打样单数据
 * 2. 提取每个打样单的全部工序进度
 * 3. 计算耗时、比对时效标准、判定超时状态
 * 4. 生成 Excel 报表（需求结果 + 透视汇总）
 *
 * 用法：
 *   node daily-sample-report.js                          # 默认查昨天
 *   node daily-sample-report.js 2026-03-23               # 单日
 *   node daily-sample-report.js 2026-03-23 2026-03-28    # 日期范围
 */

const scm = require('./scm-common');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============

const STANDARD_TIMES_FILE = path.join(__dirname, '节点时效.xlsx');

function getDatedOutputDir() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const weekNum = Math.floor((day - 1) / 7) + 1;
  const weekNames = ['第一个星期', '第二个星期', '第三个星期', '第四个星期', '第五个星期'];
  const weekName = weekNames[weekNum - 1] || weekNames[4];
  const dir = path.join(
    require('os').homedir(), 'Desktop', '工作台', '电商', '一键打样单',
    '打样单报告', `${month}月份`, `${month}月${weekName}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const OUTPUT_DIR = getDatedOutputDir();

// ============ 日期工具 ============

/** 获取昨天的日期 YYYY-MM-DD */
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 生成日期范围内所有日期 */
function getDateRange(startDate, endDate) {
  const dates = [];
  const d = new Date(startDate);
  const end = new Date(endDate);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/** 日期格式化为中文标签：2026-03-23 → 3月23日 */
function formatDateLabel(dateStr) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 日期字符串 → Excel 序列号（含时间小数） */
function toExcelSerial(dateStr) {
  if (!dateStr || dateStr === '-' || dateStr === '') return null;
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+|T)(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const ref = new Date(2000, 0, 1, 0, 0, 0);
  const target = new Date(y, mo - 1, d, h, mi, s);
  return 36526 + (target.getTime() - ref.getTime()) / 86400000;
}

// ============ 时效标准表 ============

/** 加载节点时效标准（从"要求耗时"sheet，按 模板名+节点全名 匹配） */
function loadStandardTimes() {
  if (!fs.existsSync(STANDARD_TIMES_FILE)) {
    console.error(`⚠ 节点时效表不存在: ${STANDARD_TIMES_FILE}`);
    console.error('  请把"节点时效.xlsx"复制到 scm-settle 目录');
    process.exit(1);
  }

  const wb = XLSX.readFile(STANDARD_TIMES_FILE);
  const ws = wb.Sheets['要求耗时'];
  if (!ws) {
    console.error('⚠ 节点时效表里找不到"要求耗时"Sheet');
    process.exit(1);
  }

  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const map = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const template = row[0];
    const nodeName = row[1];
    const hours = row[2];
    if (!template || !nodeName || hours == null) continue;
    map[`${template}|${nodeName}`] = hours;
  }

  console.log(`✓ 加载时效标准 ${Object.keys(map).length} 项`);
  return map;
}

/** 标准化名称：去括号、去多余空格，用于模糊匹配 */
function normalize(s) {
  return (s || '').replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
}

/** 查找时效标准：模板名+节点名，自动容错括号后缀、岗位后缀等差异 */
function lookupStandardTime(standardTimes, activityName, templateName) {
  if (!activityName || !templateName) return null;

  // 1. 精确匹配
  const key = `${templateName}|${activityName}`;
  if (standardTimes[key] != null) return standardTimes[key];

  // 2. 模板名去括号后匹配（系统="开发样进度模板（头版、二版、三版）" → 表格="开发样进度模板"）
  const normTpl = normalize(templateName);
  const normKey = `${normTpl}|${activityName}`;
  if (normKey !== key && standardTimes[normKey] != null) return standardTimes[normKey];

  // 3. 节点名模糊：API 无岗位后缀，标准表有（API="确定建立修改样单" → 表格="确定建立修改样单-设计师"）
  for (const k of Object.keys(standardTimes)) {
    const [kTpl, kNode] = k.split('|');
    if ((kTpl === templateName || kTpl === normTpl) && kNode && kNode.startsWith(activityName + '-')) {
      return standardTimes[k];
    }
  }

  // 4. 两边都有岗位但岗位不同（API="面料到位-资料员" → 表格="面料到位-设计助理"），去掉岗位比节点名
  const dashIdx = activityName.lastIndexOf('-');
  if (dashIdx !== -1) {
    const strippedActivity = activityName.substring(0, dashIdx);
    // 4a. 标准表无岗位
    for (const tpl of [templateName, normTpl]) {
      const sk = `${tpl}|${strippedActivity}`;
      if (standardTimes[sk] != null) return standardTimes[sk];
    }
    // 4b. 标准表有不同岗位
    for (const k of Object.keys(standardTimes)) {
      const [kTpl, kNode] = k.split('|');
      if (kTpl !== templateName && kTpl !== normTpl) continue;
      const kDash = kNode.lastIndexOf('-');
      if (kDash !== -1 && kNode.substring(0, kDash) === strippedActivity) {
        return standardTimes[k];
      }
    }
  }

  return null;
}

// ============ API 查询 ============

/** 查询指定日期范围节点完成的打样单（带分页） */
async function queryOrders(cookie, startDate, endDate) {
  const all = [];
  let page = 1;

  while (true) {
    const res = await scm.request('/biz-plm/sample-apply/info/page', {
      conditions: [
        {
          group: 'activity',
          field: 'actual_end_date',
          operator: 'range',
          value: [startDate, endDate + ' 23:59:59'],
        },
        {
          field: 'apply_status',
          operator: 'in',
          value: ['CREATED', 'PUBLISHED', 'FINISHED'],
        },
      ],
      sorts: [],
      pagger: { page, limit: 100 },
      extra: {},
    }, cookie);

    if (res.code !== 200) {
      throw new Error(`查询失败: ${res.msg || JSON.stringify(res)}`);
    }

    const items = res.data.items || [];
    const total = res.data.total || 0;
    all.push(...items);
    console.log(`  第 ${page} 页: +${items.length} 条（已获取 ${all.length}/${total}）`);

    if (all.length >= total || items.length === 0) break;
    page++;
    await scm.sleep(200);
  }

  return all;
}

// ============ 数据提取 ============

/** 从 activity_name 拆分工作名称和岗位 */
function splitActivityName(name) {
  if (!name) return ['', ''];
  const idx = name.lastIndexOf('-');
  if (idx === -1) return [name, ''];
  return [name.substring(0, idx), name.substring(idx + 1)];
}

/** 提取所有打样单的工序数据，生成需求结果行 */
function extractRows(orders, standardTimes) {
  const allRows = [];

  for (const item of orders) {
    const apply = item.apply;
    const schedule = item.schedule;
    if (!schedule || !schedule.activities) continue;

    const activities = schedule.activities;
    let prevOperateSerial = null;

    const createSerial = toExcelSerial(apply.created);

    for (let i = 0; i < activities.length; i++) {
      const act = activities[i];
      const [workName, role] = splitActivityName(act.activity_name);

      const operateSerial = toExcelSerial(act.operate_date);
      const actualEndSerial = toExcelSerial(act.actual_end_date);
      const actualStartSerial = toExcelSerial(act.actual_start_date);
      const plannedStartSerial = toExcelSerial(act.planned_start_date);
      const earlyWarningSerial = toExcelSerial(act.early_warning_date);
      const plannedEndSerial = toExcelSerial(act.planned_end_date);

      // 耗时计算
      let elapsed = null;
      let negativeElapsed = false;
      if (operateSerial != null) {
        if (i === 0) {
          elapsed = createSerial != null ? operateSerial - createSerial : null;
        } else {
          elapsed = prevOperateSerial != null ? operateSerial - prevOperateSerial : null;
        }
        // 负耗时 = 上一个节点的人超时操作了，当前节点未超时
        if (elapsed != null && elapsed <= 0) {
          negativeElapsed = true;
          elapsed = null;
        }
      }

      // 时效查找
      const standard = lookupStandardTime(
        standardTimes, act.activity_name, schedule.template_name
      );

      // 状态判定
      let status = null;
      if (negativeElapsed) {
        status = '不超时';
      } else if (elapsed != null && standard != null) {
        status = elapsed < standard ? '不超时' : '超时';
      }

      // 备注合并
      const remark = act.remark || '';
      const restOfWeek = act.rest_of_week || '';
      const mergedNote = remark + restOfWeek;

      allRows.push({
        创建人: apply.creator,
        模板名称: schedule.template_name,
        品牌: apply.brand_name,
        样品编码: /^\d+$/.test(apply.sample_no) ? Number(apply.sample_no) : apply.sample_no,
        样板类型: apply.sample_model_type_name || '',
        创建日期: createSerial,
        工作名称: workName,
        自动开始: role,
        操作时间: operateSerial,
        操作人: act.operate_person || '',
        耗时: elapsed,
        时效: standard,
        状态: status,
        实际完成时间: actualEndSerial,
        负责人: act.responsible_person || '',
        计划开始时间: plannedStartSerial,
        预警时间: earlyWarningSerial,
        计划完成时间: plannedEndSerial,
        实际开始时间: actualStartSerial,
        无效: null,
        备注: mergedNote || null,
        反馈: (remark || restOfWeek) ? 1 : null,
        备注原始: remark || null,
        周休: restOfWeek || null,
        _activityName: act.activity_name || workName,
        _workName: workName,
        _operator: act.operate_person || '',
        _status: status,
        _hasOperate: operateSerial != null,
        _operateDate: act.operate_date ? act.operate_date.slice(0, 10) : null,
      });

      if (operateSerial != null) {
        prevOperateSerial = operateSerial;
      }
    }
  }

  return allRows;
}

// ============ Excel 生成 ============

/** 生成"节点（原始数据）"Sheet */
function buildNodeSheet(rows) {
  const headers = [
    '创建人', '模板名称', '品牌', '样品编码', '样板类型', '创建日期', null,
    '工作名称', null, '计划开始时间', '预警时间', '计划完成时间',
    '实际开始时间', '实际完成时间', '操作时间', '操作人', '负责人',
    null, null, '耗时', '要求耗时', '超时状态', '备注',
  ];

  const data = [headers];

  for (const r of rows) {
    data.push([
      r.创建人, r.模板名称, r.品牌, r.样品编码, r.样板类型,
      r.创建日期, null,
      r._activityName, null,
      r.计划开始时间, r.预警时间, r.计划完成时间,
      r.实际开始时间 != null ? r.实际开始时间 : '-',
      r.实际完成时间 != null ? r.实际完成时间 : '-',
      r.操作时间 != null ? r.操作时间 : '-',
      r.操作人, r.负责人,
      null, null,
      r.耗时, r.时效, r.状态, r.备注原始,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);

  const dateFormat = 'yyyy-mm-dd hh:mm:ss';
  const dateCols = [5, 9, 10, 11, 12, 13, 14];
  for (let row = 1; row < data.length; row++) {
    for (const col of dateCols) {
      const addr = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = ws[addr];
      if (cell && typeof cell.v === 'number') {
        cell.t = 'n';
        cell.z = dateFormat;
      }
    }
    const elapsedAddr = XLSX.utils.encode_cell({ r: row, c: 19 });
    const elapsedCell = ws[elapsedAddr];
    if (elapsedCell && typeof elapsedCell.v === 'number') {
      elapsedCell.z = '0.00';
    }
  }

  return ws;
}

/** 生成"打样单列表（原始数据）"Sheet */
function buildApplyListSheet(orders) {
  const headers = [
    null, '单号', '工作流', '状态', '打样方式', '打样数', '图片',
    '样品编码', '样品名称', '评估状态', '打样工厂', '品牌', '样板类型',
    '改版原因', '总进度', '成本核价已完成', '来源样品', '性别', '打样规格',
    '客户款号', '版型', '成品状态', '商品编码', '同步状态', '来源计划',
    '款式来源', '纸样分数', '车板分数', '品类', '设计师名', '整体负责人',
    '制版师', '样品师', '客户', '年份', '季节', '波段', '创建人', '系列',
    '业务员', '成本价', '供应商货号', '打样颜色规格', '采购价', '创建日期',
    '计划开始日期', '计划完工日期', '实际完工日期', '样品计划完工时间',
    '样品实际开始', '样品实际完工', '打板时长', '标签', '模板名称',
    '跟单审批结果', '业务日志', '样品附件', '进度日志', '成品SKC',
    '效果图', '设计款号', '业务备注',
  ];

  const data = [headers];

  for (let idx = 0; idx < orders.length; idx++) {
    const item = orders[idx];
    const a = item.apply;
    const s = item.schedule;
    data.push([
      idx + 1, a.sample_apply_no, a.workflow_id, a.apply_status_name,
      a.sample_method_name, a.sample_num || 0, a.design_img,
      a.sample_no, a.sample_name, a.evaluate_status_name,
      a.factory_name, a.brand_name, a.sample_model_type_name,
      a.revision_reason, null, null, a.source_sample_no,
      a.gender_name, a.sample_spec, a.customer_style_no,
      a.pattern_name, a.product_status_name, a.product_code,
      a.sync_status, a.source_plan, a.style_source,
      null, null, a.category_name, a.designer_name,
      a.responsible_person, a.pattern_maker, a.sample_maker,
      a.customer_name, a.year_name, a.season_name, a.wave_name,
      a.creator, a.series_name, a.salesman, a.cost_price,
      a.supplier_style_no, null, a.purchase_price,
      a.created, null, null, null, null, null, null, null,
      null, s ? s.template_name : null,
      null, null, null, null, null, null, null, null,
    ]);
  }

  return XLSX.utils.aoa_to_sheet(data);
}

/** 按日期分组统计：返回 { groupKey: { node, role, person, byDate: { date: {total, passed} }, total, passed } } */
function groupByNodeAndPerson(rows, dates) {
  const dateSet = new Set(dates);
  const completed = rows.filter(r => r._hasOperate && dateSet.has(r._operateDate));

  const groups = {};
  for (const r of completed) {
    const key = `${r._activityName}||${r._operator}`;
    if (!groups[key]) {
      groups[key] = { node: r._activityName, role: '', person: r._operator, byDate: {}, total: 0, passed: 0 };
      const idx = (r._activityName || '').lastIndexOf('-');
      if (idx !== -1) groups[key].role = r._activityName.substring(idx + 1);
      for (const d of dates) {
        groups[key].byDate[d] = { total: 0, passed: 0 };
      }
    }
    const g = groups[key];
    g.total++;
    if (r._status === '不超时') g.passed++;
    if (g.byDate[r._operateDate]) {
      g.byDate[r._operateDate].total++;
      if (r._status === '不超时') g.byDate[r._operateDate].passed++;
    }
  }

  return Object.values(groups).sort((a, b) =>
    a.node.localeCompare(b.node, 'zh') || a.person.localeCompare(b.person, 'zh')
  );
}

/** 生成"汇总表"Sheet */
function buildSummarySheet(rows, dates) {
  const isMultiDay = dates.length > 1;
  const entries = groupByNodeAndPerson(rows, dates);

  // 计算周信息
  const d0 = new Date(dates[0]);
  const month = d0.getMonth() + 1;
  const weekOfMonth = Math.ceil(d0.getDate() / 7);
  const weekLabel = `${month}月第${weekOfMonth}周`;

  const data = [];

  if (isMultiDay) {
    // 多天模式：每天3列 + 合计3列
    // 表头行1: 固定3列 + 每天3列(日期标签) + 合计3列
    const header1 = ['开发样/产前样/拍照样模板', null, '操作日期'];
    for (const dt of dates) {
      header1.push(formatDateLabel(dt), null, null);
    }
    header1.push('合计（' + weekLabel + '）', null, null);
    data.push(header1);

    // 表头行2
    const header2 = ['节点操作', '操作岗位', '操作人'];
    for (let i = 0; i < dates.length; i++) {
      header2.push('完成数量', '时效达成数量', '时效达成率');
    }
    header2.push('完成数量', '时效达成数量', '时效达成率');
    data.push(header2);

    // 数据行
    for (const e of entries) {
      const row = [e.node, e.role, e.person];
      for (const dt of dates) {
        const day = e.byDate[dt];
        if (day.total > 0) {
          row.push(day.total, day.passed, day.passed / day.total);
        } else {
          row.push(null, null, null);
        }
      }
      const totalRate = e.total > 0 ? e.passed / e.total : null;
      row.push(e.total, e.passed, totalRate);
      data.push(row);
    }
  } else {
    // 单天模式：保持原有格式
    const date = dates[0];
    data.push(['开发样/产前样/拍照样模板', null, '操作日期', date, null, null, weekLabel, null, null, '反馈数据']);
    data.push(['节点操作', '操作岗位', '操作人', '完成数量', '时效达成数量', '时效达成率',
      '完成数量', '时效达成数量', '时效达成率', '反馈达成数量', '时效达成率', '反馈时效达成数量']);

    for (const e of entries) {
      const rate = e.total > 0 ? e.passed / e.total : null;
      data.push([e.node, e.role, e.person, e.total, e.passed, rate, e.total, e.passed, rate]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(data);

  // 设置百分比格式（达成率列）
  if (isMultiDay) {
    for (let row = 2; row < data.length; row++) {
      for (let i = 0; i <= dates.length; i++) {
        const col = 3 + i * 3 + 2; // 每组第3列是达成率
        const addr = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = ws[addr];
        if (cell && typeof cell.v === 'number') cell.z = '0%';
      }
    }
  } else {
    for (let row = 2; row < data.length; row++) {
      for (const col of [5, 8]) {
        const addr = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = ws[addr];
        if (cell && typeof cell.v === 'number') cell.z = '0%';
      }
    }
  }

  return ws;
}

/** 生成"周汇总表（达标率90%以下）"Sheet */
function buildWeeklyAlertSheet(rows, dates) {
  const entries = groupByNodeAndPerson(rows, dates)
    .filter(e => e.total > 0 && (e.passed / e.total) < 0.9);

  const d0 = new Date(dates[0]);
  const month = d0.getMonth() + 1;
  const weekOfMonth = Math.ceil(d0.getDate() / 7);
  const weekLabel = `${month}月第${weekOfMonth}周`;

  const data = [];
  data.push(['开发样/产前样/拍照样模板', null, '操作日期', weekLabel, null, null, '反馈数据']);
  data.push(['节点操作', '操作岗位', '操作人', '完成数量', '时效达成数量', '时效达成率',
    '反馈达成数量', '时效达成率', '反馈时效达成数量']);

  for (const e of entries) {
    const rate = e.total > 0 ? e.passed / e.total : null;
    data.push([e.node, e.role, e.person, e.total, e.passed, rate]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  for (let row = 2; row < data.length; row++) {
    const addr = XLSX.utils.encode_cell({ r: row, c: 5 });
    const cell = ws[addr];
    if (cell && typeof cell.v === 'number') cell.z = '0%';
  }
  return ws;
}

/** 生成完整 Excel 文件 */
function generateExcel(rows, orders, dates) {
  const wb = XLSX.utils.book_new();

  // Sheet1: 打样单列表（原始数据）
  const applyWs = buildApplyListSheet(orders);
  XLSX.utils.book_append_sheet(wb, applyWs, '打样单列表（原始数据）');

  // Sheet2: 节点（原始数据）
  const nodeWs = buildNodeSheet(rows);
  XLSX.utils.book_append_sheet(wb, nodeWs, '节点（原始数据）');

  // Sheet3: 要求耗时（从节点时效.xlsx复制）
  const stdWb = XLSX.readFile(STANDARD_TIMES_FILE, { sheets: ['要求耗时'] });
  const stdWs = stdWb.Sheets['要求耗时'];
  if (stdWs) XLSX.utils.book_append_sheet(wb, stdWs, '要求耗时');

  // Sheet4: 汇总表
  const summaryWs = buildSummarySheet(rows, dates);
  XLSX.utils.book_append_sheet(wb, summaryWs, '汇总表');

  // Sheet5: 周汇总表（达标率90%以下）
  const alertWs = buildWeeklyAlertSheet(rows, dates);
  XLSX.utils.book_append_sheet(wb, alertWs, '周汇总表（达标率90%以下）');

  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const dateLabel = dates.length === 1 ? startDate : `${startDate}~${endDate}`;
  const fileName = `打样单 (${dateLabel}节点完成数据).xlsx`;
  const filePath = path.join(OUTPUT_DIR, fileName);
  XLSX.writeFile(wb, filePath);

  return filePath;
}

// ============ 主流程 ============

async function main() {
  const args = process.argv.slice(2);
  let startDate, endDate;

  if (args.length >= 2) {
    startDate = args[0];
    endDate = args[1];
  } else {
    startDate = endDate = args[0] || yesterday();
  }

  const dates = getDateRange(startDate, endDate);
  const dateLabel = dates.length === 1 ? startDate : `${startDate} ~ ${endDate}（${dates.length}天）`;
  console.log(`\n📋 打样单节点完成报表 — ${dateLabel}\n`);

  // 1. 加载时效标准
  const standardTimes = loadStandardTimes();

  // 2. 获取 Cookie
  console.log('\n🔑 获取登录凭证...');
  const cookie = await scm.getCookie();
  console.log('✓ Cookie 获取成功');

  // 3. 查询数据
  console.log(`\n📡 查询 ${startDate} ~ ${endDate} 节点完成数据...`);
  const orders = await queryOrders(cookie, startDate, endDate);
  console.log(`✓ 共 ${orders.length} 个打样单`);

  if (orders.length === 0) {
    console.log('\n⚠ 没有数据，不生成报表');
    return;
  }

  // 4. 提取和处理数据
  console.log('\n⚙ 处理数据...');
  const rows = extractRows(orders, standardTimes);
  console.log(`✓ 共 ${rows.length} 条工序记录`);

  // 统计
  const dateSet = new Set(dates);
  const completed = rows.filter(r => r._hasOperate && dateSet.has(r._operateDate)).length;
  const overtime = rows.filter(r => r._status === '超时' && dateSet.has(r._operateDate)).length;
  console.log(`  范围内已完成: ${completed}，超时: ${overtime}`);

  // 5. 生成 Excel
  console.log('\n📊 生成报表...');
  const filePath = generateExcel(rows, orders, dates);
  console.log(`✓ 报表已保存: ${filePath}`);
}

main().catch(err => {
  console.error('\n❌ 错误:', err.message);
  process.exit(1);
});
