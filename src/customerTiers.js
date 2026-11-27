'use strict';
// ============ 客户 A/B/C/D 分层：贡献值计算、人工覆盖、周期动作 ============
const { db, run, get, all } = require('./db');
const { todayStr, nowStr, addDays } = require('./util');

const VALID_TIERS = ['A', 'B', 'C', 'D'];
const TIER_META = {
  A: { label: 'A类大客户', short: 'A类', action: '每周固定沟通', note: '每周至少联系一次，即使只是打招呼。' },
  B: { label: 'B类潜力客户', short: 'B类', action: '每月定制简报', note: '每月发送一次结合国家与行业的定制化简报。' },
  C: { label: 'C类普通客户', short: 'C类', action: '系统群发', note: '进入群发名单，不投入一对一高频维护。' },
  D: { label: 'D类放弃客户', short: 'D类', action: '停止主动联系', note: '不进入提醒和群发，保留全部历史数据。' },
};

// 系统没有实时汇率接口，贡献值统一折算为人民币，避免 USD/CNY 单据直接相加。
const CURRENCY_TO_CNY = {
  CNY: 1, RMB: 1, USD: 7.2, EUR: 7.8, GBP: 9.2, JPY: 0.048,
  AUD: 4.7, CAD: 5.2, HKD: 0.92, AED: 1.96, SAR: 1.92,
  RUB: 0.075, INR: 0.086, KRW: 0.0052, SGD: 5.35,
};

const RULES = {
  aRevenueCny: 20000,
  aPaidOrders: 3,
  bScore: 35,
  inactiveDays: 180,
  recentDays: 90,
  cacheMs: 60 * 1000,
};

const lastCalculated = new Map();

function parseDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0);
}

function daysSince(value, now) {
  const dt = parseDate(value);
  if (!dt) return null;
  const base = now || new Date();
  return Math.max(0, Math.floor((base.getTime() - dt.getTime()) / 86400000));
}

function maxDate() {
  let best = '';
  for (const value of arguments) {
    const s = String(value || '').trim();
    if (s && s > best) best = s;
  }
  return best;
}

function currencyRate(currency) {
  const key = String(currency || 'CNY').trim().toUpperCase();
  return key === 'NGN' ? 0 : (CURRENCY_TO_CNY[key] || 1);
}

function round(n, digits) {
  const p = Math.pow(10, digits == null ? 2 : digits);
  return Math.round((Number(n) || 0) * p) / p;
}

function scoreCustomer(metrics) {
  const paid = Math.max(0, Number(metrics && metrics.paidCny) || 0);
  const orders = Math.max(0, Number(metrics && metrics.paidOrders) || 0);
  const lastPaidDays = metrics && metrics.lastPaidDays;
  const quotes = Math.max(0, Number(metrics && metrics.recentQuotes) || 0);
  const inquiries = Math.max(0, Number(metrics && metrics.recentInquiries) || 0);
  const docs = Math.max(0, Number(metrics && metrics.recentDocs) || 0);
  const follows = Math.max(0, Number(metrics && metrics.recentFollows) || 0);

  const paymentScore = paid > 0
    ? Math.min(70, 70 * Math.log10(1 + paid / 1000) / Math.log10(1 + RULES.aRevenueCny / 1000))
    : 0;
  const orderScore = Math.min(10, orders * 2.5);
  const recencyScore = lastPaidDays !== null && lastPaidDays !== undefined && lastPaidDays <= 365
    ? Math.max(0, 10 * (1 - lastPaidDays / 365))
    : 0;
  const potentialScore = Math.min(10,
    Math.min(4.5, quotes * 1.5) +
    Math.min(3, inquiries * 2) +
    Math.min(2.5, docs * 1.25) +
    Math.min(1.5, follows * 0.15)
  );
  return round(Math.min(100, paymentScore + orderScore + recencyScore + potentialScore), 1);
}

function determineTier(customer, metrics, score, now) {
  const override = VALID_TIERS.includes(String(customer.tier_override || '').toUpperCase())
    ? String(customer.tier_override).toUpperCase()
    : '';
  if (Number(customer.do_not_contact) === 1) {
    return { tier: 'D', source: 'manual', reason: '已标记禁止主动联系，保留历史数据但不进入提醒和群发' };
  }
  if (override) {
    return { tier: override, source: 'manual', reason: '人工指定为 ' + override + ' 类，自动贡献值作为参考' };
  }

  const paid = Number(metrics.paidCny) || 0;
  const orders = Number(metrics.paidOrders) || 0;
  if (paid >= RULES.aRevenueCny || orders >= RULES.aPaidOrders || score >= 80) {
    const reason = paid >= RULES.aRevenueCny
      ? '近12个月实际回款折合 ¥' + round(paid).toLocaleString('zh-CN') + '，达到 A 类门槛'
      : orders >= RULES.aPaidOrders
        ? '近12个月有 ' + orders + ' 笔已回款订单，客户稳定复购'
        : '综合贡献值达到 A 类门槛';
    return { tier: 'A', source: 'auto', reason };
  }

  const hasCommercialSignal = Number(metrics.recentQuotes) > 0 || Number(metrics.recentDocs) > 0 || Number(metrics.recentInquiries) > 0;
  if (paid > 0 || hasCommercialSignal || score >= RULES.bScore) {
    const reason = paid > 0
      ? '近12个月实际回款折合 ¥' + round(paid).toLocaleString('zh-CN') + '，暂未达到 A 类门槛'
      : '近90天有报价、单据或询盘信号，属于重点培育客户';
    return { tier: 'B', source: 'auto', reason };
  }

  const lastTouchDays = daysSince(metrics.lastTouch || customer.created_at, now);
  if (lastTouchDays !== null && lastTouchDays > RULES.inactiveDays) {
    return { tier: 'D', source: 'auto', reason: '超过 ' + RULES.inactiveDays + ' 天无有效商业触点，停止主动投入' };
  }
  return { tier: 'C', source: 'auto', reason: '近180天有联系或属于新客户，暂未形成高贡献或明确潜力' };
}

function calculateForUser(userId, now) {
  const uid = Number(userId) || 0;
  const base = now || new Date();
  const since12 = addDays(todayStr(base), -365) + ' 00:00:00';
  const since90 = addDays(todayStr(base), -RULES.recentDays) + ' 00:00:00';
  const customers = all(`SELECT * FROM customers
    WHERE user_id=? AND COALESCE(in_pool,0)=0 ORDER BY id`, uid);
  const metricsByCustomer = new Map();
  const metric = (id) => {
    if (!metricsByCustomer.has(id)) {
      metricsByCustomer.set(id, {
        paidCny: 0, paidOrders: 0, lastPaid: '', lastFollow: '', lastQuote: '', lastDoc: '', lastInquiry: '',
        recentFollows: 0, recentQuotes: 0, recentDocs: 0, recentInquiries: 0, openTasks: 0,
      });
    }
    return metricsByCustomer.get(id);
  };

  const paidRows = all(`SELECT d.customer_id, d.currency, COALESCE(SUM(pr.amount),0) amount,
      COUNT(DISTINCT pr.doc_id) orders, MAX(pr.paid_at) last_paid
    FROM payment_records pr JOIN documents d ON d.id=pr.doc_id
    WHERE d.user_id=? AND COALESCE(d.status,'')<>'已作废' AND substr(COALESCE(pr.paid_at,d.created_at),1,19)>=?
    GROUP BY d.customer_id, d.currency`, uid, since12);
  for (const row of paidRows) {
    const m = metric(row.customer_id);
    m.paidCny += (Number(row.amount) || 0) * currencyRate(row.currency);
    m.paidOrders += Number(row.orders) || 0;
    m.lastPaid = maxDate(m.lastPaid, row.last_paid);
  }

  const followRows = all(`SELECT customer_id, MAX(activity_date) last_follow,
      COALESCE(SUM(CASE WHEN activity_date>=? THEN 1 ELSE 0 END),0) recent_follows,
      COALESCE(SUM(CASE WHEN COALESCE(archived,0)=0 THEN 1 ELSE 0 END),0) open_tasks
    FROM activities WHERE user_id=? GROUP BY customer_id`, since90, uid);
  for (const row of followRows) {
    const m = metric(row.customer_id);
    m.lastFollow = maxDate(m.lastFollow, row.last_follow);
    m.recentFollows = Number(row.recent_follows) || 0;
    m.openTasks = Number(row.open_tasks) || 0;
  }

  const quoteRows = all(`SELECT customer_id, MAX(quote_date) last_quote,
      COALESCE(SUM(CASE WHEN quote_date>=? THEN 1 ELSE 0 END),0) recent_quotes
    FROM quote_history WHERE user_id=? GROUP BY customer_id`, since90, uid);
  for (const row of quoteRows) {
    const m = metric(row.customer_id);
    m.lastQuote = maxDate(m.lastQuote, row.last_quote);
    m.recentQuotes = Number(row.recent_quotes) || 0;
  }

  const docRows = all(`SELECT customer_id, MAX(created_at) last_doc,
      COALESCE(SUM(CASE WHEN created_at>=? AND COALESCE(status,'') NOT IN ('草稿','已作废') THEN 1 ELSE 0 END),0) recent_docs
    FROM documents WHERE user_id=? AND customer_id>0 GROUP BY customer_id`, since90, uid);
  for (const row of docRows) {
    const m = metric(row.customer_id);
    m.lastDoc = maxDate(m.lastDoc, row.last_doc);
    m.recentDocs = Number(row.recent_docs) || 0;
  }

  const inquiryRows = all(`SELECT i.customer_id, MAX(i.created_at) last_inquiry,
      COALESCE(SUM(CASE WHEN i.created_at>=? THEN 1 ELSE 0 END),0) recent_inquiries
    FROM website_inquiries i JOIN customers c ON c.id=i.customer_id
    WHERE c.user_id=? AND i.customer_id IS NOT NULL GROUP BY i.customer_id`, since90, uid);
  for (const row of inquiryRows) {
    const m = metric(row.customer_id);
    m.lastInquiry = maxDate(m.lastInquiry, row.last_inquiry);
    m.recentInquiries = Number(row.recent_inquiries) || 0;
  }

  return customers.map((customer) => {
    const m = metric(customer.id);
    m.paidCny = round(m.paidCny);
    m.lastPaidDays = m.lastPaid ? daysSince(m.lastPaid, base) : null;
    m.lastTouch = maxDate(customer.created_at, m.lastPaid, m.lastFollow, m.lastQuote, m.lastDoc, m.lastInquiry);
    m.lastTouchDays = m.lastTouch ? daysSince(m.lastTouch, base) : null;
    const score = scoreCustomer(m);
    const decision = determineTier(customer, m, score, base);
    return { customer, metrics: m, score, tier: decision.tier, source: decision.source, reason: decision.reason };
  });
}

function refreshTiers(userId, options) {
  const uid = Number(userId) || 0;
  const opts = options || {};
  const cachedAt = lastCalculated.get(uid) || 0;
  if (!opts.force && Date.now() - cachedAt < RULES.cacheMs) return;
  const rows = calculateForUser(uid, opts.now || new Date());
  const stamp = nowStr();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const c = row.customer;
      const changed = c.customer_tier !== row.tier || c.tier_source !== row.source ||
        Number(c.tier_score || 0) !== Number(row.score || 0) || String(c.tier_reason || '') !== row.reason;
      if (changed || opts.force) {
        run(`UPDATE customers SET customer_tier=?, tier_source=?, tier_score=?, tier_reason=?, tier_updated_at=? WHERE id=?`,
          row.tier, row.source, row.score, row.reason, stamp, c.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }
  lastCalculated.set(uid, Date.now());
}

function tierRows(userId, options) {
  const uid = Number(userId) || 0;
  refreshTiers(uid, options);
  return all(`SELECT * FROM customers WHERE user_id=? AND COALESCE(in_pool,0)=0
    ORDER BY CASE customer_tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 WHEN 'D' THEN 3 ELSE 4 END,
      tier_score DESC, updated_at DESC`, uid);
}

function tierSummary(userId, options) {
  const rows = tierRows(userId, options);
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of rows) if (counts[row.customer_tier] !== undefined) counts[row.customer_tier]++;
  return {
    counts,
    total: rows.length,
  };
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

function autoActionForTier(tier) {
  if (tier === 'A') return { type: 'weekly_contact', period: 'week:' + todayStr(startOfWeek(new Date())) };
  if (tier === 'B') return { type: 'monthly_brief', period: 'month:' + todayStr().slice(0, 7) };
  return null;
}

function actionDueDate(type) {
  const today = todayStr();
  if (type === 'weekly_contact') {
    const friday = addDays(todayStr(startOfWeek(new Date())), 4);
    return friday < today ? today : friday;
  }
  const monthEnd = today.slice(0, 8) + '25';
  return monthEnd < today ? today : monthEnd;
}

function ensureTierActions(userId) {
  const uid = Number(userId) || 0;
  refreshTiers(uid);
  const customers = all(`SELECT * FROM customers WHERE user_id=? AND COALESCE(in_pool,0)=0`, uid);
  const byId = new Map(customers.map(c => [Number(c.id), c]));
  const stamp = nowStr();
  let created = 0;
  let cancelled = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    const pending = all(`SELECT ta.*, a.archived
      FROM tier_actions ta LEFT JOIN activities a ON a.id=ta.activity_id
      WHERE ta.user_id=? AND ta.status='pending'`, uid);
    for (const action of pending) {
      const customer = byId.get(Number(action.customer_id));
      const expected = customer ? autoActionForTier(customer.customer_tier) : null;
      if (!customer || !expected || expected.type !== action.action_type) {
        if (action.activity_id && !Number(action.archived)) {
          run(`UPDATE activities SET archived=1, completed_at=?, outcome=? WHERE id=? AND user_id=?`,
            stamp, '客户分层已变更，系统自动关闭该周期动作', action.activity_id, uid);
        }
        run(`UPDATE tier_actions SET status='cancelled', completed_at=? WHERE id=?`, stamp, action.id);
        cancelled++;
      } else if (action.activity_id && Number(action.archived)) {
        run(`UPDATE tier_actions SET status='completed', completed_at=COALESCE(completed_at,?) WHERE id=?`, stamp, action.id);
      }
    }

    for (const customer of customers) {
      const spec = autoActionForTier(customer.customer_tier);
      if (!spec) continue;
      const exists = get(`SELECT id FROM tier_actions WHERE customer_id=? AND action_type=? AND period_key=?`,
        customer.id, spec.type, spec.period);
      if (exists) continue;
      const actionId = Number(run(`INSERT INTO tier_actions(customer_id,user_id,tier,action_type,period_key,status,created_at)
        VALUES(?,?,?,?,?,'pending',?)`, customer.id, uid, customer.customer_tier, spec.type, spec.period, stamp).lastInsertRowid);
      const isA = spec.type === 'weekly_contact';
      const contact = get(`SELECT name FROM contacts WHERE customer_id=? ORDER BY COALESCE(is_primary,0) DESC, id ASC LIMIT 1`, customer.id);
      const subject = isA ? 'A类客户周度沟通' : 'B类客户月度行业简报';
      const briefing = isA
        ? '本周固定联系客户，即使只是打招呼，也要确认订单、交期、库存或近期需求。'
        : '结合客户国家（' + (customer.country || '未填写') + '）和行业（' + (customer.industry || '未填写') + '）准备定制化行业简报，发送前人工审核。';
      const activity = run(`INSERT INTO activities(customer_id,type,subject,content,contact_person,activity_date,
          next_follow_date,next_follow_notes,images,created_by,user_id,created_at,priority,outcome,archived)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        customer.id, '其他', subject, briefing, customer.contact_person || (contact && contact.name) || '',
        stamp, actionDueDate(spec.type), TIER_META[customer.customer_tier].note, '[]', '客户分层自动化', uid, stamp,
        isA ? '高' : '中', '');
      run('UPDATE tier_actions SET activity_id=? WHERE id=?', Number(activity.lastInsertRowid), actionId);
      created++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }
  return { created, cancelled };
}

function setTierOverride(userId, customerId, override, doNotContact) {
  const uid = Number(userId) || 0;
  const cid = Number(customerId) || 0;
  const customer = get('SELECT id FROM customers WHERE id=? AND user_id=? AND COALESCE(in_pool,0)=0', cid, uid);
  if (!customer) throw new Error('客户不存在或无权操作');
  const value = String(override || '').trim().toUpperCase();
  if (value && !VALID_TIERS.includes(value)) throw new Error('客户分层只能是 A/B/C/D 或自动');
  run(`UPDATE customers SET tier_override=?, do_not_contact=?, updated_at=? WHERE id=? AND user_id=?`,
    value, doNotContact ? 1 : 0, nowStr(), cid, uid);
  refreshTiers(uid, { force: true });
  return ensureTierActions(uid);
}

function campaignRecipients(userId, ids) {
  const uid = Number(userId) || 0;
  const requested = Array.isArray(ids) ? ids.map(Number).filter(n => n > 0) : [];
  if (!requested.length) return [];
  refreshTiers(uid);
  const ph = requested.map(() => '?').join(',');
  return all(`SELECT * FROM customers WHERE user_id=? AND customer_tier='C' AND COALESCE(do_not_contact,0)=0
    AND COALESCE(in_pool,0)=0 AND id IN (${ph}) ORDER BY id`, uid, ...requested);
}

function logCampaign(userId, message, total, sent, failed, details) {
  run(`INSERT INTO tier_campaigns(user_id,tier,message,total,sent,failed,details,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, Number(userId) || 0, 'C', message, total, sent, failed,
    JSON.stringify(details || []).slice(0, 200000), nowStr());
}

module.exports = {
  VALID_TIERS, TIER_META, RULES, CURRENCY_TO_CNY,
  parseDate, daysSince, scoreCustomer, determineTier, calculateForUser,
  refreshTiers, tierRows, tierSummary, ensureTierActions, setTierOverride,
  campaignRecipients, logCampaign,
};
