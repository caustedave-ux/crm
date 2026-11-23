'use strict';
/**
 * 轻量网络层：基于 Node 内置 fetch，带超时 / 重试 / 限速 / UA 轮换 / HTML 工具。
 * 不引入额外依赖，保证独立目录零安装可运行。
 */
const { getSetting } = require('./db');

// undici ProxyAgent（复用主系统依赖，独立目录零安装）
let ProxyAgent = null;
const proxyCache = new Map();
try {
  const undici = require(require('node:path').join(__dirname, '..', '..', 'node_modules', 'undici'));
  ProxyAgent = undici.ProxyAgent || null;
} catch {}

/** 根据目标 URL 与当前设置返回 dispatcher（是否走代理） */
function dispatcherFor(targetUrl) {
  const proxy = getSetting('proxy_url', '').trim();
  if (!proxy || !ProxyAgent) return undefined;
  // 本地地址不走代理
  try {
    const u = new URL(targetUrl);
    if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return undefined;
  } catch {}
  if (!proxyCache.has(proxy)) proxyCache.set(proxy, new ProxyAgent(proxy));
  return proxyCache.get(proxy);
}

/**
 * 代理可用状态（M3）：ProxyAgent 为 null 时，配了代理地址也会静默直连，
 * 用户机器上 Google 直连不可达会表现为“连接 Google 失败”。
 * - proxyUrl：设置里的代理地址（可能为空）
 * - proxyAgentLoaded：undici 是否加载成功（工作区/ZIP 解压后常常没有 node_modules）
 * - willUseProxy：真正会走代理（地址已配且 undici 已加载）
 * - warning：为空表示正常，否则是给启动日志 / 设置页 / 地图页看的中文提示
 */
function proxyStatus() {
  const proxyUrl = String(getSetting('proxy_url', '') || '').trim();
  const proxyAgentLoaded = !!ProxyAgent;
  const willUseProxy = !!proxyUrl && proxyAgentLoaded;
  let warning = '';
  if (proxyUrl && !proxyAgentLoaded) {
    warning = '代理地址已配（' + proxyUrl + '），但 undici 未加载（缺少 node_modules），请求将直连 Google；直连不可达时采集会失败。';
  } else if (!proxyUrl) {
    warning = '未配置代理地址，请求将直连 Google；本机直连不可达时采集会失败，可在设置里填代理地址。';
  }
  return { proxyUrl, proxyAgentLoaded, willUseProxy, warning };
}

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
let uaIdx = 0;
let lastRequestAt = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function throttle() {
  const delay = parseInt(getSetting('request_delay_ms', '1200'), 10) || 1200;
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < delay) await sleep(delay - elapsed);
  lastRequestAt = Date.now();
}

/**
 * 抓取 URL，返回 { ok, status, text, url, error }
 */
async function fetchUrl(url, opts = {}) {
  const timeout = parseInt(getSetting('request_timeout_ms', '15000'), 10) || 15000;
  const retries = opts.retries ?? 1;
  const needThrottle = opts.throttle !== false;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (needThrottle) await throttle();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        dispatcher: opts.dispatcher !== undefined ? opts.dispatcher : dispatcherFor(url),
        headers: {
          'User-Agent': opts.ua || UAS[uaIdx++ % UAS.length],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          ...(opts.headers || {}),
        },
      });
      clearTimeout(timer);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, url: res.url, error: null };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    }
  }
  return { ok: false, status: 0, text: '', url, error: String(lastErr && lastErr.message || lastErr) };
}

// ── HTML 小工具（无依赖） ──
function decodeEntities(s) {
  if (!s) return '';
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '…', middot: '·', bull: '•', para: '¶', sect: '§', eacute: 'é', ouml: 'ö', auml: 'ä', uuml: 'ü', szlig: 'ß' };
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, k) => map[k.toLowerCase()] !== undefined ? map[k.toLowerCase()] : m);
}
function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}
function metaContent(html, key) {
  // 支持 <meta name="description" content="..."> 和 property="og:description"
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'ig');
  let m;
  while ((m = re.exec(html))) {
    const c = attr(m[0], 'content');
    if (c) return c;
  }
  return '';
}

module.exports = { fetchUrl, sleep, stripTags, decodeEntities, attr, metaContent, dispatcherFor, proxyStatus };
