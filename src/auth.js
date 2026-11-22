'use strict';
// ============ 登录 / 会话鉴权 ============
const crypto = require('crypto');
const { run, get, all } = require('./db');
const { nowStr, randomToken } = require('./util');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return test.length === expect.length && crypto.timingSafeEqual(test, expect);
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

function findUserBySession(token) {
  if (!token) return null;
  const row = get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>=? AND u.active=1', token, nowStr());
  return row || null;
}

function createSession(userId) {
  const token = randomToken(32);
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000);
  const expStr = exp.getFullYear() + '-' + String(exp.getMonth() + 1).padStart(2, '0') + '-' + String(exp.getDate()).padStart(2, '0') + ' 23:59:59';
  run('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)', token, userId, expStr, nowStr());
  return token;
}

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token=?', token);
}

function authUser(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const user = findUserBySession(cookies.crm_sid);
  if (user) {
    req.user = user;
    req.sessionToken = cookies.crm_sid;
  }
  return !!user;
}

function requireAuth(req, res, next) {
  if (authUser(req, res)) return next();
  if (req.method === 'GET') {
    res.redirect('/login?next=' + encodeURIComponent(req.path));
  } else {
    res.json(401, { error: '未登录或登录已过期' });
  }
}
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.json(403, { error: '无权限，仅管理员可操作' });
}

module.exports = { hashPassword, verifyPassword, parseCookies, authUser, createSession, destroySession, findUserBySession, requireAuth, requireAdmin };
