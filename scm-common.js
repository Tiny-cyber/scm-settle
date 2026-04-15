/**
 * SCM 公共模块
 * 提供：自动 Cookie 获取、API 请求封装、共用业务逻辑
 *
 * 用法：
 *   const scm = require('./scm-common');
 *   const cookie = await scm.getCookie();           // 自动从 Chrome 拿
 *   const data = await scm.api.queryStorage(cookie, '2026-03');
 */

const https = require('https');
const http = require('http');

// ============ 配置 ============

const CONFIG = {
  host: 'zyhx.scm.xinwuyun.com',
  companyId: '2420420446834944', // 佛山市自由呼吸服饰有限公司
  companyName: '佛山市自由呼吸服饰有限公司',
  pageSize: 500,
  cdpPort: 9222,
  // 内部仓库（调拨用，不需要结算）
  internalSuppliers: [
    '佛山主仓', '经纬总仓', '染色仓',
    '虚拟仓-自由呼吸民乐厂', '自由呼吸',
  ],
  // 请求重试配置
  maxRetries: 2,
  retryDelay: 1000,
};

// ============ 工具函数 ============

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 返回今天的日期 YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 获取某月最后一天的日期数字 */
function lastDayOfMonth(month) {
  const [year, mon] = month.split('-');
  return new Date(parseInt(year), parseInt(mon), 0).getDate();
}

/** 判断是否内部调拨供应商 */
function isInternal(item) {
  const name = (item.supplier_short_name || item.supplier_company_name || '')
    .replace(/[^\u4e00-\u9fffa-zA-Z0-9\-_（）()]/g, '');
  return CONFIG.internalSuppliers.some(w => name.includes(w));
}

// ============ 自动 Cookie 获取 ============

/**
 * 从 Chrome CDP (端口 9222) 自动获取 SCM 的登录 Cookie
 * 前提：Chrome 以调试模式打开且已登录 SCM
 */
async function getCookie() {
  // 1. 获取 CDP WebSocket 地址
  const versionInfo = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Chrome CDP 返回数据解析失败')); }
      });
    }).on('error', () => {
      reject(new Error(
        '连接 Chrome 失败。确保 Chrome 以调试模式启动（端口 9222）\n' +
        '启动方式：双击 ~/Desktop/启动Chrome调试模式.command'
      ));
    });
  });

  // 2. 通过 CDP HTTP API 获取 cookies
  const cookies = await new Promise((resolve, reject) => {
    // 先拿一个可用的 target（页面）
    http.get(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('获取 Chrome 页面列表失败')); }
      });
    }).on('error', reject);
  });

  // 3. 用 fetch 通过 CDP 的 /json/protocol 拿不到 cookie，
  //    需要用 WebSocket 发 CDP 命令
  const wsUrl = versionInfo.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error('获取不到 Chrome CDP WebSocket 地址');
  }

  const cookie = await getCookieViaCDP(wsUrl);
  if (!cookie) {
    throw new Error(
      'Chrome 里没有 SCM 的登录 Cookie。\n' +
      '请先在 Chrome 里打开 SCM 系统并登录：\n' +
      `https://${CONFIG.host}`
    );
  }

  return cookie;
}

/** 通过 CDP WebSocket 获取指定域名的 cookie */
function getCookieViaCDP(wsUrl) {
  // 使用 Node.js 内置的 WebSocket（Node 22+）或降级用 http
  // Node 22+ 不内置 WebSocket client，用 CDP HTTP endpoint 替代

  return new Promise((resolve, reject) => {
    // 用 CDP 的 /json/list 找到一个 SCM 页面，然后通过它的 devtools 协议拿 cookie
    http.get(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const pages = JSON.parse(data);
        const scmPage = pages.find(p => p.url && p.url.includes(CONFIG.host));

        if (!scmPage) {
          // 没有 SCM 页面也没关系，用任意页面通过 CDP 拿全局 cookie
        }

        // 用目标页的 WebSocket 发 Network.getCookies
        const targetWs = scmPage
          ? scmPage.webSocketDebuggerUrl
          : (pages[0] && pages[0].webSocketDebuggerUrl);

        if (!targetWs) {
          reject(new Error('Chrome 没有可用的页面'));
          return;
        }

        extractCookieFromWs(targetWs, resolve, reject);
      });
    }).on('error', reject);
  });
}

/** 通过 WebSocket 连接 CDP，发送 Network.getCookies 命令 */
function extractCookieFromWs(wsUrl, resolve, reject) {
  // Node.js v22+ 没有内置 WebSocket client API 用于 ws:// 协议
  // 用更简单的方案：通过 Playwright 的 CDP 连接拿 cookie
  // 但为了零依赖，改用原生 http 模块手工实现 WebSocket 握手

  const url = new URL(wsUrl);
  const key = Buffer.from(Math.random().toString()).toString('base64');

  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'GET',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  });

  req.on('upgrade', (res, socket) => {
    // 发送 CDP 命令：获取 cookies
    const msg = JSON.stringify({
      id: 1,
      method: 'Network.getCookies',
      params: { urls: [`https://${CONFIG.host}`] },
    });

    sendWsFrame(socket, msg);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // 尝试解析 WebSocket frame
      const parsed = parseWsFrame(buffer);
      if (!parsed) return;

      try {
        const response = JSON.parse(parsed.payload);
        if (response.id === 1 && response.result) {
          const cookies = response.result.cookies || [];
          const sessionCookie = cookies.find(c => c.name === 'XWERPSSIONID');
          socket.destroy();
          if (sessionCookie) {
            resolve(`XWERPSSIONID=${sessionCookie.value}`);
          } else {
            resolve(null);
          }
        }
      } catch {
        // 还没收完，继续等
      }
    });

    socket.on('error', (e) => {
      reject(new Error(`WebSocket 错误: ${e.message}`));
    });

    // 超时保护
    setTimeout(() => {
      socket.destroy();
      reject(new Error('获取 Cookie 超时（5秒）'));
    }, 5000);
  });

  req.on('error', (e) => {
    reject(new Error(`WebSocket 连接失败: ${e.message}`));
  });

  req.end();
}

/** 发送 WebSocket frame（文本） */
function sendWsFrame(socket, data) {
  const payload = Buffer.from(data);
  const mask = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);

  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | payload.length; // masked
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  socket.write(Buffer.concat([header, mask, masked]));
}

/** 解析 WebSocket frame（简化版，只处理文本帧） */
function parseWsFrame(buffer) {
  if (buffer.length < 2) return null;

  const secondByte = buffer[1];
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    offset += 4; // skip mask key
  }

  if (buffer.length < offset + payloadLen) return null;

  let payload = buffer.slice(offset, offset + payloadLen);
  if (masked) {
    const maskKey = buffer.slice(offset - 4, offset);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i] ^ maskKey[i % 4];
    }
  }

  return { payload: payload.toString('utf8') };
}

// ============ HTTP 请求封装 ============

/**
 * 发送 API 请求，带自动重试和 Cookie 过期检测
 * @param {string} apiPath - API 路径
 * @param {object|string} body - 请求体
 * @param {string} cookie - Cookie 字符串
 * @param {'json'|'form'} contentType - 内容类型
 * @returns {Promise<object>} 响应数据
 */
async function request(apiPath, body, cookie, contentType = 'json') {
  let lastError;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`  ↻ 重试第 ${attempt} 次...`);
      await sleep(CONFIG.retryDelay);
    }

    try {
      const result = await _doRequest(apiPath, body, cookie, contentType);

      // 检查 Cookie 是否过期（SCM 返回 302 或特定错误码）
      if (result.code === 401 || result.code === 403 ||
          (result.msg && result.msg.includes('登录'))) {
        throw new CookieExpiredError();
      }

      return result;
    } catch (e) {
      if (e instanceof CookieExpiredError) throw e; // Cookie 过期不重试
      lastError = e;
    }
  }

  throw lastError;
}

class CookieExpiredError extends Error {
  constructor() {
    super(
      'Cookie 已过期，需要重新获取。\n' +
      '如果用自动获取：确保 Chrome 里 SCM 还是登录状态\n' +
      '如果手动粘贴：从浏览器重新复制 Cookie'
    );
    this.name = 'CookieExpiredError';
  }
}

function _doRequest(apiPath, body, cookie, contentType) {
  return new Promise((resolve, reject) => {
    const payload = contentType === 'json' ? JSON.stringify(body) : body;
    const options = {
      hostname: CONFIG.host,
      path: apiPath,
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
      // 处理重定向（Cookie 过期时 SCM 可能 302 到登录页）
      if (res.statusCode === 302 || res.statusCode === 301) {
        reject(new CookieExpiredError());
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`返回数据解析失败: ${data.substring(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`请求超时: ${apiPath}`));
    });
    req.write(payload);
    req.end();
  });
}

// ============ 常用 API 封装 ============

const api = {
  /**
   * 查询采购入库单（单页）
   * @param {string} cookie
   * @param {string} month - 格式 YYYY-MM
   * @param {number} page - 页码
   */
  queryStorage(cookie, month, page = 1) {
    const lastDay = lastDayOfMonth(month);
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
  },

  /**
   * 查询所有页的入库单
   * @param {string} cookie
   * @param {string} month
   * @returns {Promise<Array>} 所有入库单
   */
  async queryAllStorage(cookie, month) {
    const all = [];
    let page = 1;

    while (true) {
      const res = await api.queryStorage(cookie, month, page);
      if (res.code !== 200) {
        throw new Error(`查询失败: ${res.msg || JSON.stringify(res)}`);
      }

      const items = res.data.items || [];
      const total = res.data.total || 0;
      all.push(...items);
      console.log(`  第 ${page} 页: +${items.length} 条（已获取 ${all.length}/${total}）`);

      if (all.length >= total || items.length === 0) break;
      page++;
    }

    return all;
  },

  /**
   * 按供应商分组（排除内部调拨）
   * @param {Array} items - 入库单列表
   * @returns {{ external: Array, groups: Object, internalCount: number }}
   */
  groupBySupplier(items) {
    const external = items.filter(item => !isInternal(item));
    const internalCount = items.length - external.length;

    const groups = {};
    for (const item of external) {
      const sid = item.supplier_id;
      if (!groups[sid]) {
        groups[sid] = {
          supplierId: sid,
          name: item.supplier_short_name || item.supplier_company_name,
          settlementType: item.settlement_types === 'current' ? '现结' : '月结',
          storageIds: [],
          count: 0,
        };
      }
      if (!groups[sid].storageIds.includes(item.id)) {
        groups[sid].storageIds.push(item.id);
      }
      groups[sid].count++;
    }

    return {
      external,
      groups,
      suppliers: Object.values(groups),
      internalCount,
    };
  },

  /**
   * 调用自动结算 API
   * @param {string} cookie
   * @param {string} supplierId
   * @param {Array<string>} storageIds
   * @param {string} settlementType - 'current' 或 ''
   */
  autoSettle(cookie, supplierId, storageIds, settlementType = '') {
    const params = new URLSearchParams();
    params.append('supplierId', supplierId);
    params.append('companyId', CONFIG.companyId);
    params.append('settlementType', settlementType);
    params.append('storageIds', storageIds.join(','));

    return request('/biz-finance/settlement/auto-settlement',
      params.toString(), cookie, 'form');
  },

  /**
   * 查询结算单列表
   */
  querySettlement(cookie, month, page = 1) {
    const lastDay = lastDayOfMonth(month);
    return request('/biz-finance/settlement/pageDto', {
      conditions: [
        { group: 'master', field: 'biz_date', operator: 'range',
          value: { min: `${month}-01`, max: `${month}-${lastDay}` }, not: false },
      ],
      sorts: [],
      pagger: { page, limit: CONFIG.pageSize },
      extra: {},
    }, cookie);
  },

  /**
   * 按来源单号查询入库单信息
   * @param {string} cookie
   * @param {string} orderNo - 来源单号（QO 开头）
   */
  async lookupOrder(cookie, orderNo) {
    const res = await request('/biz-scm/purchase-storage/pageDto', {
      conditions: [
        { group: 'master', field: 'source_no', operator: 'like', value: orderNo }
      ],
      sorts: [],
      pagger: { page: 1, limit: 10 },
      extra: {},
    }, cookie);

    if (res.code !== 200) {
      throw new Error(`查询失败: ${res.msg}`);
    }

    const items = (res.data && res.data.items) || [];
    if (items.length === 0) {
      throw new Error(`找不到单号: ${orderNo}`);
    }

    const item = items[0];
    if (item.is_settlement === 1) {
      throw new Error(`${orderNo} 已经结算过了`);
    }
    if (item.status !== 2) {
      throw new Error(`${orderNo} 状态不是"已核对"，无法结算`);
    }

    return {
      supplier: item.supplier_short_name,
      supplierId: item.supplier_id,
      settlementType: item.settlement_types === 'current' ? '现结' : '月结',
      storageNo: item.storage_no,
      sourceNo: item.source_no,
      status: item.status,
      isSettlement: item.is_settlement,
    };
  },
};

// ============ CSV 报告 ============

const fs = require('fs');
const path = require('path');

function saveCsv(filePath, rows) {
  const header = '供应商,入库单数,状态,详情\n';
  const body = rows
    .map(r => `"${r.name}",${r.count},"${r.ok ? '成功' : '失败'}","${r.msg}"`)
    .join('\n');
  fs.writeFileSync(filePath, '\ufeff' + header + body, 'utf8');
}

// ============ 导出 ============

module.exports = {
  CONFIG,
  sleep,
  today,
  lastDayOfMonth,
  isInternal,
  getCookie,
  request,
  api,
  saveCsv,
  CookieExpiredError,
};
