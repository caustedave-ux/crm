'use strict';
// ============================================================
// 小程序独立 API 服务（V1）
// 位置：miniapp/mp-api/server.js —— 独立新增文件，不修改系统任何源文件。
// 通过 require 复用主系统的 src/db.js（同一 SQLite 库）与
// src/auth.js（同一 sessions 表鉴权），为微信小程序提供 JSON 接口。
//
// 启动：node miniapp/mp-api/server.js  （默认端口 5100，可用环境变量 MP_PORT 覆盖）
// 与主系统（5000 端口）可同时运行，数据实时一致。
// ============================================================

const http = require('http');
const { get, all } = require('../../src/db');
const auth = require('../../src/auth');

const PORT = Number(process.env.MP_PORT || 5100);
const PAGE_SIZE = 20;

// ---------- 基础工具 ----------
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
function bearerToken(req) {
  const h = String(req.headers['authorization'] || '');
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return String(req.headers['x-crm-token'] || '').trim() || null;
}
function userFromReq(req) {
  const u = auth.findUserBySession(bearerToken(req));
  return u && u.active ? u : null;
}
function like(kw) { return '%' + String(kw || '').trim() + '%'; }

// ---------- 路由 ----------
async function handle(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  // 健康检查（无需登录）
  if (req.method === 'GET' && p === '/api/mp/ping') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  // 登录（无需登录）
  if (req.method === 'POST' && p === '/api/mp/login') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = get('SELECT * FROM users WHERE username=? AND active=1', username);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { ok: false, error: '用户名或密码错误' });
    }
    const token = auth.createSession(user.id);
    return sendJson(res, 200, {
      ok: true,
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    });
  }

  // ---------- 以下接口均需 Bearer Token ----------
  const user = userFromReq(req);
  if (!user) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });

  // 仪表盘：统计 + 待跟进 + 最近单据
  if (req.method === 'GET' && p === '/api/mp/overview') {
    const totalCustomers = get('SELECT COUNT(*) c FROM customers WHERE user_id=?', user.id).c;
    const monthStart = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const newCustomersMonth = get('SELECT COUNT(*) c FROM customers WHERE user_id=? AND created_at>=?', user.id, monthStart + ' 00:00:00').c;
    const docMonth = get('SELECT COUNT(*) c FROM documents WHERE user_id=? AND created_at>=?', user.id, monthStart + ' 00:00:00').c;
    const docMonthAmount = get("SELECT COALESCE(SUM(total_amount),0) s FROM documents WHERE user_id=? AND created_at>=? AND status!='已作废'", user.id, monthStart + ' 00:00:00').s;
    const today = ymd(new Date());
    const tmrw = ymd(new Date(Date.now() + 86400000));
    const upcoming = all(
      "SELECT a.id, a.customer_id, a.type, a.subject, a.next_follow_date, a.next_follow_notes, a.priority, a.contact_person, c.company_name FROM activities a JOIN customers c ON c.id=a.customer_id WHERE a.next_follow_date IS NOT NULL AND a.next_follow_date<>'' AND a.next_follow_date<=? AND a.archived=0 AND a.user_id=? ORDER BY CASE a.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, a.next_follow_date ASC, a.id DESC LIMIT 30",
      tmrw, user.id
    );
    const recentDocs = all('SELECT d.id, d.doc_no, d.doc_type, d.status, d.total_amount, d.currency, d.issue_date, d.created_at, c.company_name FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.user_id=? ORDER BY d.id DESC LIMIT 8', user.id);
    return sendJson(res, 200, {
      ok: true,
      today,
      stats: { totalCustomers, newCustomersMonth, docMonth, docMonthAmount },
      upcoming: upcoming.map((a) => ({ ...a, overdue: !!a.next_follow_date && a.next_follow_date < today })),
      recentDocs,
    });
  }

  // 客户列表（按登录账号隔离）
  if (req.method === 'GET' && p === '/api/mp/customers') {
    const kw = like(q.get('kw'));
    const where = ['user_id=?', "(company_name LIKE ? OR IFNULL(name_en,'') LIKE ? OR IFNULL(country,'') LIKE ?)"];
    const args = [user.id, kw, kw, kw];
    const status = String(q.get('status') || '').trim();
    if (status) { where.push('status=?'); args.push(status); }
    const w = 'WHERE ' + where.join(' AND ');
    const total = get('SELECT COUNT(*) c FROM customers ' + w, ...args).c;
    const page = Math.max(1, Number(q.get('page') || 1));
    const list = all('SELECT id, company_name, name_en, country, status, level, phone, email, whatsapp, created_at FROM customers ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?', ...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return sendJson(res, 200, { ok: true, total, page, pageSize: PAGE_SIZE, list });
  }

  // 客户详情（含联系人 + 最近跟进）
  let m = p.match(/^\/api\/mp\/customers\/(\d+)$/);
  if (req.method === 'GET' && m) {
    const c = get('SELECT * FROM customers WHERE id=? AND user_id=?', Number(m[1]), user.id);
    if (!c) return sendJson(res, 404, { ok: false, error: '客户不存在或无权访问' });
    const contacts = all('SELECT id, name, position, phone, mobile, email, is_primary FROM contacts WHERE customer_id=? ORDER BY is_primary DESC, id ASC', c.id);
    const activities = all('SELECT id, type, subject, content, contact_person, activity_date, next_follow_date, next_follow_notes, archived FROM activities WHERE customer_id=? AND user_id=? ORDER BY activity_date DESC, id DESC LIMIT 20', c.id, user.id);
    return sendJson(res, 200, { ok: true, customer: c, contacts, activities });
  }

  // 产品列表（全局共享）
  if (req.method === 'GET' && p === '/api/mp/products') {
    const kw = like(q.get('kw'));
    const cond = "name LIKE ? OR IFNULL(name_en,'') LIKE ? OR IFNULL(model,'') LIKE ? OR IFNULL(hs_code,'') LIKE ?";
    const total = get('SELECT COUNT(*) c FROM products WHERE ' + cond, kw, kw, kw, kw).c;
    const page = Math.max(1, Number(q.get('page') || 1));
    const list = all('SELECT id, name, name_en, model, hs_code, unit, price, currency, origin, stock, stock_alert FROM products WHERE ' + cond + ' ORDER BY id DESC LIMIT ? OFFSET ?', kw, kw, kw, kw, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return sendJson(res, 200, { ok: true, total, page, pageSize: PAGE_SIZE, list });
  }

  // 单据列表
  if (req.method === 'GET' && p === '/api/mp/documents') {
    const kw = like(q.get('kw'));
    const where = ['d.user_id=?', "(d.doc_no LIKE ? OR IFNULL(d.title,'') LIKE ? OR c.company_name LIKE ?)"];
    const args = [user.id, kw, kw, kw];
    const docType = String(q.get('type') || '').trim();
    if (docType) { where.push('d.doc_type=?'); args.push(docType); }
    const w = 'FROM documents d JOIN customers c ON c.id=d.customer_id WHERE ' + where.join(' AND ');
    const total = get('SELECT COUNT(*) c ' + w, ...args).c;
    const page = Math.max(1, Number(q.get('page') || 1));
    const list = all('SELECT d.id, d.doc_no, d.doc_type, d.status, d.currency, d.total_amount, d.issue_date, d.created_at, d.customer_id, c.company_name ' + w + ' ORDER BY d.id DESC LIMIT ? OFFSET ?', ...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return sendJson(res, 200, { ok: true, total, page, pageSize: PAGE_SIZE, list });
  }

  // 单据详情（含明细 items）
  m = p.match(/^\/api\/mp\/documents\/(\d+)$/);
  if (req.method === 'GET' && m) {
    const d = get('SELECT d.*, c.company_name FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.id=? AND d.user_id=?', Number(m[1]), user.id);
    if (!d) return sendJson(res, 404, { ok: false, error: '单据不存在或无权访问' });
    let items = [];
    try { items = d.items ? JSON.parse(d.items) : []; } catch (e) { items = []; }
    return sendJson(res, 200, { ok: true, document: { ...d, items } });
  }

  // 退出登录
  if (req.method === 'POST' && p === '/api/mp/logout') {
    auth.destroySession(bearerToken(req));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求地址不合法' });
  }
  Promise.resolve(handle(req, res, url)).catch((e) => {
    console.error('[mp-api] 出错:', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误：' + e.message });
  });
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  小程序 API 服务已启动');
  console.log('  本机调试地址: http://127.0.0.1:' + PORT);
  console.log('  小程序端请在 miniapp/wechat/utils/config.js 中配置服务地址');
  console.log('  （与主系统共用同一数据库，数据实时一致）');
  console.log('==============================================');
});
