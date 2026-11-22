'use strict';
// ============ 共用主 CRM 登录态 ============
// 浏览器 Cookie 不区分端口：主系统在 5000 端口设置的 crm_sid，
// 访问获客系统 5101 端口时会自动带上。这里以只读方式打开主库校验会话，
// 不写主系统任何数据，也不改动主系统代码。
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAIN_DB = process.env.CRM_DB_PATH || path.join(__dirname, '..', '..', 'data', 'crm.db');
let _db = null;
function mainDb() {
  if (!_db) _db = new DatabaseSync(MAIN_DB, { readOnly: true });
  return _db;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// 返回已登录用户（含 display_name / role），未登录或失效返回 null。
function currentUser(req) {
  const token = parseCookies(req.headers && req.headers.cookie).crm_sid;
  if (!token) return null;
  try {
    const row = mainDb().prepare('SELECT u.id,u.username,u.display_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>=? AND u.active=1').get(token, nowStr());
    return row || null;
  } catch (e) {
    console.error('[获客鉴权] 校验主系统会话失败：', e.message);
    return null;
  }
}

// 主系统登录页地址：与获客同主机、端口取主系统端口（默认 5000）。
function loginUrl(req) {
  const host = String((req && req.headers && req.headers.host) || '127.0.0.1:5101');
  const ipv6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  const hostname = ipv6 ? '[' + ipv6[1] + ']' : (host.split(':')[0] || '127.0.0.1');
  const mainPort = parseInt(process.env.CRM_PORT || '5000', 10);
  return 'http://' + hostname + ':' + mainPort + '/login?next=/leadgen';
}

module.exports = { currentUser, loginUrl, parseCookies, MAIN_DB };
