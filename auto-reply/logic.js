'use strict';
// ============ 纯决策逻辑（不碰数据库、不发消息，便于独立自测） ============

const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const FACEBOOK_URL = 'https://www.facebook.com/caustechina/';
const FACEBOOK_INVITATIONS = {
  en: 'Feel free to follow our Facebook page for new door hardware designs.',
  zh: '欢迎关注我们的 Facebook 主页，看看最新的门锁五金款式。',
  fr: 'Suivez notre page Facebook pour découvrir nos nouveautés en quincaillerie de porte.',
  ar: 'يمكنك متابعة صفحتنا على فيسبوك للاطلاع على أحدث تصاميم مستلزمات الأبواب.',
  es: 'Puedes seguirnos en Facebook para ver nuestros nuevos diseños de herrajes para puertas.',
  ru: 'Подписывайтесь на нашу страницу в Facebook, чтобы увидеть новые модели дверной фурнитуры.',
  sw: 'Unaweza kufuata ukurasa wetu wa Facebook kuona miundo mipya ya vifaa vya milango.',
};

function facebookInvitation(language) {
  const key = String(language || '').toLowerCase().split(/[-_]/)[0];
  return (FACEBOOK_INVITATIONS[key] || FACEBOOK_INVITATIONS.en) + '\n' + FACEBOOK_URL;
}

function shouldCloseOffTopic(verdict, decision, current) {
  const signals = verdict.signals || {};
  return signals.consecutiveOffTopic === true && current?.status !== 'review'
    && (decision.action === 'ask' || decision.action === 'hold')
    && decision.precision === 'unknown' && !decision.notify && !decision.riskFlags?.length
    && !signals.quantityGiven && !signals.wantsSampleOrTour && signals.purchaseIntent !== 'none';
}

function phoneNumberRegion(chat) {
  if (!chat || Number(chat.is_group) || /@(?:g\.us|broadcast|newsletter)$/.test(chat.jid || '')) return '';
  const jidNumber = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(chat.jid || '');
  const raw = String(jidNumber?.[1] || chat.phone || '').trim();
  if (!/^\+?[\d()\s.-]+$/.test(raw)) return '';
  const digits = raw.replace(/\D/g, '');
  const number = parsePhoneNumberFromString('+' + (raw.startsWith('00') ? digits.slice(2) : digits), { extract: false });
  return number?.country && number.isValid() ? regionNames.of(number.country) + ' (+' + number.countryCallingCode + ')' : '';
}

const questionTopics = [
  /\b(?:smart locks?|mechanical locks?|digital locks?|electronic locks?|what (?:type|kind) of (?:door )?locks?|quel type de serrure)\b|(?:智能锁|机械锁|哪种锁|什么类型的锁|أقفال ذكية|أقفال ميكانيكية)/i,
  /\b(?:which city|what city|city are you|city should|city for delivery|quelle ville|dans quelle ville|qu[eé] ciudad)\b|(?:哪个城市|哪座城市|几线城市|أي مدينة|أيّ مدينة)/i,
  /\b(?:how many|what quantity|combien|cu[aá]nt[oa]s?|what volume)\b|(?:多少[件套箱个]|采购量|كم عدد)/i,
  /\b(?:imported from china|import from china|import experience|importer de chine|importado de china)\b|(?:中国进口经验|从中国进口过|从中国采购过)/i,
];

function hasBlockedQuestion(text, previousQuestions) {
  const questions = String(text || '').match(/[^.!?\n。！？؟]+[?？؟]/g) || [];
  const earlierQuestions = previousQuestions.flatMap(previous => previous.match(/[^.!?\n。！？؟]+[?？؟]/g) || []);
  return questions.some(question => {
    if (/\b(?:what country|which country|what is your country|country are you|quel pays|qu[eé] pa[ií]s)\b|(?:哪个国家|哪国|أي بلد|أي دولة)/i.test(question)) return true;
    const normalized = question.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    return earlierQuestions.some(previous => {
      const earlier = previous.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      return (normalized.length >= 8 && earlier.includes(normalized))
        || questionTopics.some(topic => topic.test(question) && topic.test(previous));
    });
  });
}

function trimRepeatedGreeting(text, hasOutgoing) {
  const clean = String(text || '').trim();
  if (!hasOutgoing) return clean;
  const body = clean.replace(/^(?:(?:hi|hello|hey|good morning|good afternoon|good evening|bonjour|salut|hola|olá|jambo|habari)(?:[ \t]+[\p{L}\p{M}'’.-]+)?|您好|你好|早上好|مرحبًا|مرحبا|السلام عليكم)(?:\s*[,，!！:：.。]\s*|$)/iu, '').trim();
  return body === clean ? clean : body.replace(/^\p{Ll}/u, letter => letter.toUpperCase());
}

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

/** 解析 'YYYY-MM-DD HH:MM:SS' 时间戳（wa_messages.ts / nowStr 同款格式），非法返回 null */
function parseTs(ts) {
  const s = String(ts || '').trim();
  if (!s) return null;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/** 静默时长（小时）：距最后一条客户消息多久没回音；时间戳非法返回 null */
function silenceHours(lastTs, nowMs) {
  const t = parseTs(lastTs);
  if (t === null) return null;
  const h = (Number(nowMs) - t) / 3600000;
  return h < 0 ? 0 : h;
}

/** 客户明确拒绝：整条消息就是拒绝 / 明确结束对话才算（只用于“14 天内不再跟进”）。
 * “这个型号不用了，换另一个”这种带“换/另一个/其他型号”的仍在谈，不算拒接。 */
const REFUSAL_RE = /^(我|我们)?(不感兴趣|没兴趣|暂时不需要|不需要了|不用了|不想要了|算了|不用麻烦了|别再发(消息)?|不要再联系(我)?|请勿打扰|not interested|no longer interested|do not contact( me)?|don'?t contact( me)?|stop messaging|no thanks|no need|not needed)[，。！!、,.\s]*(谢谢|thanks?|thank you)?[，。！!、,.\s]*$/i;
function isRefusal(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // 带有继续谈的意思（换型号/换一个）不算拒接
  if (/换|另一个|其他型号|换一个|another|other model|different model/i.test(s)) return false;
  return REFUSAL_RE.test(s);
}

/**
 * 主动跟进是否到点了（纯函数）。
 * state: { followupsSent 已跟进次数, closingSent 收尾是否已发,
 *          silenceHours 距最后一条客户消息的静默小时数,
 *          silenceSinceFollowupHours 距上次跟进的小时数（无跟进记录为 null） }
 * cfg: { minSilenceHours, maxSilenceHours, maxFollowups, sendClosing }
 * 返回 { due, kind: 'followup'|'closing'|null, reason }
 * 规则：首跟静默须落在 [min, max]（24–72h，太早不催、太晚不翻旧账）；
 * 第 2 次跟进距上次跟进满 min 小时；满 maxFollowups 次后只发一次礼貌收尾。
 */
function followupDue(state, cfg) {
  const s = state || {};
  const min = Number((cfg && cfg.minSilenceHours) || 24);
  const max = Number((cfg && cfg.maxSilenceHours) || 72);
  const maxN = Number((cfg && cfg.maxFollowups) || 2);
  const sent = Number(s.followupsSent) || 0;
  if (s.closingSent) return { due: false, kind: null, reason: '收尾已发，不再打扰' };
  if (sent >= maxN) {
    if (!(cfg && cfg.sendClosing)) return { due: false, kind: null, reason: '跟进次数已达上限，收尾开关关闭' };
    // 收尾也要看总静默：停工/重启后静默 30 天的客户不再发收尾
    const h = s.silenceHours;
    if (h === null || h === undefined) return { due: false, kind: null, reason: '无客户消息时间，无法发收尾' };
    const closingMax = max + min;
    if (h < min || h > closingMax) return { due: false, kind: null, reason: '总静默 ' + Math.round(h) + ' 小时不在 ' + min + '–' + closingMax + ' 小时窗口内，不发收尾' };
    const gap = s.silenceSinceFollowupHours;
    if (gap === null || gap === undefined) return { due: false, kind: null, reason: '无上次跟进时间，无法发收尾' };
    if (gap < min) return { due: false, kind: null, reason: '距上次跟进不足 ' + min + ' 小时' };
    return { due: true, kind: 'closing', reason: '跟进 ' + maxN + ' 次无回复，发礼貌收尾' };
  }
  if (sent === 0) {
    const h = s.silenceHours;
    if (h === null || h === undefined) return { due: false, kind: null, reason: '无客户消息时间，无法判断静默' };
    if (h < min) return { due: false, kind: null, reason: '静默不足 ' + min + ' 小时，不催' };
    if (h > max) return { due: false, kind: null, reason: '静默超过 ' + max + ' 小时，不翻旧账' };
    return { due: true, kind: 'followup', reason: '静默 ' + Math.round(h) + ' 小时，第 1 次跟进' };
  }
  const gap = s.silenceSinceFollowupHours;
  if (gap === null || gap === undefined) return { due: false, kind: null, reason: '无上次跟进时间' };
  if (gap < min) return { due: false, kind: null, reason: '距上次跟进不足 ' + min + ' 小时' };
  // 第 2 次跟进也要看总静默：客户最新消息太久远（>72 小时）的不再跟
  const h = s.silenceHours;
  if (h === null || h === undefined) return { due: false, kind: null, reason: '无客户消息时间，无法判断静默' };
  if (h < min || h > max) return { due: false, kind: null, reason: '总静默 ' + Math.round(h) + ' 小时不在 ' + min + '–' + max + ' 小时窗口内，不跟进' };
  return { due: true, kind: 'followup', reason: '距上次跟进 ' + Math.round(gap) + ' 小时，第 ' + (sent + 1) + ' 次跟进' };
}

/**
 * 要目录的新客户转人工原因（只用于 purpose=catalog 且非老客户）。
 * 报了采购量 / 要样品或视频看厂 → 人工接手给适配报价，不再自动追问。
 * 注意：v4 起不再“答了 2 轮就转人工”——客户没给具体需求之前继续一轮一问地挖，
 * 直到判精准或追问到上限（maxQualifyRounds，默认 6 轮）才转人工。
 * 返回原因字符串，不满足返回 null。
 */
function catalogHandoffReason(signals, rounds) {
  const s = signals || {};
  if (s.quantityGiven) return '客户已报采购量，转人工给适配报价';
  if (s.wantsSampleOrTour) return '客户要样品或视频看厂，转人工';
  return null;
}

/** 已挖到的信息摘要：追问到上限转人工时附上，让人工一眼看到客户已给过什么，不丢信息 */
function summarizeDugUp(verdict) {
  const v = verdict || {};
  const s = v.signals || {};
  const bits = [];
  if (s.productSpecific) bits.push('产品已具体');
  if (s.quantityGiven) bits.push('已报采购量');
  if (s.destinationGiven) bits.push('目的国已给');
  if (s.tradeTerms) bits.push('贸易条款已提');
  if (['explicit', 'inferred'].includes(String(s.importExperience || ''))) bits.push('有中国进口经验');
  if (s.buyerRole && s.buyerRole !== 'unknown') bits.push('角色：' + s.buyerRole);
  if (v.purpose && v.purpose !== 'other') bits.push('目的：' + v.purpose);
  if (v.evidence) bits.push('依据：' + String(v.evidence).slice(0, 200));
  return bits.length ? bits.join('；') : '暂无已挖到的具体信息';
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
  // "not qualified" 含 "qualified" 子串，必须最先排除，否则会被判 high
  if (/not\s+qualified/.test(s)) return 'low';
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
function decideQualification(verdict, current, cfg, opts) {
  let precision = normalizePrecision(verdict.precision);
  const purpose = normalizePurpose(verdict.purpose);
  const confidence = normalizeConfidence(verdict.confidence);
  const riskFlags = normalizeRiskFlags(verdict.riskFlags);
  const signals = verdict.signals || {};
  // 老客户直发必须交叉核对：只有会话已绑定客户（chat.customer_id 非空）才算老客户，
  // 光靠 AI 的 signals.existingCustomer 一次误判不能让未绑定新客户跳过“要目录先问后发”。
  // 未传 opts 时沿用旧口径（只看 AI 信号），worker 调用时必须显式传 customerBound。
  const customerBound = !opts || opts.customerBound !== false;
  const rounds = Number((current && current.ask_rounds) || 0);
  const maxRounds = Number((cfg && cfg.maxQualifyRounds) || 6);
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
  // 老客户要目录/报价/现货：不走三个问题，直接给资料（unknown 也直接给，不追问；low 已在上面处理）
  // 必须已绑定客户才算老客户直发，未绑定会话即使 AI 说是老客户也仍走追问
  if (signals.existingCustomer && customerBound && ['catalog', 'quote', 'stock'].includes(purpose)) {
    return { action: 'send_material', status: 'qualified', precision, purpose, confidence, riskFlags, reason: '老客户，直接发素材' };
  }
  // 确认精准 → 直接发素材（但要目录的新客户例外，见下）
  if (precision === 'high') {
    // 要目录的新客户：绝不直接发全套目录。先看是否该转人工，否则追问（一次一问）
    if (purpose === 'catalog') {
      const handoff = catalogHandoffReason(signals, rounds);
      if (handoff) {
        return { action: 'hold', status: 'review', precision, purpose, confidence, riskFlags, notify: true, reason: handoff };
      }
      if (rounds < maxRounds) {
        return { action: 'ask', status: 'pending', precision, purpose, confidence, riskFlags, ask_rounds: rounds + 1, reason: '要目录的新客户不直接发全套，追问第 ' + (rounds + 1) + ' 轮' };
      }
      // 追问到上限才转人工：只有真给过具体需求（至少 2 个强信号，如产品已具体 + 目的国/数量/贸易条款）
      // 才弹强通知；否则理由如实写“仍未给具体需求”，不弹通知
      const dugUpSpecific = strongSignalCount(signals) >= 2;
      return { action: 'hold', status: 'review', precision, purpose, confidence, riskFlags,
        notify: dugUpSpecific ? true : undefined,
        reason: dugUpSpecific
          ? '追问 ' + maxRounds + ' 轮，客户已给具体需求，转人工给适配报价｜已挖到：' + summarizeDugUp(verdict)
          : '追问 ' + maxRounds + ' 轮仍未给具体需求，转人工｜已挖到：' + summarizeDugUp(verdict) };
    }
    return { action: 'send_material', status: 'qualified', precision, purpose, confidence, riskFlags, reason: '高置信度，按目的分发素材' };
  }
  // 信息不足 → 追问，但不超过上限（要目录的新客户同样不直接发全套）
  if (rounds < maxRounds) {
    if (purpose === 'catalog' && !(signals.existingCustomer && customerBound)) {
      const handoff = catalogHandoffReason(signals, rounds);
      if (handoff) {
        // 与 high 分支同款 hold：给出具体需求（报采购量/要样品）都要带 notify
        return { action: 'hold', status: 'review', precision, purpose, confidence, riskFlags, notify: true, reason: handoff };
      }
    }
    return { action: 'ask', status: 'pending', precision, purpose, confidence, riskFlags, ask_rounds: rounds + 1, reason: '信息不足，追问第 ' + (rounds + 1) + ' 轮' };
  }
  // 追问到上限仍不明 → 转人工，附上已挖到的信息摘要（不丢信息；这类客户没给具体需求，不弹强通知）
  return { action: 'hold', status: 'review', precision, purpose, confidence, riskFlags, reason: '追问 ' + maxRounds + ' 轮仍无法判定，转人工｜已挖到：' + summarizeDugUp(verdict) };
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
  facebookInvitation, shouldCloseOffTopic,
  phoneNumberRegion, hasBlockedQuestion, trimRepeatedGreeting,
  isPinned, humanReplied, isSensitive, isCoolingDown, quotaExceeded, chooseDecision,
  normalizePrecision, normalizePurpose, normalizeConfidence, normalizeRiskFlags, hasBlockingRisk, strongSignalCount, HARD_STOP_RE, decideQualification, isQualified, parseVerdict,
  parseTs, silenceHours, isRefusal, followupDue, catalogHandoffReason, summarizeDugUp,
};
