'use strict';
// ============ 极简 Web 框架（零依赖）：路由 / 静态文件 / 请求解析 ============
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { parseCookies } = require('./auth');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    let escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  del(p, h) { this.add('DELETE', p, h); }
}

function createApp(options) {
  options = options || {};
  const router = new Router();
  const flashStore = new Map(); // sessionToken -> [{category,msg}]
  const appObj = {};

  function setFlash(token, category, msg) {
    if (!token) return;
    const arr = flashStore.get(token) || [];
    arr.push({ category, msg });
    flashStore.set(token, arr);
  }
  function takeFlash(token) {
    if (!token) return [];
    const arr = flashStore.get(token) || [];
    flashStore.delete(token);
    return arr;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method.toUpperCase();
    const parsedBody = await readBody(req);
    const body = parsedBody.body;
    const files = parsedBody.files || {};
    const rawBody = parsedBody.rawBody || '';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // 便捷方法
    const noStoreHeaders = {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    };
    res.send = (html, type) => {
      res.writeHead(200, Object.assign({ 'Content-Type': type || 'text/html; charset=utf-8' }, noStoreHeaders));
      res.end(html);
    };
    res.json = (code, obj) => {
      const payload = JSON.stringify(obj);
      res.writeHead(code || 200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, noStoreHeaders));
      res.end(payload);
    };
    res.redirect = (loc) => {
      res.writeHead(302, { Location: loc });
      res.end();
    };
    res.setCookie = (name, value, opts) => {
      let c = name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax';
      if (opts && opts.maxAge) c += '; Max-Age=' + opts.maxAge;
      res.setHeader('Set-Cookie', c);
    };
    res.clearCookie = (name) => {
      res.setHeader('Set-Cookie', name + '=; Path=/; HttpOnly; Max-Age=0');
    };

    const ctx = { req, res, url, method, body, files, rawBody, router, flash: () => takeFlash(parseCookies(req.headers.cookie || '').crm_sid) };
    ctx.app = appObj;
    if (options.before) {
      const allow = await options.before(ctx);
      if (allow === false) return;
    }

    // 静态资源
    if (method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/static/') || url.pathname.startsWith('/uploads/'))) {
      if (url.pathname === '/') return serveIndex(ctx);
      return serveStatic(ctx);
    }

    // 路由匹配
    for (const r of router.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      ctx.params = params;
      ctx.query = Object.fromEntries(url.searchParams);
      try {
        await r.handler(ctx);
      } catch (e) {
        console.error('路由错误', url.pathname, e);
        if (!res.headersSent) res.json(500, { error: '服务器内部错误：' + e.message });
        else res.end();
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 页面不存在');
  });

  function serveIndex(ctx) {
    ctx.res.redirect('/dashboard');
  }

  function serveStatic(ctx) {
    const root = path.join(__dirname, '..');
    let rel = ctx.url.pathname;
    let disk;
    if (rel.startsWith('/uploads/')) {
      disk = path.join(root, 'uploads', rel.slice('/uploads/'.length).replace(/\\/g, '/'));
    } else {
      disk = path.join(root, 'static', rel.slice('/static/'.length).replace(/\\/g, '/'));
    }
    const resolved = path.resolve(disk);
    if (!resolved.startsWith(path.resolve(root))) return ctx.res.writeHead(403).end();
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return ctx.res.writeHead(404).end();
    const ext = path.extname(resolved).toLowerCase();
    const size = fs.statSync(resolved).size;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes',
    };
    const range = String(ctx.req.headers.range || '');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) {
        ctx.res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        return ctx.res.end();
      }
      let start = m[1] ? Number(m[1]) : size - Number(m[2] || 0);
      let end = m[2] ? Number(m[2]) : size - 1;
      if (!m[1] && m[2]) {
        const suffix = Number(m[2]);
        start = Math.max(size - suffix, 0);
        end = size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
        ctx.res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        return ctx.res.end();
      }
      end = Math.min(end, size - 1);
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      headers['Content-Length'] = end - start + 1;
      ctx.res.writeHead(206, headers);
      return fs.createReadStream(resolved, { start, end }).pipe(ctx.res);
    }
    headers['Content-Length'] = size;
    ctx.res.writeHead(200, headers);
    fs.createReadStream(resolved).pipe(ctx.res);
  }

  appObj.server = server;
  appObj.router = router;
  appObj.setFlash = setFlash;
  return appObj;
}

function parseMultipart(buf, boundary) {
  const body = {};
  const files = {};
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next < 0) break;
    const part = buf.subarray(pos + delim.length + 2, next);
    const sepIdx = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sepIdx < 0) break;
    const head = part.subarray(0, sepIdx).toString('utf8');
    const data = part.subarray(sepIdx + 4);
    const dis = head.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (dis) {
      const name = dis[1];
      if (dis[2] !== undefined) {
        const ct = head.match(/content-type:\s*([^\r\n]+)/i);
        let buf2 = data;
        if (buf2.length && buf2[buf2.length - 1] === 10) buf2 = buf2.subarray(0, buf2.length - 1);
        if (buf2.length && buf2[buf2.length - 1] === 13) buf2 = buf2.subarray(0, buf2.length - 1);
        // 直接引用请求缓冲区，避免 20MB 级附件在解析时再复制一份。
        const f = { filename: dis[2], contentType: ct ? ct[1].trim() : '', data: buf2 };
        // 同名字段传多个文件时收成数组（批量上传用），单文件时保持对象，向后兼容
        if (files[name] === undefined) files[name] = f;
        else if (Array.isArray(files[name])) files[name].push(f);
        else files[name] = [files[name], f];
      } else {
        const v = data.toString('utf8');
        if (body[name] === undefined) body[name] = v;
        else if (Array.isArray(body[name])) body[name].push(v);
        else body[name] = [body[name], v];
      }
    }
    pos = next;
  }
  return { body, files };
}

function readBody(req) {
  return new Promise((resolve) => {
    const ct = req.headers['content-type'] || '';
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({ body: {}, files: {}, rawBody: '' });
      try {
        if (ct.includes('application/json')) {
          const raw = buf.toString('utf8');
          try {
            return resolve({ body: JSON.parse(raw), files: {}, rawBody: raw });
          } catch (e) {
            console.error('解析 JSON 请求体失败', e.message);
            return resolve({ body: {}, files: {}, rawBody: raw });
          }
        }
        if (ct.includes('application/x-www-form-urlencoded')) {
          const sp = new URLSearchParams(buf.toString());
          const o = {};
          // 同名字段重复出现时收成数组（如分票明细的 customer_id[]）
          for (const [k, v] of sp) {
            if (o[k] === undefined) o[k] = v;
            else if (Array.isArray(o[k])) o[k].push(v);
            else o[k] = [o[k], v];
          }
          return resolve({ body: o, files: {} });
        }
        const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (ct.includes('multipart/form-data') && bm) {
          return resolve(parseMultipart(buf, (bm[1] || bm[2]).trim()));
        }
        resolve({ body: { raw: buf.toString() }, files: {} });
      } catch (e) {
        console.error('解析请求体失败', e);
        resolve({ body: {}, files: {} });
      }
    });
    req.on('error', () => resolve({ body: {}, files: {} }));
  });
}

module.exports = { createApp, Router };





