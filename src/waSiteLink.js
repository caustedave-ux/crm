'use strict';

const { setTimeout: wait } = require('node:timers/promises');
const { all, get, run, transaction } = require('./db');
const { nowStr } = require('./util');
const wa = require('./wa');
const { normalizePhone } = require('./waImport');
const { isRefusal } = require('../auto-reply/logic');

const SITE_URL = 'https://foeve.vip/';
const INTRO = 'You can browse our door hardware range on the FOEVE website:';
const MESSAGE = INTRO + '\n' + SITE_URL;
const MESSAGE_LIMIT = 4096;
const BATCH_LIMIT = 3;
const DAILY_LIMIT = 10;
const GAP_MS = 15000;
const DEFAULT_AUTO_LIMIT = 30;
const DEFAULT_AUTO_GAP = 60;
const MAX_DAILY_LIMIT = 100;
const MAX_GAP_SECONDS = 3600;
const DAY_MS = 86400000;
const RESEND_DAYS = 30;
const PAGE_SIZE = 25;
const running = new Set();
let timer;

const candidatesSql = `
  FROM wa_chats c
  WHERE c.account_id=? AND c.customer_id IS NULL AND COALESCE(c.is_group,0)=0
    AND (c.jid LIKE '%@s.whatsapp.net' OR c.jid LIKE '%@lid')
    AND NULLIF(c.last_msg_at,'') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM wa_site_link_sends s WHERE s.account_id=c.account_id AND s.jid=c.jid
      AND s.attempted_at>=?)
    AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.account_id=c.account_id AND m.chat_jid=c.jid AND m.from_me=0)
    AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.account_id=c.account_id AND m.chat_jid=c.jid
      AND m.from_me=1 AND lower(m.text) LIKE '%foeve.vip%'
      AND (COALESCE(NULLIF(m.ts,''),NULLIF(m.created_at,'')) IS NULL
        OR COALESCE(NULLIF(m.ts,''),NULLIF(m.created_at,''))>=?))
    `;

function blockedNumbers(userId) {
  const profiles = all('SELECT whatsapp,phone,contact_phone FROM customers WHERE user_id=? AND do_not_contact=1', userId);
  const contacts = all(`SELECT ct.phone,ct.mobile FROM contacts ct JOIN customers c ON c.id=ct.customer_id
    WHERE c.user_id=? AND c.do_not_contact=1`, userId);
  return new Set([...profiles, ...contacts].flatMap(row =>
    Object.values(row).map(normalizePhone).filter(Boolean)));
}

function candidates(account, userId, ids, now = Date.now()) {
  const whereIds = ids ? ' AND c.id IN (' + ids.map(() => '?').join(',') + ')' : '';
  const blocked = blockedNumbers(userId);
  const cutoff = now - RESEND_DAYS * DAY_MS;
  // WhatsApp 消息时间使用本地时间，精确到秒。
  const messageCutoff = nowStr(new Date(Math.ceil(cutoff / 1000) * 1000));
  return all(`SELECT c.id,c.jid,c.name,c.phone,c.last_msg_at
    ${candidatesSql}${whereIds} ORDER BY c.last_msg_at ASC,c.id ASC`,
  account.id, cutoff, messageCutoff, ...(ids || []))
    .filter(chat => {
      const number = /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(chat.jid) ? wa.chatPhone(chat.jid) : chat.phone;
      return !blocked.has(normalizePhone(number)) && !all(`SELECT text FROM wa_messages
        WHERE account_id=? AND chat_jid=? AND from_me=0 AND kind='text' AND COALESCE(text,'')<>''`,
      account.id, chat.jid).some(message => isRefusal(
        message.text.trim().replace(/^please[\s,]+/i, '').replace(/[\s,]+please[.!]?$/i, '')
      ));
    });
}

function quota(accountId, now, dailyLimit, gapMs) {
  const row = get(`SELECT COUNT(*) AS used,MAX(attempted_at) AS latest FROM wa_site_link_sends
    WHERE account_id=? AND attempted_at>?`, accountId, now - DAY_MS);
  return { remaining: Math.max(0, dailyLimit - row.used), waitMs: Math.max(0, (row.latest || 0) + gapMs - now) };
}

function settings(userId) {
  return get('SELECT * FROM wa_site_link_jobs WHERE user_id=?', userId);
}

function preview(userId, requestedPage) {
  const account = get('SELECT id FROM wa_accounts WHERE user_id=?', userId);
  const job = settings(userId);
  const dailyLimit = job?.daily_limit ?? DAILY_LIMIT;
  const gapMs = job ? job.gap_seconds * 1000 : GAP_MS;
  const list = account ? candidates(account, userId) : [];
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const requested = Number(requestedPage);
  const page = Number.isSafeInteger(requested) ? Math.max(1, Math.min(pages, requested)) : 1;
  return {
    page, pages, total: list.length, chats: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    remaining: account ? quota(account.id, Date.now(), dailyLimit, gapMs).remaining : 0,
    online: !!account && wa.sessions.get(userId)?.status === 'online',
    job, dailyLimit, gapMs,
  };
}

function validateMessage(draft) {
  const message = typeof draft === 'string' ? draft.replace(/\r\n?/g, '\n').trim() : '';
  if (!message || message.length > MESSAGE_LIMIT) {
    return { error: '请输入 1 至 ' + MESSAGE_LIMIT + ' 字的消息', sent: 0 };
  }
  const hasSiteLink = (message.match(/https:\/\/[^\s<>"']+/gi) || []).some(link => {
    try {
      const url = new URL(link.replace(/[.,，。!?！？)）]+$/u, ''));
      return ['foeve.vip', 'www.foeve.vip'].includes(url.host) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
  if (!hasSiteLink) return { error: '请在消息中保留一个 FOEVE 站内 HTTPS 链接', sent: 0 };
  return { message };
}

function configure(userId, body) {
  if (body.action === 'pause') {
    run('UPDATE wa_site_link_jobs SET enabled=0 WHERE user_id=?', userId);
    return {};
  }
  if (body.action !== 'start') return { error: '请选择启动或暂停' };
  const dailyLimit = Number(body.daily_limit);
  const gapSeconds = Number(body.gap_seconds);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > MAX_DAILY_LIMIT) {
    return { error: '每日数量须为 1 至 ' + MAX_DAILY_LIMIT + ' 的整数' };
  }
  if (!Number.isInteger(gapSeconds) || gapSeconds < GAP_MS / 1000 || gapSeconds > MAX_GAP_SECONDS) {
    return { error: '发送间隔须为 ' + GAP_MS / 1000 + ' 至 ' + MAX_GAP_SECONDS + ' 秒的整数' };
  }
  const { message, error } = validateMessage(body.message);
  if (error) return { error };
  run(`INSERT INTO wa_site_link_jobs(user_id,enabled,daily_limit,gap_seconds,message) VALUES(?,1,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=1,daily_limit=excluded.daily_limit,
      gap_seconds=excluded.gap_seconds,message=excluded.message,last_error=''`, userId, dailyLimit, gapSeconds, message);
  return {};
}

async function sendOne(userId, account, chat, message, dailyLimit, gapMs) {
  const claimed = transaction(() => {
    const now = Date.now();
    const allowance = quota(account.id, now, dailyLimit, gapMs);
    if (allowance.remaining <= 0 || allowance.waitMs > 0 || !candidates(account, userId, [chat.id], now).length) return false;
    const claim = run(`INSERT INTO wa_site_link_sends(account_id,jid,attempted_at) VALUES(?,?,?)
      ON CONFLICT(account_id,jid) DO UPDATE SET attempted_at=excluded.attempted_at,status='pending'
      WHERE wa_site_link_sends.attempted_at<?`, account.id, chat.jid, now, now - RESEND_DAYS * DAY_MS);
    return claim.changes === 1;
  });
  if (!claimed) return 'skipped';
  // 先记录尝试，进程退出或连接中断也不会自动重发同一会话。
  let result;
  try { result = await wa.sendText(userId, chat.jid, message); }
  catch { result = { ok: false }; }
  const status = result?.ok ? 'sent' : 'unconfirmed';
  run('UPDATE wa_site_link_sends SET status=?,attempted_at=MAX(attempted_at,?) WHERE account_id=? AND jid=?',
    status, Date.now(), account.id, chat.jid);
  return status;
}

async function sendBatch(userId, selected, draft) {
  const { message, error } = validateMessage(draft);
  if (error) return { sent: 0, error };
  const ids = [...new Set((Array.isArray(selected) ? selected : [selected]).map(Number))];
  if (!ids.length || ids.length > BATCH_LIMIT || !ids.every(id => Number.isSafeInteger(id) && id > 0)) {
    return { error: '请选择 1 至 ' + BATCH_LIMIT + ' 个会话', sent: 0 };
  }
  const account = get('SELECT id FROM wa_accounts WHERE user_id=?', userId);
  if (!account || wa.sessions.get(userId)?.status !== 'online') return { error: '请先连接 WhatsApp', sent: 0 };
  if (running.has(account.id)) return { error: '当前账号已有一批正在发送', sent: 0 };
  running.add(account.id);
  let sent = 0;
  let skipped = 0;
  try {
    const selectedChats = candidates(account, userId, ids);
    if (selectedChats.length !== ids.length) return { sent, error: '所选会话已变化，请重新查看候选列表' };
    const job = settings(userId);
    const dailyLimit = job?.daily_limit ?? DAILY_LIMIT;
    if (job?.enabled) return { sent, error: '后台任务已启用，请暂停后再手动发送' };
    const gapMs = GAP_MS;
    if (quota(account.id, Date.now(), dailyLimit, gapMs).remaining < selectedChats.length) return { sent, error: '本批数量超过当前剩余额度' };
    for (const chat of selectedChats) {
      const { waitMs } = quota(account.id, Date.now(), dailyLimit, gapMs);
      if (waitMs) await wait(waitMs);
      if (wa.sessions.get(userId)?.status !== 'online') return { sent, skipped, error: 'WhatsApp 连接已断开' };
      const status = await sendOne(userId, account, chat, message, dailyLimit, gapMs);
      if (status === 'skipped') { skipped++; continue; }
      if (status !== 'sent') return { sent, skipped, error: '有一条发送结果未确认，本批已停止。请在会话中核对。' };
      sent++;
    }
    return { sent, skipped };
  } finally {
    running.delete(account.id);
  }
}

async function tick() {
  const jobs = all(`SELECT j.*,a.id AS account_id FROM wa_site_link_jobs j
    JOIN users u ON u.id=j.user_id AND u.active=1
    JOIN wa_accounts a ON a.user_id=j.user_id WHERE j.enabled=1`);
  await Promise.all(jobs.map(async job => {
    const account = { id: job.account_id };
    if (running.has(account.id) || wa.sessions.get(job.user_id)?.status !== 'online') return;
    const gapMs = job.gap_seconds * 1000;
    const { remaining, waitMs } = quota(account.id, Date.now(), job.daily_limit, gapMs);
    if (!remaining || waitMs) return;
    const chat = candidates(account, job.user_id)[0];
    if (!chat) return;
    running.add(account.id);
    try {
      const result = await sendOne(job.user_id, account, chat, job.message, job.daily_limit, gapMs);
      if (result === 'unconfirmed') {
        run('UPDATE wa_site_link_jobs SET enabled=0,last_error=? WHERE user_id=?',
          '有一条发送结果未确认，任务已暂停。请检查 WhatsApp 后再启动。', job.user_id);
      }
    } finally {
      running.delete(account.id);
    }
  }));
}

function start() {
  if (!timer) timer = setInterval(() => tick().catch(error => console.error('独立站链接后台任务失败：', error.message)), 5000).unref();
}

function stop() {
  clearInterval(timer);
  timer = undefined;
}

module.exports = {
  MESSAGE, MESSAGE_LIMIT, BATCH_LIMIT, GAP_MS, RESEND_DAYS, DEFAULT_AUTO_LIMIT, DEFAULT_AUTO_GAP,
  MAX_DAILY_LIMIT, MAX_GAP_SECONDS, preview, sendBatch, configure, start, stop,
};
