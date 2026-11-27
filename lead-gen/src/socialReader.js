'use strict';
/**
 * 社媒直接读取（增强通道）
 *
 * 背景：本环境社媒官网直连受限（FB 400 / LinkedIn 403 / Ins 登录墙），
 * 但通过 r.jina.ai 文本阅读器代理（走本地代理 7897）可读到 FB / LinkedIn
 * 公开主页的 Markdown 文本，含行业、公司规模、粉丝数、地址、联系方式等硬指标。
 *
 * 流程：定位社媒主页 URL → r.jina.ai 转文本 → 正则解析字段 → 返回统一 evidence[]
 */
const { fetchUrl, stripTags } = require('./net');
const norm = require('./normalize');
const { getSetting } = require('./db');
const path = require('node:path');

// 阅读器直连用带代理的 fetch（不受全局节流影响，避免连续请求返回精简缓存）
let jinaAgent = null, jinaProxy = null;
function getJinaDispatcher() {
  const proxy = getSetting('proxy_url', '').trim();
  if (!proxy) return undefined;
  try {
    const undici = require(path.join(__dirname, '..', '..', 'node_modules', 'undici'));
    if (proxy !== jinaProxy) { jinaProxy = proxy; jinaAgent = new undici.ProxyAgent(proxy); }
    return jinaAgent;
  } catch { return undefined; }
}

const SOCIAL_URL_RE = {
  linkedin: /(?:https?:)?\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^\s/?#'"<>]+)/i,
  facebook: /(?:https?:)?\/\/(?:[a-z]{2,3}\.)?facebook\.com\/([^\s/?#'"<>]+)/i,
  instagram: /(?:https?:)?\/\/(?:[a-z]{2,3}\.)?instagram\.com\/([^\s/?#'"<>]+)/i,
};

/** 从已有社媒 URL（官网外链）中提取各平台主页链接 */
function pickSocialUrls(evidence, companyName) {
  const urls = { linkedin: '', facebook: '', instagram: '' };
  const nameCore = norm.normalizeCompanyName(companyName || '');
  for (const ev of evidence || []) {
    if (ev.field !== 'social' || !ev.url) continue;
    for (const [platform, re] of Object.entries(SOCIAL_URL_RE)) {
      const m = ev.url.match(re);
      if (!m) continue;
      // slug 只取 ASCII 段，遇到 &、?、中文等立即截断
      const slug = (m[1].split(/[&?#\u4e00-\u9fff]/)[0] || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/\/$/, '');
      if (!slug || urls[platform]) continue;
      const slugCore = norm.normalizeCompanyName(slug);
      // 外链 slug 与公司名至少有 4 个字符重合才采纳（避免地区页/子品牌页误导）
      const related = !nameCore || slugCore.includes(nameCore.slice(0, 6)) || nameCore.includes(slugCore.slice(0, 6));
      if (!related) continue;
      urls[platform] = platform === 'linkedin'
        ? `https://www.linkedin.com/company/${slug}`
        : `https://www.${platform}.com/${slug}/`;
    }
  }
  return urls;
}

/** 用 r.jina.ai 读取 URL 的干净文本 */
async function readViaJina(url) {
  const base = getSetting('jina_base', 'https://r.jina.ai/').trim() || 'https://r.jina.ai/';
  const target = base.replace(/\/$/, '') + '/' + url;
  let text = '', lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(target, {
        dispatcher: getJinaDispatcher(),
        signal: AbortSignal.timeout(30000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/plain,text/markdown,*/*' },
      });
      text = await res.text();
      if (!res.ok) { lastErr = `HTTP ${res.status}`; }
      else break;
    } catch (e) { lastErr = e.message; }
    if (attempt === 0) await new Promise(r => setTimeout(r, 800));
  }
  if (!text) return { ok: false, error: lastErr };
  if (/^Title:\s*Instagram\s*$/m.test(text) && /accounts\/login/i.test(text)) return { ok: false, error: 'instagram login wall' };
  return { ok: true, text };
}

/** K/M 缩写转数字 */
function parseCount(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KkMmBb])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const u = (m[2] || '').toLowerCase();
  if (u === 'k') n *= 1e3;
  else if (u === 'm') n *= 1e6;
  else if (u === 'b') n *= 1e9;
  return Math.round(n);
}

/** 解析 LinkedIn 公司主页文本 */
function parseLinkedIn(text, sourceUrl) {
  const facts = [];
  const push = (field, raw, value, conf, snippet) => {
    if (!raw) return;
    facts.push({ source: 'linkedin_page', field, raw_value: raw, value: value || '', url: sourceUrl, snippet: snippet || raw, confidence: conf });
  };
  // 行业： "Industry  Wholesale Building Materials"
  let m = text.match(/Industry\s{1,}\s*([^\n]+)/i);
  if (m) { const ind = stripTags(m[1]).trim(); push('industry', ind, '', 0.85, `LinkedIn Industry: ${ind}`); }
  // 规模： "Company size  10,001+ employees" 或 "51-200 employees"
  m = text.match(/Company size\s{1,}\s*([^\n]+)/i);
  if (m) {
    const raw = stripTags(m[1]).trim();
    const emp = norm.parseEmployees(raw.replace(/10,001\+/i, '10001+'));
    push('employees', raw, emp.bucket || '', 0.9, `LinkedIn Company size: ${raw}`);
  }
  // 总部
  m = text.match(/Headquarters\s{1,}\s*([^\n]+)/i);
  if (m) { const hq = stripTags(m[1]).trim(); push('country', hq, norm.normalizeCountry(hq), 0.75, `LinkedIn HQ: ${hq}`); }
  // 粉丝数
  m = text.match(/([\d,.]+[KkMm]?)\s+followers/i);
  if (m) { const n = parseCount(m[1]); push('followers', `${n} followers`, `LinkedIn ${n}`, 0.8, `LinkedIn ${n} followers`); }
  // 员工总数："View all 9,647 employees"
  m = text.match(/View all\s+([\d,]+)\s+employees/i);
  if (m) { const n = parseCount(m[1]); push('employees', `${n} employees`, norm.bucketOf(n), 0.85, `LinkedIn ${n} employees on platform`); }
  // 成立年份："Founded  1908"
  m = text.match(/Founded\s{1,}\s*((?:19|20)\d{2})/i);
  if (m) push('founded', m[1], m[1], 0.8, `LinkedIn Founded: ${m[1]}`);
  // 简介：## 标题下的段落（取 ### 后的第一行有意义文本）
  m = text.match(/##\s+[^\n]+\n(?:.{0,200}?\n){0,4}?([A-Z][^\n]{40,300})/);
  if (m) push('description', stripTags(m[1]).trim(), '', 0.6, stripTags(m[1]).trim().slice(0, 300));
  return facts;
}

/** 解析 Facebook 主页文本 */
function parseFacebook(text, sourceUrl) {
  const facts = [];
  const push = (field, raw, value, conf, snippet) => {
    if (!raw) return;
    facts.push({ source: 'facebook_page', field, raw_value: raw, value: value || '', url: sourceUrl, snippet: snippet || raw, confidence: conf });
  };
  // 粉丝数：**3.5K** followers
  let m = text.match(/\*\*([\d.,]+[KkMm]?)\*\*\s+followers/i) || text.match(/([\d.,]+[KkMm]?)\s+followers/i);
  if (m) { const n = parseCount(m[1]); push('followers', `${n} followers`, `Facebook ${n}`, 0.8, `Facebook ${n} followers`); }
  // 类别：**Page** · Industrial Company / Categories\nIndustrial Company
  m = text.match(/\*\*Page\*\*\s*[·|]\s*([^\n]+)/i) || text.match(/##\s*Categories\s*\n\s*([^\n]+)/i);
  if (m) {
    const cat = stripTags(m[1]).trim();
    const ind = norm.classifyIndustry(cat);
    push('industry', cat, ind ? ind.sub : '', 0.8, `Facebook category: ${cat}`);
  }
  // 简介：## Intro 下的第一段 / "We make access in life smart and secure"
  m = text.match(/##\s*Intro\s*\n\s*([^\n]{10,300})/i);
  if (m) {
    const intro = stripTags(m[1]).trim();
    push('description', intro, '', 0.7, `Facebook Intro: ${intro}`);
    const ind = norm.classifyIndustry(intro);
    if (ind) push('industry', intro, ind.sub, 0.65, `Facebook intro matching: ${ind.sub}`);
  }
  // 地址：优先取 "xxx\nAddress" 结构（FB about 页格式），排除导航词
  const navWords = /^(posts?|about|reels?|photos?|more|intro|videos?|see more|log in|sign up)$/i;
  m = text.match(/([^\n]{6,90},\s*[A-Za-z][^\n]{0,40}\d{0,6})\s*\n\s*Address\b/i);
  if (!m) m = text.match(/^([A-Z][\w\s.,-]{10,80},\s*[A-Za-z][\w\s.,-]{2,30}\s*\d{0,6})$/im);
  if (m) {
    const addr = m[1].trim();
    if (!navWords.test(addr) && !/^https?:/i.test(addr)) push('country', addr, norm.normalizeCountry(addr), 0.7, `Facebook address: ${addr}`);
  }
  // 电话 / 邮箱
  m = text.match(/(?:\+?[\d][\d\s()-]{7,20})\s*(?:Mobile|Phone|Tel)/i);
  if (m) push('phone', m[0].trim(), '', 0.6, `Facebook phone: ${m[0].trim()}`);
  m = text.match(/([\w.+-]+@[\w.-]+\.[a-z]{2,})/i);
  if (m) push('email', m[1], m[1], 0.6, `Facebook email: ${m[1]}`);
  return facts;
}

/** 解析 Instagram 文本（通常登录墙，尽力而为） */
function parseInstagram(text, sourceUrl) {
  const facts = [];
  const m = text.match(/([\d.,]+[KkMm]?)\s+followers/i);
  if (m) { const n = parseCount(m[1]); facts.push({ source: 'instagram_page', field: 'followers', raw_value: `${n} followers`, value: String(n), url: sourceUrl, snippet: `Instagram ${n} followers`, confidence: 0.8 }); }
  return facts;
}

/**
 * 对单条线索读取社媒主页
 * @param lead 线索对象
 * @param priorEvidence 已采集到的证据（用于提取官网外链里的社媒 URL）
 * @param opts { platforms: ['linkedin','facebook','instagram'] }
 */
async function readSocial(lead, priorEvidence = [], opts = {}) {
  if (getSetting('jina_reader', '1') !== '1') return { evidence: [], log: ['jina_reader disabled'] };
  const urls = pickSocialUrls(priorEvidence, lead.company_name);
  // 公司名推导的 slug 优先（总部主页），仅对无空格的英文名稳妥
  const nameSlug = String(lead.company_name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  if (nameSlug) {
    urls.linkedin = `https://www.linkedin.com/company/${nameSlug}`;
    urls.facebook = `https://www.facebook.com/${nameSlug}/`;
    urls.instagram = urls.instagram || `https://www.instagram.com/${nameSlug}/`;
  }

  const wanted = opts.platforms || ['linkedin', 'facebook', 'instagram'];
  const evidence = [];
  const log = [];
  for (const platform of wanted) {
    const url = urls[platform];
    if (!url) continue;
    try {
      let r = await readViaJina(url);
      if (!r.ok) { log.push(`${platform}: ${r.error}`); continue; }
      let facts = [];
      if (platform === 'linkedin') facts = parseLinkedIn(r.text, url);
      else if (platform === 'facebook') facts = parseFacebook(r.text, url);
      else if (platform === 'instagram') facts = parseInstagram(r.text, url);
      // 关键字段缺失时重试一次（r.jina.ai 偶发返回精简缓存）
      if (platform === 'linkedin' && facts.length < 3) {
        await new Promise(res => setTimeout(res, 1200));
        const r2 = await readViaJina(url + '?retry=1');
        if (r2.ok) {
          const f2 = parseLinkedIn(r2.text, url);
          if (f2.length > facts.length) { facts = f2; log.push(`${platform}: retried with more facts`); }
        }
      }
      evidence.push(...facts);
      log.push(`${platform}: ${facts.length} facts`);
    } catch (e) { log.push(`${platform}: exception ${e.message}`); }
  }
  return { evidence, log };
}

module.exports = { readSocial, parseLinkedIn, parseFacebook, parseInstagram, pickSocialUrls, readViaJina, parseCount };
