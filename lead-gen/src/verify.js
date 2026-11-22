'use strict';
/**
 * 交叉验证与置信度评分引擎
 *
 * 核心思想（行业成熟做法）：
 * 1. 每个字段独立收集多来源证据（evidence）
 * 2. 从每条证据里抽取该字段的候选值，并归一化到统一口径
 * 3. 多源投票：一致→confirmed，单弱源→weak，互相矛盾→conflict
 * 4. 置信度 = 来源可信度 × 一致性系数 × 证据数量加成
 * 5. 总分 = 各字段置信度的加权平均（行业/规模/官网/社媒权重大）
 *
 * 所有候选值与来源都写入 detail，形成可审计的证据链。
 */

const norm = require('./normalize');
const { getSetting } = require('./db');

const FIELD_WEIGHT = {
  industry: 0.24,
  size: 0.22,
  website: 0.12,
  social: 0.18,
  country: 0.09,
  founded: 0.05,
  followers: 0.05,
  description: 0.05,
};

// 权威一手来源（官网 / 社媒官方主页）：单源即可确认
const AUTHORITATIVE_SOURCES = ['website', 'linkedin_page', 'facebook_page'];

/** 从一条证据中抽取某字段的候选值 */
function extractValue(ev, field) {
  const text = `${ev.raw_value || ''} ${ev.snippet || ''}`;
  switch (field) {
    case 'industry': {
      if (ev.hint) { const [s, sub] = ev.hint.split('/'); return { value: sub || s, sector: s, confidence: ev.confidence }; }
      const ind = norm.classifyIndustry(text);
      if (ind) return { value: ind.sub, sector: ind.sector, confidence: ev.confidence };
      // 兜底：把 industry 字段的 JSON-LD 值当候选
      if (/industry/i.test(ev.raw_value || '')) {
        const v = String(ev.raw_value).replace(/^.*?industry[:：]?\s*/i, '').trim().slice(0, 60);
        if (v) return { value: v, confidence: ev.confidence * 0.8 };
      }
      return null;
    }
    case 'employees':
    case 'size': {
      if (ev.hint) return { value: ev.hint, confidence: ev.confidence };
      const emp = norm.parseEmployees(text);
      if (emp.bucket) return { value: emp.bucket, count: emp.count, confidence: ev.confidence };
      return null;
    }
    case 'country': {
      const c = norm.normalizeCountry(ev.raw_value || ev.snippet);
      return c ? { value: c, confidence: ev.confidence } : null;
    }
    case 'website': {
      const m = String(ev.url || '').match(/https?:\/\/([^\/]+)/);
      return m ? { value: m[1].replace(/^www\./, ''), confidence: ev.confidence } : null;
    }
    case 'social': {
      return ev.value ? { value: ev.value, confidence: ev.confidence } : null;
    }
    case 'founded': {
      const m = text.match(/(19|20)\d{2}/);
      return m ? { value: m[0], confidence: ev.confidence } : null;
    }
    case 'followers': {
      if (ev.value && /^\d+$/.test(ev.value)) return { value: ev.value, confidence: ev.confidence };
      const m = text.match(/([\d,.]+)\s*(followers|粉丝)/i);
      if (m) return { value: m[1].replace(/,/g, ''), confidence: ev.confidence };
      return null;
    }
    case 'description': {
      if (ev.raw_value && ev.raw_value.length > 20) return { value: String(ev.raw_value).slice(0, 400), confidence: ev.confidence };
      return null;
    }
    case 'email': {
      const m = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
      return m ? { value: m[0].toLowerCase(), confidence: ev.confidence } : null;
    }
    case 'phone': {
      // 只认带国家码或足够位数的号码，避免把年份/员工数当电话
      const m = text.match(/(?:\+\d[\d\s().-]{6,18}\d|\b\d[\d\s().-]{7,18}\d\b)/);
      if (!m) return null;
      const digits = m[0].replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 18 ? { value: m[0].trim(), confidence: ev.confidence } : null;
    }
    default:
      return null;
  }
}

/** 对单个字段的多来源候选值做投票，得到字段级结论 */
function resolveField(field, evidence) {
  const candidates = [];
  for (const ev of evidence) {
    const v = extractValue(ev, field);
    if (!v) continue;
    candidates.push({
      value: String(v.value),
      sector: v.sector || '',
      count: v.count || null,
      confidence: v.confidence,
      source: ev.source,
      url: ev.url || '',
      snippet: (ev.snippet || '').slice(0, 200),
    });
  }
  if (!candidates.length) {
    return { field, value: '', confidence: 0, status: 'missing', evidence_count: 0, detail: [] };
  }

  // 社媒 / 粉丝数 / 邮箱 / 电话是「多值并列」字段：各自计数，合并展示，不算冲突
  if (['social', 'followers', 'email', 'phone'].includes(field)) {
    const platforms = [...new Set(candidates.map(c => c.value))];
    const avg = candidates.reduce((s, c) => s + c.confidence, 0) / candidates.length;
    const conf = Math.min(1, avg * (1 + Math.min(candidates.length - 1, 4) * 0.06));
    return {
      field, value: platforms.join(', '), confidence: Math.round(conf * 100) / 100,
      status: candidates.length >= 2 ? 'confirmed' : 'weak',
      evidence_count: candidates.length,
      detail: platforms.map(p => ({
        value: p, sources: candidates.filter(c => c.value === p).map(c => ({ source: c.source, url: c.url, snippet: c.snippet, confidence: c.confidence })),
      })),
    };
  }

  // 按值聚合（行业用细分名；规模用档位）
  const groups = {};
  for (const c of candidates) {
    const key = c.value.toLowerCase();
    if (!groups[key]) groups[key] = { value: c.value, sector: c.sector, count: c.count, sum: 0, n: 0, sources: [] };
    groups[key].sum += c.confidence;
    groups[key].n += 1;
    groups[key].sources.push({ source: c.source, url: c.url, snippet: c.snippet, confidence: c.confidence, count: c.count });
  }
  const ranked = Object.values(groups).map(g => ({
    ...g,
    avgConfidence: g.sum / g.n,
    // 数量加成：多样化来源比单一来源更可信
    score: g.sum * (1 + Math.min(g.n - 1, 3) * 0.12),
  })).sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const runner = ranked[1];
  const distinctSources = new Set(top.sources.map(s => s.source)).size;
  const authoritative = top.sources.some(s => AUTHORITATIVE_SOURCES.includes(s.source) && s.confidence >= 0.8);

  let status = 'weak';
  // 权威来源（官网）单源即可确认；普通来源需 2 个独立来源交叉印证
  if (authoritative && top.score >= 0.75) status = 'confirmed';
  else if (distinctSources >= 2 && top.score >= 0.9) status = 'confirmed';
  else if (top.score >= 0.7) status = 'weak';
  // 冲突：两个不同值都有较强支持，且都不是压倒性权威
  if (runner && runner.score >= top.score * 0.7 && runner.score >= 0.6 && !authoritative) status = 'conflict';

  // 置信度 0~1
  let confidence = Math.min(1, top.score / 1.5);
  if (status === 'conflict') confidence *= 0.6;
  if (distinctSources >= 3) confidence = Math.min(1, confidence * 1.1);
  if (status === 'confirmed' && authoritative) confidence = Math.max(confidence, 0.85);

  return {
    field,
    value: top.value,
    sector: top.sector || '',
    count: top.count,
    confidence: Math.round(confidence * 100) / 100,
    status,
    evidence_count: candidates.length,
    detail: ranked.map(r => ({ value: r.value, sector: r.sector, count: r.count, sources: r.sources })),
  };
}

/** 生成整体建议：行业（一级/细分）、规模档、可信等级 */
function makeSummary(fieldResults, lead) {
  const get = f => fieldResults.find(r => r.field === f);
  const social = get('social');

  // 社媒列表：从 social 字段 detail 里取平台名（跳过合并串，只取单平台项）
  const socialPlatforms = [];
  if (social && social.detail && social.detail.length) {
    for (const d of social.detail.slice(0, 8)) {
      if (!d.value || d.value.includes(',')) continue;
      if (!socialPlatforms.includes(d.value)) socialPlatforms.push(d.value);
    }
  }
  if (!socialPlatforms.length && social && social.value) socialPlatforms.push(social.value);

  const parallelValues = field => {
    const f = get(field);
    if (!f || !f.detail) return [];
    return [...new Set(f.detail.map(d => String(d.value || '')).filter(Boolean))];
  };
  const indF = get('industry');
  const sizeF = get('size');
  const industryText = indF ? (indF.sector && indF.value && indF.sector !== indF.value ? `${indF.sector} / ${indF.value}` : (indF.value || indF.sector)) : '';
  const sizeText = sizeF ? (sizeF.count ? `${norm.bucketLabel(sizeF.value)}（约 ${sizeF.count} 人）` : norm.bucketLabel(sizeF.value)) : '';

  return {
    industry: industryText,
    industry_sector: indF ? indF.sector : '',
    industry_sub: indF ? indF.value : '',
    size: sizeText,
    size_bucket: sizeF ? sizeF.value : '',
    employees_est: sizeF ? sizeF.count : null,
    social_platforms: socialPlatforms,
    followers: (() => {
      const f = get('followers');
      if (!f || !f.detail) return '';
      let max = 0;
      for (const d of f.detail) {
        const nums = String(d.value || '').match(/[\d,]+/g) || [];
        for (const raw of nums) { const n = parseInt(raw.replace(/,/g, ''), 10); if (!isNaN(n) && n > max) max = n; }
      }
      return max ? String(max) : '';
    })(),
    country: (get('country') || {}).value || lead.country || '',
    website: (get('website') || {}).value || norm.normalizeDomain(lead.website || lead.domain || ''),
    founded: (get('founded') || {}).value || '',
    emails: parallelValues('email'),
    phones: parallelValues('phone'),
  };
}

/**
 * 核验一条线索
 * @param lead 线索对象
 * @param evidence 证据数组（来自 sources.collect）
 * @returns 完整结果对象
 */
function verifyLead(lead, evidence) {
  const fields = ['industry', 'size', 'country', 'website', 'social', 'founded', 'followers', 'description', 'email', 'phone'];
  const fieldResults = fields.map(f => {
    let pool = evidence.filter(e => e.field === f);
    // 行业/规模/成立年份可由「描述类」证据二次提取（如官网 about 文本里写了员工数和业务）
    if (f === 'industry' || f === 'founded') pool = pool.concat(evidence.filter(e => e.field === 'description'));
    if (f === 'size') pool = pool.concat(evidence.filter(e => e.field === 'employees'));
    return resolveField(f, pool);
  });

  // 总分：加权平均（description/email/phone 仅作佐证与渠道加分，不参与基础分）
  let scoreSum = 0, weightSum = 0;
  for (const r of fieldResults) {
    if (['description', 'email', 'phone'].includes(r.field)) continue;
    const w = FIELD_WEIGHT[r.field] || 0.05;
    scoreSum += r.confidence * w;
    weightSum += w;
  }
  let overall = weightSum ? scoreSum / weightSum : 0;

  // 命中用户提示（industry_hint / size_hint）且被证据佐证，加分
  if (lead.industry_hint) {
    const ind = fieldResults.find(r => r.field === 'industry');
    if (ind && ind.value && norm.classifyIndustry(lead.industry_hint)) overall = Math.min(1, overall + 0.05);
  }

  const conflictCount = fieldResults.filter(r => r.status === 'conflict' && r.field !== 'description').length;
  const confirmedCount = fieldResults.filter(r => r.status === 'confirmed' && r.field !== 'description').length;
  const score100 = Math.round(overall * 100);

  // GoodJob 式可解释推荐分：基础质量 70 + 联系方式 20 + 多源佐证 10 - 冲突扣分
  // 只从证据里抽联系方式，不猜测、不验证可达性；审批仍由人工确认。
  const emailF = fieldResults.find(r => r.field === 'email');
  const phoneF = fieldResults.find(r => r.field === 'phone');
  const distinctSources = new Set(evidence.map(e => e.source)).size;
  const components = [];
  const base = Math.round(overall * 70);
  components.push({ label: '基础可信度', value: base, detail: `${score100} 分 × 0.7` });

  let contact = 0;
  const contactBits = [];
  if (emailF && emailF.value) { contact += 12; contactBits.push('邮箱 +12'); }
  if (phoneF && phoneF.value) { contact += 8; contactBits.push('电话 +8'); }
  if (contact) components.push({ label: '联系方式', value: contact, detail: contactBits.join(' / ') });

  let corroboration = distinctSources >= 5 ? 6 : distinctSources >= 3 ? 4 : 0;
  corroboration += confirmedCount >= 3 ? 4 : confirmedCount >= 1 ? 2 : 0;
  corroboration = Math.min(10, corroboration);
  if (corroboration) components.push({ label: '多源佐证', value: corroboration, detail: `${distinctSources} 个来源 / ${confirmedCount} 个已确认字段` });

  const penalty = Math.min(20, conflictCount * 10);
  if (penalty) components.push({ label: '冲突扣分', value: -penalty, detail: `${conflictCount} 个字段冲突` });

  const recommendScore = Math.max(0, Math.min(100, base + contact + corroboration - penalty));
  const minScore = parseInt(getSetting('approval_min_score', '70'), 10) || 70;
  const recommendLevel = recommendScore >= 80 ? '优先联系' : recommendScore >= 60 ? '可联系' : recommendScore >= 40 ? '待补证据' : '暂不建议';
  const suggestedStage = recommendScore >= minScore && conflictCount === 0 ? 'approved' : 'candidate';
  const recommendation = {
    score: recommendScore,
    level: recommendLevel,
    min_score: minScore,
    suggested_stage: suggestedStage,
    components,
    reasons: components.filter(c => c.value).map(c => `${c.label} ${c.value > 0 ? '+' : ''}${c.value}（${c.detail}）`),
  };

  // 建议状态：>=75 且无冲突 → verified；>=45 或有确认字段 → review；否则 new
  let suggestedStatus = 'new';
  if (score100 >= 75 && conflictCount === 0) suggestedStatus = 'verified';
  else if (score100 >= 45 || confirmedCount >= 1) suggestedStatus = 'review';

  const summary = makeSummary(fieldResults, lead);
  const level = score100 >= 80 ? 'A' : score100 >= 60 ? 'B' : score100 >= 40 ? 'C' : 'D';

  return {
    engine_version: getSetting('engine_version', '1.0.0'),
    overall_score: score100,
    level,
    recommend_score: recommendScore,
    recommendation,
    suggested_status: suggestedStatus,
    field_count: fieldResults.filter(r => r.value).length,
    conflict_count: conflictCount,
    confirmed_count: confirmedCount,
    evidence_count: evidence.length,
    fields: fieldResults,
    summary,
    verified_at: new Date().toISOString(),
  };
}

module.exports = { verifyLead, resolveField, extractValue, FIELD_WEIGHT };
