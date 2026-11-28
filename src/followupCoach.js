'use strict';
// ============ 跟进要点 + 回复话术（AI）============
// 「跟进中心 → 待处理跟进」每位客户一个按钮：读最近 WhatsApp 聊天 + 跟进记录 + 跟进备注，
// 让 AI 总结聊天要点、指出卡点、给 1-2 版可直接发送的话术（客户语言 + 中文对照）。
// 只读业务数据；结果缓存在 ai_followup_notes，重新生成时覆盖。

const { all, get, run } = require('./db');
const ai = require('./aiProvider');

const KIND_LABEL = { image: '[图片]', sticker: '[贴纸]', video: '[视频]', audio: '[语音]', document: '[文件]', contact: '[名片]' };

function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

/** 取该客户最近 1-2 个 WhatsApp 会话的原文（含译文），拼成可读文本 */
function chatDigest(userId, customerId, perChat) {
  const chats = all(`SELECT id, name, jid, is_group, last_msg_at FROM wa_chats
    WHERE customer_id=? AND account_id IN (SELECT id FROM wa_accounts WHERE user_id=?)
    ORDER BY COALESCE(last_msg_at,'') DESC, id DESC LIMIT 2`, customerId, userId);
  if (!chats.length) return { chats: [], text: '' };
  const blocks = [];
  for (const c of chats) {
    const rows = all(`SELECT msg_id, from_me, kind, text, translated, media_name, sender_name, ts
      FROM wa_messages WHERE account_id=? AND chat_jid=? ORDER BY ts DESC, id DESC LIMIT ?`,
      (get('SELECT account_id FROM wa_chats WHERE id=?', c.id) || {}).account_id, c.jid, perChat || 40);
    const lines = rows.slice().reverse().map(m => {
      const who = Number(m.from_me) === 1 ? '我方' : (m.sender_name || '客户');
      const main = clip(m.text || m.media_name || KIND_LABEL[m.kind] || '', 300) || KIND_LABEL[m.kind] || '[消息]';
      const zh = m.translated ? '（译：' + clip(m.translated, 300) + '）' : '';
      return '[' + String(m.ts || '').slice(5, 16) + '] ' + who + '：' + main + zh;
    });
    blocks.push('会话' + (c.name ? '（' + c.name + '）' : '') + '最后更新 ' + String(c.last_msg_at || '').slice(0, 16) + '\n' + lines.join('\n'));
  }
  return { chats, text: blocks.join('\n\n') };
}

function buildContext(userId, customerId, perChat) {
  const c = get('SELECT id, company_name, name_en, country, contact_person, customer_tier, notes, whatsapp, phone FROM customers WHERE id=? AND user_id=?', customerId, userId);
  if (!c) return null;
  const acts = all(`SELECT type, subject, content, outcome, activity_date, next_follow_date, next_follow_notes, priority
    FROM activities WHERE customer_id=? AND user_id=? ORDER BY COALESCE(activity_date, created_at) DESC, id DESC LIMIT 6`, customerId, userId);
  const chat = chatDigest(userId, customerId, perChat);
  const lastInbound = acts.length ? acts[0] : null;
  return {
    customer: c,
    activities: acts,
    chats: chat.chats,
    chatText: chat.text,
    followNote: lastInbound ? String(lastInbound.next_follow_notes || '') : '',
    lastActivity: lastInbound,
  };
}

function sysPrompt() {
  return [
    '你是一家中国五金门锁出口企业的资深外贸业务助理，帮业务员处理「待处理跟进」。',
    '只能依据给定的 WhatsApp 聊天原文、历史跟进记录和跟进备注写内容；聊天里没有的事实（价格、交期、数量、承诺）一律不许编，缺具体数字时写 XXX 让业务员填。',
    '必须先看懂客户最后说了什么、在等什么，话术要直接回应客户最后一句，并给出明确下一步和一个便于客户回答的问题。',
    '话术按客户使用的语言写（英语/法语/俄语/西班牙语/阿拉伯语/葡萄牙语/乌兹别克语/中文），同一段再给一句中文对照；客户用中文就只给中文。',
    '不要空泛套话，不要写「很高兴为您服务」这类模板句。',
    '只输出一个 JSON 对象，不要代码围栏，结构：',
    '{"summary":["要点1","要点2","要点3"],"stuck":"一句话说明为什么卡住","scripts":[{"lang":"English","text":"可直接发送的话术","zh":"这句的中文意思"}]}',
    'summary 2-4 条，每条 40 字以内；scripts 给 1-2 版，每版 40-160 词。',
  ].join('\n');
}

function parseJson(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let s = m[0].replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try { return JSON.parse(s); } catch (e) {}
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
  return null;
}

function normalize(parsed) {
  const summary = (Array.isArray(parsed && parsed.summary) ? parsed.summary : [])
    .map(x => clip(x, 120)).filter(Boolean).slice(0, 4);
  const scripts = (Array.isArray(parsed && parsed.scripts) ? parsed.scripts : [])
    .map(s => ({
      lang: clip(s && s.lang || 'English', 30),
      text: String(s && s.text || '').trim().slice(0, 1200),
      zh: clip(s && s.zh || '', 500),
    }))
    .filter(s => s.text)
    .slice(0, 2);
  return { summary, stuck: clip(parsed && (parsed.stuck || parsed.block || ''), 200), scripts };
}

function cached(userId, customerId) {
  const row = get('SELECT * FROM ai_followup_notes WHERE user_id=? AND customer_id=?', userId, customerId);
  if (!row) return null;
  let data = null;
  try { data = JSON.parse(row.content); } catch (e) { return null; }
  return Object.assign({ cached: true, provider: row.provider, model: row.model, created_at: row.created_at }, data);
}

async function generate(userId, customerId, opts) {
  const o = opts || {};
  const ctx = buildContext(userId, customerId, o.messagesPerChat);
  if (!ctx) throw new Error('客户不存在');
  const c = ctx.customer;
  const userText = [
    '客户：' + (c.company_name || '') + (c.name_en ? ' / ' + c.name_en : ''),
    '国家：' + (c.country || '未填写') + ' · 分层：' + (c.customer_tier || '未分层') + ' · 联系人：' + (c.contact_person || '未填写'),
    c.notes ? '客户备注：' + clip(c.notes, 400) : '',
    '',
    '【最近跟进记录】',
    ctx.activities.length ? ctx.activities.map(a => [
      '-' + String(a.activity_date || '').slice(0, 10) + ' ' + (a.type || '跟进') + '｜' + (a.subject || ''),
      a.content ? '  内容：' + clip(a.content, 200) : '',
      a.outcome ? '  结果：' + clip(a.outcome, 120) : '',
      a.next_follow_notes ? '  下一步：' + clip(a.next_follow_notes, 150) : '',
      a.next_follow_date ? '  计划跟进：' + String(a.next_follow_date).slice(0, 10) : '',
    ].filter(Boolean).join('\n')).join('\n') : '（暂无跟进记录）',
    '',
    '【WhatsApp 聊天原文】',
    ctx.chatText || '（该客户还没有绑定或同步过 WhatsApp 聊天记录）',
    '',
    '请按系统要求输出 JSON：总结要点、卡点、回复话术。',
  ].filter(Boolean).join('\n');

  const text = await ai.chat({
    system: sysPrompt(),
    user: userText.slice(0, 26000),
    maxTokens: 900,
    temperature: 0.4,
    json: true,
    timeoutMs: 120000,
  });
  const parsed = parseJson(text);
  if (!parsed) throw new Error('AI 返回格式无法解析，请稍后重试');
  const data = normalize(parsed);
  if (!data.scripts.length) throw new Error('AI 没有返回话术，请重试');
  const st = ai.status();
  const t = require('./util').nowStr();
  run(`INSERT INTO ai_followup_notes(user_id,customer_id,provider,model,content,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,customer_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, content=excluded.content, created_at=excluded.created_at`,
    userId, customerId, st.provider || '', st.model || '', JSON.stringify(data), t);
  return Object.assign({ cached: false, provider: st.provider, model: st.model, created_at: t,
    hasChat: !!ctx.chatText, customer: c.company_name }, data);
}

module.exports = { generate, cached, buildContext };
