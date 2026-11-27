'use strict';
/**
 * 多源采集层（可插拔 provider）
 * 每个 provider 返回统一的 evidence 数组：
 *   { source, field, raw_value, value, url, snippet, confidence }
 *
 * 内置 provider：
 *   bing          - Bing 搜索（免密主通道，当前网络实测可达）
 *   website       - 官网抓取（JSON-LD / OpenGraph / meta / about 页）
 *   linkedin_search / facebook_search / instagram_search - site: 搜索间接验证
 *   google_cse    - Google Custom Search API（配置 key 后启用）
 *   serpapi       - SerpAPI（配置 key 后启用）
 */
const { fetchUrl, stripTags, decodeEntities, attr, metaContent } = require('./net');
const norm = require('./normalize');
const getSetting = (...args) => require('./db').getSetting(...args);

const MAX = () => parseInt(getSetting('max_results_per_query', '8'), 10) || 8;
const enc = q => encodeURIComponent(q);

/** 解析 Bing HTML 结果为 [{title,url,snippet}] */
function parseBing(html, limit = MAX()) {
  const out = [];
  const blocks = html.split(/<li class="b_algo["\s]/).slice(1);
  for (const b of blocks) {
    const h2 = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (!h2) continue;
    const href = attr((h2[1].match(/<a[^>]*>/i) || [''])[0], 'href');
    const title = stripTags(h2[1]);
    const cap = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = cap ? stripTags(cap[1]) : '';
    if (href && href.startsWith('http')) out.push({ title, url: href, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/** 组装带国家/域名的搜索 query */
function buildQuery(lead, extra) {
  const parts = [`"${lead.company_name}"`];
  if (lead.country) parts.push(lead.country);
  if (lead.industry_hint) parts.push(lead.industry_hint);
  parts.push(extra || '');
  return parts.filter(Boolean).join(' ');
}

// ── provider: Bing 通用搜索 ──
async function bingSearch(query, { field = 'description', confidence = 0.55, limit, lead } = {}) {
  const url = `https://www.bing.com/search?q=${enc(query)}&count=${limit || MAX()}&setlang=en`;
  const r = await fetchUrl(url);
  if (!r.ok) return { evidence: [], error: r.error || `HTTP ${r.status}` };
  let results = parseBing(r.text);
  const total = results.length;
  if (lead) results = results.filter(x => isRelevant(x, lead));
  const evidence = results.map(x => ({
    source: 'bing', field,
    raw_value: `${x.title} ${x.snippet}`, value: '', url: x.url, snippet: x.snippet,
    title: x.title, confidence: lead ? confidence : confidence * 0.5,
  }));
  return { evidence, results, filtered: total - results.length };
}

// ── provider: 官网抓取（JSON-LD + meta + about 页） ──
function parseJsonLd(html) {
  const nodes = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(decodeEntities(m[1]).trim());
      const arr = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const node of arr) nodes.push(node);
    } catch { /* ignore bad json-ld */ }
  }
  return nodes;
}

/**
 * 从官网 HTML 提取社媒外链（比 site: 搜索更可靠的社媒存在性证据）
 */
function extractSocialLinks(html, baseUrl) {
  const found = [];
  const patterns = [
    { label: 'LinkedIn', re: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[^\s"'<>]+/gi },
    { label: 'Facebook', re: /https?:\/\/(?:[a-z]{2,3}\.)?facebook\.com\/[^\s"'<>]+/gi },
    { label: 'Instagram', re: /https?:\/\/(?:[a-z]{2,3}\.)?instagram\.com\/[^\s"'<>]+/gi },
    { label: 'YouTube', re: /https?:\/\/(?:[a-z]{2,3}\.)?(?:youtube\.com|youtube-nocookie\.com)\/(?:@|channel\/|c\/|user\/)[^\s"'<>]+/gi },
    { label: 'X/Twitter', re: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^\s"'<>]+/gi },
  ];
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(text)) && found.length < 12) {
      let u = m[0].replace(/&amp;/g, '&');
      // 清理尾部噪声：标点 + 非 URL 的中文字符（社媒 slug 一般是 ASCII）
      u = u.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/, '').replace(/[),;.&]*$/, '');
      if (!found.some(f => f.url === u)) found.push({ label: p.label, url: u });
    }
  }
  return found;
}

/** 判断搜索结果是否与目标公司相关（过滤搜索引擎的本地化污染） */
function isRelevant(result, lead) {
  const core = norm.normalizeCompanyName(lead.company_name);
  if (!core || core.length < 3) return true;
  const hay = norm.normalizeCompanyName(`${result.title || ''} ${result.snippet || ''} ${result.url || ''}`);
  if (hay.includes(core)) return true;
  // 公司名首个词（如 Demo Hardware）命中也算
  const first = core.slice(0, Math.min(core.length, 8));
  return first.length >= 4 && hay.includes(first);
}

function websiteFacts(html, url) {
  const facts = [];
  const links = extractSocialLinks(html, url);
  for (const l of links) {
    facts.push({ field: 'social', raw_value: l.label, value: l.label, confidence: 0.75, snippet: `${l.label}: ${l.url}`, url: l.url });
  }
  const desc = metaContent(html, 'description') || metaContent(html, 'og:description');
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const title = stripTags(titleTag || '');
  if (desc) facts.push({ field: 'description', raw_value: desc, value: '', confidence: 0.8, snippet: desc, url });
  if (title) facts.push({ field: 'description', raw_value: title, value: '', confidence: 0.7, snippet: title, url });

  for (const node of parseJsonLd(html)) {
    const type = node['@type'];
    const isOrg = Array.isArray(type) ? type.includes('Organization') : /Organization|Corporation|Company/i.test(type || '');
    if (!isOrg) continue;
    if (node.name) facts.push({ field: 'description', raw_value: `Company: ${node.name}`, value: '', confidence: 0.8, snippet: `Organization name: ${node.name}`, url });
    if (node.industry) facts.push({ field: 'industry', raw_value: node.industry, value: '', confidence: 0.85, snippet: `JSON-LD industry: ${node.industry}`, url });
    const emp = node.numberOfEmployees;
    if (emp) {
      const val = typeof emp === 'object' ? (emp.value ?? emp.maxValue ?? '') : emp;
      facts.push({ field: 'employees', raw_value: String(val), value: '', confidence: 0.85, snippet: `JSON-LD employees: ${val}`, url });
    }
    if (node.foundingDate) facts.push({ field: 'founded', raw_value: String(node.foundingDate), value: '', confidence: 0.8, snippet: `Founded: ${node.foundingDate}`, url });
    if (node.description) facts.push({ field: 'description', raw_value: node.description, value: '', confidence: 0.75, snippet: stripTags(String(node.description)).slice(0, 300), url });
    if (node.address) {
      const a = typeof node.address === 'object' ? (node.address.addressCountry || node.address.addressLocality || '') : node.address;
      if (a) facts.push({ field: 'country', raw_value: String(a), value: '', confidence: 0.7, snippet: `Address: ${a}`, url });
    }
  }
  return facts;
}

async function websiteProbe(lead) {
  const evidence = [];
  const bases = [];
  if (lead.website) bases.push(lead.website.startsWith('http') ? lead.website : 'https://' + lead.website);
  if (lead.domain && !bases.some(b => b.includes(lead.domain))) bases.push('https://' + lead.domain);
  if (!bases.length) return { evidence, error: 'no website provided' };

  for (const base of bases.slice(0, 2)) {
    const r = await fetchUrl(base);
    if (r.ok && r.text) {
      for (const f of websiteFacts(r.text, r.url)) evidence.push({ source: 'website', ...f });
      // 尝试 about 页补充说明
      let aboutUrl = null;
      const al = r.text.match(/<a[^>]+href=["']([^"']*(?:\/about|about\.html|\/company)[^"']*)["'][^>]*>/i);
      if (al) { try { aboutUrl = new URL(al[1], r.url).href; } catch {} }
      if (aboutUrl) {
        const ar = await fetchUrl(aboutUrl);
        if (ar.ok) {
          const txt = stripTags(ar.text).slice(0, 4000);
          if (txt) evidence.push({ source: 'website', field: 'description', raw_value: txt, value: '', confidence: 0.6, snippet: txt.slice(0, 300), url: ar.url });
        }
      }
    }
  }
  return { evidence };
}

// ── provider: 社媒 site: 搜索（间接验证存在性 + 规模） ──
const SOCIAL_SPECS = {
  linkedin_search: { domain: 'linkedin.com/company', label: 'LinkedIn', conf: 0.7 },
  facebook_search: { domain: 'facebook.com', label: 'Facebook', conf: 0.6 },
  instagram_search: { domain: 'instagram.com', label: 'Instagram', conf: 0.6 },
};

async function socialSearch(lead, kind) {
  const spec = SOCIAL_SPECS[kind];
  const q = `site:${spec.domain} ${lead.company_name}${lead.country ? ' ' + lead.country : ''}`;
  const url = `https://www.bing.com/search?q=${enc(q)}&count=10&setlang=en`;
  const r = await fetchUrl(url);
  if (!r.ok) return { evidence: [], error: r.error };
  const results = parseBing(r.text)
    .filter(x => x.url.includes(spec.domain.replace('linkedin.com/company', 'linkedin.com')))
    .filter(x => isRelevant(x, lead));
  if (!results.length) return { evidence: [] };
  const evidence = [];
  // 存在性
  evidence.push({
    source: kind, field: 'social', raw_value: spec.label, value: spec.label,
    url: results[0].url, snippet: results[0].snippet || results[0].title, confidence: spec.conf,
  });
  // 从摘要里挖行业与规模
  for (const x of results.slice(0, 5)) {
    const text = `${x.title} ${x.snippet}`;
    const ind = norm.classifyIndustry(text);
    if (ind) evidence.push({ source: kind, field: 'industry', raw_value: text, value: '', url: x.url, snippet: text.slice(0, 240), confidence: 0.62, hint: `${ind.sector}/${ind.sub}` });
    const emp = norm.parseEmployees(text);
    if (emp.bucket) evidence.push({ source: kind, field: 'employees', raw_value: text, value: '', url: x.url, snippet: text.slice(0, 240), confidence: 0.6, hint: emp.bucket });
  }
  return { evidence, results };
}

// ── provider: Google CSE（需 key） ──
async function googleCse(lead, query) {
  const key = getSetting('google_cse_key'), cx = getSetting('google_cse_cx');
  if (!key || !cx) return { evidence: [], skipped: true };
  const url = `https://www.googleapis.com/customsearch/v1?key=${enc(key)}&cx=${enc(cx)}&q=${enc(query)}&num=${MAX()}`;
  const r = await fetchUrl(url, { throttle: false });
  if (!r.ok) return { evidence: [], error: r.error || `HTTP ${r.status}` };
  try {
    const data = JSON.parse(r.text);
    const items = data.items || [];
    return { evidence: items.map(x => ({
      source: 'google_cse', field: 'description', raw_value: `${x.title} ${x.snippet}`,
      value: '', url: x.link, snippet: x.snippet || '', title: x.title, confidence: 0.8,
    })) };
  } catch (e) { return { evidence: [], error: 'bad json: ' + e.message }; }
}

// ── provider: SerpAPI（需 key） ──
async function serpApi(lead, query) {
  const key = getSetting('serpapi_key');
  if (!key) return { evidence: [], skipped: true };
  const url = `https://serpapi.com/search.json?engine=google&q=${enc(query)}&api_key=${enc(key)}&num=${MAX()}`;
  const r = await fetchUrl(url, { throttle: false });
  if (!r.ok) return { evidence: [], error: r.error || `HTTP ${r.status}` };
  try {
    const data = JSON.parse(r.text);
    const items = data.organic_results || [];
    return { evidence: items.map(x => ({
      source: 'serpapi', field: 'description', raw_value: `${x.title} ${x.snippet || ''}`,
      value: '', url: x.link, snippet: x.snippet || '', title: x.title, confidence: 0.8,
    })) };
  } catch (e) { return { evidence: [], error: 'bad json: ' + e.message }; }
}

/**
 * 对单条线索采集全部来源的证据
 * @param lead {company_name, website, domain, country, industry_hint, ...}
 * @param opts {providers: string[]} 指定要跑的 provider，默认全部
 * @returns { evidence:[], log:[], error }
 */
async function collect(lead, opts = {}) {
  const allProviders = ['website', 'bing', 'linkedin_search', 'facebook_search', 'instagram_search', 'google_cse', 'serpapi'];
  // 设置页可关闭某些通道；未列出的源不请求，避免无效 Key/慢源拖慢整批核验
  const rawSources = require('./db').allSettings().enabled_sources;
  const configured = rawSources === undefined
    ? allProviders
    : String(rawSources).split(',').map(s => s.trim()).filter(Boolean);
  const wanted = opts.providers || configured;
  const evidence = [];
  const log = [];
  const errors = [];
  let socialReader = null;
  try { socialReader = require('./socialReader'); } catch {}

  const runProvider = async (name, fn) => {
    if (!wanted.includes(name)) return;
    try {
      const r = await fn();
      if (r.skipped) { log.push(`${name}: skipped (no key)`); return; }
      if (r.error) { log.push(`${name}: error ${r.error}`); errors.push(`${name}: ${r.error}`); }
      for (const e of (r.evidence || [])) evidence.push(e);
      log.push(`${name}: ${(r.evidence || []).length} evidence`);
    } catch (e) {
      log.push(`${name}: exception ${e.message}`);
      errors.push(`${name}: ${e.message}`);
    }
  };

  const descQuery = buildQuery(lead, 'company profile industry employees');
  await runProvider('website', () => websiteProbe(lead));
  await runProvider('bing', () => bingSearch(descQuery, { field: 'description', confidence: 0.55, lead }));
  await runProvider('linkedin_search', () => socialSearch(lead, 'linkedin_search'));
  await runProvider('facebook_search', () => socialSearch(lead, 'facebook_search'));
  await runProvider('instagram_search', () => socialSearch(lead, 'instagram_search'));
  await runProvider('google_cse', () => googleCse(lead, buildQuery(lead, 'industry employees')));
  await runProvider('serpapi', () => serpApi(lead, buildQuery(lead, 'industry employees')));

  // 若配置了 key，追加行业/规模定向搜索
  if (wanted.includes('bing')) {
    await runProvider('bing', async () => {
      const q = buildQuery(lead, 'number of employees industry');
      const r = await bingSearch(q, { field: 'employees', confidence: 0.55, lead });
      for (const e of r.evidence) { e.field = 'employees'; }
      return r;
    });
  }

  // 社媒直读（r.jina.ai 阅读器）：从官网外链定位主页，读行业/规模/粉丝数
  if (wanted.includes('website') && socialReader) {
    try {
      const sr = await socialReader.readSocial(lead, evidence, { platforms: ['linkedin', 'facebook', 'instagram'] });
      for (const e of sr.evidence) evidence.push(e);
      log.push(...(sr.log || []).map(x => 'social_reader: ' + x));
    } catch (e) { log.push('social_reader: exception ' + e.message); }
  }

  return { evidence, log, errors };
}

module.exports = { collect, parseBing, websiteFacts, buildQuery, SOCIAL_SPECS };
