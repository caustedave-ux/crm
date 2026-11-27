'use strict';
// 每日跟进盘点：导出「今天到期 + 已逾期」的跟进，并附上对应客户最近的 WhatsApp 聊天原文，
// 供 AI 每天早上总结要点、拟定回复话术。
// 用法：node tools/daily_followup.js [--msgs 15] [--chats 2] [--chars 300] [--user hq]
// 输出：stdout 的 JSON（不写库、不改数据）

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { all, get } = require(path.join(ROOT, 'src', 'db'));
const { todayStr } = require(path.join(ROOT, 'src', 'util'));

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const MSG_LIMIT = Math.max(3, Number(opt('msgs', 15)) || 15);
const CHAT_LIMIT = Math.max(1, Number(opt('chats', 2)) || 2);
const MAX_CHARS = Math.max(60, Number(opt('chars', 300)) || 300);
const DEEP_LIMIT = Math.max(5, Number(opt('deep', 30)) || 30); // 需要深度总结（要点+话术）的最大条数
const ONLY_USER = String(opt('user', '') || '').trim();
const RECENT_DAYS = 14; // 客户最近这么天内有来信，就算“有动静”

const today = todayStr();

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function dayOf(v) { return String(v || '').slice(0, 10); }

// 1) 到期与逾期跟进（archived=0，next_follow_date <= 今天）
let sql = `SELECT a.id, a.customer_id, a.type, a.subject, a.content, a.next_follow_date,
    a.next_follow_notes, a.priority, a.user_id, a.activity_date, a.outcome,
    c.company_name, c.contact_person, c.phone, c.whatsapp, c.email, c.country
  FROM activities a JOIN customers c ON c.id = a.customer_id
  WHERE a.archived = 0 AND a.next_follow_date IS NOT NULL AND a.next_follow_date <> ''
    AND substr(a.next_follow_date, 1, 10) <= ?`;
const params = [today];
if (ONLY_USER) {
  const u = get('SELECT id FROM users WHERE username = ?', ONLY_USER);
  if (u) { sql += ' AND a.user_id = ?'; params.push(u.id); }
}
sql += ` ORDER BY substr(a.next_follow_date, 1, 10) ASC,
  CASE a.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, a.id DESC`;

const due = all(sql, ...params);

const users = all('SELECT id, username, COALESCE(NULLIF(display_name, \'\'), username) AS name FROM users');
const userName = id => {
  const u = users.find(x => Number(x.id) === Number(id));
  return u ? u.name + (u.username && u.username !== u.name ? '(' + u.username + ')' : '') : '未分配';
};

const items = due.map(row => {
  const d = dayOf(row.next_follow_date);
  const daysLate = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
  // 该客户的历史跟进记录（最近 3 条，帮 AI 判断进度）
  const recentActs = all(`SELECT type, subject, content, activity_date, next_follow_date, outcome
    FROM activities WHERE customer_id = ? AND archived = 0 AND id <> ?
    ORDER BY COALESCE(activity_date, '') DESC, id DESC LIMIT 3`, row.customer_id, row.id)
    .map(a => ({
      date: dayOf(a.activity_date),
      type: a.type || '',
      subject: clip(a.subject, 80),
      content: clip(a.content, MAX_CHARS),
      next: dayOf(a.next_follow_date),
      outcome: a.outcome || '',
    }));

  // 绑定的 WhatsApp 会话（按最近消息排序）
  const chats = all(`SELECT id, jid, phone, name, account_id, unread, last_msg_at, last_msg_text,
      last_inbound_at, manual_category, remark
    FROM wa_chats WHERE customer_id = ? AND is_group = 0
    ORDER BY COALESCE(last_msg_at, '') DESC LIMIT ?`, row.customer_id, CHAT_LIMIT)
    .map(ch => {
      const raw = all(`SELECT from_me, kind, text, translated, ts, sender_name
        FROM wa_messages WHERE account_id = ? AND chat_jid = ?
        ORDER BY COALESCE(ts, '') DESC, id DESC LIMIT ?`, ch.account_id, ch.jid, MSG_LIMIT);
      // 最新一条是不是客户发的（是 → 客户在等我们回复）
      const pendingReply = raw.length > 0 && !Number(raw[0].from_me);
      const msgs = raw.map(m => ({
        at: String(m.ts || '').slice(0, 16),
        from: Number(m.from_me) ? '我方' : (m.sender_name || '客户'),
        kind: m.kind || 'text',
        text: clip(m.text, MAX_CHARS),
        translated: m.translated ? clip(m.translated, MAX_CHARS) : '',
      })).reverse();
      return {
        chat: ch.name || ('+' + (ch.phone || '')),
        jid: ch.jid,
        unread: Number(ch.unread || 0),
        lastMsgAt: String(ch.last_msg_at || '').slice(0, 16),
        lastInboundAt: String(ch.last_inbound_at || '').slice(0, 16),
        pendingReply,
        category: ch.manual_category || '',
        remark: clip(ch.remark, 120),
        messages: msgs,
      };
    });

  const pendingReply = chats.some(c => c.pendingReply);
  const lastInboundAt = chats.map(c => c.lastInboundAt).filter(Boolean).sort().pop() || '';
  const recentInbound = !!lastInboundAt &&
    (Date.parse(today + 'T00:00:00Z') - Date.parse(lastInboundAt.slice(0, 10) + 'T00:00:00Z')) / 86400000 <= RECENT_DAYS;
  // 需要“要点 + 话术”的：客户在等回复 / 今天到期 / 高优先级
  const deep = pendingReply || daysLate <= 0 || String(row.priority || '') === '高';

  return {
    activityId: row.id,
    customerId: row.customer_id,
    customer: row.company_name || row.contact_person || ('客户#' + row.customer_id),
    contact: row.contact_person || '',
    phone: row.phone || '',
    whatsapp: row.whatsapp || '',
    email: row.email || '',
    country: row.country || '',
    owner: userName(row.user_id),
    priority: row.priority || '中',
    dueDate: d,
    status: daysLate > 0 ? '逾期' + daysLate + '天' : '今天',
    type: row.type || '',
    lastSubject: clip(row.subject, 100),
    lastContent: clip(row.content, MAX_CHARS),
    lastOutcome: row.outcome || '',
    followNote: clip(row.next_follow_notes, 200),
    lastActivityDate: dayOf(row.activity_date),
    pendingReply,
    lastInboundAt,
    recentInbound,
    deep,
    recentActivities: deep ? recentActs : [],
    chats: deep ? chats : chats.map(c => ({ chat: c.chat, unread: c.unread, lastMsgAt: c.lastMsgAt, lastInboundAt: c.lastInboundAt, pendingReply: c.pendingReply })),
  };
});

// 同一客户可能有多条到期跟进，按客户合并：主记录取最早到期的一条，其余收进 others
const byCustomer = new Map();
for (const it of items) {
  const key = it.customerId;
  const prev = byCustomer.get(key);
  if (!prev) { byCustomer.set(key, it); continue; }
  const head = prev.dueDate <= it.dueDate ? prev : it;
  const tail = head === prev ? it : prev;
  head.others = (head.others || []).concat([{
    activityId: tail.activityId, dueDate: tail.dueDate, status: tail.status,
    subject: tail.lastSubject, followNote: tail.followNote,
  }]);
  head.others = head.others.concat(tail.others || []);
  head.pendingReply = head.pendingReply || tail.pendingReply;
  head.deep = head.deep || tail.deep;
  if (!head.chats.length) head.chats = tail.chats;
  if (!head.recentActivities.length) head.recentActivities = tail.recentActivities;
  byCustomer.set(key, head);
}
const merged = Array.from(byCustomer.values())
  .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

const deepItems = merged.filter(i => i.deep).slice(0, DEEP_LIMIT);
const summary = {
  date: today,
  generatedAt: new Date().toISOString(),
  totalActivities: items.length,
  totalCustomers: merged.length,
  overdue: merged.filter(i => i.status.startsWith('逾期')).length,
  dueToday: merged.filter(i => i.status === '今天').length,
  pendingReply: merged.filter(i => i.pendingReply).length,
  deepCount: deepItems.length,
  byOwner: Object.entries(merged.reduce((m, i) => { m[i.owner] = (m[i.owner] || 0) + 1; return m; }, {}))
    .map(([owner, count]) => ({ owner, count })),
  items: deepItems,                       // 需要写要点 + 回复话术的
  rest: merged.filter(i => !deepItems.includes(i)).map(i => ({
    customer: i.customer, owner: i.owner, status: i.status, dueDate: i.dueDate,
    priority: i.priority, followNote: i.followNote, pendingReply: i.pendingReply,
    moreActivities: (i.others || []).length,
  })),                                    // 其余只列清单
};

process.stdout.write(JSON.stringify(summary, null, 1));
