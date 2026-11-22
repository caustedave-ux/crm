'use strict';
// ============ AI 外贸工作台：数据聚合 + DeepSeek 生成 ============
const { all, get, getSetting } = require('./db');
const { buildContext } = require('./aiContext');

// 常见国家/地区中心坐标（WGS84，用于按国家聚合打点，非精确定位）。
// 覆盖主要外贸市场；未在表中的国家按名称哈希落到相近位置，避免丢点。
const COORD = {
  '中国': [35.86, 104.19], '中国大陆': [35.86, 104.19], '美国': [39.83, -98.58], '美国USA': [39.83, -98.58],
  '加拿大': [56.13, -106.35], '墨西哥': [23.63, -102.55], '巴西': [-14.24, -51.93], '阿根廷': [-38.42, -63.62],
  '英国': [55.38, -3.44], '德国': [51.17, 10.45], '法国': [46.23, 2.21], '意大利': [41.87, 12.57],
  '西班牙': [40.46, -3.75], '荷兰': [52.13, 5.29], '比利时': [50.50, 4.47], '波兰': [51.92, 19.15],
  '瑞典': [60.13, 18.64], '瑞士': [46.82, 8.23], '奥地利': [47.52, 14.55], '葡萄牙': [39.40, -8.22],
  '俄罗斯': [61.52, 105.32], '乌克兰': [48.38, 31.17], '土耳其': [38.96, 35.24], '希腊': [39.07, 21.82],
  '埃及': [26.82, 30.80], '南非': [-30.56, 22.94], '尼日利亚': [9.08, 8.68], '肯尼亚': [-0.02, 37.91],
  '摩洛哥': [31.79, -7.09], '阿尔及利亚': [28.03, 1.66], '突尼斯': [33.89, 9.54], '加纳': [7.95, -1.02],
  '阿联酋': [23.42, 53.85], '沙特阿拉伯': [23.89, 45.08], '以色列': [31.05, 34.85], '伊朗': [32.43, 53.69],
  '印度': [20.59, 78.96], '巴基斯坦': [30.38, 69.35], '孟加拉国': [23.68, 90.36], '斯里兰卡': [7.87, 80.77],
  '越南': [14.06, 108.28], '泰国': [15.87, 100.99], '马来西亚': [4.21, 101.98], '印度尼西亚': [-2.55, 118.02],
  '菲律宾': [12.88, 121.77], '新加坡': [1.35, 103.82], '韩国': [35.91, 127.77], '日本': [36.20, 138.25],
  '澳大利亚': [-25.27, 133.77], '新西兰': [-40.90, 174.89],
  '坦桑尼亚': [-6.37, 34.89], '乌干达': [1.29, 32.22], '赞比亚': [-13.13, 27.85],
  '喀麦隆': [5.69, 12.74], '科特迪瓦': [7.54, -5.56], '刚果（金）': [-2.88, 23.66],
  '伊拉克': [33.22, 43.68],
};
// 中英文别名 → 标准中文国名（覆盖 CRM 里常见的「尼日利亚 Nigeria」「Nigeria」等混写）
const ALIAS = {
  'nigeria': '尼日利亚', '斯里兰卡 sri lanka': '斯里兰卡', 'sri lanka': '斯里兰卡',
  '刚果（金） dr congo': '刚果（金）', 'dr congo': '刚果（金）', 'democratic republic of the congo': '刚果（金）',
  '肯尼亚 kenya': '肯尼亚', 'kenya': '肯尼亚', '加纳 ghana': '加纳', 'ghana': '加纳',
  '美国 usa': '美国', 'usa': '美国', 'united states': '美国', 'united states of america': '美国',
  '英国 uk': '英国', 'uk': '英国', 'united kingdom': '英国',
  'vietnam': '越南', 'viet nam': '越南', '越南 vietnam': '越南',
  'india': '印度', 'indonesia': '印度尼西亚', 'malaysia': '马来西亚', 'singapore': '新加坡',
  'Philippines': '菲律宾', 'philippines': '菲律宾', 'thailand': '泰国', 'turkey': '土耳其', 'türkiye': '土耳其',
  'uae': '阿联酋', 'united arab emirates': '阿联酋', 'saudi arabia': '沙特阿拉伯',
  'south africa': '南非', 'egypt': '埃及', 'morocco': '摩洛哥', 'algeria': '阿尔及利亚', 'tunisia': '突尼斯',
  'germany': '德国', 'france': '法国', 'italy': '意大利', 'spain': '西班牙', 'netherlands': '荷兰',
  'poland': '波兰', 'sweden': '瑞典', 'switzerland': '瑞士', 'austria': '奥地利', 'portugal': '葡萄牙',
  'russia': '俄罗斯', 'ukraine': '乌克兰', 'greece': '希腊', 'belgium': '比利时',
  'brazil': '巴西', 'mexico': '墨西哥', 'argentina': '阿根廷', 'canada': '加拿大', 'australia': '澳大利亚',
  'japan': '日本', 'south korea': '韩国', 'korea': '韩国', 'pakistan': '巴基斯坦', 'bangladesh': '孟加拉国',
  'israel': '以色列', 'iran': '伊朗', 'iraq': '伊拉克', 'new zealand': '新西兰',
  '坦桑尼亚 tanzania': '坦桑尼亚', 'tanzania': '坦桑尼亚', '乌干达 uganda': '乌干达', 'uganda': '乌干达',
  '赞比亚 zambia': '赞比亚', 'zambia': '赞比亚', '喀麦隆 cameroon': '喀麦隆', 'cameroon': '喀麦隆',
  '科特迪瓦 cote divoire': '科特迪瓦', '象牙海岸': '科特迪瓦',
};
function normalizeCountry(raw) {
  const s = String(raw || '').trim();
  if (!s) return '未知';
  const low = s.toLowerCase();
  if (ALIAS[low]) return ALIAS[low];
  if (ALIAS[s]) return ALIAS[s];
  // 形如「尼日利亚 Nigeria」：拆出英文段再查
  const parts = s.split(/[\s(（/]+/).filter(Boolean);
  for (const p of parts) {
    const pl = p.toLowerCase().replace(/[)）]$/, '');
    if (ALIAS[pl]) return ALIAS[pl];
    if (COORD[p]) return p;
  }
  for (const k of Object.keys(COORD)) if (s.includes(k) || k.includes(s)) return k;
  return s;
}
function coordOf(country) {
  const key = normalizeCountry(country);
  if (!key || key === '未知') return null;
  if (COORD[key]) return COORD[key];
  for (const k of Object.keys(COORD)) if (key.includes(k) || k.includes(key)) return COORD[k];
  // 兜底：国家名哈希到欧亚大陆范围内，避免关键点丢失（前端会标注"坐标为估算"）
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 100000;
  return [20 + (h % 400) / 10, 40 + (h % 1100) / 10];
}

// 地图点位：客户（主库）+ 线索（获客库，若存在）按国家聚合。
function mapPoints(user) {
  const uid = parseInt(user && user.id, 10) || 0;
  const groups = {};
  function add(kind, id, name, country, extra) {
    const c = normalizeCountry(country);
    if (!groups[c]) {
      const xy = coordOf(c);
      groups[c] = { country: c, lat: xy ? xy[0] : null, lng: xy ? xy[1] : null, estimated: !COORD[c], customers: [], leads: [] };
    }
    groups[c][kind].push(Object.assign({ id, name }, extra || {}));
  }
  try {
    for (const r of all('SELECT id,company_name,country,status,industry,website FROM customers WHERE user_id=?', uid)) {
      add('customers', r.id, r.company_name, r.country, { status: r.status, industry: r.industry, website: r.website });
    }
  } catch (e) {}
  // 获客线索库与主库不同文件，仅在同机可读时聚合；失败不影响客户点位。
  try {
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const lgDb = new DatabaseSync(path.join(__dirname, '..', 'lead-gen', 'data', 'leads.db'), { readOnly: true });
    const rows = lgDb.prepare('SELECT id,company_name,country,industry_hint,overall_score,stage FROM leads').all();
    for (const r of rows) add('leads', r.id, r.company_name, r.country, { industry: r.industry_hint, score: r.overall_score, stage: r.stage });
    lgDb.close();
  } catch (e) {}
  return Object.values(groups).map(g => Object.assign(g, { total: g.customers.length + g.leads.length })).sort((a, b) => b.total - a.total);
}

function callDeepSeek(system, userText, maxTokens) {
  const key = getSetting('ai_api_key');
  if (!key) throw new Error('未配置 DeepSeek API Key，请先到「系统设置 → DeepSeek 设置」填写');
  const model = getSetting('ai_model') || 'deepseek-chat';
  return fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: String(userText || '').slice(0, 28000) }], temperature: 0.3, stream: false, max_tokens: maxTokens || 1200 }),
    signal: AbortSignal.timeout(90000),
  }).then(async (resp) => {
    if (!resp.ok) {
      let msg = 'DeepSeek 返回 HTTP ' + resp.status;
      try { const j = await resp.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    return String(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  });
}

// 工作台通用对话：带 CRM 上下文 + 外贸助理人设。
async function chat(user, question, skill) {
  const q = String(question || '').trim();
  if (!q) throw new Error('请输入问题');
  const system = [
    '你是资深外贸业务助理，服务于一家的中国出口企业的业务员。',
    '回答用简体中文，专业、具体、可执行；涉及客户、产品、单据、金额时优先引用给定的 CRM 数据，数据不足时明确说明。',
    '不要编造不存在的客户、订单、数字或事实。语气简洁，避免空话。',
    skill === 'dev' ? '当前场景：开发海外客户。给出目标市场选择、渠道、切入话术和可执行步骤。' : '',
    skill === 'background' ? '当前场景：客户背调。给出应核查的维度、风险点和尽调清单，并说明哪些可凭现有数据判断、哪些需要外部核实。' : '',
    skill === 'quote' ? '当前场景：报价谈判。给出报价策略、让步底线设计和应对议价的话术框架。' : '',
    skill === 'marketing' ? '当前场景：营销推广。给出渠道组合、内容角度和触达节奏建议。' : '',
  ].filter(Boolean).join('\n');
  const ctx = buildContext(user);
  return callDeepSeek(system, '【CRM 上下文】\n' + ctx + '\n\n【业务员的问题】\n' + q, 1400);
}

// 写开发信：按客户 + 产品 + 目标语言生成邮件。
async function compose(user, opts) {
  const customerId = parseInt(opts.customer_id, 10) || 0;
  const product = String(opts.product || '').trim();
  const language = String(opts.language || 'en').trim();
  const goal = String(opts.goal || '').trim();
  const cust = customerId ? get('SELECT * FROM customers WHERE id=? AND user_id=?', customerId, user.id) : null;
  if (customerId && !cust) throw new Error('未找到该客户或无权限');
  if (!cust && !product) throw new Error('请选择客户或填写产品');
  const langMap = { en: '英语', zh: '简体中文', fr: '法语', es: '西班牙语', ar: '阿拉伯语', ru: '俄语' };
  const langName = langMap[language] || language;
  const system = [
    '你是 B2B 外贸开发信撰写专家。写一封简洁、专业、可直接发送的开发信。',
    '正文使用指定语言；主题行也用该语言。不要编造客户未提供的信息、认证、价格或交期。',
    '结构：简短开场（如何找到对方）→ 我们能提供什么（结合产品）→ 一个明确的下一步（低门槛行动号召）→ 署名。',
    '控制在 180 词以内，不使用夸张营销词，不堆砌形容词。',
    '只输出如下 JSON（不要代码围栏）：{"subject":"...","body":"..."}',
  ].join('\n');
  const info = [
    '目标语言：' + langName,
    '客户公司：' + (cust ? cust.company_name : '（未指定，写给潜在客户）'),
    '客户国家：' + (cust ? (cust.country || '未知') : '未知'),
    '客户行业：' + (cust ? (cust.industry || '未知') : '未知'),
    '联系人：' + (cust ? (cust.contact_person || '未知') : '未知'),
    '推荐产品：' + (product || '（请从我方主营产品中选择合适的）'),
    '本次目标：' + (goal || '建立初步联系，争取回复'),
    '我方公司：' + (get("SELECT value FROM settings WHERE key='company_name'") || {}).value || '',
  ].join('\n');
  const text = await callDeepSeek(system, info, 900);
  let raw = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('AI 未返回可解析的邮件内容，请重试');
  const parsed = JSON.parse(raw.slice(s, e + 1));
  return { subject: String(parsed.subject || '').slice(0, 200), body: String(parsed.body || '').slice(0, 4000), customer: cust ? cust.company_name : '' };
}

module.exports = { mapPoints, chat, compose, callDeepSeek, coordOf, normalizeCountry };
