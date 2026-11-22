'use strict';
// ============ 外贸客户自动回复工作台 · 常驻 worker ============
// 独立运行，不改动主系统任何代码。
// 数据来源：只读打开 ../data/crm.db 的 wa_messages / wa_chats
// 发送通道：带 session cookie 调主系统 /api/wa/draft 与 /whatsapp/send
// 本地状态：state.db（游标、冷却、额度、日志），不写主库

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const logic = require('./logic');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.db');
const PID_PATH = path.join(DIR, 'worker.pid');
const CRM_DB_PATH = path.resolve(DIR, '..', 'data', 'crm.db');

let cfg = loadConfig();
let state = null;
let crm = null;
let running = true;
let inTick = false;
let cookieUserId = 0; // session 解析出的 user_id

function pidAlive(pid) {
  const n = Number(pid) || 0;
  if (!n) return false;
  try { process.kill(n, 0); return true; } catch (e) { return false; }
}

function acquireWorkerPid() {
  try {
    if (fs.existsSync(PID_PATH)) {
      const oldPid = Number(fs.readFileSync(PID_PATH, 'utf8').trim()) || 0;
      if (oldPid && oldPid !== process.pid && pidAlive(oldPid)) {
        console.error('已有 auto-reply worker 正在运行，PID=' + oldPid);
        process.exit(0);
      }
    }
    fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  } catch (e) { console.error('写入 worker.pid 失败：' + e.message); }
}

function releaseWorkerPid() {
  try {
    if (!fs.existsSync(PID_PATH)) return;
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim()) || 0;
    if (pid === process.pid) fs.unlinkSync(PID_PATH);
  } catch (e) {}
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function todayStr() { return nowStr().slice(0, 10); }

function log(level, msg) {
  const line = '[' + nowStr() + '] [' + level + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(path.join(DIR, cfg.logFile || 'auto-reply.log'), line + '\n', 'utf8');
  } catch (e) { /* 日志写失败不影响主流程 */ }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- 本地状态库 ---------------- */
function initState() {
  state = new DatabaseSync(STATE_PATH);
  state.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_db_id INTEGER,
      chat_key TEXT,
      chat_name TEXT,
      action TEXT,
      reason TEXT,
      draft TEXT,
      message_count INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0,
      at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sent_log_chat ON sent_log(chat_key, at);
    CREATE INDEX IF NOT EXISTS idx_sent_log_at ON sent_log(at);
    CREATE TABLE IF NOT EXISTS qualification (
      chat_key TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      precision TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      language TEXT DEFAULT '',
      evidence TEXT DEFAULT '',
      ask_rounds INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,
      signals TEXT DEFAULT '{}',
      risk_flags TEXT DEFAULT '[]',
      prompt_version TEXT DEFAULT '',
      updated_at TEXT
    );
  `);
  ensureStateColumn('qualification', 'confidence', 'REAL DEFAULT 0');
  ensureStateColumn('qualification', 'signals', "TEXT DEFAULT '{}'");
  ensureStateColumn('qualification', 'risk_flags', "TEXT DEFAULT '[]'");
  ensureStateColumn('qualification', 'prompt_version', "TEXT DEFAULT ''");
  ensureStateColumn('sent_log', 'message_count', 'INTEGER DEFAULT 0');
  ensureStateColumn('sent_log', 'file_count', 'INTEGER DEFAULT 0');
}

function ensureStateColumn(table, column, definition) {
  try {
    const cols = state.prepare('PRAGMA table_info(' + table + ')').all();
    if (!cols.some(c => c.name === column)) state.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  } catch (e) { log('WARN', '状态库升级字段失败 ' + table + '.' + column + '：' + e.message); }
}

/* ---------------- 资格状态存取 ---------------- */
function getQualification(chatKey) {
  const r = state.prepare('SELECT * FROM qualification WHERE chat_key=?').get(chatKey);
  return r || null;
}
function saveQualification(chatKey, data) {
  state.prepare(`INSERT INTO qualification(chat_key,status,precision,purpose,language,evidence,ask_rounds,confidence,signals,risk_flags,prompt_version,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_key) DO UPDATE SET
      status=excluded.status, precision=excluded.precision, purpose=excluded.purpose,
      language=excluded.language, evidence=excluded.evidence, ask_rounds=excluded.ask_rounds,
      confidence=excluded.confidence, signals=excluded.signals, risk_flags=excluded.risk_flags,
      prompt_version=excluded.prompt_version, updated_at=excluded.updated_at`).run(
    chatKey, data.status || 'pending', data.precision || '', data.purpose || '',
    data.language || '', data.evidence || '', Number(data.ask_rounds) || 0,
    Number(data.confidence) || 0, JSON.stringify(data.signals || {}), JSON.stringify(data.riskFlags || []),
    data.promptVersion || '', nowStr());
}

function metaGet(key, def) {
  const r = state.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? r.value : def;
}
function metaSet(key, value) {
  state.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

/* ---------------- 主库只读连接 ---------------- */
function initCrm() {
  if (!fs.existsSync(CRM_DB_PATH)) throw new Error('找不到主库：' + CRM_DB_PATH);
  crm = new DatabaseSync(CRM_DB_PATH, { readOnly: true });
  // 只读打开无需建表，这里只验证关键表可读
  crm.prepare('SELECT id FROM wa_messages LIMIT 1').get();
  crm.prepare('SELECT id, pinned_at FROM wa_chats LIMIT 1').get();
}

/* ---------------- HTTP 调用主系统 ---------------- */
function cookieHeader() {
  const sid = String(cfg.sessionCookie || '').trim();
  if (!sid) throw new Error('config.json 的 sessionCookie 为空，请先登录 CRM 并抓取 crm_sid');
  return 'crm_sid=' + encodeURIComponent(sid);
}

async function apiGet(urlPath) {
  const resp = await fetch(cfg.crmBaseUrl + urlPath, {
    method: 'GET',
    headers: { Cookie: cookieHeader(), Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  let body = null;
  try { body = await resp.json(); } catch (e) { body = null; }
  return { status: resp.status, body };
}

async function apiPostForm(urlPath, form) {
  const resp = await fetch(cfg.crmBaseUrl + urlPath, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30000),
  });
  let body = null;
  try { body = await resp.json(); } catch (e) { body = null; }
  return { status: resp.status, body };
}

/** 发送文本（v1 原有通道，抽出来复用） */
async function sendText(chatId, text) {
  return apiPostForm('/whatsapp/send', { chat_id: chatId, text });
}

/** 用 multipart 发送一个文件（画册/报价/现货图），caption 作为附言 */
async function sendFile(chatId, absPath, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('text', String(caption || ''));
  const buf = fs.readFileSync(absPath);
  const filename = path.basename(absPath);
  fd.append('attachment', new Blob([buf], { type: mimeOf(filename) }), filename);
  const resp = await fetch(cfg.crmBaseUrl + '/whatsapp/send', {
    method: 'POST',
    headers: { Cookie: cookieHeader(), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    body: fd,
    signal: AbortSignal.timeout(60000),
  });
  let body = null;
  try { body = await resp.json(); } catch (e) { body = null; }
  return { status: resp.status, body };
}

function mimeOf(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const map = {
    '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  };
  return map[ext] || 'application/octet-stream';
}

/** 启动时解析 cookie 对应的 user_id（通过 /api/wa/status 拿不到，退回配置或用 draft 探测） */
async function resolveUserId() {
  if (Number(cfg.botUserId) > 0) return Number(cfg.botUserId);
  // 读 sessions 表：用已知 token 反查 user_id（只读，权限最小）
  const sid = String(cfg.sessionCookie || '').trim();
  if (!sid) return 0;
  try {
    const r = crm.prepare('SELECT user_id FROM sessions WHERE token=?').get(sid);
    return r ? Number(r.user_id) : 0;
  } catch (e) { return 0; }
}

/* ---------------- 业务判定 ---------------- */
function getChat(accountId, jid) {
  return crm.prepare('SELECT * FROM wa_chats WHERE account_id=? AND jid=?').get(accountId, jid) || null;
}

function getLastMsg(accountId, jid) {
  return crm.prepare('SELECT from_me, text, id FROM wa_messages WHERE account_id=? AND chat_jid=? ORDER BY id DESC LIMIT 1')
    .get(accountId, jid) || null;
}

function lastAutoReplyAt(chatKey) {
  return metaGet('last_reply:' + chatKey, '');
}

function sentToday() {
  const r = state.prepare("SELECT COUNT(*) AS n FROM sent_log WHERE action='sent' AND substr(at,1,10)=?").get(todayStr());
  return r ? Number(r.n) : 0;
}
function sentCustomersToday() {
  const r = state.prepare("SELECT COUNT(DISTINCT chat_key) AS n FROM sent_log WHERE action='sent' AND substr(at,1,10)=?").get(todayStr());
  return r ? Number(r.n) : 0;
}
function chatSentToday(chatKey) {
  const r = state.prepare("SELECT COUNT(*) AS n FROM sent_log WHERE action='sent' AND chat_key=? AND substr(at,1,10)=?").get(chatKey, todayStr());
  return r ? Number(r.n) : 0;
}
function materialPackagesToday() {
  const r = state.prepare("SELECT COUNT(*) AS n FROM sent_log WHERE action='sent' AND reason LIKE '%material:%' AND substr(at,1,10)=?").get(todayStr());
  return r ? Number(r.n) : 0;
}
function filesSentToday() {
  const r = state.prepare("SELECT COALESCE(SUM(file_count),0) AS n FROM sent_log WHERE action='sent' AND substr(at,1,10)=?").get(todayStr());
  return r ? Number(r.n) : 0;
}

function recordLog(row) {
  state.prepare(`INSERT INTO sent_log(msg_db_id,chat_key,chat_name,action,reason,draft,message_count,file_count,at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    row.msgDbId || 0, row.chatKey || '', row.chatName || '', row.action || '',
    row.reason || '', row.draft || '', Number(row.messageCount) || 0, Number(row.fileCount) || 0, row.at || nowStr());
}

/* ---------------- 单个会话处理 ---------------- */
async function processChat(item) {
  const chatKey = item.account_id + ':' + item.chat_jid;
  const msgId = item.last_customer_id;
  const chat = getChat(item.account_id, item.chat_jid);

  // 会话不存在 / 属于其他账号 → 跳过
  if (!chat) {
    recordLog({ msgDbId: msgId, chatKey, action: 'skip', reason: '会话不存在' });
    return;
  }
  // 只处理 session 对应账号名下的会话（避免越权发送）
  if (cookieUserId && !ownsChat(chat)) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'skip', reason: '会话不属于当前登录账号' });
    return;
  }
  // 群聊跳过
  if (cfg.skipGroups && Number(chat.is_group) === 1) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'skip', reason: '群聊不自动回复' });
    return;
  }
  // 必须绑定客户
  if (cfg.requireCustomerBound && !chat.customer_id) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'skip', reason: '会话未绑定客户' });
    return;
  }

  const last = getLastMsg(item.account_id, item.chat_jid);
  const customerText = item.text || '';
  // v2 下普通价格/报价词作为判定信号；投诉、退款、律师、付款争议仍必须人工处理
  const hitSensitive = logic.isSensitive(customerText, cfg.sensitiveWords);
  if (cfg.qualify && cfg.qualify.enabled && logic.HARD_STOP_RE.test(customerText)) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'hold', reason: '命中高风险词，转人工：' + hitSensitive.join('、') });
    log('WARN', (chat.name || item.chat_jid) + ' 命中高风险词，未调用 AI、未发送');
    return;
  }
  const batchQuotaHit = logic.quotaExceeded(sentToday(), cfg.dailyLimit);
  const customerLimit = Number(cfg.dailyUniqueCustomers) || 0;
  const customerQuotaHit = !chatSentToday(chatKey) && customerLimit > 0 && sentCustomersToday() >= customerLimit;
  let quotaReason = '';
  if (batchQuotaHit) quotaReason = '今日自动回复批次已达上限 ' + cfg.dailyLimit;
  else if (customerQuotaHit) quotaReason = '今日自动覆盖客户数已达上限 ' + customerLimit;
  const decision = logic.chooseDecision({
    pinned: logic.isPinned(chat),
    human: logic.humanReplied(last),
    cooling: logic.isCoolingDown(lastAutoReplyAt(chatKey), Date.now(), cfg.cooldownMinutes),
    quota: !!(batchQuotaHit || customerQuotaHit),
    sensitive: (cfg.qualify && cfg.qualify.enabled) ? [] : hitSensitive,
  });
  if (quotaReason && decision.action === 'skip') decision.reason = quotaReason;

  if (decision.action !== 'send') {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: decision.action, reason: decision.reason });
    log('INFO', '跳过 ' + (chat.name || item.chat_jid) + '：' + decision.reason);
    return;
  }

  // ============ v2 资格判定模式 ============
  if (cfg.qualify && cfg.qualify.enabled) {
    await processQualified(item, chat, chatKey, msgId, customerText, hitSensitive);
    return;
  }

  // ============ v1 简单回复模式（保留） ============
  if (!cfg.enabled) {
    const draft = await draftOf(chat.id);
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'dry', reason: '观察模式未发送', draft: draft.text || draft.error || '' });
    log('OBSERVE', (chat.name || item.chat_jid) + ' → ' + (draft.text || draft.error || '(无草稿)').slice(0, 120));
    return;
  }

  const draft = await draftOf(chat.id);
  if (!draft.ok) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'error', reason: '草稿生成失败：' + (draft.error || '') });
    log('ERROR', '草稿生成失败 ' + (chat.name || item.chat_jid) + '：' + (draft.error || ''));
    return;
  }
  await deliver(chat, chatKey, msgId, [{ type: 'text', text: draft.text }], draft.text);
}

/** v2 核心：资格判定 → 按状态发素材/追问/放弃 */
async function processQualified(item, chat, chatKey, msgId, customerText, hitSensitive) {
  const name = chat.name || item.chat_jid;
  const q = getQualification(chatKey);
  let verdict = null;
  let decision = null;

  if (logic.isQualified(q)) {
    // 已精准：不再重复调用 AI；只有客户明确提到新目的时才切换素材类型
    const requestedPurpose = logic.normalizePurpose(customerText);
    const purpose = requestedPurpose !== 'other' ? requestedPurpose : (q.purpose || 'catalog');
    decision = { action: 'send_material', purpose, precision: 'high', confidence: Number(q.confidence) || 1,
      riskFlags: (() => { try { return JSON.parse(q.risk_flags || '[]'); } catch (e) { return []; } })(),
      reason: '已判定精准，检查素材是否已发送' };
    verdict = { language: q.language, reply: '', precision: 'high', purpose };
  } else {
    // 调 AI 判定
    const context = buildJudgeContext(item, chat, hitSensitive);
    const judge = await require('./qualify').judge(context);
    if (!judge.ok) {
      recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'error', reason: '资格判定失败：' + judge.error });
      log('ERROR', '资格判定失败 ' + name + '：' + judge.error);
      return;
    }
    verdict = judge.verdict;
    decision = logic.decideQualification(verdict, q, cfg.qualify);
    // 保存判定状态
    saveQualification(chatKey, {
      status: decision.status,
      precision: decision.precision,
      purpose: decision.purpose,
      language: verdict.language,
      evidence: verdict.evidence,
      ask_rounds: decision.ask_rounds !== undefined ? decision.ask_rounds : (q && q.ask_rounds) || 0,
      confidence: decision.confidence,
      signals: verdict.signals,
      riskFlags: decision.riskFlags || verdict.riskFlags,
      promptVersion: judge.promptVersion,
    });
    // 敏感词作为判定附注写入证据
    if (hitSensitive.length) {
      log('INFO', name + ' 命中敏感词（供判定参考）：' + hitSensitive.join('、'));
    }
    log('JUDGE', name + ' → 精准度=' + decision.precision + ' 置信度=' + Number(decision.confidence || 0).toFixed(2) + ' 目的=' + decision.purpose + ' 风险=' + ((decision.riskFlags || verdict.riskFlags || []).join(',') || '无') + ' AI尝试=' + (judge.attempts || 1) + ' 依据=' + verdict.evidence);
  }

  // 根据决策分流
  const sends = [];
  if (decision.action === 'unqualified') {
    recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'unqualified', reason: decision.reason + '｜' + verdict.evidence, draft: verdict.reply });
    log('INFO', name + '：' + decision.reason + '，不发消息');
    return;
  }
  if (decision.action === 'hold') {
    recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'hold', reason: decision.reason + '｜' + verdict.evidence, draft: verdict.reply });
    log('WARN', name + '：' + decision.reason);
    return;
  }
  if (decision.action === 'ask') {
    if (!verdict.reply) {
      recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'error', reason: 'AI 未生成追问文本' });
      return;
    }
    sends.push({ type: 'text', text: verdict.reply });
    await deliver(chat, chatKey, msgId, sends, verdict.reply, 'qualify_ask');
    return;
  }
  // send_material：按目的准备素材
  const material = prepareMaterial(decision.purpose);
  if (cfg.qualify.sendMaterialPackage && material.fallback && !material.files.length) {
    recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'hold', reason: '客户要报价但 materials 中没有报价文件，转人工补正式报价', draft: verdict.reply });
    log('WARN', name + '：缺报价文件，未发送');
    return;
  }
  const materialLimit = Number(cfg.qualify.dailyMaterialPackages) || 0;
  if (material.files.length && materialLimit > 0 && materialPackagesToday() >= materialLimit) {
    recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'hold', reason: '今日素材包数量已达上限 ' + materialLimit + '，转人工处理', draft: verdict.reply });
    log('WARN', name + '：今日素材包额度已用尽，转人工');
    return;
  }
  const plannedFileCount = cfg.qualify.sendMaterialPackage ? material.files.length : 0;
  const fileLimit = Number(cfg.qualify.dailyFiles) || 0;
  if (plannedFileCount && fileLimit > 0 && filesSentToday() + plannedFileCount > fileLimit) {
    recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'hold', reason: '今日文件发送额度不足：计划 ' + plannedFileCount + ' 个，已发 ' + filesSentToday() + '，上限 ' + fileLimit, draft: verdict.reply });
    log('WARN', name + '：今日文件额度不足，转人工');
    return;
  }
  const materialKey = 'material_sent:' + chatKey + ':' + material.kind;
  const resendHours = Math.max(1, Number(cfg.qualify.materialResendHours) || 168);
  if (logic.isCoolingDown(metaGet(materialKey, ''), Date.now(), resendHours * 60)) {
    recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'skip', reason: '已在 ' + resendHours + ' 小时内发送过 ' + material.kind + ' 素材，避免重复刷屏' });
    log('INFO', name + '：重复素材已抑制（' + material.kind + '）');
    return;
  }
  if (cfg.qualify.sendMaterialPackage && material.files.length) {
    for (const f of material.files) sends.push({ type: 'file', path: f });
  }
  const caption = verdict.reply || materialCaption(decision.purpose, material);
  if (caption) sends.push({ type: 'text', text: caption });
  if (!sends.length) {
    recordLog({ msgDbId: msgId, chatKey, chatName: name, action: 'hold', reason: '判定精准但无可用素材（materials 目录为空），待人工补素材' });
    log('WARN', name + '：判定精准但 materials 目录没有可用素材，未发送');
    return;
  }
  const delivered = await deliver(chat, chatKey, msgId, sends, caption, 'material:' + material.kind);
  if (delivered && delivered.sent) metaSet(materialKey, nowStr());
}

function materialCaption(purpose, material) {
  if (material.fallback) return '正式报价我们正在准备，稍后发您。先附上产品资料供参考。';
  return '';
}

/** 组装给 AI 的判定上下文：客户档案 + 最近对话 + 客户关注产品 */
function buildJudgeContext(item, chat, hitSensitive) {
  let profile = chat.name || chat.phone || '未绑定客户';
  let uid = Number(cookieUserId) || 0;
  if (!uid) {
    try { const a = crm.prepare('SELECT user_id FROM wa_accounts WHERE id=?').get(chat.account_id); uid = a ? Number(a.user_id) : 0; } catch (e) {}
  }
  if (chat.customer_id) {
    try {
      const cu = crm.prepare('SELECT company_name,name_en,country,industry,status,source,contact_person,notes FROM customers WHERE id=?').get(chat.customer_id);
      if (cu) {
        profile = [cu.company_name, cu.name_en, cu.country, cu.industry, cu.source, cu.status, cu.contact_person]
          .filter(Boolean).join(' / ') || profile;
        if (cu.notes) profile += '｜客户备注：' + String(cu.notes).slice(0, 500);
      }
    } catch (e) {}
    try {
      const qs = crm.prepare(`SELECT product_name_en, product_name, MAX(quote_date) AS d
        FROM quote_history WHERE customer_id=? GROUP BY product_name_en, product_name ORDER BY d DESC LIMIT 5`).all(chat.customer_id);
      if (qs.length) profile += '｜历史报价产品：' + qs.map(x => (x.product_name_en || x.product_name)).join(', ');
    } catch (e) {}
    try {
      const ds = crm.prepare(`SELECT COUNT(*) n, MAX(issue_date) last_date,
        SUM(CASE WHEN status IN ('已确认','已完成') THEN 1 ELSE 0 END) confirmed
        FROM documents WHERE customer_id=? AND user_id=? AND doc_type IN ('pi','so','ci')`).get(chat.customer_id, uid);
      if (ds && Number(ds.n) > 0) profile += '｜历史商业单据：' + Number(ds.n) + ' 张，已确认/完成 ' + (Number(ds.confirmed) || 0) + ' 张，最近 ' + (ds.last_date || '未知');
    } catch (e) {}
    try {
      const ps = crm.prepare(`SELECT COUNT(*) n, COALESCE(SUM(pr.amount),0) total, MAX(pr.paid_at) last_paid
        FROM payment_records pr JOIN documents d ON d.id=pr.doc_id
        WHERE d.customer_id=? AND d.user_id=?`).get(chat.customer_id, uid);
      if (ps && Number(ps.n) > 0) profile += '｜历史收款：' + Number(ps.n) + ' 笔，合计 ' + Number(ps.total || 0) + '，最近 ' + (ps.last_paid || '未知');
    } catch (e) {}
  } else {
    profile += '｜尚未绑定CRM客户，不能使用历史成交/收款作硬证据';
  }
  const adBits = [];
  if (chat.ad_title) adBits.push('广告标题=' + String(chat.ad_title).slice(0, 300));
  if (chat.ad_source_id) adBits.push('广告ID=' + String(chat.ad_source_id));
  if (chat.ad_ref) adBits.push('ref=' + String(chat.ad_ref).slice(0, 200));
  if (chat.ad_source_url) adBits.push('落地页=' + String(chat.ad_source_url).slice(0, 500));
  if (adBits.length) profile += '｜客户来自广告：' + adBits.join('；');
  if (hitSensitive && hitSensitive.length) profile += '｜客户消息命中词：' + hitSensitive.join('、');
  let transcript = '';
  try {
    const rows = crm.prepare(`SELECT from_me, text FROM wa_messages
      WHERE account_id=? AND chat_jid=? ORDER BY id DESC LIMIT 20`).all(item.account_id, item.chat_jid).reverse();
    transcript = rows.map(m => (Number(m.from_me) ? '我方' : '客户') + '：' + String(m.text || '').slice(0, 500)).join('\n');
  } catch (e) { transcript = '客户最新消息：' + item.text; }
  return { customerText: item.text, transcript, customerProfile: profile };
}

/** 统一投递：观察模式只记不发；真实模式逐条发送并二次确认 */
async function deliver(chat, chatKey, msgId, sends, summary, tag) {
  if (!cfg.enabled) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'dry', reason: '观察模式未发送' + (tag ? '｜' + tag : ''), draft: summary });
    log('OBSERVE', (chat.name || item_jid(chat)) + ' → [' + (tag || 'msg') + '] ' + String(summary || '').slice(0, 120));
    return { sent: false, dry: true };
  }
  // 发送前二次确认：置顶/人工已回则放弃
  const freshChat = getChat(chat.account_id, chat.jid);
  if (logic.isPinned(freshChat)) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'skip', reason: '发送前被置顶，放弃' });
    log('INFO', (chat.name || chat.jid) + ' 发送前被置顶，放弃');
    return { sent: false, skipped: true };
  }
  const freshLast = getLastMsg(chat.account_id, chat.jid);
  if (logic.humanReplied(freshLast) && Number(freshLast.id) > msgId) {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'skip', reason: '发送前人工已回复，放弃' });
    log('INFO', (chat.name || chat.jid) + ' 发送前人工已回复，放弃');
    return { sent: false, skipped: true };
  }

  let sentCount = 0, sentTexts = 0, sentFiles = 0, lastErr = '';
  for (let i = 0; i < sends.length; i++) {
    const s = sends[i];
    let r = s.type === 'file' ? await sendFile(chat.id, s.path, '') : await sendText(chat.id, s.text);
    let ok = r.status === 200 && r.body && r.body.ok === true;
    if (!ok && /发送太快|rate.?limit/i.test(String((r.body && r.body.error) || ''))) {
      await sleep(1500);
      r = s.type === 'file' ? await sendFile(chat.id, s.path, '') : await sendText(chat.id, s.text);
      ok = r.status === 200 && r.body && r.body.ok === true;
    }
    if (ok) {
      sentCount++;
      if (s.type === 'file') sentFiles++;
      else sentTexts++;
    }
    else lastErr = (r.body && r.body.error) || ('HTTP ' + r.status);
    if (i < sends.length - 1) await sleep(s.type === 'file' ? 650 : 350);
  }
  if (sentCount > 0) {
    metaSet('last_reply:' + chatKey, nowStr());
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'sent', reason: '成功 ' + sentCount + '/' + sends.length + (tag ? '｜' + tag : ''), draft: summary, messageCount: sentTexts, fileCount: sentFiles });
    log('SENT', (chat.name || chat.jid) + ' → ' + sentCount + ' 条' + (lastErr ? '（部分失败：' + lastErr + '）' : ''));
    return { sent: true, sentCount, error: lastErr };
  } else {
    recordLog({ msgDbId: msgId, chatKey, chatName: chat.name, action: 'error', reason: '全部发送失败：' + lastErr });
    log('ERROR', '发送失败 ' + (chat.name || chat.jid) + '：' + lastErr);
    return { sent: false, error: lastErr };
  }
}

function item_jid(chat) { return chat.jid || chat.phone || ''; }

function ownsChat(chat) {
  try {
    const r = crm.prepare('SELECT user_id FROM wa_accounts WHERE id=?').get(chat.account_id);
    return !!(r && Number(r.user_id) === cookieUserId);
  } catch (e) { return false; }
}

/* ---------------- 素材准备（v2） ---------------- */
function materialsDir() {
  return path.join(DIR, (cfg.qualify && cfg.qualify.materialsDir) || 'materials');
}

/** 找画册文件：优先配置指定，否则取目录里第一个 PDF/图片 */
function findCatalogFile() {
  const q = cfg.qualify || {};
  const dir = materialsDir();
  if (!fs.existsSync(dir)) return '';
  if (q.catalogFile) {
    const p = path.join(dir, q.catalogFile);
    if (fs.existsSync(p)) return p;
  }
  const exts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
  const files = fs.readdirSync(dir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()) && !/^stock[\\/]/.test(f))
    .sort();
  return files.length ? path.join(dir, files[0]) : '';
}

/** 找现货图片：优先 materials/stock 目录，再按配置从 products 表取 image 路径 */
function findStockImages() {
  const q = cfg.qualify || {};
  const out = [];
  const stockDir = path.join(materialsDir(), 'stock');
  if (fs.existsSync(stockDir)) {
    const files = fs.readdirSync(stockDir).sort();
    const pdfs = files.filter(f => path.extname(f).toLowerCase() === '.pdf');
    const images = files.filter(f => ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(f).toLowerCase()));
    // 现货目录有 PDF 时默认优先发 PDF；没有 PDF 才回退发送图片。
    const selected = q.stockPreferPdf !== false && pdfs.length ? pdfs : pdfs.concat(images);
    for (const f of selected) out.push(path.join(stockDir, f));
  }
  const stockLimit = Number(q.maxStockImages);
  const limitStock = list => stockLimit > 0 ? list.slice(0, stockLimit) : list;
  if (out.length || !q.stockFromProducts) return limitStock(out);

  // 从主库 products 取图片路径
  try {
    let rows;
    const ids = String(q.stockProductIds || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      rows = crm.prepare(`SELECT image FROM products WHERE id IN (${ph}) AND COALESCE(image,'')<>''`).all(...ids);
    } else {
      const sql = `SELECT image FROM products WHERE COALESCE(image,'')<>'' ORDER BY updated_at DESC` + (stockLimit > 0 ? ' LIMIT ?' : '');
      rows = stockLimit > 0 ? crm.prepare(sql).all(stockLimit) : crm.prepare(sql).all();
    }
    for (const r of rows) {
      const img = String(r.image || '');
      if (!img) continue;
      // image 形如 /uploads/products/xxx.jpg → 映射到磁盘
      const rel = img.replace(/^\//, '');
      const abs = path.resolve(DIR, '..', rel);
      if (fs.existsSync(abs)) out.push(abs);
    }
  } catch (e) { log('WARN', '读取产品图片失败：' + e.message); }
  return limitStock(out);
}

/** 按目的准备素材文件列表 */
function prepareMaterial(purpose) {
  const p = logic.normalizePurpose(purpose);
  if (p === 'stock') return { kind: 'stock', files: findStockImages() };
  if (p === 'quote') {
    // 报价：若 materials 里有专门报价文件就用，否则回落到画册（并提示人工补正式报价）
    const dir = materialsDir();
    const quoteFile = ['quote.pdf', 'quotation.pdf', '报价单.pdf', 'quote.jpg', 'quotation.jpg']
      .map(f => path.join(dir, f)).find(f => fs.existsSync(f));
    if (quoteFile) return { kind: 'quote', files: [quoteFile] };
    return { kind: 'quote', files: [], fallback: true };
  }
  // catalog / other 都发画册
  return { kind: 'catalog', files: findCatalogFile() ? [findCatalogFile()] : [] };
}

async function draftOf(chatId) {
  const r = await apiGet('/api/wa/draft?chat_id=' + encodeURIComponent(chatId));
  const b = r.body || {};
  if (r.status === 200 && b.ok === true && b.text) return { ok: true, text: String(b.text).trim() };
  return { ok: false, error: b.error || ('HTTP ' + r.status) };
}

/* ---------------- 主循环 ---------------- */
async function tick() {
  if (inTick) return;
  inTick = true;
  try {
    const maxRow = crm.prepare('SELECT MAX(id) AS maxid FROM wa_messages').get();
    const maxId = maxRow ? Number(maxRow.maxid) : 0;
    if (!maxId) return;

    let cursor = Number(metaGet('cursor', '0'));
    if (!cursor) {
      if (cfg.startFromNow) {
        metaSet('cursor', maxId);
        log('INFO', '首次启动：游标设为当前最大消息 id=' + maxId + '，只处理此后的新消息');
        return;
      }
      cursor = 0;
    }
    if (maxId <= cursor) return;

    // 按会话聚合：每个会话只取本轮最新的那条客户文本消息的 id
    const rows = crm.prepare(`
      SELECT account_id, chat_jid, MAX(id) AS last_customer_id
      FROM wa_messages m
      WHERE id > ? AND id <= ? AND from_me=0 AND kind='text' AND COALESCE(text,'')<>''
      GROUP BY account_id, chat_jid
      ORDER BY last_customer_id ASC
    `).all(cursor, maxId);

    const textOf = crm.prepare('SELECT text FROM wa_messages WHERE id=?');
    for (const item of rows) {
      if (!running) break;
      const t = textOf.get(item.last_customer_id);
      item.text = t ? String(t.text || '') : '';
      try { await processChat(item); }
      catch (e) { log('ERROR', '处理会话异常 ' + item.chat_jid + '：' + (e && e.message)); }
    }

    metaSet('cursor', maxId);
  } catch (e) {
    log('ERROR', '轮询异常：' + (e && e.stack || e));
  } finally {
    inTick = false;
  }
}

async function main() {
  acquireWorkerPid();
  log('INFO', '=== 外贸客户自动回复工作台启动 ===');
  log('INFO', '模式：' + (cfg.enabled ? '【真实发送】' : '【观察模式·不发送】'));
  log('INFO', '资格判定：' + ((cfg.qualify && cfg.qualify.enabled) ? '【开启·先判精准再发素材】' : '【关闭·v1 简单模式】'));
  initState();
  initCrm();
  require('./qualify').init(cfg, crm, log);
  cookieUserId = await resolveUserId();
  if (cookieUserId) log('INFO', '当前登录账号 user_id=' + cookieUserId);
  else log('WARN', '未能解析登录账号，将不做会话归属校验（请确保 cookie 与会话属于同一账号）');

  try {
    const h = await apiGet('/api/wa/status');
    if (h.status === 401) log('ERROR', 'sessionCookie 无效或已过期，请重新抓取 crm_sid');
    else if (h.body && h.body.status === 'online') log('INFO', 'WhatsApp 状态：online');
    else log('WARN', 'WhatsApp 状态：' + ((h.body && h.body.status) || ('HTTP ' + h.status)));
  } catch (e) { log('WARN', '无法连接主系统 ' + cfg.crmBaseUrl + '：' + e.message); }

  await tick();
  const timer = setInterval(() => { if (running) tick(); }, Math.max(5, Number(cfg.pollSeconds) || 15) * 1000);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function shutdown() {
  running = false;
  releaseWorkerPid();
  log('INFO', '收到退出信号，正在停止…');
  try { state && state.close(); } catch (e) {}
  try { crm && crm.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
}

process.on('exit', releaseWorkerPid);
main().catch(e => { releaseWorkerPid(); log('FATAL', (e && e.stack) || String(e)); process.exit(1); });
