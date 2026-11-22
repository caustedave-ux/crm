'use strict';
// ============ 纯决策逻辑（不碰数据库、不发消息，便于独立自测） ============

/** 置顶判断：与 CRM 页面口径一致——pinned_at 非空即视为置顶 */
function isPinned(row) {
  return String((row && row.pinned_at) || '').trim() !== '';
}

/** 会话最后一条消息是否为我方发出（人工已回 → 机器人不再插嘴） */
function humanReplied(lastMsg) {
  return !!(lastMsg && Number(lastMsg.from_me) === 1);
}

/** 敏感词命中：返回命中的词数组，未命中返回空数组 */
function isSensitive(text, words) {
  const s = String(text || '');
  const hit = [];
  for (const w of (words || [])) {
    const k = String(w || '').trim();
    if (k && s.includes(k)) hit.push(k);
  }
  return hit;
}

/** 冷却窗口：距上次自动回复不足 N 分钟则跳过 */
function isCoolingDown(lastAutoReplyAt, nowMs, minutes) {
  if (!lastAutoReplyAt) return false;
  const t = Date.parse(String(lastAutoReplyAt).replace(' ', 'T'));
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) < Number(minutes) * 60 * 1000;
}

/** 每日额度：已发数量 >= 上限则停止 */
function quotaExceeded(sentToday, dailyLimit) {
  const limit = Number(dailyLimit);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return Number(sentToday) >= limit;
}

/**
 * 综合决策。返回 { action, reason }
 * action: 'send' 发送 | 'skip' 静默跳过 | 'hold' 拦截待人工
 */
function chooseDecision(ctx) {
  if (ctx.pinned) return { action: 'skip', reason: '置顶会话，跳过不回' };
  if (ctx.human) return { action: 'skip', reason: '人工已回复，跳过不回' };
  if (ctx.cooling) return { action: 'skip', reason: '冷却窗口内，跳过不回' };
  if (ctx.quota) return { action: 'skip', reason: '今日额度已用尽，跳过不回' };
  if (ctx.sensitive && ctx.sensitive.length) {
    return { action: 'hold', reason: '命中敏感词：' + ctx.sensitive.join('、') };
  }
  return { action: 'send', reason: '通过' };
}

/* ==================== v2.0 资格判定与素材分发 ==================== */

/** 精准度归一化：把 AI 返回的自由文本收敛成三档 high / unknown / low */
function normalizePrecision(raw) {
  const s = String(raw || '').trim().toLowerCase();
  // 先排除"不精准"（它同时含"精准"，必须优先判断）
  if (/不精准|不够精准|明显不是|无采购|low|unlikely|unqualified/.test(s)) {
    if (!/未知|unknown|不确定|无法/.test(s)) return 'low';
  }
  if (/高精准|精准|确认|explicit|high|qualified|^yes$/.test(s)) return 'high';
  return 'unknown';
}

function normalizeConfidence(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) n = n / 100;
  return Math.max(0, Math.min(1, n));
}

const RISK_ALIASES = [
  ['complaint', /投诉|质量争议|质量不符|质量差|货不对板|描述不符|破损|缺陷|少发|错发|complain|complaint|quality\s*issue|defect|damaged|wrong\s*(item|product)|not\s*as\s*described|short\s*shipment/],
  ['refund', /退款|退货|返款|refund|return|chargeback/],
  ['lawyer', /律师|诉讼|法律|lawyer|legal action|lawsuit/],
  ['payment_dispute', /付款争议|拒付|payment\s*dispute/],
  ['abuse', /辱骂|骚扰|威胁|abuse|harass|threat/],
  ['job_seeker', /求职|找工作|招聘|job\s*seek|resume|cv/],
  ['competitor', /同行|竞争对手|competitor/],
  ['solicitation', /代理|货代|推广|拉客|solicitation|freight forwarder/],
  ['spam', /垃圾|博彩|贷款|spam|casino|loan/],
  ['no_purchase_intent', /没有采购需求|无采购意向|not interested|no purchase intent/],
];

function normalizeRiskFlags(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? String(raw).split(/[,，|;；\s]+/) : []);
  const out = new Set();
  for (const item of list) {
    const s = String(item || '').trim().toLowerCase();
    if (!s) continue;
    for (const [key, re] of RISK_ALIASES) if (re.test(s)) out.add(key);
  }
  return [...out];
}

function hasBlockingRisk(flags) {
  return normalizeRiskFlags(flags).some(x => ['complaint','refund','lawyer','payment_dispute','abuse'].includes(x));
}

function strongSignalCount(signals) {
  const s = signals || {};
  return (s.productSpecific ? 1 : 0) +
    (s.quantityGiven ? 1 : 0) +
    (s.destinationGiven ? 1 : 0) +
    (s.tradeTerms ? 1 : 0) +
    (['explicit', 'inferred'].includes(String(s.importExperience || '')) ? 1 : 0);
}

const HARD_STOP_RE = /投诉|退款|退货|返款|律师|诉讼|拒付|辱骂|威胁|质量不符|质量差|货不对板|描述不符|破损|缺陷|少发|错发|complain|complaint|refund|return|chargeback|lawyer|lawsuit|payment\s*dispute|abuse|threat|defect|damaged|wrong\s*(item|product)|not\s*as\s*described|short\s*shipment/i;

/** 客户目的归一化：catalog 画册 / quote 报价 / stock 现货图 / other 其他 */
function normalizePurpose(raw) {
  const s = String(raw || '').toLowerCase();
  if (/画册|目录|catalog|brochure|product\s*list/.test(s)) return 'catalog';
  if (/报价|价格|quote|quotation|price|pricing/.test(s)) return 'quote';
  if (/现货|库存|stock|ready|available|in\s*stock/.test(s)) return 'stock';
  return 'other';
}

/**
 * 资格状态机：根据 AI 判定结果 + 当前追问轮数，决定下一步动作。
 * 返回 { action, status, precision, reason }
 *   action: send_material 发素材 | ask 追问 | unqualified 放弃 | hold 转人工
 *   status: qualified 已精准 | pending 待判定 | done 终结
 */
function decideQualification(verdict, current, cfg) {
  let precision = normalizePrecision(verdict.precision);
  const purpose = normalizePurpose(verdict.purpose);
  const confidence = normalizeConfidence(verdict.confidence);
  const riskFlags = normalizeRiskFlags(verdict.riskFlags);
  const signals = verdict.signals || {};
  const rounds = Number((current && current.ask_rounds) || 0);
  const maxRounds = Number((cfg && cfg.maxQualifyRounds) || 2);
  const minHigh = Number((cfg && cfg.minHighConfidence) || 0.78);
  const minLow = Number((cfg && cfg.minLowConfidence) || 0.85);

  // 投诉、退款、律师、付款争议等风险必须人工处理，绝不自动发素材
  if (hasBlockingRisk(riskFlags)) {
    return { action: 'hold', status: 'review', precision, purpose, confidence, riskFlags, reason: '命中高风险：' + riskFlags.join('、') + '，转人工' };
  }

  // high 必须有足够置信度，否则按信息不足处理
  const strongCount = strongSignalCount(signals);
  const ruleQualified = String(signals.purchaseIntent || '') === 'clear' &&
    (!!signals.existingCustomer || strongCount >= 3 || (strongCount >= 2 && ['explicit', 'inferred'].includes(String(signals.importExperience || ''))));
  if (precision === 'unknown' && ruleQualified && !hasBlockingRisk(riskFlags)) precision = 'high';
  if (precision === 'high' && confidence < minHigh && !ruleQualified) precision = 'unknown';

  // low 只有高置信度且出现明确排除证据时才允许放弃
  if (precision === 'low') {
    const disqualifiers = ['job_seeker','competitor','solicitation','spam','abuse','no_purchase_intent'];
    const canDrop = confidence >= minLow && riskFlags.some(x => disqualifiers.includes(x));
    if (canDrop) {
      return { action: 'unqualified', status: 'done', precision, purpose, confidence, riskFlags, reason: '高置信度明确排除：' + riskFlags.join('、') };
    }
    return { action: 'hold', status: 'review', precision, purpose, confidence, riskFlags, reason: 'AI 判低精准但缺少明确排除证据或置信度不足，转人工' };
  }
  // 确认精准 → 直接发素材
  if (precision === 'high') {
    return { action: 'send_material', status: 'qualified', precision, purpose, confidence, riskFlags, reason: '高置信度，按目的分发素材' };
  }
  // 信息不足 → 追问，但不超过上限
  if (rounds < maxRounds) {
    return { action: 'ask', status: 'pending', precision, purpose, confidence, riskFlags, ask_rounds: rounds + 1, reason: '信息不足，追问第 ' + (rounds + 1) + ' 轮' };
  }
  // 追问到上限仍不明 → 转人工
  return { action: 'hold', status: 'review', precision, purpose, confidence, riskFlags, reason: '追问 ' + maxRounds + ' 轮仍无法判定，转人工' };
}

/** 已精准客户的状态：后续消息直接发素材，不再重复判定（除非人工在CRM改了置顶） */
function isQualified(current) {
  return !!(current && current.status === 'qualified');
}

/** 解析 AI 返回的 JSON（容错：剥离 ```json 代码块、前后杂字） */
function parseVerdict(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch (e) { return null; }
}

module.exports = {
  isPinned, humanReplied, isSensitive, isCoolingDown, quotaExceeded, chooseDecision,
  normalizePrecision, normalizePurpose, normalizeConfidence, normalizeRiskFlags, hasBlockingRisk, strongSignalCount, HARD_STOP_RE, decideQualification, isQualified, parseVerdict,
};
