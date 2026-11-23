'use strict';
/** 极简 HTTP 框架（零依赖，仿主系统自研风格）——获客工作台版：静态挂载为 /static/ */
const http = require('node:http');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

// 请求级异步上下文：让视图层（layout）无需逐层透传即可读取当前登录用户。
const ALS = new AsyncLocalStorage();
function getRequestContext() { return ALS.getStore(); }

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
}

function parseBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      size += c.length;
      // 超过 2MB 不再收内容（但继续把流读完），由调用方返回 413，而不是
      // 静默截断成空对象让业务以为收到了一份空表单。
      if (size > 2e6) { tooLarge = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ __tooLarge: true });
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { return resolve(JSON.parse(raw)); } catch { return resolve({}); }
      }
      const out = {};
      for (const pair of raw.split('&')) {
        if (!pair) continue;
        const [k, v] = pair.split('=');
        try { out[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' ')); } catch {}
      }
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });
}

function createApp(router, opts = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const pathname = u.pathname;
      const query = Object.fromEntries(u.searchParams);
      const ctx = { req, res, url: u, path: pathname, query, params: {}, body: {} };

      // 静态资源（获客工作台：/static/ → suite/static/）
      if (pathname.startsWith('/static/')) {
        const rel = pathname.slice('/static/'.length);
        const file = path.join(__dirname, '..', 'static', rel);
        if (!file.startsWith(path.join(__dirname, '..', 'static'))) { res.writeHead(403).end(); return; }
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file);
          const types = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
          res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
          fs.createReadStream(file).pipe(res);
          return;
        }
        res.writeHead(404).end('not found');
        return;
      }
      // 主系统静态资源代理（复用 Bootstrap / 图标 / 字体）
      if (pathname.startsWith('/vendor/')) {
        const mainStatic = path.join(__dirname, '..', '..', 'static');
        const file = path.join(mainStatic, pathname.slice(1));
        if (file.startsWith(mainStatic) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file);
          const types = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };
          res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
          fs.createReadStream(file).pipe(res);
          return;
        }
        res.writeHead(404).end('not found');
        return;
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        ctx.body = await parseBody(req);
        // 请求体超过 2MB：返回 413，不让业务拿到一份被静默截断的空对象。
        // 注意：res.json 在下面才定义，这里直接用 writeHead。
        if (ctx.body && ctx.body.__tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: '请求体过大（超过 2MB），请分批提交。' }));
          return;
        }
      }

      res.json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      res.send = (html, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      };
      res.redirect = (loc, code = 302) => { res.writeHead(code, { Location: loc }); res.end(); };

      // before hook（可选鉴权）
      if (opts.before && !(await opts.before(ctx))) return;

      const route = router.routes.find(r => r.method === req.method && r.re.test(pathname));
      if (!route) { res.send('<h1>404</h1>', 404); return; }
      const m = pathname.match(route.re);
      route.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      await ALS.run(ctx, () => route.handler(ctx));
    } catch (e) {
      console.error('[lead-suite] route error:', e);
      if (!res.headersSent) {
        // 500 只给通用文案，不把堆栈打进响应（堆栈只写服务端日志）。
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>500</h1><p>服务器内部错误，请稍后再试。</p>');
      }
    }
  });
  return { server, Router };
}

module.exports = { Router, createApp, getRequestContext };
