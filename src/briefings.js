'use strict';
// ============ B 类客户月度行业简报：素材源、AI 草稿、人工审核与发送 ============
const dns = require('dns').promises;
const net = require('net');
const Parser = require('rss-parser');
const { ProxyAgent } = require('undici');
const { get, all, run, getSetting } = require('./db');
const { nowStr, todayStr } = require('./util');
const customerTiers = require('./customerTiers');

const PERIOD = () => 'month:' + todayStr().slice(0, 7);
const LANGUAGES = {
  en: 'English', zh: '简体中文', fr: 'Français', ar: 'العربية', es: 'Español', ru: 'Русский',
};
const DEFAULT_SOURCES = [
  { name: 'WTO 国际贸易新闻', kind: 'rss', url: 'https://www.wto.org/library/rss/latest_news_e.xml', category: '国际贸易政策', keywords: 'trade policy tariff regulation market access rules' },
  { name: '美国国际贸易署 ITA', kind: 'rss', url: 'https://www.trade.gov/rss.xml', category: '国际贸易政策', keywords: 'export import regulation tariff market access trade' },
];
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

function safeText(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 1000);
}
function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] || m);
}
function stripHtml(value) {
  return decodeEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function parseDate(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? new Date(t) : null;
}
function isoDate(value) {
  const d = parseDate(value);
  return d ? d.toISOString() : '';
}
function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19));
  }
  const s = String(ip).toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:') ||
    s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.');
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw new Error('素材地址不是有效 URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('素材地址只允许 http/https');
  if (u.username || u.password) throw new Error('素材地址不能包含用户名或密码');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.lan') || host.endsWith('.home') || (!host.includes('.') && !net.isIP(host))) {
    throw new Error('不允许访问本机或局域网素材地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问内网素材地址');
    return u.toString();
  }
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.some(r => isPrivateIp(r.address))) throw new Error('素材域名解析到内网地址，已拒绝访问');
  } catch (e) {
    if (/内网地址/.test(String(e.message || ''))) throw e;
  }
  return u.toString();
}
function proxyCandidates() {
  const configured = safeText(getSetting('wa_proxy') || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '', 500);
  const out = [];
  if (/^https?:\/\//i.test(configured)) out.push(configured);
  out.push('');
  return out;
}
async function fetchViaProxy(url, proxy) {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  return fetch(url, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), dispatcher,
    headers: { 'User-Agent': 'HQ-CRM-Briefing/1.0 (+local CRM feed reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
  });
}
async function fetchText(rawUrl) {
  let current = await assertPublicUrl(rawUrl);
  let lastError = null;
  for (const proxy of proxyCandidates()) {
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const resp = await fetchViaProxy(current, proxy);
        if ([301, 302, 303, 307, 308].includes(resp.status)) {
          const loc = resp.headers.get('location');
          if (!loc) throw new Error('素材地址发生重定向但没有 Location');
          if (redirects === 3) throw new Error('素材地址重定向次数过多');
          current = await assertPublicUrl(new URL(loc, current).toString());
          continue;
        }
        if (!resp.ok) throw new Error('素材源返回 HTTP ' + resp.status);
        const length = Number(resp.headers.get('content-length') || 0);
        if (length > MAX_RESPONSE_BYTES) throw new Error('素材源内容超过 2MB 限制');
        const text = await resp.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('素材源内容超过 2MB 限制');
        return text;
      }
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('素材源读取失败');
}

function ensureDefaultSources(userId) {
  const uid = Number(userId) || 0;
  const count = get('SELECT COUNT(*) c FROM briefing_sources WHERE user_id=?', uid).c || 0;
  if (count > 0) return;
  const stamp = nowStr();
  for (const s of DEFAULT_SOURCES) {
    run(`INSERT INTO briefing_sources(user_id,name,kind,url,content,category,keywords,active,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, uid, s.name, s.kind, s.url, '', s.category, s.keywords, 1, stamp, stamp);
  }
}
function listSources(userId, activeOnly) {
  ensureDefaultSources(userId);
  return all(`SELECT * FROM briefing_sources WHERE user_id=? ${activeOnly ? 'AND active=1' : ''}
    ORDER BY active DESC, id ASC`, Number(userId) || 0);
}
function addSource(userId, body) {
  const uid = Number(userId) || 0;
  const name = safeText(body.name, 120);
  const kind = String(body.kind || 'rss') === 'manual' ? 'manual' : 'rss';
  const url = safeText(body.url, 1000);
  const content = String(body.content || '').trim().slice(0, 20000);
  const category = safeText(body.category, 120);
  const keywords = safeText(body.keywords, 500);
  if (!name) throw new Error('请输入素材源名称');
  if (kind === 'rss') {
    if (!url) throw new Error('请输入 RSS/Atom 地址');
    const existing = get('SELECT id FROM briefing_sources WHERE user_id=? AND url=?', uid, url);
    if (existing) throw new Error('该 RSS 地址已经添加');
  } else if (!content) throw new Error('请粘贴手工素材内容');
  const stamp = nowStr();
  const r = run(`INSERT INTO briefing_sources(user_id,name,kind,url,content,category,keywords,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,1,?,?)`, uid, name, kind, kind === 'rss' ? url : '', content, category, keywords, stamp, stamp);
  return Number(r.lastInsertRowid);
}
function removeSource(userId, id) {
  run('DELETE FROM briefing_sources WHERE id=? AND user_id=?', Number(id) || 0, Number(userId) || 0);
}
function toggleSource(userId, id) {
  const row = get('SELECT id,active FROM briefing_sources WHERE id=? AND user_id=?', Number(id) || 0, Number(userId) || 0);
  if (!row) throw new Error('素材源不存在');
  run('UPDATE briefing_sources SET active=?, updated_at=? WHERE id=? AND user_id=?', row.active ? 0 : 1, nowStr(), row.id, Number(userId));
}
async function articlesFromSource(source) {
  if (String(source.kind) === 'manual') {
    return [{ id: 'manual:' + source.id, title: source.name, summary: safeText(source.content, 1600), url: '',
      source: source.name, publishedAt: String(source.updated_at || source.created_at || nowStr()).slice(0, 19).replace(' ', 'T') }];
  }
  const xml = await fetchText(source.url);
  const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });
  const feed = await parser.parseString(xml);
  return (feed.items || []).slice(0, 20).map((item, index) => ({
    id: 'rss:' + source.id + ':' + (item.guid || item.id || index),
    title: safeText(item.title, 300),
    summary: safeText(stripHtml(item.contentSnippet || item.content || item.summary || item.description || ''), 1400),
    url: String(item.link || '').trim(), source: safeText(source.name || feed.title, 120),
    publishedAt: isoDate(item.isoDate || item.pubDate || item.date),
  })).filter(x => x.title);
}
function relevanceScore(article, words) {
  const haystack = (article.title + ' ' + article.summary + ' ' + article.source).toLowerCase();
  let score = 0;
  for (const word of words) if (word && haystack.includes(word)) score += word.length >= 6 ? 3 : 1;
  const ageDays = article.publishedAt ? Math.max(0, (Date.now() - Date.parse(article.publishedAt)) / 86400000) : 9999;
  if (ageDays <= 45) score += 4; else if (ageDays <= 120) score += 2; else if (ageDays > 365) score -= 4;
  return score;
}
function customerProductContext(userId, customerId) {
  try {
    return all(`SELECT product_name_en, product_name, model, MAX(quote_date) last_quote
      FROM quote_history WHERE user_id=? AND customer_id=?
      GROUP BY product_name_en, product_name, model ORDER BY last_quote DESC LIMIT 10`, userId, customerId);
  } catch (e) { return []; }
}
async function collectArticles(userId, customer) {
  const sources = listSources(userId, true);
  if (!sources.length) throw new Error('没有启用的行业简报素材源，请先添加 RSS 或手工素材');
  const products = customerProductContext(userId, customer.id);
  const contextWords = [customer.country, customer.industry, customer.company_name,
    ...products.map(p => p.product_name_en || p.product_name || p.model)].join(' ')
    .toLowerCase().split(/[\s,，;；/|()（）\-]+/).map(x => x.trim()).filter(x => x.length >= 3);
  for (const source of sources) contextWords.push(...String(source.keywords || '').toLowerCase().split(/\s+/).filter(x => x.length >= 3));
  const words = Array.from(new Set(contextWords)).slice(0, 80);
  const results = await Promise.allSettled(sources.map(async source => {
    try {
      const items = await articlesFromSource(source);
      run('UPDATE briefing_sources SET last_fetch_at=?, last_error=? WHERE id=?', nowStr(), '', source.id);
      return items;
    } catch (e) {
      run('UPDATE briefing_sources SET last_fetch_at=?, last_error=? WHERE id=?', nowStr(), safeText(e.message, 500), source.id);
      throw e;
    }
  }));
  const articles = [];
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') articles.push(...results[i].value);
    else failures.push(sources[i].name + '：' + results[i].reason.message);
  }
  const unique = new Map();
  for (const article of articles) {
    const key = (article.url || article.title).toLowerCase();
    if (!unique.has(key)) unique.set(key, article);
  }
  const ranked = Array.from(unique.values()).map(a => ({ ...a, relevance: relevanceScore(a, words) }))
    .sort((a, b) => (b.relevance - a.relevance) || String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, 10);
  if (!ranked.length) throw new Error('素材源没有返回可用文章' + (failures.length ? '；' + failures.join('；') : ''));
  return { articles: ranked, failures };
}

function parseAiJson(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 没有返回可解析的 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}
async function callDeepSeek(customer, products, articles, language) {
  const key = getSetting('ai_api_key');
  if (!key) throw new Error('未配置 DeepSeek API Key，请先到系统设置 → AI 助理填写');
  const model = getSetting('ai_model') || 'deepseek-chat';
  const languageName = LANGUAGES[language] || LANGUAGES.en;
  const productText = products.length ? products.map(p => [p.product_name_en || p.product_name, p.model].filter(Boolean).join(' / ')).join('; ') : '暂无报价产品记录';
  const articleText = articles.map((a, i) => ['[' + (i + 1) + '] ' + a.title, '来源：' + a.source,
    '日期：' + (a.publishedAt || '未知'), '摘要：' + a.summary, '链接：' + (a.url || '手工素材无链接')].join('\n')).join('\n\n');
  const system = [
    '你是严谨的 B2B 外贸行业情报编辑，为采购商客户编写月度行业简报。',
    '只能使用提供的素材和 CRM 客户/产品事实；不得补造统计数字、法规、认证、价格、库存、交期或市场结论。',
    '素材不足时明确写“本月尚无足够可靠的新数据”，并给出可执行的采购/验货/供应链检查清单，不要猜测。',
    '客户正文使用指定语言，语气专业、简洁、销售推进但不硬推销，控制在 1800-2800 字符。',
    '正文结构：1) 本月要闻速览；2) 对客户所在市场和产品类别的意义；3) 给客户的两个具体行动建议；4) 一句自然的下一步沟通。',
    '正文中用 [1][2] 标注素材编号。不要输出 Markdown 表格。',
    '另外给业务员写 2-3 条中文内部提示：哪些结论有出处、哪些需要人工复核、建议追加什么资料。',
    '只输出一个 JSON 对象，不要代码围栏：{"subject":"邮件/WhatsApp主题","content":"客户可读正文","internal_notes":"中文内部提示"}',
  ].join('\n');
  const user = ['客户：' + (customer.company_name || ''), '国家/地区：' + (customer.country || '未填写'),
    '行业：' + (customer.industry || '未填写'), '联系人：' + (customer.contact_person || '未填写'),
    '历史报价产品：' + productText, '客户备注：' + safeText(customer.notes, 800), '目标语言：' + languageName,
    '月份：' + todayStr().slice(0, 7), '', '可用素材：', articleText].join('\n');
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user.slice(0, 28000) }], temperature: 0.25, stream: false }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) {
    let msg = 'DeepSeek 返回 HTTP ' + resp.status;
    try { const j = await resp.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = parseAiJson(text);
  if (!parsed.subject || !parsed.content) throw new Error('AI 返回缺少 subject 或 content');
  return { subject: safeText(parsed.subject, 180), content: String(parsed.content || '').trim().slice(0, 3000),
    internal_notes: String(parsed.internal_notes || '').trim().slice(0, 4000) };
}
function buildSourcesSnapshot(articles) {
  return JSON.stringify(articles.map(a => ({ id: a.id, title: a.title, source: a.source, url: a.url,
    publishedAt: a.publishedAt, summary: safeText(a.summary, 500) })));
}
function addSourceFooter(content, articles) {
  const list = articles.filter(a => a.url).slice(0, 5);
  if (!list.length || /\n\s*Sources?\s*:/i.test(content)) return content;
  return content + '\n\nSources:\n' + list.map((a, i) => '[' + (i + 1) + '] ' + a.title + ' - ' + a.url).join('\n');
}
function attachTierAction(userId, customerId, period, briefingId) {
  customerTiers.ensureTierActions(userId);
  const action = get(`SELECT * FROM tier_actions WHERE user_id=? AND customer_id=? AND action_type='monthly_brief' AND period_key=?`,
    userId, customerId, period);
  if (action) run('UPDATE briefings SET tier_action_id=? WHERE id=?', action.id, briefingId);
  return action || null;
}
async function generateBriefing(userId, customerId, options) {
  const opts = options || {};
  const uid = Number(userId) || 0;
  const cid = Number(customerId) || 0;
  const language = LANGUAGES[opts.language] ? opts.language : 'en';
  const customer = get('SELECT * FROM customers WHERE id=? AND user_id=? AND COALESCE(in_pool,0)=0', cid, uid);
  if (!customer) throw new Error('客户不存在或无权操作');
  customerTiers.refreshTiers(uid, { force: false });
  customerTiers.ensureTierActions(uid);
  const current = get('SELECT * FROM customers WHERE id=?', cid);
  if (current.customer_tier !== 'B') throw new Error('只有 B 类潜力客户需要生成定制化行业简报');
  if (Number(current.do_not_contact) === 1) throw new Error('该客户已标记禁止联系');
  const period = PERIOD();
  const existing = get('SELECT * FROM briefings WHERE user_id=? AND customer_id=? AND period_key=?', uid, cid, period);
  if (existing && existing.status === 'sent') throw new Error('本月简报已经发送，不能覆盖已发送版本');
  let articles = opts.articles;
  if (!articles) articles = (await collectArticles(uid, current)).articles;
  if (!Array.isArray(articles) || !articles.length) throw new Error('没有可用于生成简报的素材');
  const products = customerProductContext(uid, cid);
  const generated = opts.generate ? await opts.generate({ customer: current, products, articles, language })
    : await callDeepSeek(current, products, articles, language);
  if (!generated || !generated.subject || !generated.content) throw new Error('简报生成结果不完整');
  let content = String(generated.content).trim().slice(0, 3000);
  content = addSourceFooter(content, articles).slice(0, 3900);
  const stamp = nowStr();
  let id;
  if (existing) {
    run(`UPDATE briefings SET title=?,subject=?,language=?,status='draft',content=?,content_zh=?,sources=?,article_count=?,
      error='',generated_at=?,updated_at=? WHERE id=? AND user_id=?`, current.company_name + ' · ' + period.slice(6),
      safeText(generated.subject, 180), language, content, String(generated.internal_notes || '').slice(0, 4000),
      buildSourcesSnapshot(articles), articles.length, stamp, stamp, existing.id, uid);
    id = existing.id;
  } else {
    const r = run(`INSERT INTO briefings(user_id,customer_id,period_key,title,subject,language,status,content,content_zh,
      sources,article_count,channel,generated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)`,
      uid, cid, period, current.company_name + ' · ' + period.slice(6), safeText(generated.subject, 180), language,
      content, String(generated.internal_notes || '').slice(0, 4000), buildSourcesSnapshot(articles), articles.length,
      '', stamp, stamp, stamp);
    id = Number(r.lastInsertRowid);
  }
  attachTierAction(uid, cid, period, id);
  return get('SELECT * FROM briefings WHERE id=? AND user_id=?', id, uid);
}
function getBriefing(userId, id) {
  return get(`SELECT b.*, c.company_name,c.country,c.industry,c.email,c.whatsapp,c.phone,c.contact_person,c.contact_phone,
      c.customer_tier,c.do_not_contact FROM briefings b JOIN customers c ON c.id=b.customer_id
    WHERE b.id=? AND b.user_id=? AND c.user_id=?`, Number(id) || 0, Number(userId) || 0, Number(userId) || 0);
}
function saveBriefing(userId, id, body) {
  const b = getBriefing(userId, id);
  if (!b) throw new Error('简报不存在或无权操作');
  if (b.status === 'sent') throw new Error('已发送的简报不能修改');
  const subject = safeText(body.subject, 180);
  const content = String(body.content || '').trim().slice(0, 3900);
  const notes = String(body.content_zh || '').trim().slice(0, 4000);
  if (!subject) throw new Error('请输入简报主题');
  if (!content) throw new Error('请输入简报正文');
  run('UPDATE briefings SET subject=?,content=?,content_zh=?,updated_at=? WHERE id=? AND user_id=?', subject, content, notes, nowStr(), b.id, Number(userId));
  return getBriefing(userId, id);
}

function whatsappDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}
async function sendBriefing(userId, id, options) {
  const opts = options || {};
  const uid = Number(userId) || 0;
  const b = getBriefing(uid, id);
  if (!b) throw new Error('简报不存在或无权操作');
  if (b.status === 'sent') throw new Error('该简报已经发送，请勿重复发送');
  if (b.customer_tier !== 'B') throw new Error('客户已不是 B 类，请重新确认分层后再发送');
  if (Number(b.do_not_contact) === 1) throw new Error('该客户已标记禁止联系');
  if (String(b.content || '').length > 3900) throw new Error('简报正文过长，请压缩到 3900 字以内再发送');
  const account = get('SELECT * FROM wa_accounts WHERE user_id=?', uid);
  if (!account || String(account.status) !== 'online') throw new Error('请先连接 WhatsApp，再发送行业简报');
  const primary = get(`SELECT COALESCE(NULLIF(mobile,''),NULLIF(phone,'')) AS phone FROM contacts WHERE customer_id=?
    ORDER BY COALESCE(is_primary,0) DESC,id ASC LIMIT 1`, b.customer_id);
  const boundChat = get(`SELECT * FROM wa_chats WHERE account_id=? AND customer_id=? AND COALESCE(is_group,0)=0
    ORDER BY COALESCE(last_msg_at,updated_at) DESC,id DESC LIMIT 1`, account.id, b.customer_id);
  const digits = whatsappDigits(b.whatsapp || b.phone || b.contact_phone || (primary && primary.phone));
  let jid = boundChat && boundChat.jid ? boundChat.jid : '';
  if (!jid && digits.length >= 7 && digits.length <= 15) jid = digits + '@s.whatsapp.net';
  if (!jid) throw new Error('该客户没有有效 WhatsApp 号码，请先补充客户 WhatsApp');
  const result = opts.sendText ? await opts.sendText(uid, jid, b.content) : await require('./wa').sendText(uid, jid, b.content);
  if (!result || !result.ok) throw new Error((result && result.error) || 'WhatsApp 发送失败');
  const stamp = nowStr();
  run(`UPDATE briefings SET status='sent',sent_at=?,channel='whatsapp',error='',updated_at=? WHERE id=? AND user_id=?`, stamp, stamp, b.id, uid);
  let action = null;
  if (b.tier_action_id) action = get('SELECT * FROM tier_actions WHERE id=? AND user_id=?', b.tier_action_id, uid);
  if (!action) action = attachTierAction(uid, b.customer_id, b.period_key, b.id);
  if (action) {
    run(`UPDATE tier_actions SET status='completed',completed_at=COALESCE(completed_at,?) WHERE id=? AND user_id=?`, stamp, action.id, uid);
    if (action.activity_id) {
      const a = get('SELECT * FROM activities WHERE id=? AND user_id=?', action.activity_id, uid);
      if (a) {
        const marker = '【B类行业简报 · ' + b.period_key + '】';
        const oldContent = String(a.content || '');
        const extra = marker + '\n' + b.subject + '\n简报记录：/briefings/' + b.id;
        if (!oldContent.includes(marker)) {
          run(`UPDATE activities SET content=?,archived=1,completed_at=?,outcome=? WHERE id=? AND user_id=?`,
            oldContent + (oldContent ? '\n\n' : '') + extra, stamp, '行业简报已通过 WhatsApp 发送', a.id, uid);
        } else {
          run('UPDATE activities SET archived=1,completed_at=?,outcome=? WHERE id=? AND user_id=?', stamp, '行业简报已通过 WhatsApp 发送', a.id, uid);
        }
      }
    }
  }
  if (boundChat && !boundChat.customer_id) run('UPDATE wa_chats SET customer_id=?,updated_at=? WHERE id=?', b.customer_id, stamp, boundChat.id);
  return getBriefing(uid, id);
}
function briefingDashboard(userId, filter) {
  const uid = Number(userId) || 0;
  customerTiers.refreshTiers(uid, { force: false });
  customerTiers.ensureTierActions(uid);
  ensureDefaultSources(uid);
  const period = PERIOD();
  const customers = all(`SELECT id,company_name,name_en,country,industry,contact_person,email,whatsapp,phone,customer_tier,
      tier_score,tier_reason FROM customers WHERE user_id=? AND COALESCE(in_pool,0)=0 AND customer_tier='B'
    ORDER BY tier_score DESC, updated_at DESC`, uid);
  const map = new Map(all('SELECT * FROM briefings WHERE user_id=? AND period_key=? ORDER BY id DESC', uid, period).map(b => [Number(b.customer_id), b]));
  const rows = customers.map(c => ({ customer: c, briefing: map.get(Number(c.id)) || null }));
  const counts = { customers: rows.length, generated: rows.filter(x => x.briefing).length,
    sent: rows.filter(x => x.briefing && x.briefing.status === 'sent').length };
  const status = String(filter || 'all');
  const filtered = status === 'pending' ? rows.filter(x => !x.briefing)
    : status === 'draft' ? rows.filter(x => x.briefing && x.briefing.status === 'draft')
      : status === 'sent' ? rows.filter(x => x.briefing && x.briefing.status === 'sent') : rows;
  return { period, counts, rows: filtered, sources: listSources(uid, false) };
}

module.exports = {
  PERIOD, LANGUAGES, DEFAULT_SOURCES, assertPublicUrl, stripHtml, parseAiJson, isPrivateIp,
  ensureDefaultSources, listSources, addSource, removeSource, toggleSource, collectArticles,
  generateBriefing, getBriefing, saveBriefing, sendBriefing, briefingDashboard,
};

