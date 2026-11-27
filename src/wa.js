'use strict';
// ============ WhatsApp 内置会话（Baileys 通道） ============
// 每个业务员一个账号（wa_accounts.user_id 唯一），扫码登录后会话/消息落本机 SQLite。
// 视界规则：账号本人可见自己的全部会话；某会话绑定到客户后，该客户的归属业务员也可见。
//
// 注意：Baileys 走的是 WhatsApp Web 的非官方协议，可能触发风控。主号直连前请自行评估。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, get, all, getSetting, setSetting } = require('./db');
const { nowStr, todayStr, addDays } = require('./util');
const { normalizePhone, importMessages } = require('./waImport');

const DATA_DIR = path.join(__dirname, '..', 'data');
// 允许用环境变量指向别处：跑测试/演练时不要动真实登录态
const AUTH_DIR = process.env.CRM_WA_AUTH_DIR
  ? path.resolve(process.env.CRM_WA_AUTH_DIR)
  : path.join(DATA_DIR, 'wa-auth');
const WA_LOG = process.env.CRM_WA_LOG
  ? path.resolve(process.env.CRM_WA_LOG)
  : path.join(DATA_DIR, 'wa.log');
const MEDIA_DIR = path.join(__dirname, '..', 'uploads', 'wa');
const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'wa-avatars');
const MAX_MEDIA = 20 * 1024 * 1024;
const MAX_AVATAR = 8 * 1024 * 1024;

// 关键事件同时写控制台和 data/wa.log —— 用户从 .bat 启动时控制台看不到，
// 排查时只看这一个文件就够了。
function waNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
let waLogQueue = Promise.resolve();
function enqueueWaLogWrite(line, checkRotate) {
  waLogQueue = waLogQueue.then(async () => {
    try {
      await fs.promises.appendFile(WA_LOG, line, 'utf8');
      if (checkRotate) {
        const st = await fs.promises.stat(WA_LOG);
        if (st.size > 2 * 1024 * 1024) {
          await fs.promises.rename(WA_LOG, WA_LOG + '.1'); // 2MB 轮转
        }
      }
    } catch (e) {}
  }).catch(() => {});
}
function waLog(...args) {
  const msg = args.map(a => (a && a.message) ? a.message : String(a)).join(' ');
  process.stdout.write('[wa] ' + msg + '\n');
  enqueueWaLogWrite(waNow() + ' ' + msg + '\n', true);
}
function waErr(...args) {
  const msg = args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ');
  process.stderr.write('[wa] ' + msg + '\n');
  enqueueWaLogWrite(waNow() + ' !! ' + msg + '\n', false);
}

const sessions = new Map();   // userId -> { sock, qr, status, error }
const lastAttempt = new Map(); // userId -> 上次发起注册的时间戳（防刷）
let baileys = null;
const RETRY_BACKOFF = [15000, 45000, 120000];  // 只有登录过的会话掉线才自动重连，且逐步退避
const MIN_ATTEMPT_GAP = 45000;                 // 两次「注册扫码」之间至少隔 45 秒，别把 WhatsApp 惹毛
const MAX_ATTEMPTS_PER_HOUR = 3;               // 硬上限：1 小时最多 3 次注册尝试
const MAX_ATTEMPTS_PER_DAY = 10;               // 24 小时最多 10 次

/* ---------------- 登录态备份 / 恢复 ----------------
   Baileys 官方明确说 useMultiFileAuthState 不适合生产（文件态可能写坏 → 要重扫码）。
   我们在没有自研 AuthState 的前提下做两层兜底：
     1) 登录成功和正常关闭时，把整个 account-N 目录快照到 backups/（留最近 5 份）
     2) 启动/连接时如果 creds.json 不在，自动从最近一份快照恢复
   多一份快照，就少一次重新扫码。 */
const AUTH_BACKUP = path.join(AUTH_DIR, 'backups');

function authDirOf(accId) { return path.join(AUTH_DIR, 'account-' + accId); }

function backupAuth(accId) {
  try {
    const dir = authDirOf(accId);
    if (!fs.existsSync(path.join(dir, 'creds.json'))) return '';
    if (!fs.existsSync(AUTH_BACKUP)) fs.mkdirSync(AUTH_BACKUP, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dest = path.join(AUTH_BACKUP, 'account-' + accId + '-' + stamp);
    if (!fs.existsSync(dest)) fs.cpSync(dir, dest, { recursive: true });
    const mine = fs.readdirSync(AUTH_BACKUP).filter(n => n.startsWith('account-' + accId + '-')).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - 5))) {
      try { fs.rmSync(path.join(AUTH_BACKUP, old), { recursive: true, force: true }); } catch (e) {}
    }
    waLog('登录态已备份：' + path.basename(dest));
    return dest;
  } catch (e) {
    waErr('备份登录态失败：', e.message);
    return '';
  }
}

function latestAuthBackup(accId) {
  try {
    if (!fs.existsSync(AUTH_BACKUP)) return '';
    const mine = fs.readdirSync(AUTH_BACKUP).filter(n => n.startsWith('account-' + accId + '-')).sort();
    return mine.length ? path.join(AUTH_BACKUP, mine[mine.length - 1]) : '';
  } catch (e) { return ''; }
}

/** creds.json 丢了就从最近一份快照恢复（扫码一次能用很久，别因为文件没写进去就重扫） */
function restoreAuthIfMissing(accId) {
  const dir = authDirOf(accId);
  if (fs.existsSync(path.join(dir, 'creds.json'))) return false;
  const src = latestAuthBackup(accId);
  if (!src) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(src, dir, { recursive: true });
    waLog('检测到登录态缺失，已从备份恢复：' + path.basename(src));
    return true;
  } catch (e) {
    waErr('恢复登录态失败：', e.message);
    return false;
  }
}

/* ---------------- 连续失败保护 ----------------
   现实里"手机端拒绝关联"时我们这边 socket 反而不报错，单纯靠日志发现不了。
   所以按「连续 N 次没登录成功」计数，达标就锁定 24 小时——宁可今天不让试，
   也别把一个已经被风控的号继续往死里试。 */
const FAIL_LOCK_HOURS = 24;
const FAIL_LOCK_THRESHOLD = 3;

function failStreak(uid) { return Number(getSetting('wa_fail_streak_' + uid) || 0) || 0; }

function bumpFail(uid) {
  const n = failStreak(uid) + 1;
  setSetting('wa_fail_streak_' + uid, String(n));
  if (n >= FAIL_LOCK_THRESHOLD) {
    const until = Date.now() + FAIL_LOCK_HOURS * 3600 * 1000;
    setSetting('wa_block_until_' + uid, String(until));
    waLog('连续 ' + n + ' 次没登成功 → 锁定 ' + FAIL_LOCK_HOURS + ' 小时，保护账号');
  }
  return n;
}
function resetFail(uid) {
  setSetting('wa_fail_streak_' + uid, '0');
  setSetting('wa_block_until_' + uid, '0');
}
/** 剩余锁定小时数；0 表示没锁 */
function lockHoursLeft(uid) {
  const until = Number(getSetting('wa_block_until_' + uid) || 0) || 0;
  if (until <= Date.now()) return 0;
  return Math.ceil((until - Date.now()) / 3600000);
}

/** 读取该账号最近 24h 的注册尝试时间戳。 */
function attemptHistory(uid) {  let arr = [];
  try { arr = JSON.parse(getSetting('wa_attempts_' + uid) || '[]'); } catch (e) { arr = []; }
  const now = Date.now();
  return (Array.isArray(arr) ? arr : []).filter(t => typeof t === 'number' && now - t < 24 * 3600 * 1000);
}
function recordAttempt(uid) {
  const arr = attemptHistory(uid);
  arr.push(Date.now());
  try { setSetting('wa_attempts_' + uid, JSON.stringify(arr)); } catch (e) {}
}
/** 频次保护：超限直接拒绝，连 force 也不放行。 */
function attemptBudget(uid) {
  const arr = attemptHistory(uid);
  const lastHour = arr.filter(t => Date.now() - t < 3600 * 1000).length;
  if (lastHour >= MAX_ATTEMPTS_PER_HOUR) {
    return { ok: false, error: '这一小时已经尝试 ' + lastHour + ' 次了。为避免账号被进一步风控，请至少等 1 小时再试（建议明天）。' };
  }
  if (arr.length >= MAX_ATTEMPTS_PER_DAY) {
    return { ok: false, error: '24 小时内已尝试 ' + arr.length + ' 次，已达上限。请明天再试；现有客户和跟进记录不受影响。' };
  }
  return { ok: true, lastHour, total: arr.length };
}

function lib() {
  if (!baileys) {
    // 延迟加载：没装依赖时 CRM 其余功能照常可用
    baileys = require('@whiskeysockets/baileys');
  }
  return baileys;
}

function hasLib() {
  try { lib(); return true; } catch (e) { return false; }
}

/* ---------------- 出网代理 ---------------- */
// WhatsApp 服务器在国内网络通常不可直连，必须挂代理（Clash/V2Ray 常见 7890/7897 端口）。
// 优先级：系统设置里填的 > Windows 系统代理（只认本机地址）> 直连。
let sysProxyCache = { at: 0, value: '' };

function systemProxy() {
  if (process.platform !== 'win32') return '';
  if (Date.now() - sysProxyCache.at < 60000) return sysProxyCache.value;
  let value = '';
  try {
    const out = require('child_process').execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    );
    const enable = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
    if (enable && m) {
      let s = m[1].trim();
      const httpsPart = /https=([^;\s]+)/i.exec(s);
      if (httpsPart) s = httpsPart[1];
      if (/^(127\.0\.0\.1|localhost):\d+$/i.test(s)) value = 'http://' + s;
    }
  } catch (e) {}
  sysProxyCache = { at: Date.now(), value };
  return value;
}

function proxyUrl() {
  return String(getSetting('wa_proxy') || '').trim() || systemProxy();
}

function buildAgent() {
  const url = proxyUrl();
  if (!url) return null;
  try {
    if (/^socks/i.test(url)) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      return new SocksProxyAgent(url);
    }
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(url);
  } catch (e) {
    waErr('代理配置无效，已阻断直连:', e.message);
    throw e;
  }
}

// Node 内置 fetch 使用的是 undici dispatcher；普通的 https.Agent 不会作用于媒体下载。
// 单独缓存一个 ProxyAgent，让图片、语音和文件下载也走与 WebSocket 相同的 HTTP 代理。
let mediaDispatcherCache = { url: '', dispatcher: null };
function buildFetchDispatcher() {
  const url = proxyUrl();
  if (!url || /^socks/i.test(url)) return null;
  if (mediaDispatcherCache.url === url) return mediaDispatcherCache.dispatcher;
  try {
    const { ProxyAgent } = require('undici');
    mediaDispatcherCache = { url, dispatcher: new ProxyAgent(url) };
    return mediaDispatcherCache.dispatcher;
  } catch (e) {
    waErr('媒体下载代理配置无效，已阻断直连:', e.message);
    throw e;
  }
}

/** 测一下代理能不能出网（不碰 WhatsApp，只测连通性）。 */
async function testProxy() {
  const agent = buildAgent();
  const started = Date.now();
  try {
    const https = require('https');
    const opts = { method: 'HEAD', timeout: 8000 };
    if (agent) opts.agent = agent;
    const status = await new Promise((resolve, reject) => {
      const req = https.request('https://web.whatsapp.com/', opts, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => { req.destroy(new Error('超时')); });
      req.on('error', reject);
      req.end();
    });
    return { ok: true, status, ms: Date.now() - started, via: agent ? proxyUrl() : '直连' };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - started, via: agent ? proxyUrl() : '直连' };
  }
}

/* ---------------- 账号 ---------------- */

function ensureAccount(userId) {
  let acc = get('SELECT * FROM wa_accounts WHERE user_id=?', userId);
  if (acc) return acc;
  const t = nowStr();
  run('INSERT INTO wa_accounts(user_id,label,status,auto_translate,created_at,updated_at) VALUES(?,?,?,0,?,?)',
    userId, '我的 WhatsApp', 'offline', t, t);
  return get('SELECT * FROM wa_accounts WHERE user_id=?', userId);
}

function accountView(userId) {
  const acc = get('SELECT * FROM wa_accounts WHERE user_id=?', userId);
  const s = sessions.get(Number(userId));
  const hist = attemptHistory(userId);
  const now = Date.now();
  return {
    account: acc || null,
    status: s ? s.status : (acc ? acc.status : 'offline'),
    qr: s ? s.qr : '',
    pairCode: s ? s.pairCode : '',
    pairCodeAt: s ? (s.pairCodeAt || 0) : 0,
    error: s ? s.error : (acc ? acc.last_error : ''),
    attemptsHour: hist.filter(t => now - t < 3600 * 1000).length,
    attemptsDay: hist.length,
    failStreak: failStreak(userId),
    lockHoursLeft: lockHoursLeft(userId),
    connectedAt: s ? (s.connectedAt || '') : '',
    lastMessageEventAt: s ? (s.lastMessageEventAt || '') : '',
    lastInboundAt: s ? (s.lastInboundAt || '') : '',
    notifyEvents: s ? (s.notifyEvents || 0) : 0,
    appendEvents: s ? (s.appendEvents || 0) : 0,
    messagesStored: s ? (s.messagesStored || 0) : 0,
    decryptFailures: s ? (s.decryptFailures || 0) : 0,
    lastDecryptErrorAt: s ? (s.lastDecryptErrorAt || '') : '',
    lastDecryptError: s ? (s.lastDecryptError || '') : '',
  };
}

/** 清除所有限流/锁定记录（用户明确要求时使用） */
function clearLimits(userId) {
  const uid = Number(userId);
  setSetting('wa_attempts_' + uid, '[]');
  resetFail(uid);
  lastAttempt.delete(uid);
  waLog('已清除限流与锁定记录（手动）');
  return true;
}

function setStatus(userId, status, extra) {
  const t = nowStr();
  const e = extra || {};
  run('UPDATE wa_accounts SET status=?, last_error=?, last_seen=?, updated_at=? WHERE user_id=?',
    status, e.error || '', t, t, userId);
  const s = sessions.get(Number(userId));
  if (s) { s.status = status; if (e.error) s.error = e.error; }
}

/* ---------------- 会话与消息 ---------------- */

function chatPhone(jid) {
  const raw = String(jid || '').split('@')[0];
  return raw.split(':')[0];
}

function upsertChat(accountId, jid, patch) {
  const p = patch || {};
  const t = nowStr();
  const isGroup = !!(p.isGroup || String(jid).endsWith('@g.us'));
  const isLid = String(jid).endsWith('@lid');
  const phone = isGroup || isLid ? (p.phone || '') : (p.phone || chatPhone(jid));
  const ad = p.ad && p.ad.has ? p.ad : null;
  const present = ad ? 1 : 0;
  const adSourceId = ad ? String(ad.sourceId || '') : '';
  const adSourceType = ad ? String(ad.sourceType || '') : '';
  const adSourceUrl = ad ? String(ad.sourceUrl || '') : '';
  const adTitle = ad ? String(ad.title || '') : '';
  const adBody = ad ? String(ad.body || '') : '';
  const adMediaType = ad ? String(ad.mediaType || '') : '';
  const adThumbnailUrl = ad ? String(ad.thumbnailUrl || '') : '';
  const adCtwaClid = ad ? String(ad.ctwaClid || '') : '';
  const adRef = ad ? String(ad.ref || '') : '';
  const adData = ad ? String(ad.data || '') : '';
  const exists = get('SELECT id FROM wa_chats WHERE account_id=? AND jid=?', accountId, jid);
  if (exists) {
    run(`UPDATE wa_chats SET name=CASE WHEN ?<>'' THEN ? ELSE name END, phone=CASE WHEN ?<>'' THEN ? ELSE phone END,
         last_msg_text=CASE WHEN ? IS NULL THEN last_msg_text WHEN last_msg_at IS NULL OR ?>=last_msg_at THEN ? ELSE last_msg_text END,
         last_msg_at=CASE WHEN ? IS NULL THEN last_msg_at WHEN last_msg_at IS NULL OR ?>=last_msg_at THEN ? ELSE last_msg_at END,
         ad_source_id=CASE WHEN COALESCE(ad_source_id,'')='' AND ?=1 THEN ? ELSE ad_source_id END,
         ad_source_type=CASE WHEN COALESCE(ad_source_type,'')='' AND ?=1 THEN ? ELSE ad_source_type END,
         ad_source_url=CASE WHEN COALESCE(ad_source_url,'')='' AND ?=1 THEN ? ELSE ad_source_url END,
         ad_title=CASE WHEN COALESCE(ad_title,'')='' AND ?=1 THEN ? ELSE ad_title END,
         ad_body=CASE WHEN COALESCE(ad_body,'')='' AND ?=1 THEN ? ELSE ad_body END,
         ad_media_type=CASE WHEN COALESCE(ad_media_type,'')='' AND ?=1 THEN ? ELSE ad_media_type END,
         ad_thumbnail_url=CASE WHEN COALESCE(ad_thumbnail_url,'')='' AND ?=1 THEN ? ELSE ad_thumbnail_url END,
         ad_ctwa_clid=CASE WHEN COALESCE(ad_ctwa_clid,'')='' AND ?=1 THEN ? ELSE ad_ctwa_clid END,
         ad_ref=CASE WHEN COALESCE(ad_ref,'')='' AND ?=1 THEN ? ELSE ad_ref END,
         ad_data=CASE WHEN COALESCE(ad_data,'')='' AND ?=1 THEN ? ELSE ad_data END,
         ad_first_seen_at=CASE WHEN COALESCE(ad_first_seen_at,'')='' AND ?=1 THEN ? ELSE ad_first_seen_at END,
         ad_last_seen_at=CASE WHEN ?=1 THEN ? ELSE ad_last_seen_at END,
         updated_at=? WHERE id=?`,
      p.name || '', p.name || '', phone, phone,
      p.lastMsgAt || null, p.lastMsgAt || null, p.lastMsgText || '',
      p.lastMsgAt || null, p.lastMsgAt || null, p.lastMsgAt || null,
      present, adSourceId, present, adSourceType, present, adSourceUrl, present, adTitle,
      present, adBody, present, adMediaType, present, adThumbnailUrl, present, adCtwaClid,
      present, adRef, present, adData, present, t, present, t, t, exists.id);
    return exists.id;
  }
  const r = run(`INSERT INTO wa_chats(account_id,jid,phone,name,is_group,last_msg_at,last_msg_text,unread,
      ad_source_id,ad_source_type,ad_source_url,ad_title,ad_body,ad_media_type,ad_thumbnail_url,ad_ctwa_clid,ad_ref,ad_data,ad_first_seen_at,ad_last_seen_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    accountId, jid, phone, p.name || '', isGroup ? 1 : 0, p.lastMsgAt || null, p.lastMsgText || null,
    adSourceId, adSourceType, adSourceUrl, adTitle, adBody, adMediaType, adThumbnailUrl, adCtwaClid, adRef, adData,
    ad ? t : null, ad ? t : null, t, t);
  return Number(r.lastInsertRowid);
}
function unwrap(mc) {
  if (!mc) return null;
  if (mc.ephemeralMessage) return unwrap(mc.ephemeralMessage.message);
  if (mc.viewOnceMessage) return unwrap(mc.viewOnceMessage.message);
  if (mc.viewOnceMessageV2) return unwrap(mc.viewOnceMessageV2.message);
  if (mc.documentWithCaptionMessage) return unwrap(mc.documentWithCaptionMessage.message);
  if (mc.editedMessage) return unwrap(mc.editedMessage.message);
  return mc;
}

function extract(msg) {
  const mc = unwrap(msg.message) || {};
  let text = '';
  let kind = 'text';
  if (mc.conversation) text = mc.conversation;
  else if (mc.extendedTextMessage) text = mc.extendedTextMessage.text || '';
  else if (mc.imageMessage) { kind = 'image'; text = mc.imageMessage.caption || ''; }
  else if (mc.videoMessage) { kind = 'video'; text = mc.videoMessage.caption || ''; }
  else if (mc.audioMessage) { kind = 'audio'; }
  else if (mc.documentMessage) { kind = 'document'; text = mc.documentMessage.caption || mc.documentMessage.fileName || ''; }
  else if (mc.stickerMessage) { kind = 'sticker'; }
  else if (mc.locationMessage) { kind = 'location'; text = mc.locationMessage.name || ''; }
  else if (mc.contactMessage) { kind = 'contact'; text = mc.contactMessage.displayName || ''; }
  return { text: String(text || '').trim(), kind };
}

const KIND_LABEL = { image: '[图片]', video: '[视频]', audio: '[语音]', document: '[文件]', sticker: '[贴纸]', location: '[位置]', contact: '[名片]' };

function contextInfoOf(message) {
  const mc = unwrap(message) || {};
  for (const key of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage', 'contactMessage']) {
    if (mc[key] && mc[key].contextInfo) return mc[key].contextInfo;
  }
  return null;
}

function adInfoOf(message) {
  const info = contextInfoOf(message) || {};
  const ad = info.externalAdReply || null;
  if (!ad) return { has: false };
  const pick = (value, max) => String(value == null ? '' : value).trim().slice(0, max || 1000);
  const sourceId = pick(ad.sourceId, 200);
  const sourceType = pick(ad.sourceType, 100);
  const sourceUrl = pick(ad.sourceUrl, 1500);
  const title = pick(ad.title, 500);
  const body = pick(ad.body, 1500);
  const ctwaClid = pick(ad.ctwaClid, 1000);
  const ref = pick(ad.ref, 1000);
  const has = !!(sourceId || sourceType || sourceUrl || title || body || ctwaClid || ref);
  if (!has) return { has: false };
  const payload = {
    externalAdReply: {
      title, body, mediaType: pick(ad.mediaType, 50), thumbnailUrl: pick(ad.thumbnailUrl, 1500),
      mediaUrl: pick(ad.mediaUrl, 1500), sourceType, sourceId, sourceUrl, ctwaClid, ref,
      sourceApp: pick(ad.sourceApp, 200), wtwaWebsiteUrl: pick(ad.wtwaWebsiteUrl, 1500),
      adPreviewUrl: pick(ad.adPreviewUrl, 1500), originalImageUrl: pick(ad.originalImageUrl, 1500),
      automatedGreetingMessageCtaType: pick(ad.automatedGreetingMessageCtaType, 100),
    },
    entryPointConversionSource: pick(info.entryPointConversionSource, 200),
    entryPointConversionApp: pick(info.entryPointConversionApp, 200),
    entryPointConversionExternalSource: pick(info.entryPointConversionExternalSource, 500),
    entryPointConversionExternalMedium: pick(info.entryPointConversionExternalMedium, 500),
    smbClientCampaignId: pick(info.smbClientCampaignId, 200),
    smbServerCampaignId: pick(info.smbServerCampaignId, 200),
    ctwaSignals: pick(info.ctwaSignals, 1000),
  };
  return {
    has: true, sourceId, sourceType, sourceUrl, title, body,
    mediaType: pick(ad.mediaType, 50), thumbnailUrl: pick(ad.thumbnailUrl, 1500),
    ctwaClid, ref, data: JSON.stringify(payload).slice(0, 12000),
  };
}

function quotedMeta(msg) {
  const info = contextInfoOf(msg && msg.message);
  if (!info || !info.stanzaId) return { id: '', preview: '' };
  const quotedMessage = info.quotedMessage;
  const { kind, text } = extract({ message: quotedMessage });
  const mc = unwrap(quotedMessage) || {};
  const mediaName = mc.documentMessage
    ? String(mc.documentMessage.fileName || '')
    : mc.imageMessage || mc.videoMessage || mc.audioMessage || mc.stickerMessage ? KIND_LABEL[kind] || '' : '';
  return {
    id: String(info.stanzaId),
    preview: JSON.stringify({ kind, text: text || KIND_LABEL[kind] || '', mediaName }),
  };
}

function quotePreview(row) {
  const kind = String(row.kind || 'text');
  return {
    kind,
    text: String(row.text || KIND_LABEL[kind] || ''),
    mediaName: String(row.media_name || ''),
  };
}

/** 把 CRM 中保存的消息还原成 Baileys 可识别的引用对象。 */
function buildQuotedMessage(row) {
  if (!row || !row.msg_id || !row.chat_jid) return null;
  const kind = String(row.kind || 'text');
  const text = String(row.text || '');
  const caption = Object.values(KIND_LABEL).includes(text) ? '' : text;
  const mime = String(row.media_mime || '');
  let message;
  if (kind === 'image') message = { imageMessage: { caption, mimetype: mime || 'image/jpeg' } };
  else if (kind === 'video') message = { videoMessage: { caption, mimetype: mime || 'video/mp4' } };
  else if (kind === 'audio') message = { audioMessage: { mimetype: mime || 'audio/ogg', ptt: false } };
  else if (kind === 'document') message = { documentMessage: { fileName: row.media_name || text || 'attachment', caption, mimetype: mime || 'application/octet-stream' } };
  else if (kind === 'sticker') message = { stickerMessage: { mimetype: mime || 'image/webp' } };
  else if (kind === 'location') message = { locationMessage: { name: text } };
  else if (kind === 'contact') message = { contactMessage: { displayName: text } };
  else message = { conversation: text };
  const fromMe = Number(row.from_me) === 1;
  const key = { remoteJid: row.chat_jid, fromMe, id: row.msg_id };
  const quoted = { key, message };
  if (!fromMe && row.sender_jid) key.participant = row.sender_jid;
  if (row.sender_jid) quoted.participant = row.sender_jid;
  if (row.sender_name) quoted.pushName = row.sender_name;
  const stamp = new Date(String(row.ts || '').replace(' ', 'T')).getTime();
  if (Number.isFinite(stamp)) quoted.messageTimestamp = Math.floor(stamp / 1000);
  return quoted;
}

function markSentQuote(messageId, quotedRow) {
  if (!messageId || !quotedRow) return;
  try {
    run('UPDATE wa_messages SET quoted_msg_id=?, quoted_preview=? WHERE id=?',
      quotedRow.msg_id || '', JSON.stringify(quotePreview(quotedRow)), messageId);
  } catch (e) {}
}

function tsOf(msg) {
  const raw = msg.messageTimestamp;
  const sec = typeof raw === 'number' ? raw : Number(raw && raw.toNumber ? raw.toNumber() : raw) || Math.floor(Date.now() / 1000);
  const d = new Date(sec * 1000);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** WhatsApp 回执状态：3=已送达，4=已读，5=语音已播放。 */
function receiptEpoch(value) {
  if (value === null || value === undefined || value === '') return 0;
  const raw = value && typeof value.toNumber === 'function' ? value.toNumber() : value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 100000000000 ? Math.floor(n / 1000) : Math.floor(n);
}

function receiptTime(value) {
  const sec = receiptEpoch(value);
  if (!sec) return '';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function receiptMetaFromMessage(msg) {
  let status = Number(msg && msg.status) || 0;
  let deliveredAt = '';
  let readAt = '';
  for (const receipt of (msg && msg.userReceipt) || []) {
    const delivered = receiptTime(receipt && receipt.receiptTimestamp);
    const read = receiptTime((receipt && receipt.readTimestamp) || (receipt && receipt.playedTimestamp));
    if (delivered && !deliveredAt) deliveredAt = delivered;
    if (read && !readAt) readAt = read;
    if (delivered) status = Math.max(status, 3);
    if (read) status = Math.max(status, 4);
  }
  return { status, deliveredAt, readAt };
}

/** 只升级我方消息的回执，避免延迟到达的旧状态把“已读”降回“未读”。 */
function updateMessageReceipt(accountId, msgId, receiptStatus, receiptAt, useNowWhenMissing) {
  const accId = Number(accountId) || 0;
  const id = String(msgId || '');
  const status = Math.max(1, Math.min(5, Number(receiptStatus) || 1));
  if (!accId || !id) return 0;
  const at = String(receiptAt || '') || (useNowWhenMissing ? nowStr() : '');
  return Number(run(`UPDATE wa_messages SET
      receipt_status=CASE WHEN ? > COALESCE(receipt_status,0) THEN ? ELSE COALESCE(receipt_status,0) END,
      delivered_at=CASE WHEN ?>=3 AND ?<>'' AND COALESCE(delivered_at,'')='' THEN ? ELSE COALESCE(delivered_at,'') END,
      read_at=CASE WHEN ?>=4 AND ?<>'' AND COALESCE(read_at,'')='' THEN ? ELSE COALESCE(read_at,'') END,
      receipt_updated_at=?
    WHERE account_id=? AND msg_id=? AND from_me=1`,
    status, status, status, at, at, status, at, at, nowStr(), accId, id).changes || 0);
}

function storeMessage(accountId, msg, opts) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return null;
    const fromMe = !!msg.key.fromMe;
    // @lid 聊天要拿真实手机号：WhatsApp 把 PN（手机号 JID）放在 remoteJidAlt / senderPn
    let pn = '';
    for (const cand of [msg.key.remoteJidAlt, msg.key.senderPn, msg.key.participantPn]) {
      if (cand && String(cand).endsWith('@s.whatsapp.net')) { pn = chatPhone(cand); break; }
    }
    const { text, kind } = extract(msg);
    const ad = !fromMe ? adInfoOf(msg.message) : { has: false };
    const body = text || KIND_LABEL[kind] || (ad.has ? '客户点击了 WhatsApp 广告' : '');
    if (opts && opts.debug) {
      waLog('收到消息 key=' + JSON.stringify({ jid, alt: msg.key.remoteJidAlt, fromMe, id: msg.key.id })
        + ' type=' + (msg.message ? Object.keys(msg.message).join('/') : 'null') + ' push=' + (msg.pushName || ''));
    }
    if (!body) return null;
    const ts = tsOf(msg);
    const senderName = msg.pushName || '';
    const senderJid = msg.key.participant || msg.participant || '';
    const quoted = quotedMeta(msg);
    const receiptMeta = fromMe ? receiptMetaFromMessage(msg) : { status: 0, deliveredAt: '', readAt: '' };
    const exists = get('SELECT id FROM wa_messages WHERE account_id=? AND msg_id=?', accountId, msg.key.id);
    if (exists) {
      if (fromMe && receiptMeta.status > 0) {
        const receiptAt = receiptMeta.status >= 4 ? receiptMeta.readAt : receiptMeta.deliveredAt;
        updateMessageReceipt(accountId, msg.key.id, receiptMeta.status, receiptAt, false);
      }
      if (ad.has) {
        run(`UPDATE wa_messages SET ad_source_id=CASE WHEN COALESCE(ad_source_id,'')='' THEN ? ELSE ad_source_id END,
          ad_source_type=CASE WHEN COALESCE(ad_source_type,'')='' THEN ? ELSE ad_source_type END,
          ad_source_url=CASE WHEN COALESCE(ad_source_url,'')='' THEN ? ELSE ad_source_url END,
          ad_title=CASE WHEN COALESCE(ad_title,'')='' THEN ? ELSE ad_title END,
          ad_body=CASE WHEN COALESCE(ad_body,'')='' THEN ? ELSE ad_body END,
          ad_media_type=CASE WHEN COALESCE(ad_media_type,'')='' THEN ? ELSE ad_media_type END,
          ad_thumbnail_url=CASE WHEN COALESCE(ad_thumbnail_url,'')='' THEN ? ELSE ad_thumbnail_url END,
          ad_ctwa_clid=CASE WHEN COALESCE(ad_ctwa_clid,'')='' THEN ? ELSE ad_ctwa_clid END,
          ad_ref=CASE WHEN COALESCE(ad_ref,'')='' THEN ? ELSE ad_ref END,
          ad_data=CASE WHEN COALESCE(ad_data,'')='' THEN ? ELSE ad_data END WHERE id=?`,
          ad.sourceId || '', ad.sourceType || '', ad.sourceUrl || '', ad.title || '', ad.body || '',
          ad.mediaType || '', ad.thumbnailUrl || '', ad.ctwaClid || '', ad.ref || '', ad.data || '', exists.id);
        const chatId = upsertChat(accountId, jid, { ad });
        const chat = get('SELECT * FROM wa_chats WHERE id=?', chatId);
        if (chat && chat.customer_id) copyAdAttributionToCustomer(chat.customer_id, chat);
      }
      return exists.id;
    }
    const r = run(`INSERT INTO wa_messages(account_id,chat_jid,msg_id,from_me,kind,text,translated,media_path,media_name,media_mime,
        sender_name,sender_jid,quoted_msg_id,quoted_preview,ad_source_id,ad_source_type,ad_source_url,ad_title,ad_body,
        ad_media_type,ad_thumbnail_url,ad_ctwa_clid,ad_ref,ad_data,ts,created_at)
      VALUES(?,?,?,?,?,?,'','','','',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      accountId, jid, msg.key.id, fromMe ? 1 : 0, kind, body, senderName, senderJid, quoted.id, quoted.preview,
      ad.sourceId || '', ad.sourceType || '', ad.sourceUrl || '', ad.title || '', ad.body || '', ad.mediaType || '',
      ad.thumbnailUrl || '', ad.ctwaClid || '', ad.ref || '', ad.data || '', ts, nowStr());
    if (fromMe) {
      const receiptAt = receiptMeta.status >= 4 ? receiptMeta.readAt : receiptMeta.deliveredAt;
      updateMessageReceipt(accountId, msg.key.id, Math.max(1, receiptMeta.status),
        receiptAt, false);
    }
    const chatId = upsertChat(accountId, jid, {
      name: fromMe ? '' : senderName,
      phone: pn,
      isGroup: jid.endsWith('@g.us'),
      lastMsgAt: ts,
      lastMsgText: body.slice(0, 120),
      ad,
    });
    // 本地未读只统计实时收到的消息；历史同步和本人发出的消息不能制造红点。
    if (fromMe) {
      run('UPDATE wa_chats SET unread=0, updated_at=? WHERE id=?', nowStr(), chatId);
    } else if (opts && opts.markUnread) {
      run('UPDATE wa_chats SET unread=COALESCE(unread,0)+1, last_inbound_at=?, updated_at=? WHERE id=?',
        ts, nowStr(), chatId);
    } else if (opts && opts.live) {
      run('UPDATE wa_chats SET last_inbound_at=?, updated_at=? WHERE id=?', ts, nowStr(), chatId);
    }
    const chat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', accountId, jid);
    if (chat && chat.customer_id) copyAdAttributionToCustomer(chat.customer_id, chat);
    if (chat && !chat.customer_id && !chat.is_group) autoBindChat(chat);
    if (opts && opts.live) setTimeout(() => { try { syncChatFollowup(chatId); } catch (e) {} }, 120);
    // 会话消息只按需翻译；实时收消息时不调用翻译服务，避免无谓的外部请求。
    return Number(r.lastInsertRowid);
  } catch (e) {
    waErr('落库失败：', e.message);
    return null;
  }
}

/** 把 WhatsApp 广告首触信息复制到已绑定客户；已有首触广告时不覆盖。 */
function copyAdAttributionToCustomer(customerId, chat) {
  const cid = Number(customerId) || 0;
  if (!cid || !chat) return 0;
  const sourceId = String(chat.ad_source_id || '');
  const ctwaClid = String(chat.ad_ctwa_clid || '');
  const ref = String(chat.ad_ref || '');
  const sourceUrl = String(chat.ad_source_url || '');
  if (!sourceId && !ctwaClid && !ref && !sourceUrl) return 0;
  const stamp = nowStr();
  return Number(run(`UPDATE customers SET
      ad_source_id=CASE WHEN COALESCE(ad_source_id,'')='' AND ?<>'' THEN ? ELSE ad_source_id END,
      ad_source_type=CASE WHEN COALESCE(ad_source_type,'')='' AND ?<>'' THEN ? ELSE ad_source_type END,
      ad_source_url=CASE WHEN COALESCE(ad_source_url,'')='' AND ?<>'' THEN ? ELSE ad_source_url END,
      ad_title=CASE WHEN COALESCE(ad_title,'')='' AND ?<>'' THEN ? ELSE ad_title END,
      ad_body=CASE WHEN COALESCE(ad_body,'')='' AND ?<>'' THEN ? ELSE ad_body END,
      ad_media_type=CASE WHEN COALESCE(ad_media_type,'')='' AND ?<>'' THEN ? ELSE ad_media_type END,
      ad_thumbnail_url=CASE WHEN COALESCE(ad_thumbnail_url,'')='' AND ?<>'' THEN ? ELSE ad_thumbnail_url END,
      ad_ctwa_clid=CASE WHEN COALESCE(ad_ctwa_clid,'')='' AND ?<>'' THEN ? ELSE ad_ctwa_clid END,
      ad_ref=CASE WHEN COALESCE(ad_ref,'')='' AND ?<>'' THEN ? ELSE ad_ref END,
      ad_data=CASE WHEN COALESCE(ad_data,'')='' AND ?<>'' THEN ? ELSE ad_data END,
      ad_first_seen_at=CASE WHEN COALESCE(ad_first_seen_at,'')='' AND ?<>'' THEN ? ELSE ad_first_seen_at END,
      ad_last_seen_at=CASE WHEN ?<>'' THEN ? ELSE ad_last_seen_at END,
      updated_at=? WHERE id=?`,
    sourceId, sourceId, chat.ad_source_type || '', chat.ad_source_type || '', sourceUrl, sourceUrl,
    chat.ad_title || '', chat.ad_title || '', chat.ad_body || '', chat.ad_body || '', chat.ad_media_type || '', chat.ad_media_type || '',
    chat.ad_thumbnail_url || '', chat.ad_thumbnail_url || '', ctwaClid, ctwaClid, ref, ref, chat.ad_data || '', chat.ad_data || '',
    sourceId || ctwaClid || ref || sourceUrl, chat.ad_first_seen_at || stamp, sourceId || ctwaClid || ref || sourceUrl, stamp, stamp, cid).changes || 0);
}

/** 号码自动匹配客户：只匹配本账号客户或公共池，先精确，再唯一后缀。 */
function autoBindChat(chat) {
  try {
    const account = get('SELECT user_id FROM wa_accounts WHERE id=?', chat.account_id);
    if (!account) return;
    const phone = normalizePhone(chat.phone);
    if (!phone) return;
    // 客户隔离：私有客户只能由所属业务员匹配；公共池客户按共享规则允许匹配。
    const customers = all(`SELECT id, whatsapp, user_id, COALESCE(in_pool,0) AS in_pool
      FROM customers
      WHERE user_id=? OR COALESCE(in_pool,0)=1
      ORDER BY CASE WHEN user_id=? THEN 0 ELSE 1 END, id`, account.user_id, account.user_id);
    let candidates = customers
      .filter(c => normalizePhone(c.whatsapp) === phone)
      .map(c => c.id);
    if (!candidates.length) {
      const contactRows = all(`SELECT cu.id, ct.mobile
        FROM contacts ct JOIN customers cu ON cu.id=ct.customer_id
        WHERE cu.user_id=? OR COALESCE(cu.in_pool,0)=1
        ORDER BY CASE WHEN cu.user_id=? THEN 0 ELSE 1 END, cu.id`, account.user_id, account.user_id);
      candidates = contactRows
        .filter(c => normalizePhone(c.mobile) === phone)
        .map(c => c.id);
    }
    if (!candidates.length && phone.length >= 9) {
      const tail = phone.slice(-9);
      const suffixIds = new Set();
      for (const c of customers) {
        const value = normalizePhone(c.whatsapp);
        if (value && value.endsWith(tail)) suffixIds.add(c.id);
      }
      if (!suffixIds.size) {
        const contactRows = all(`SELECT cu.id, ct.mobile
          FROM contacts ct JOIN customers cu ON cu.id=ct.customer_id
          WHERE cu.user_id=? OR COALESCE(cu.in_pool,0)=1`, account.user_id);
        for (const c of contactRows) {
          const value = normalizePhone(c.mobile);
          if (value && value.endsWith(tail)) suffixIds.add(c.id);
        }
      }
      candidates = [...suffixIds];
    }
    const unique = [...new Set(candidates)];
    if (unique.length === 1) {
      run('UPDATE wa_chats SET customer_id=?, updated_at=? WHERE id=?', unique[0], nowStr(), chat.id);
      copyAdAttributionToCustomer(unique[0], get('SELECT * FROM wa_chats WHERE id=?', chat.id));
    }
  } catch (e) {}
}

/** 打开会话时清除本地未读。调用方必须先做会话可见性校验。 */
function markChatRead(chatId) {
  const id = Number(chatId) || 0;
  if (!id) return 0;
  return Number(run('UPDATE wa_chats SET unread=0, updated_at=? WHERE id=?', nowStr(), id).changes || 0);
}

const WA_SYNC_SOURCE = '内置会话自动同步';
const WA_MERGED_SOURCE = '内置会话自动同步（合并当天跟进）';
const MERGED_FOLLOWUP_MARKER = '\n\n────────\n【原跟进记录】\n';

/**
 * WhatsApp 当天有聊天时，为客户维护一条未完成的自动跟进。
 * 默认跟随到聊天当天 +3 天；完成归档后再次聊天会创建新任务。
 */
function scheduleWhatsAppFollowup(customerId, contactPerson, user, days) {
  const cid = Number(customerId) || 0;
  const uid = Number(user && user.id) || 0;
  if (!cid) return { ok: false, error: '客户不存在' };
  if (!uid) return { ok: false, error: '找不到当前登录账号' };
  const customer = get('SELECT id, company_name, user_id FROM customers WHERE id=?', cid);
  if (!customer) return { ok: false, error: '客户不存在' };
  if (Number(customer.user_id) !== uid) return { ok: false, error: '无权为该客户安排跟进' };

  const offset = Number.isFinite(Number(days)) ? Math.max(0, Math.floor(Number(days))) : 3;
  const subject = 'WhatsApp 会话跟进';
  const existing = get(`SELECT id, next_follow_date, contact_person FROM activities
    WHERE customer_id=? AND user_id=? AND type='WhatsApp' AND archived=0
      AND subject IN ('WhatsApp 会话跟进','WhatsApp 新客户首次跟进')
    ORDER BY id DESC LIMIT 1`, cid, uid);
  const createdAt = nowStr();
  const followDate = addDays(todayStr(), offset);
  const content = 'WhatsApp 当天有聊天，系统自动安排第 ' + offset + ' 天跟进。';
  const followupNotes = 'WhatsApp 聊天自动跟进（' + offset + ' 天后）';
  if (existing) {
    run(`UPDATE activities SET subject=?, content=?, contact_person=COALESCE(NULLIF(?,''),contact_person),
      activity_date=?, next_follow_date=?, next_follow_notes=? WHERE id=? AND user_id=?`,
      subject, content, String(contactPerson || '').trim(), createdAt, followDate, followupNotes, existing.id, uid);
    return { ok: true, created: false, id: Number(existing.id), followDate };
  }

  const created = run(`INSERT INTO activities(customer_id,type,subject,content,contact_person,activity_date,next_follow_date,next_follow_notes,images,created_by,user_id,created_at,priority,outcome,archived)
    VALUES(?,?,?,?,?,?,?,?,'[]',?,?,?,?,'',0)`,
    cid, 'WhatsApp', subject, content,
    String(contactPerson || '').trim(), createdAt, followDate,
    followupNotes, user.display_name || user.username || '系统', uid, createdAt, '中');
  return { ok: true, created: true, id: Number(created.lastInsertRowid), followDate };
}

/**
 * 服务升级或跨天启动时，为“今天已经聊过”的存量已绑定客户补一次规则。
 * 同一天只补一次，避免反复重启覆盖用户之后的手动调整。
 */
function ensureTodayWhatsAppFollowups() {
  const day = todayStr();
  const markerKey = 'wa_auto_followup_day';
  if (String(getSetting(markerKey) || '') === day) {
    return { ok: true, skipped: true, count: 0, day, followDate: addDays(day, 3) };
  }
  const chats = all(`SELECT wc.id, wc.customer_id, wc.name, cu.contact_person, wa.user_id
    FROM wa_chats wc
    JOIN wa_accounts wa ON wa.id=wc.account_id
    JOIN customers cu ON cu.id=wc.customer_id
    WHERE wc.customer_id IS NOT NULL
      AND COALESCE(wc.is_group,0)=0
      AND COALESCE(wc.sync_followup,1)=1
      AND cu.user_id=wa.user_id
      AND EXISTS (
        SELECT 1 FROM wa_messages m
        WHERE m.account_id=wc.account_id AND m.chat_jid=wc.jid
          AND substr(m.ts,1,10)=?
      )
    ORDER BY wc.customer_id, wc.id`, day);
  const done = new Set();
  let count = 0;
  for (const chat of chats) {
    const key = Number(chat.customer_id) + ':' + Number(chat.user_id);
    if (done.has(key)) continue;
    const user = get('SELECT * FROM users WHERE id=?', chat.user_id);
    if (!user) continue;
    // 走完整同步：如果今天已有计划跟进，会直接把聊天覆盖进那条记录；
    // 没有当天计划时，才生成独立的“WhatsApp 会话跟进”。
    const r = syncChatFollowup(chat.id, true);
    if (r.ok) { done.add(key); count++; }
  }
  setSetting(markerKey, day);
  return { ok: true, skipped: false, count, day, followDate: addDays(day, 3) };
}

/** 从已合并的聊天记录里取出最初的人工跟进内容，重复同步时不会越叠越长。 */
function mergedOriginalText(content) {
  const raw = String(content || '');
  const marker = '【原跟进记录】';
  const at = raw.lastIndexOf(marker);
  return at >= 0 ? raw.slice(at + marker.length).replace(/^[\r\n]+/, '').trim() : '';
}

/** 把待覆盖的跟进整理成可保留的原文，确保聊天覆盖时不会丢掉手工内容。 */
function followupOriginalText(activity) {
  const parts = [];
  if (activity.subject) parts.push('原跟进主题：' + activity.subject);
  if (activity.content) parts.push('原跟进内容：\n' + activity.content);
  if (activity.next_follow_notes) parts.push('原下一步：\n' + activity.next_follow_notes);
  if (activity.outcome) parts.push('原处理结果：\n' + activity.outcome);
  return parts.join('\n\n').trim();
}

/**
 * 找今天应被聊天覆盖的跟进：
 * 1. 优先找同一天已合并过的跟进，保证重复同步不新建记录；
 * 2. 再找今天到期，或今天手工记录但未排期的未完成跟进；
 * 3. 已被 WhatsApp 导入台账占用的聊天记录不参与，避免自己覆盖自己。
 */
function findTodayFollowupMerge(chat, userId, day) {
  const chatKey = 'chat-' + chat.id;
  const importRow = get('SELECT * FROM wa_imports WHERE customer_id=? AND chat_key=? AND day=?',
    chat.customer_id, chatKey, day);
  if (importRow && importRow.activity_id) {
    const mapped = get('SELECT * FROM activities WHERE id=? AND customer_id=? AND user_id=?',
      importRow.activity_id, chat.customer_id, userId);
    if (mapped && !Number(mapped.archived) && (importRow.source === WA_MERGED_SOURCE || String(mapped.content || '').indexOf('【原跟进记录】') >= 0)) {
      return { target: mapped, previousGeneratedId: null, originalText: mergedOriginalText(mapped.content) };
    }
  }
  const target = get(`SELECT a.* FROM activities a
    WHERE a.customer_id=? AND a.user_id=? AND a.archived=0
      AND NOT EXISTS (SELECT 1 FROM wa_imports wi WHERE wi.activity_id=a.id)
      AND (
        a.next_follow_date=?
        OR ((a.next_follow_date IS NULL OR a.next_follow_date='') AND substr(COALESCE(a.activity_date,''),1,10)=?)
      )
    ORDER BY CASE WHEN a.next_follow_date=? THEN 0 ELSE 1 END,
      CASE a.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
      a.id DESC LIMIT 1`, chat.customer_id, userId, day, day, day);
  if (!target) return null;
  const previousGeneratedId = importRow && importRow.activity_id && Number(importRow.activity_id) !== Number(target.id)
    ? Number(importRow.activity_id) : 0;
  return { target, previousGeneratedId, originalText: followupOriginalText(target) };
}

/** 把已绑定会话按天同步到客户跟进；wa_imports 保证重复同步只改写、不重复。 */
function syncChatFollowup(chatId, force) {
  const id = Number(chatId) || 0;
  if (!id) return { ok: false, error: '会话不存在' };
  const chat = get(`SELECT c.*, a.user_id AS account_user_id, cu.user_id AS customer_user_id,
      cu.company_name, cu.contact_person
    FROM wa_chats c
    JOIN wa_accounts a ON a.id=c.account_id
    LEFT JOIN customers cu ON cu.id=c.customer_id
    WHERE c.id=?`, id);
  if (!chat || !chat.customer_id || chat.is_group) return { ok: false, error: '请先绑定客户' };
  if (!Number(chat.sync_followup) && !force) return { ok: false, error: '这个会话未开启自动同步' };
  if (!chat.customer_user_id || Number(chat.customer_user_id) !== Number(chat.account_user_id)) {
    return { ok: false, error: '会话账号与客户归属不一致，已阻止写入' };
  }
  const user = get('SELECT * FROM users WHERE id=?', chat.account_user_id);
  if (!user) return { ok: false, error: '找不到会话所属账号' };
  const rows = all('SELECT * FROM wa_messages WHERE account_id=? AND chat_jid=? ORDER BY ts ASC, id ASC', chat.account_id, chat.jid);
  if (!rows.length) return { ok: false, error: '这个会话还没有消息' };
  const mediaMap = {};
  const messages = rows.map(m => {
    const mediaName = (m.kind === 'image' || m.kind === 'sticker') && m.media_path ? 'm-' + m.id : '';
    if (mediaName) mediaMap[mediaName] = m.media_path;
    return {
      date: String(m.ts || '').slice(0, 10),
      time: String(m.ts || '').slice(11, 16),
      ts: m.ts,
      fromMe: Number(m.from_me) === 1,
      sender: Number(m.from_me) ? '我方' : (chat.name || chat.contact_person || chat.phone || '客户'),
      text: m.translated ? (m.text + '\n（译文）' + m.translated) : m.text,
      kind: m.kind === 'image' || m.kind === 'sticker' ? 'media' : 'text',
      mediaName,
    };
  }).filter(m => m.date && m.text);
  const day = todayStr();
  const hasTodayMessages = messages.some(m => m.date === day);
  const mergeInfo = hasTodayMessages ? findTodayFollowupMerge(chat, user.id, day) : null;
  const result = importMessages({
    customerId: chat.customer_id,
    messages,
    chatKey: 'chat-' + chat.id,
    user,
    source: mergeInfo ? WA_MERGED_SOURCE : WA_SYNC_SOURCE,
    mediaMap,
    mergeDay: mergeInfo ? day : '',
    mergeActivityId: mergeInfo ? mergeInfo.target.id : 0,
    mergeSuffix: mergeInfo ? mergeInfo.originalText : '',
    mergeContactPerson: mergeInfo ? (chat.contact_person || chat.name || chat.phone || '') : '',
    mergeNextDate: mergeInfo ? addDays(day, 3) : null,
    mergeNextFollowNotes: mergeInfo ? 'WhatsApp 当天已沟通，3 天后继续跟进' : '',
    mergeOutcome: mergeInfo ? '当天已通过 WhatsApp 沟通' : '',
  });
  if (result && result.ok && result.mergedToday && mergeInfo) {
    // 旧版本可能已为当天聊天生成过一条自动记录；合并成功后归档旧自动记录，只保留覆盖后的跟进。
    if (mergeInfo.previousGeneratedId && mergeInfo.previousGeneratedId !== Number(mergeInfo.target.id)) {
      const old = get('SELECT * FROM activities WHERE id=? AND user_id=?', mergeInfo.previousGeneratedId, user.id);
      if (old && !Number(old.archived)) {
        run(`UPDATE activities SET archived=1, completed_at=?,
          outcome=CASE WHEN COALESCE(outcome,'')='' THEN ? ELSE outcome END WHERE id=? AND user_id=?`,
          nowStr(), '已合并到当天跟进', old.id, user.id);
      }
    }
    result.followupScheduled = true;
    result.nextFollowDate = addDays(day, 3);
    result.mergedActivityId = mergeInfo.target.id;
  } else if (result && result.ok && hasTodayMessages) {
    const scheduled = scheduleWhatsAppFollowup(chat.customer_id, chat.contact_person || chat.name, user, 3);
    if (scheduled.ok) {
      result.followupScheduled = true;
      result.nextFollowDate = scheduled.followDate;
    }
  }
  return result;
}

function mediaMeta(msg) {
  const mc = unwrap(msg && msg.message) || {};
  if (mc.imageMessage) return { kind: 'image', mime: mc.imageMessage.mimetype || 'image/jpeg', fileName: '' };
  if (mc.videoMessage) return { kind: 'video', mime: mc.videoMessage.mimetype || 'video/mp4', fileName: '' };
  if (mc.audioMessage) return { kind: 'audio', mime: mc.audioMessage.mimetype || 'audio/ogg', fileName: '' };
  if (mc.documentMessage) return { kind: 'document', mime: mc.documentMessage.mimetype || 'application/octet-stream', fileName: mc.documentMessage.fileName || '' };
  if (mc.stickerMessage) return { kind: 'sticker', mime: mc.stickerMessage.mimetype || 'image/webp', fileName: '' };
  return null;
}

function safeMediaExt(fileName, mime, kind) {
  const fromName = path.extname(String(fileName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  // WhatsApp 的语音 MIME 常见为 "audio/ogg; codecs=opus"，必须先去掉参数再匹配扩展名。
  const baseMime = String(mime || '').toLowerCase().split(';')[0].trim();
  const byMime = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm',
    'audio/ogg': '.ogg', 'audio/opus': '.ogg', 'audio/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
    'audio/wav': '.wav', 'audio/x-wav': '.wav',
    'application/pdf': '.pdf', 'application/zip': '.zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  };
  return byMime[baseMime] || (kind === 'audio' ? '.ogg' : (kind === 'image' || kind === 'sticker' ? '.jpg' : '.bin'));
}

function saveAvatarBuffer(accountId, jid, buffer, mime) {
  if (!buffer || !buffer.length || buffer.length > MAX_AVATAR) return '';
  if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const ext = safeMediaExt('', mime, 'image') || '.jpg';
  const key = crypto.createHash('sha1').update(String(jid || '')).digest('hex').slice(0, 18);
  const file = 'avatar-' + accountId + '-' + key + ext;
  const disk = path.join(AVATAR_DIR, file);
  fs.writeFileSync(disk, buffer);
  return '/uploads/wa-avatars/' + file;
}

const avatarFetchInFlight = new Map();

async function fetchChatAvatar(chat, force) {
  if (!chat || !chat.id || !chat.jid) return '';
  const key = String(chat.id);
  if (avatarFetchInFlight.has(key)) return avatarFetchInFlight.get(key);
  const task = (async () => {
    const oldPath = String(chat.avatar_path || '').trim();
    const updatedAt = chat.avatar_updated_at ? new Date(String(chat.avatar_updated_at).replace(' ', 'T')).getTime() : 0;
    const age = Date.now() - updatedAt;
    const oldRel = oldPath ? String(oldPath).replace(/^\/?uploads\//, '') : '';
    const oldFile = oldRel ? path.join(__dirname, '..', 'uploads', oldRel) : '';
    const oldExists = oldFile && fs.existsSync(oldFile) && fs.statSync(oldFile).isFile();
    if (!force && oldExists && age >= 0 && age < 7 * 86400000) return oldPath;
    if (!force && !oldPath && age >= 0 && age < 12 * 3600000) return '';
    const acc = get('SELECT * FROM wa_accounts WHERE id=?', chat.account_id);
    const s = acc ? sessions.get(Number(acc.user_id)) : null;
    if (!s || !s.sock) return oldExists ? oldPath : '';
    run('UPDATE wa_chats SET avatar_updated_at=? WHERE id=?', nowStr(), chat.id);
    try {
      const url = await s.sock.profilePictureUrl(chat.jid, 'image');
      if (!url) return oldExists ? oldPath : '';
      const options = { signal: AbortSignal.timeout(12000) };
      const dispatcher = buildFetchDispatcher();
      if (dispatcher) options.dispatcher = dispatcher;
      const resp = await fetch(url, options);
      if (!resp.ok) return oldExists ? oldPath : '';
      const mime = String(resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
      if (!mime.startsWith('image/')) return oldExists ? oldPath : '';
      const buffer = Buffer.from(await resp.arrayBuffer());
      const saved = saveAvatarBuffer(chat.account_id, chat.jid, buffer, mime);
      if (!saved) return oldExists ? oldPath : '';
      run('UPDATE wa_chats SET avatar_path=?,avatar_updated_at=? WHERE id=?', saved, nowStr(), chat.id);
      return saved;
    } catch (e) {
      return oldExists ? oldPath : '';
    }
  })();
  avatarFetchInFlight.set(key, task);
  try { return await task; } finally { avatarFetchInFlight.delete(key); }
}

async function getChatAvatarPath(chatId, userId) {
  const chat = get(`SELECT c.* FROM wa_chats c WHERE c.id=? AND (${visibleChatsSql()})`,
    Number(chatId) || 0, Number(userId) || 0, Number(userId) || 0);
  if (!chat) return '';
  return fetchChatAvatar(chat, false);
}

function saveMediaBuffer(accountId, messageId, buffer, meta) {
  if (!buffer || !buffer.length || buffer.length > MAX_MEDIA) return '';
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = safeMediaExt(meta.fileName, meta.mime, meta.kind);
  const file = 'wa-' + accountId + '-' + messageId + '-' + crypto.randomBytes(4).toString('hex') + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
  return '/uploads/wa/' + file;
}

async function downloadIncomingMedia(sock, accountId, msg, messageId) {
  const meta = mediaMeta(msg);
  if (!meta || !messageId) return '';
  try {
    const B = lib();
    const dispatcher = buildFetchDispatcher();
    const downloadOptions = { options: {} };
    if (dispatcher) downloadOptions.options.dispatcher = dispatcher;
    const ctx = sock && typeof sock.updateMediaMessage === 'function'
      ? { reuploadRequest: sock.updateMediaMessage.bind(sock), logger: sock.logger || console }
      : undefined;
    const buffer = ctx
      ? await B.downloadMediaMessage(msg, 'buffer', downloadOptions, ctx)
      : await B.downloadMediaMessage(msg, 'buffer', downloadOptions);
    const mediaPath = saveMediaBuffer(accountId, messageId, buffer, meta);
    if (!mediaPath) return '';
    run('UPDATE wa_messages SET media_path=?, media_name=?, media_mime=? WHERE id=?',
      mediaPath, String(meta.fileName || ''), String(meta.mime || ''), messageId);
    const chat = get('SELECT id FROM wa_chats WHERE account_id=? AND jid=?', accountId, msg.key.remoteJid);
    if (chat) syncChatFollowup(chat.id);
    return mediaPath;
  } catch (e) {
    const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : '';
    waErr('媒体下载失败：', e.message + (cause ? '（' + cause + '）' : ''));
    return '';
  }
}

/* ---------------- 翻译 ----------------
   谷歌翻译网页版使用的免费端点：不需要 API Key、不产生账单。
   属于非官方接口，可能限流或变更；失败时明确报错，不把失败结果写成译文。 */

// 旧 AI 翻译的拒答识别，保留给历史测试/兼容；谷歌机翻不会返回这类文本。
function isTranslationRefusal(text) {
  const s = String(text || '').trim();
  return !s || /(?:我)?无法(?:识别|翻译|判断)(?:这段|该)?(?:文本|内容|语言|语种|含义)|请(?:你)?提供.{0,12}(?:需要翻译|翻译的|待翻译)|不能确定.{0,10}(?:语种|语言|含义)|未提供.{0,10}(?:文本|内容)/.test(s);
}

const GOOGLE_TRANSLATE_ENDPOINTS = [
  { base: 'https://translate.googleapis.com/translate_a/single', client: 'gtx' },
  { base: 'https://translate.google.com/translate_a/single', client: 'gtx' },
  { base: 'https://translate.google.com/translate_a/single', client: 'at' },
];
const GOOGLE_TARGETS = { 'zh-CN': 'zh-CN', en: 'en', fr: 'fr', ar: 'ar', es: 'es', ru: 'ru' };
let googleTranslateCache = new Map();   // 同一段文本短期重复翻译直接复用，减轻限流

/** 谷歌返回 [[["译文","原文",...],...],...]，按段拼回原文顺序。 */
function parseGoogleTranslation(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
  return payload[0].map(seg => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('').trim();
}

async function googleTranslateOnce(text, tl, endpoint) {
  const url = new URL(endpoint.base);
  url.searchParams.set('client', endpoint.client);
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', tl);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);
  const options = {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HQ-CRM/1.0)' },
  };
  const dispatcher = buildFetchDispatcher();   // 复用 WhatsApp 的出网代理（Node fetch 不读系统代理）
  if (dispatcher) options.dispatcher = dispatcher;
  const resp = await fetch(url.toString(), options);
  if (!resp.ok) {
    const err = new Error(resp.status === 429 ? '请求过于频繁' : 'HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }
  const out = parseGoogleTranslation(await resp.json());
  if (!out) throw new Error('未返回译文');
  return out;
}

async function callTranslate(text, targetCode) {
  const source = String(text || '').trim().slice(0, 4000);
  if (!source) return { ok: false, error: '没有可翻译的文本' };
  const tl = GOOGLE_TARGETS[targetCode] || GOOGLE_TARGETS['zh-CN'];
  const cacheKey = tl + '\n' + source;
  if (googleTranslateCache.has(cacheKey)) return { ok: true, text: googleTranslateCache.get(cacheKey) };

  let lastError = null;
  for (let round = 0; round < 2; round++) {
    for (const endpoint of GOOGLE_TRANSLATE_ENDPOINTS) {
      try {
        const out = await googleTranslateOnce(source, tl, endpoint);
        googleTranslateCache.set(cacheKey, out);
        if (googleTranslateCache.size > 200) googleTranslateCache.delete(googleTranslateCache.keys().next().value);
        return { ok: true, text: out };
      } catch (e) { lastError = e; }
    }
    if (round === 0) await new Promise(resolve => setTimeout(resolve, 350));
  }
  const reason = lastError && lastError.status === 429 ? '谷歌翻译限流，请稍后再试' : '谷歌翻译失败，请检查网络或代理';
  return { ok: false, error: lastError && lastError.message ? reason + '（' + lastError.message + '）' : reason };
}

/** 把一天的 WhatsApp 对话压成 1-2 句中文要点（存库，不覆盖原文）。 */
async function summarizeChat(text) {
  const key = getSetting('ai_api_key');
  if (!key) return { ok: false, error: '未配置 DeepSeek API Key（系统设置 → AI 助理）' };
  const model = getSetting('ai_model') || 'deepseek-chat';
  const system = [
    '你是外贸业务助理。下面是一天里业务员和某个客户的 WhatsApp 聊天记录。',
    '请用简体中文写 1-2 句要点，必须覆盖：①客户想要什么/关心什么 ②我方答复了什么 ③还有什么没定下来或待办。',
    '只写事实，数字、型号、价格、交期要保留原值；查不到就写"未提及"。不要加"要点："之类的前缀，不要分段。',
  ].join('');
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: String(text).slice(0, 12000) }],
      temperature: 0.2, stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    let msg = '摘要接口返回 ' + resp.status;
    try { const j = await resp.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
    return { ok: false, error: msg };
  }
  const data = await resp.json();
  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { ok: !!out, text: String(out || '').trim().replace(/^要点[:：]\s*/, '') };
}

/** 生成可编辑的销售回复草稿；只返回文本，不自动发送。 */
async function draftReply(userId, chatId) {
  const key = getSetting('ai_api_key');
  if (!key) return { ok: false, error: '未配置 DeepSeek API Key（系统设置 → AI 助理）' };
  const chat = get(`SELECT c.*, cu.company_name, cu.country, cu.status, cu.contact_person
    FROM wa_chats c
    JOIN wa_accounts a ON a.id=c.account_id
    LEFT JOIN customers cu ON cu.id=c.customer_id
    WHERE c.id=? AND a.user_id=?`, Number(chatId) || 0, Number(userId) || 0);
  if (!chat) return { ok: false, error: '会话不存在或无权操作' };
  const rows = all('SELECT from_me, kind, text, ts FROM wa_messages WHERE account_id=? AND chat_jid=? ORDER BY id DESC LIMIT 24', chat.account_id, chat.jid).reverse();
  if (!rows.length) return { ok: false, error: '这个会话还没有消息' };
  const transcript = rows.map(m => (Number(m.from_me) ? '我方' : '客户') + '：' + String(m.text || '').slice(0, 1200)).join('\n').slice(-12000);
  const customer = [chat.company_name, chat.country, chat.status, chat.contact_person].filter(Boolean).join(' / ') || (chat.name || chat.phone || '未绑定客户');
  const model = getSetting('ai_model') || 'deepseek-chat';
  const system = [
    '你是专业的外贸销售助理，正在帮业务员起草一条 WhatsApp 回复。',
    '自动判断客户使用的语言，并用同一种语言回复；客户使用英语、法语、阿拉伯语或斯瓦希里语时不要改成中文。',
    '回复要自然、简洁、偏销售推进：确认客户需求，主动追问型号/图片、规格、数量、目标价、收货国家和运输方式中仍缺失的信息。',
    '不得虚构价格、库存、交期、认证或折扣。需要工厂核算时明确说明稍后给正式报价。',
    '这是客户可读的消息，不要写分析、标题、Markdown 或“回复如下”。只输出可以直接发送的一段消息。',
  ].join('\n');
  const userPrompt = '客户档案：' + customer + '\n最近对话：\n' + transcript;
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
      temperature: 0.35, stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    let msg = 'AI 接口返回 ' + resp.status;
    try { const j = await resp.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
    return { ok: false, error: msg };
  }
  const data = await resp.json();
  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { ok: !!out, text: String(out || '').trim() };
}


async function translateMessage(messageId, force) {
  const m = get('SELECT * FROM wa_messages WHERE id=?', messageId);
  if (!m) return { ok: false, error: '消息不存在' };
  if (m.translated && !force) return { ok: true, text: m.translated };
  const history = all(`SELECT from_me,text FROM wa_messages WHERE account_id=? AND chat_jid=? AND id<? AND kind='text'
    AND COALESCE(text,'')<>'' ORDER BY id DESC LIMIT 6`, m.account_id, m.chat_jid, m.id).reverse();
  const context = history.map(x => (Number(x.from_me) ? '我方：' : '客户：') + String(x.text || '').slice(0, 500)).join('\n');
  const r = await callTranslate(m.text, 'zh-CN', { context });
  if (r.ok) run('UPDATE wa_messages SET translated=? WHERE id=?', r.text, messageId);
  return r;
}

/* ---------------- 连接 ---------------- */

async function connect(userId, opts) {
  const uid = Number(userId);
  const force = !!(opts && opts.force);
  const phone = opts && opts.phone ? String(opts.phone).replace(/\D/g, '') : '';
  const keepCode = opts && opts.keepCode ? String(opts.keepCode) : '';
  const keepCodeAt = opts && opts.keepCodeAt ? Number(opts.keepCodeAt) : 0;
  const keepPhone = opts && opts.keepPhone ? String(opts.keepPhone) : '';
  const netRetry = !!(opts && opts.netRetry);   // TLS 握手失败后的自动重连，不算注册尝试
  const keepCreds = !!(opts && opts.keepCreds);  // 保留现有登录态（515 重连 / 关联完成后）
  const acc = ensureAccount(uid);
  if (!hasLib()) {
    setStatus(uid, 'error', { error: '未安装 @whiskeysockets/baileys，请先 npm install' });
    return { ok: false, error: '未安装 Baileys 依赖' };
  }
  // 连续失败锁定：手机端拒绝关联时我们这侧不报错，只能按"连续没登成功"来数
  // 已有登录态（creds 里有设备号）→ 这是"重新登录"，不是"注册新设备"，
  // 不该占用注册限流，也不该被判为连续失败。
  let hasSession = false;
  try {
    const credPath = path.join(AUTH_DIR, 'account-' + acc.id, 'creds.json');
    if (fs.existsSync(credPath)) {
      const c = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      hasSession = !!(c && c.me && /:\d+@/.test(String(c.me.id || '')));
    }
  } catch (e) {}
  const isLogin = netRetry || keepCode || hasSession;

  if (!isLogin) {
    const left = lockHoursLeft(uid);
    if (left > 0) {
      const msg = '连续 ' + failStreak(uid) + ' 次没登录成功，已保护性锁定约 ' + left + ' 小时。'
        + '解锁后建议换副号再试。';
      setStatus(uid, 'error', { error: msg });
      return { ok: false, error: msg };
    }
  }
  // 频次硬上限（force 也不放行）：反复注册是封号的头号诱因，
  // 宁可今天不让试，也不能把号试没了。
  if (!isLogin) {
    const budget = attemptBudget(uid);
    if (!budget.ok) return budget;
  }
  // 注册节奏保护：两次注册尝试之间至少隔 45 秒。连续狂刷会被 WhatsApp 限流，
  // 表现就是扫码时手机提示「网络连接不上」。
  const gap = Date.now() - (lastAttempt.get(uid) || 0);
  if (!force && gap < MIN_ATTEMPT_GAP) {
    const wait = Math.ceil((MIN_ATTEMPT_GAP - gap) / 1000);
    return { ok: true, reused: true, wait, msg: '距上次尝试不到 45 秒，请再等 ' + wait + ' 秒' };
  }
  // 同一账号同时只允许一个 socket：重复点击只复用，不新建（否则互相踢下线，二维码/配对码永远出不来）
  const cur = sessions.get(uid);
  if (cur && cur.sock && !force) {
    const freshQr = cur.qr && Date.now() - (cur.qrAt || 0) < 25000;
    if (cur.status === 'online') return { ok: true, reused: true };
    if (cur.status === 'qr' && freshQr) return { ok: true, reused: true };
    if (cur.status === 'connecting' && Date.now() - (cur.startedAt || 0) < 15000) return { ok: true, reused: true };
  }
  // 配对码还在有效期内且号码没变：复用，别把刚发的码作废
  const samePhone = !!phone && (cur && (cur.pairPhone === phone || cur.phone === phone));
  if (cur && cur.sock && samePhone && cur.pairCode && Date.now() - (cur.pairCodeAt || 0) < 50000) {
    return { ok: true, reused: true, msg: '配对码还有效，请直接输入，别重复生成' };
  }
  if (cur) {
    // 上一次连接没登成功就又要发起新的：算一次失败（手机端拒绝时我们这侧不会报错）
    if (!cur.opened && !cur.countedFail && !netRetry) { cur.countedFail = true; bumpFail(uid); }
    if (cur.retryTimer) { clearTimeout(cur.retryTimer); cur.retryTimer = null; }
    if (cur.sock) { try { cur.sock.end(undefined); } catch (e) {} }
    sessions.delete(uid);
  }
  // 只有"真的要注册新设备"才计入尝试次数；重新登录已有设备不算
  if (!isLogin) {
    lastAttempt.set(uid, Date.now());
    recordAttempt(uid);
    const hist = attemptHistory(uid);
    waLog('今天第 ' + hist.length + ' 次注册尝试（上限 10 次/24h、3 次/小时）');
  } else if (hasSession) {
    waLog('沿用已有登录态重连（不计入尝试次数）');
  } else {
    waLog('网络握手失败，自动重连（不计入尝试次数）');
  }
  const B = lib();
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const dir = path.join(AUTH_DIR, 'account-' + acc.id);
  // 半注册状态的处理有讲究：
  //   - 配对码阶段 me 是 "8613...@s.whatsapp.net"（没有 :设备号）→ 这是无效状态，清掉重来
  //   - 扫码/关联成功后会变成 "8613...:18@s.whatsapp.net"（带设备号）→ **这是有效登录态**，
  //     只是 registered 字段要等重连后才置 true，绝不能清掉，清掉就等于把刚关联的设备丢了
  if (!keepCode && !keepCreds) {
    try {
      const credPath = path.join(dir, 'creds.json');
      if (fs.existsSync(credPath)) {
        const c = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const meId = c.me && c.me.id ? String(c.me.id) : '';
        const hasDevice = /:\d+@/.test(meId);
        if (!c.registered && !hasDevice) {
          fs.rmSync(dir, { recursive: true, force: true });
          waLog('清理半注册登录态，重新开始');
        } else if (!c.registered && hasDevice) {
          waLog('检测到已关联但未完成注册的登录态（' + meId + '），保留并重连');
        }
      }
    } catch (e) {}
  }
  // creds 不在但有快照 → 先恢复，省一次扫码。
  // 但用户明确“退出登录并修复”后必须跳过恢复，否则会重新载入坏会话，永远出不了新二维码。
  if (!keepCode && String(getSetting('wa_skip_restore_' + acc.id) || '') !== '1') {
    restoreAuthIfMissing(acc.id);
  }
  const { state, saveCreds } = await B.useMultiFileAuthState(dir);

  // 关键修正：扫码关联成功后服务器已经分配了设备号（8613...:19），但 Baileys 的
  // creds.registered 可能没置 true。带着 registered=false 去连，走的是"注册"分支而不是
  // "登录"分支——表现就是：socket 能连上、回执（messages.update）能收到，但
  // **真实消息一条都不投递**（messages.upsert 永远不触发）。
  // 只要 me.id 带设备号（:NN），就说明服务器侧已建好设备，可以按"已注册"登录。
  try {
    const meId = state.creds && state.creds.me && state.creds.me.id ? String(state.creds.me.id) : '';
    if (!state.creds.registered && /:\d+@/.test(meId)) {
      state.creds.registered = true;
      await saveCreds();
      waLog('检测到设备号 ' + meId + ' 但 registered=false，已修正为已注册（否则收不到消息）');
    }
  } catch (e) { waErr('修正注册状态失败：', e.message); }

  const agent = buildAgent();
  // 设备身份很关键：用 macOS('Desktop') 会伪装成「WhatsApp 桌面版」，
  // 而桌面版每个账号只允许一个，联进来就会把用户电脑上那个桌面版踢下线，
  // 手机端随后报「无法关联设备」。改用普通网页端身份（Chrome），互不影响。
  const browserProfile = B.Browsers ? B.Browsers.macOS('Chrome') : ['CRM', 'Chrome', '1.0'];
  waLog('设备身份：' + JSON.stringify(browserProfile));
  const sock = B.default({
    auth: state,
    printQRInTerminal: false,
    browser: browserProfile,
    // 历史同步：默认关（v7-rc 上开这个会被 428 踢），但 6.7.24 上可以开。
    // 用环境变量 CRM_WA_FULL_HISTORY=1 打开，用来把最近几个月的聊天拉下来。
    syncFullHistory: process.env.CRM_WA_FULL_HISTORY === '1',
    markOnlineOnConnect: false,
    // 二维码有效期：默认 60 秒，扫得慢一点就 408「QR refs attempts ended」直接关连接，
    // 表现为"码还在但连不上了"。放宽到 3 分钟。
    qrTimeout: 180000,
    generateHighQualityLinkPreview: false,
    ...(agent ? { agent, fetchAgent: agent } : {}),
    // 不要给 getMessage 塞一个"永远返回空消息"的假实现：
    // 解密失败时 Baileys 会调它回捞原文，返回空对象会让它以为消息真的是空的，
    // 既不入库也不会发重试请求。删掉后由 Baileys 自己发 retry receipt，手机会补发真实内容。
  });
  const s = { sock, qr: '', qrAt: 0, status: 'connecting', error: '', fails: 0, netFails: 0, opened: false, pairCode: keepCode, pairCodeAt: keepCodeAt, pairPhone: keepPhone || phone || '', phone: phone || keepPhone || '', startedAt: Date.now(), connectedAt: '', lastMessageEventAt: '', lastInboundAt: '', notifyEvents: 0, appendEvents: 0, messagesStored: 0, decryptFailures: 0, lastDecryptErrorAt: '', lastDecryptError: '', retryTimer: null, watchdog: null };
  sessions.set(uid, s);
  setStatus(uid, 'connecting');
  if (keepCode) { s.status = 'pairing'; waLog('重连并保留配对码：' + keepCode); }

  // 旧 socket 的迟到事件一律忽略（避免被顶掉的那条连接把状态改回去）
  const alive = () => sessions.get(uid) === s;

  // 看门狗：出了二维码但 90 秒没有新 ref，说明 socket 已经静默卡死
  // （代理偶发断流时不会触发 close 事件，只能靠这个发现）
  s.watchdog = setInterval(() => {
    if (!alive()) { clearInterval(s.watchdog); return; }
    if (s.status === 'qr' && s.qrAt && Date.now() - s.qrAt > 90000) {
      waLog('二维码 90 秒没更新（socket 可能已断），自动重连');
      clearInterval(s.watchdog);
      connect(uid, { force: true, netRetry: true }).catch(e => waErr('重连失败：', e.message));
    }
  }, 15000);
  waLog('发起连接' + (agent ? '（代理 ' + proxyUrl() + '）' : '（直连）') + (netRetry ? '（网络重试）' : ''));

  // 配对码登录：不扫码，手机输入 8 位码。
  // 时序很关键：必须等噪声握手完成（约 3 秒）再取码。太快取码 WhatsApp 会以 428/401 直接断开，
  // 手机端就报「无法关联设备」。实测 3 秒取码后 socket 能稳定存活。
  if (phone) {
    waLog('配对码请求：手机号 ' + phone);
    const askCode = async (attempt) => {
      if (!alive()) return;
      try {
        const code = await s.sock.requestPairingCode(phone);
        s.pairCode = String(code || '').replace(/(.{4})(?!$)/g, '$1-');
        s.pairCodeAt = Date.now();
        s.pairPhone = phone;
        s.status = 'pairing';
        s.error = '';
        waLog('配对码：' + s.pairCode + '（有效期约 60 秒）');
      } catch (e) {
        waErr('取配对码失败（第 ' + attempt + ' 次）：', e.message);
        if (attempt < 2 && alive()) setTimeout(() => askCode(attempt + 1), 3000);
        else { s.error = '取配对码失败：' + e.message; }
      }
    };
    setTimeout(() => askCode(1), 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (!alive()) return;
    try {
    const { connection, lastDisconnect, qr } = u || {};
    if (qr && !s.pairCode) {
      try {
        const QR = require('qrcode');
        s.qr = await QR.toDataURL(qr, { margin: 1, width: 320 });
      } catch (e) { s.qr = ''; }
      s.qrAt = Date.now();
      s.qrRefs = (s.qrRefs || 0) + 1;
      s.status = 'qr';
      waLog('二维码已刷新（第 ' + s.qrRefs + ' 次）');
      setStatus(uid, 'qr');
    }
    if (connection === 'open') {
      s.status = 'online'; s.qr = ''; s.error = ''; s.fails = 0; s.opened = true; s.pairCode = '';
      s.connectedAt = nowStr();
      s.countedFail = true; s.netFails = 0;
      setSetting('wa_skip_restore_' + acc.id, '0');
      if (s.watchdog) { clearInterval(s.watchdog); s.watchdog = null; }
      resetFail(uid);   // 登录成功，清掉连续失败计数
      const jid = sock.user && sock.user.id ? sock.user.id : '';
      const phoneNum = chatPhone(jid);
      run('UPDATE wa_accounts SET status=?, jid=?, phone=?, last_error=?, last_seen=?, updated_at=? WHERE user_id=?',
        'online', jid, phoneNum, '', nowStr(), nowStr(), uid);
      waLog('账号已连接：' + (sock.user ? sock.user.name || phoneNum : phoneNum));
      // 连接稳定后再快照登录态（creds.update 是异步写的，等 5 秒）
      setTimeout(() => { if (alive()) backupAuth(acc.id); }, 5000);
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : 0;
      const rawMsg = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || '';
      // 配对进行中时，WhatsApp 会用 401/428/515 主动断开要求客户端重连来完成关联，
      // 这不能被当成「已退出登录」，否则刚发的码立刻作废（手机端表现为「无法关联设备」）。
      const pairingNow = !!s.pairCode && Date.now() - (s.pairCodeAt || 0) < 120000;
      const loggedOut = B.DisconnectReason && code === B.DisconnectReason.loggedOut && !pairingNow;
      s.status = loggedOut ? 'logged_out' : 'offline';
      s.qr = '';
      if (!pairingNow) s.pairCode = '';
      s.fails = (s.fails || 0) + 1;
      // 服务器吊销了登录态：本地凭据已经废了，留着只会让下次连接继续 401，
      // 所以直接删掉（连带最近备份），让状态回到"干净未连接，可扫码"
      if (loggedOut) {
        try { fs.rmSync(authDirOf(acc.id), { recursive: true, force: true }); } catch (e) {}
        try {
          const b = latestAuthBackup(acc.id);
          if (b) fs.rmSync(b, { recursive: true, force: true });
        } catch (e) {}
        waLog('登录态已被服务器吊销，本地凭据已清除（需要重新扫码）');
      }
      let hint = '连接断开（' + code + '）';
      if (loggedOut) {
        hint = '登录态已失效（服务器已断开这个设备），本地凭据已清除。需要时点「扫码连接」重新关联即可。';
      } else if (pairingNow) {
        hint = '配对码已发出，正在重连等待手机提交（码保持有效）';
      } else if (/QR refs attempts ended/i.test(rawMsg)) {
        hint = '二维码有效期到了（3 分钟内没扫上），已自动停止。重新点「扫码连接」再试一次。';
      } else if (code === 408 || /timed out|handshake|secure TLS/i.test(rawMsg)) {
        hint = '连不上 WhatsApp 服务器（' + (rawMsg.slice(0, 40) || '握手失败') + '）：检查代理是否稳定，或换一个节点。';
      } else if (s.opened) {
        hint = '登录态掉线（' + code + '），稍后自动重连。';
      } else {
        hint = '本次注册没成功（' + code + '）：扫码前请确保代理稳定；必要时改用配对码。';
      }
      s.error = hint;
      setStatus(uid, s.status, { error: hint });
      if (s.watchdog) { clearInterval(s.watchdog); s.watchdog = null; }

      // 515 = 关联已完成，服务器要求客户端带着新凭据重连。
      // 这一步必须重连，否则手机显示"关联成功"而我们这边永远停在未登录。
      const restartRequired = code === 515;
      if (restartRequired && !loggedOut && alive()) {        waLog('关联已完成（515），1.5 秒后用新凭据重连');
        s.retryTimer = setTimeout(() => {
          if (!alive()) return;
          connect(uid, { force: true, keepCreds: true, netRetry: true })
            .catch(e => waErr('重连失败', e.message));
        }, 1500);
        const msg = '手机已关联成功，正在用新凭据登录…';
        s.error = msg;
        setStatus(uid, 'connecting', { error: msg });
        return;
      }

      // 网络层失败（TLS 握手断了 / 从没出过码）：自动重试几次。
      // 这不是"注册失败"，不该计入尝试次数，也不该把用户挡在外面——
      // 代理对 Node 的 TLS 握手就是间歇性失败，重试通常第二次就通了。
      const netErr = code === 408 || /secure TLS|handshake|ECONNRESET|socket hang up/i.test(rawMsg);
      const neverRegistered = !s.qrRefs && !s.pairCode;
      s.netFails = (s.netFails || 0) + 1;
      if (netErr && neverRegistered && !loggedOut && alive() && s.netFails <= 6) {
        const delay = 2500;
        s.retryTimer = setTimeout(() => {
          if (!alive()) return;
          connect(uid, { force: true, netRetry: true }).catch(e => waErr('重连失败', e.message));
        }, delay);
        const msg = '网络握手失败（第 ' + s.netFails + '/6 次），正在自动重试…';
        s.error = msg + (s.netFails >= 5 ? '（多次失败说明代理不稳，建议换个节点）' : '');
        setStatus(uid, s.status, { error: s.error });
        waLog(msg);
        return;
      }

      if (!s.opened && !s.countedFail) { s.countedFail = true; bumpFail(uid); }
      waLog('连接关闭：code=' + code + ' opened=' + s.opened + ' fails=' + s.fails + ' ' + rawMsg.slice(0, 80));
      // 自动重连的两种合法场景：
      //   1) 登录过又掉线 → 退避重连；
      //   2) 刚发过配对码、手机还没提交 → WhatsApp 发码后会主动断一次，必须立刻重连等手机提交，
      //      否则码就废了（手机端表现为「无法关联设备」）。重连时带上原码，不重新申请。
      // 其它情况（纯注册阶段失败）绝不自动重试，避免变成刷注册被风控。
      const pairing = !!s.pairCode && Date.now() - (s.pairCodeAt || 0) < 120000;
      const canRetry = (!loggedOut && s.opened && s.fails <= 3) || (pairing && s.pairFails !== undefined && (s.pairFails = (s.pairFails || 0) + 1) <= 2);
      if (!loggedOut && alive() && canRetry) {
        if (s.retryTimer) clearTimeout(s.retryTimer);
        const delay = pairing && !s.opened ? 4000 : RETRY_BACKOFF[Math.min(s.fails - 1, RETRY_BACKOFF.length - 1)];
        const keepCode = pairing ? s.pairCode : '';
        const keepCodeAt = pairing ? s.pairCodeAt : 0;
        const keepPhone = pairing ? (s.pairPhone || '') : '';
        s.retryTimer = setTimeout(() => {
          if (!alive()) return;
          connect(uid, { force: true, keepCode, keepCodeAt, keepPhone })
            .catch(e => waErr('重连失败', e.message));
        }, delay);
        hint += '（' + Math.round(delay / 1000) + ' 秒后自动重连' + (pairing ? '，配对码继续有效' : '') + '）';
        s.error = hint;
        setStatus(uid, s.status, { error: hint });
      }
    }
    } catch (e) {
      waErr('connection.update 处理异常：', e && e.message);
    }
  });

  sock.ev.on('messages.upsert', async (evt) => {
    if (!alive()) return;
    // 不读取自动翻译开关：实时消息始终不自动调用翻译服务。
    const debug = process.env.CRM_WA_DEBUG === '1';
    const eventType = String((evt && evt.type) || '');
    const evtMessages = (evt && evt.messages) || [];
    if (evtMessages.length) {
      s.lastMessageEventAt = nowStr();
      if (eventType === 'notify') {
        s.notifyEvents = (s.notifyEvents || 0) + evtMessages.length;
        waLog('收到实时消息事件：' + evtMessages.length + ' 条');
      } else if (eventType === 'append') {
        s.appendEvents = (s.appendEvents || 0) + evtMessages.length;
        waLog('收到离线/同步消息事件：' + evtMessages.length + ' 条');
      }
    }
    if (debug) waLog('messages.upsert type=' + eventType + ' 条数=' + evtMessages.length);
    const ciphertextStub = B.proto && B.proto.WebMessageInfo && B.proto.WebMessageInfo.StubType
      ? B.proto.WebMessageInfo.StubType.CIPHERTEXT : 2;
    for (const msg of evtMessages) {
      const jid = msg.key && msg.key.remoteJid;
      const isStatus = jid === 'status@broadcast';
      const ownPn = String((sock.user && sock.user.id) || '');
      const ownLid = String((sock.user && sock.user.lid) || '');
      const remoteJid = String(jid || '');
      const remoteJidAlt = String((msg.key && msg.key.remoteJidAlt) || '');
      const ownCopy = !!((ownPn && (remoteJid === ownPn || remoteJidAlt === ownPn)) ||
        (ownLid && (remoteJid === ownLid || remoteJidAlt === ownLid)));
      const decryptFailed = !msg.message && Number(msg.messageStubType) === Number(ciphertextStub);
      // 只有实时客户消息才计入“接收异常”。历史同步、关联设备自己的副本和状态动态
      // 也可能以 CIPHERTEXT stub 出现，不能据此要求用户退出登录重新扫码。
      const liveCustomerMessage = eventType === 'notify' && !(msg.key && msg.key.fromMe) && !ownCopy;
      if (decryptFailed && !isStatus && liveCustomerMessage) {
        s.decryptFailures = (s.decryptFailures || 0) + 1;
        s.lastDecryptErrorAt = nowStr();
        s.lastDecryptError = String((msg.messageStubParameters && msg.messageStubParameters[0]) || '消息解密失败');
        if (s.decryptFailures === 1 || s.decryptFailures % 10 === 0) {
          waLog('实时客户消息解密失败：' + s.decryptFailures + ' 条；最后一次=' + s.lastDecryptError);
        }
      }
      if (debug) {
        waLog('原始消息 jid=' + jid + ' alt=' + (msg.key && msg.key.remoteJidAlt)
          + ' fromMe=' + (msg.key && msg.key.fromMe) + ' hasMessage=' + !!msg.message
          + ' stub=' + (msg.messageStubType || 0)
          + ' keys=' + (msg.message ? Object.keys(msg.message).join('/') : 'null'));
      }
      if (!msg.message) continue;
      const live = eventType === 'notify' || eventType === 'append';
      const messageId = storeMessage(acc.id, msg, {
        debug,
        live,
        // 离线补发的客户消息同样是未读；只靠 notify 会让重连期间的新消息没有角标。
        markUnread: live && !msg.key.fromMe,
      });
      if (messageId && !msg.key.fromMe) {
        s.messagesStored = (s.messagesStored || 0) + 1;
        s.lastInboundAt = tsOf(msg);
      }
      if (live && messageId && mediaMeta(msg)) {
        const saved = get('SELECT media_path FROM wa_messages WHERE id=?', messageId);
        if (saved && !saved.media_path) {
          downloadIncomingMedia(s.sock, acc.id, msg, messageId).catch(() => {});
        }
      }
    }
  });

  // 客户读取/送达回执（单聊）：只更新我方发出的消息。
  sock.ev.on('messages.update', (updates) => {
    if (!alive()) return;
    for (const item of updates || []) {
      const key = item && item.key ? item.key : {};
      const update = item && item.update ? item.update : {};
      const status = Number(update.status) || 0;
      if (!key.id || status < 3) continue;
      const at = receiptTime(update.messageTimestamp);
      updateMessageReceipt(acc.id, key.id, status, at, true);
    }
  });

  // 群聊逐人回执：readTimestamp 表示某位成员已经读取。
  sock.ev.on('message-receipt.update', (updates) => {
    if (!alive()) return;
    for (const item of updates || []) {
      const key = item && item.key ? item.key : {};
      const receipt = item && item.receipt ? item.receipt : {};
      if (!key.id) continue;
      const readAt = receiptTime(receipt.readTimestamp || receipt.playedTimestamp);
      const deliveredAt = receiptTime(receipt.receiptTimestamp);
      if (readAt) updateMessageReceipt(acc.id, key.id, 4, readAt, true);
      else if (deliveredAt) updateMessageReceipt(acc.id, key.id, 3, deliveredAt, true);
    }
  });

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    if (!alive()) return;
    try {
      const nameOf = new Map();
      for (const c of contacts || []) {
        if (!c.id) continue;
        if (c.name) nameOf.set(c.id, c.name);
        let phone = '';
        for (const cand of [c.phoneNumber, c.id]) {
          if (cand && String(cand).endsWith('@s.whatsapp.net')) { phone = chatPhone(cand); break; }
        }
        if (phone) run('UPDATE wa_chats SET phone=?, updated_at=? WHERE account_id=? AND jid=?', phone, nowStr(), acc.id, c.id);
      }
      for (const c of chats || []) {
        if (!c.id) continue;
        upsertChat(acc.id, c.id, { name: c.name || nameOf.get(c.id) || '', isGroup: c.id.endsWith('@g.us') });
        const chat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, c.id);
        if (chat && !chat.customer_id && !chat.is_group) autoBindChat(chat);
      }
      let n = 0;
      let mediaDownloads = 0;
      for (const m of messages || []) {
        if (n++ > 1500) break;   // 限量：历史太多既占内存也拖慢首屏
        const messageId = storeMessage(acc.id, m);
        if (messageId && mediaMeta(m) && mediaDownloads < 12) {
          const saved = get('SELECT media_path FROM wa_messages WHERE id=?', messageId);
          if (saved && !saved.media_path) {
            mediaDownloads++;
            downloadIncomingMedia(s.sock, acc.id, m, messageId).catch(() => {});
          }
        }
      }
      waLog('历史同步：' + (chats || []).length + ' 个会话 / ' + n + ' 条消息');
    } catch (e) { waErr('历史同步失败：', e.message); }
  });

  sock.ev.on('contacts.upsert', (list) => {
    if (!alive()) return;
    for (const c of list || []) {
      if (!c.id) continue;
      let phone = '';
      for (const cand of [c.phoneNumber, c.id]) {
        if (cand && String(cand).endsWith('@s.whatsapp.net')) { phone = chatPhone(cand); break; }
      }
      run(`UPDATE wa_chats SET name=CASE WHEN ?<>'' THEN ? ELSE name END,
        phone=CASE WHEN ?<>'' THEN ? ELSE phone END, updated_at=?
        WHERE account_id=? AND jid=?`,
        c.name || '', c.name || '', phone, phone, nowStr(), acc.id, c.id);
      const chat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, c.id);
      if (chat && !chat.customer_id && !chat.is_group) autoBindChat(chat);
    }
  });

  // v6 的会话事件：新会话/会话更新也要建档，不能只靠历史同步
  const onChats = (list) => {
    if (!alive()) return;
    let n = 0;
    for (const c of list || []) {
      if (!c.id || c.id === 'status@broadcast') continue;
      const pn = c.phoneNumber && String(c.phoneNumber).endsWith('@s.whatsapp.net') ? chatPhone(c.phoneNumber) : '';
      upsertChat(acc.id, c.id, {
        name: c.name || '',
        phone: pn,
        isGroup: c.id.endsWith('@g.us'),
        lastMsgAt: c.conversationTimestamp ? new Date(Number(c.conversationTimestamp) * 1000).toISOString().slice(0, 19).replace('T', ' ') : null,
      });
      if (Number(c.unreadCount) > 0) {
        run('UPDATE wa_chats SET unread=? WHERE account_id=? AND jid=?', Number(c.unreadCount), acc.id, c.id);
      }
      n++;
    }
    if (n) waLog('会话事件：+' + n + ' 个会话');
  };
  sock.ev.on('chats.upsert', onChats);
  sock.ev.on('chats.update', onChats);
  sock.ev.on('chats.set', onChats);

  // 调试：CRM_WA_DEBUG=1 时把收到的事件名打出来，排查"为什么没历史"用
  if (process.env.CRM_WA_DEBUG === '1') {
    const seen = new Map();
    sock.ev.process((events) => {
      for (const name of Object.keys(events || {})) seen.set(name, (seen.get(name) || 0) + 1);
      waLog('事件：' + Object.keys(events || {}).map(k => k + (Array.isArray(events[k]) ? '[' + events[k].length + ']' : '')).join(', '));
    });
  }

  return { ok: true };
}

async function disconnect(userId) {
  const uid = Number(userId);
  const acc = get('SELECT * FROM wa_accounts WHERE user_id=?', uid);
  // 重新扫码前先留一份可恢复快照；聊天和 CRM 数据不在这个目录里，不会被删除。
  if (acc) backupAuth(acc.id);
  const s = sessions.get(uid);
  if (s && s.sock) { try { await s.sock.logout(); } catch (e) { try { s.sock.end(undefined); } catch (e2) {} } }
  sessions.delete(uid);
  if (acc) {
    const dir = path.join(AUTH_DIR, 'account-' + acc.id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    // 防止 connect() 又从旧备份恢复同一个坏会话。
    setSetting('wa_skip_restore_' + acc.id, '1');
  }
  setStatus(uid, 'offline', { error: '已退出原关联设备。请点“扫码连接”，用手机重新扫码关联。' });
  return { ok: true };
}

/** 暂停：断开 socket 但保留登录态，不自动重连（怀疑账号异常时先按这个）。 */
function stop(userId) {
  const uid = Number(userId);
  const s = sessions.get(uid);
  if (s) {
    if (s.retryTimer) clearTimeout(s.retryTimer);
    try { s.sock.end(undefined); } catch (e) {}
    sessions.delete(uid);
  }
  setStatus(uid, 'paused', { error: '已手动暂停，登录态保留；点「扫码连接」可重新上线' });
  waLog('已手动暂停（保留登录态）');
  return { ok: true };
}

const lastTextSendAt = new Map();  // uid -> 上一条文字发送时间
const lastMediaSendAt = new Map(); // uid -> 下一个可用的媒体发送时间，支持批量上传并发
const MEDIA_SEND_GAP_MIN = 350;
const MEDIA_SEND_GAP_JITTER = 250;
const MEDIA_SEND_CONCURRENCY = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function waitForMediaSendSlot(uid) {
  // 先预约发送时隙，再等待。批量发送时每个文件都能拿到不同时隙，
  // 避免所有请求同时抢到同一时间导致 WhatsApp 判定为机器连发。
  const now = Date.now();
  const gap = MEDIA_SEND_GAP_MIN + Math.floor(Math.random() * MEDIA_SEND_GAP_JITTER);
  const startAt = Math.max(now, (lastMediaSendAt.get(uid) || 0) + gap);
  lastMediaSendAt.set(uid, startAt);
  if (startAt > now) await sleep(startAt - now);
}

async function sendText(userId, jid, text, quotedRow) {
  const uid = Number(userId);
  const s = sessions.get(uid);
  if (!s || s.status !== 'online') return { ok: false, error: 'WhatsApp 未连接' };
  // 人工发送节流：最短 1 秒 + 随机抖动，避免出现"机器连发"的特征
  const gap = 1000 + Math.floor(Math.random() * 400);
  const prev = lastTextSendAt.get(uid) || 0;
  if (Date.now() - prev < gap) return { ok: false, error: '发送太快了，稍等一下再发（防封保护）' };
  lastTextSendAt.set(uid, Date.now());
  const acc = get('SELECT * FROM wa_accounts WHERE user_id=?', uid);
  try {
    const quoted = quotedRow ? buildQuotedMessage(quotedRow) : null;
    const sent = await s.sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    if (sent && sent.key) {
      const messageId = storeMessage(acc.id, sent, { live: true });
      markSentQuote(messageId, quotedRow);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 从 CRM 发送图片/文件；仍沿用与人工输入相同的发送节流。 */
async function sendMedia(userId, jid, file, quotedRow) {
  const uid = Number(userId);
  const s = sessions.get(uid);
  if (!s || s.status !== 'online') return { ok: false, error: 'WhatsApp 未连接' };
  const data = file && file.data ? file.data : null;
  if (!data || !data.length) return { ok: false, error: '附件为空' };
  if (data.length > MAX_MEDIA) return { ok: false, error: '附件超过 20MB' };
  await waitForMediaSendSlot(uid);
  const acc = get('SELECT * FROM wa_accounts WHERE user_id=?', uid);
  const fileName = path.basename(String((file && file.filename) || 'attachment').replace(/\\/g, '/')) || 'attachment';
  const mime = String((file && file.contentType) || 'application/octet-stream').toLowerCase();
  const caption = String((file && file.caption) || '').trim();
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document';
  const payload = kind === 'image' ? { image: data, mimetype: mime, caption }
    : kind === 'video' ? { video: data, mimetype: mime, caption }
      : kind === 'audio' ? { audio: data, mimetype: mime, ptt: false }
        : { document: data, mimetype: mime, fileName, caption };
  try {
    const quoted = quotedRow ? buildQuotedMessage(quotedRow) : null;
    const sent = await s.sock.sendMessage(jid, payload, quoted ? { quoted } : undefined);
    if (sent && sent.key) {
      const messageId = storeMessage(acc.id, sent, { live: true });
      const mediaPath = messageId ? saveMediaBuffer(acc.id, messageId, data, { kind, mime, fileName }) : '';
      if (messageId && mediaPath) {
        run('UPDATE wa_messages SET media_path=?, media_name=?, media_mime=? WHERE id=?', mediaPath, fileName, mime, messageId);
      }
      markSentQuote(messageId, quotedRow);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 批量发送媒体：最多 3 路并发，发送时隙仍按顺序预约，保证不会瞬间连发。 */
async function sendMediaBatch(userId, jid, files, quotedRow) {
  const list = Array.isArray(files) ? files.filter(file => file && file.data && file.data.length) : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      const result = await sendMedia(userId, jid, list[index], index === 0 ? quotedRow : null);
      results[index] = Object.assign({ index: index }, result);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(MEDIA_SEND_CONCURRENCY, list.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** 服务重启后自动恢复已登录的账号（静默失败，不阻塞启动）。 */
function resumeAll(delayMs) {
  setTimeout(() => {
    if (!hasLib()) return;
    let rows = [];
    try { rows = all("SELECT * FROM wa_accounts WHERE status IN ('online','connecting')"); } catch (e) { return; }
    for (const acc of rows) {
      connect(acc.user_id).catch(e => waErr('自动恢复失败：', e.message));
    }
  }, delayMs || 5000);
}

/* ---------------- 健康检查 / 优雅关闭 ---------------- */

/** 给运维看的一句话状态（对照 WAHA 的 /health、wppconnect 的 /healthz） */
function health() {
  let acc = null;
  try { acc = get('SELECT * FROM wa_accounts ORDER BY id LIMIT 1'); } catch (e) {}
  const s = acc ? sessions.get(Number(acc.user_id)) : null;
  let creds = false, backup = '';
  if (acc) {
    try { creds = fs.existsSync(path.join(authDirOf(acc.id), 'creds.json')); } catch (e) {}
    const b = latestAuthBackup(acc.id);
    backup = b ? path.basename(b) : '';
  }
  let socketOpen = false;
  try { socketOpen = !!(s && s.sock && s.sock.ws && (s.sock.ws.readyState === 1 || s.sock.ws.isOpen)); } catch (e) {}
  let dbLastInbound = '';
  if (acc) {
    const row = get('SELECT MAX(ts) AS at FROM wa_messages WHERE account_id=? AND from_me=0', acc.id);
    dbLastInbound = row && row.at ? String(row.at) : '';
  }
  const status = s ? s.status : (acc ? acc.status : 'none');
  const decryptFailures = s ? Number(s.decryptFailures || 0) : 0;
  const messagesStored = s ? Number(s.messagesStored || 0) : 0;
  const receiveState = status !== 'online' || !socketOpen ? 'offline'
    : (decryptFailures > 0 && messagesStored === 0 ? 'degraded'
      : (messagesStored > 0 || dbLastInbound ? 'receiving' : 'waiting'));
  return {
    ok: hasLib(),
    lib: hasLib(),
    status,
    socketOpen,
    receiveState,
    receiveHealthy: status === 'online' && socketOpen && receiveState !== 'degraded',
    connectedAt: s ? (s.connectedAt || '') : '',
    lastMessageEventAt: s ? (s.lastMessageEventAt || '') : '',
    lastInboundAt: s ? (s.lastInboundAt || dbLastInbound) : dbLastInbound,
    notifyEvents: s ? Number(s.notifyEvents || 0) : 0,
    appendEvents: s ? Number(s.appendEvents || 0) : 0,
    messagesStored,
    decryptFailures,
    lastDecryptErrorAt: s ? (s.lastDecryptErrorAt || '') : '',
    lastDecryptError: s ? (s.lastDecryptError || '') : '',
    phone: acc ? acc.phone : '',
    proxy: proxyUrl() || 'direct',
    creds,
    backup,
    failStreak: acc ? failStreak(acc.user_id) : 0,
    lockHoursLeft: acc ? lockHoursLeft(acc.user_id) : 0,
    sessions: sessions.size,
    serverTime: nowStr(),
  };
}

/** 进程退出前：备份登录态 + 断开所有 socket，避免 creds 写一半。 */
async function shutdown() {
  waLog('收到退出信号，正在保存登录态并断开 WhatsApp…');
  for (const [uid, s] of sessions) {
    try {
      const acc = get('SELECT * FROM wa_accounts WHERE user_id=?', uid);
      if (acc && s.opened) backupAuth(acc.id);
      if (s.retryTimer) clearTimeout(s.retryTimer);
      if (s.sock) s.sock.end(undefined);
    } catch (e) {}
  }
  sessions.clear();
  await new Promise(r => setTimeout(r, 300));
  waLog('已断开，可以安全退出');
}

/* ---------------- 会话可见性 ---------------- */

/** 账号本人看自己的全部会话；绑定客户后，客户归属业务员也能看。 */
function visibleChatsSql() {
  return `(c.account_id IN (SELECT id FROM wa_accounts WHERE user_id=?)
           OR c.customer_id IN (SELECT id FROM customers WHERE user_id=?))`;
}

module.exports = {
  ensureAccount, accountView, connect, disconnect, stop, sendText, sendMedia, sendMediaBatch, resumeAll,
  translateMessage, callTranslate, parseGoogleTranslation, isTranslationRefusal, summarizeChat, draftReply, storeMessage, upsertChat, autoBindChat, adInfoOf, copyAdAttributionToCustomer, buildQuotedMessage, quotePreview,
  markChatRead, updateMessageReceipt, scheduleWhatsAppFollowup, ensureTodayWhatsAppFollowups, syncChatFollowup,
  visibleChatsSql, chatPhone, hasLib, sessions, testProxy, proxyUrl, getChatAvatarPath,
  health, shutdown, backupAuth, latestAuthBackup, restoreAuthIfMissing, clearLimits,
  resetFail, lockHoursLeft, failStreak,
};

