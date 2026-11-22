'use strict';
// ============ WhatsApp 聊天记录：导出文件解析 + 导入 CRM ============
// 把手机 WhatsApp「导出聊天」得到的 .txt/.zip 解析成结构化消息，按"天"写入跟进记录。
//
// 设计参考了开源项目 GoodJob 的 whatsapp-history-import / followup-sync 三个要点：
//   1. 行框架两种（[戳] 发送人: 正文 / 戳 - 发送人: 正文），但**戳里的日期与时间谁在前无关**，
//      中英文时段（上午/下午、AM/PM）都要认；日月顺序拿不准时按 >12 逐个判、判不出再问用户。
//   2. **按天幂等**：同一天重跑是"改写"，不是再写一条（唯一键 customer+chat+day）。
//   3. 系统提示、空消息、已撤回都不算"聊了什么"，不进正文。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { run, get } = require('./db');
const { randomToken, nowStr } = require('./util');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TMP_DIR = path.join(DATA_DIR, 'wa-tmp');
const MAX_TEXT_BYTES = 12 * 1024 * 1024;  // 单文件上限 12MB
const MAX_DAY_CHARS = 60000;              // 单天跟进记录正文上限

const INVISIBLE = /[\u200e\u200f\u202a-\u202e\ufeff]/g;

// 破折号式/老式冒号式：行首是「日期 时间」，随后 "- " 或 ": " 引出正文
const RE_DASH = /^(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:[AaPp]\.?[Mm]\.?|上午|下午))?)(?:\s*[-\u2013\u2014]\s*|\s+)([\s\S]*)$/;
const RE_SENDER = /^([^:\n]{1,64}):\s?([\s\S]*)$/;

const MEDIA_LABELS = [
  [/^(<media omitted>|<媒体已省略>)$/i, '图片/视频'],
  [/^(<image omitted>|图片已省略)$/i, '图片'],
  [/^(<video omitted>|视频已省略)$/i, '视频'],
  [/^(<audio omitted>|语音已省略|音频已省略)$/i, '语音'],
  [/^(<sticker omitted>|贴纸已省略)$/i, '贴纸'],
  [/^(<document omitted>|文件已省略)$/i, '文件'],
  [/^(<gif omitted>|GIF 已省略)$/i, 'GIF'],
  [/^(<contact card omitted>|联系人名片已省略)$/i, '名片'],
  [/^<attached:.*>$/i, '附件'],
];

/* ---------------- 基础工具 ---------------- */

function decodeBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  let s = b.toString('utf8');
  const bad = (s.match(/\uFFFD/g) || []).length;
  if (bad > 5 && bad > s.length * 0.01) {
    const u16 = b.toString('utf16le');
    if ((u16.match(/\uFFFD/g) || []).length < bad) return u16;
    return b.toString('latin1');
  }
  return s.replace(/^\uFEFF/, '');
}

// 零依赖解包 zip（安卓导出的：一个 _chat.txt + 一堆图片/语音/文件）
// 返回 { text: Buffer|null, files: [{name, data}] }；单文件/总量都有上限，防炸内存。
const MAX_ZIP_ENTRY = 12 * 1024 * 1024;
const MAX_ZIP_TOTAL = 80 * 1024 * 1024;

function extractZip(buf) {
  const empty = { text: null, files: [] };
  if (!Buffer.isBuffer(buf) || buf.length < 22) return empty;
  const SIG_EOCD = 0x06054b50;
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return empty;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off <= 0 || off >= buf.length) return empty;
  const entries = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  let text = null;
  const files = [];
  let total = 0;
  for (const e of entries) {
    if (/\/$/.test(e.name) || e.name.indexOf('__MACOSX') >= 0) continue;
    if (e.localOff + 30 > buf.length || e.compSize > MAX_ZIP_ENTRY) continue;
    if (buf.readUInt32LE(e.localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(e.localOff + 26);
    const lExtraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + e.compSize);
    let data;
    try {
      if (e.method === 0) data = raw;
      else if (e.method === 8) data = zlib.inflateRawSync(raw);
      else continue;
    } catch (err) { continue; }
    const base = e.name.split('/').pop();
    if (/\.txt$/i.test(base)) {
      if (!text) text = data;            // 第一个 txt 当聊天正文
      continue;
    }
    if (total + data.length > MAX_ZIP_TOTAL) continue;
    total += data.length;
    files.push({ name: base, data });
  }
  return { text, files };
}

function extractZipText(buf) {
  return extractZip(buf).text;
}

const pad2 = n => String(n).padStart(2, '0');

function mediaLabel(text) {
  const t = String(text || '').trim();
  for (const [re, label] of MEDIA_LABELS) if (re.test(t)) return label;
  return null;
}

const MEDIA_EXT_LABEL = {
  jpg: '图片', jpeg: '图片', png: '图片', webp: '图片', gif: 'GIF',
  mp4: '视频', '3gp': '视频', mov: '视频',
  opus: '语音', ogg: '语音', m4a: '语音', mp3: '语音',
  pdf: '文件', doc: '文件', docx: '文件', xls: '文件', xlsx: '文件', vcf: '名片',
};

/** 从消息正文里认出附件文件名（iOS 的 <attached: x.jpg>、安卓的 xxx.jpg (file attached)）。 */
function mediaRefName(text, mediaNames) {
  const t = String(text || '').trim();
  const a = /<attached:\s*([^>]+)>/i.exec(t);
  if (a) return a[1].trim();
  const b = /^(\S+\.([a-z0-9]{2,5}))\s*(?:\(?(?:file\s*)?attached\)?)?\s*$/i.exec(t);
  if (b) {
    const name = b[1];
    const ext = b[2].toLowerCase();
    if (!MEDIA_EXT_LABEL[ext]) return '';
    // 只有"明确写了 attached"或「zip 里确实有这个文件」才算附件，避免把普通文本当附件
    if (/attached/i.test(t) || (mediaNames && mediaNames.has(name))) return name;
  }
  return '';
}

function labelOfMediaName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return MEDIA_EXT_LABEL[ext] || '附件';
}

/* ---------------- 时间戳解析 ---------------- */

function dayPeriodOf(s) {
  const m = /([AaPp])\.?\s?[Mm]\.?|上午|下午|凌晨|中午|晚上/.exec(String(s));
  if (!m) return '';
  const v = m[0];
  if (/^[Pp]/.test(v) || v === '下午' || v === '晚上') return 'pm';
  if (/^[Aa]/.test(v) || v === '上午' || v === '凌晨') return 'am';
  return ''; // 中午 按 12 点处理
}

function resolveDayMonth(a, b, fallback) {
  const order = a > 12 ? 'dmy' : b > 12 ? 'mdy' : fallback;
  return order === 'mdy' ? { day: b, month: a } : { day: a, month: b };
}

/** 从一整段戳里分别抠出日期和时钟——谁前谁后都无所谓。 */
function parseStamp(stamp, dateOrder) {
  const s = String(stamp || '');
  const clock = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!clock) return null;
  const ymd = s.match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  let y, mo, d;
  if (ymd) {
    y = Number(ymd[1]); mo = Number(ymd[2]); d = Number(ymd[3]);
  } else {
    const dmy = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (!dmy) return null;
    const r = resolveDayMonth(Number(dmy[1]), Number(dmy[2]), dateOrder);
    d = r.day; mo = r.month;
    y = Number(dmy[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
  }
  let hour = Number(clock[1]);
  const min = Number(clock[2]);
  const sec = Number(clock[3] || 0);
  const period = dayPeriodOf(s);
  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  if (hour > 23 || min > 59 || sec > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1990 || y > 2100) return null;
  return {
    date: y + '-' + pad2(mo) + '-' + pad2(d),
    time: pad2(hour) + ':' + pad2(min),
    ts: y + '-' + pad2(mo) + '-' + pad2(d) + ' ' + pad2(hour) + ':' + pad2(min) + ':' + pad2(sec),
  };
}

/** 把一行拆成「戳」和「正文」；不是消息行返回 null。 */
function splitLine(line) {
  if (line[0] === '[') {
    const end = line.indexOf(']');
    if (end > 0) {
      const rest = line.slice(end + 1).replace(/^\s*[-\u2013\u2014]?\s*/, '');
      return { stamp: line.slice(1, end), rest };
    }
  }
  const m = line.match(RE_DASH);
  if (m) return { stamp: m[1], rest: m[2] };
  return null;
}

/* ---------------- 解析主流程 ---------------- */

/**
 * @param {string} raw 文件内容
 * @param {{dateOrder?: 'auto'|'dmy'|'mdy'}} opts
 */
function parseChatText(raw, opts) {
  opts = opts || {};
  const orderOpt = opts.dateOrder === 'dmy' || opts.dateOrder === 'mdy' ? opts.dateOrder : 'auto';
  const text = String(raw || '').replace(INVISIBLE, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // 先探全局顺序：出现 >12 的那一侧就是真实顺序
  let globalOrder = orderOpt === 'auto' ? 'dmy' : orderOpt;
  if (orderOpt === 'auto') {
    let bigFirst = false, bigSecond = false;
    for (let i = 0; i < lines.length && i < 80000; i++) {
      const sp = splitLine(lines[i]);
      if (!sp) continue;
      const m = sp.stamp.match(/(?:^|[^\d])(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?!\d)/);
      if (!m) continue;
      const a = Number(m[1]), b = Number(m[2]);
      if (a > 12 && a <= 31) bigFirst = true;
      if (b > 12 && b <= 31) bigSecond = true;
    }
    if (bigFirst && !bigSecond) globalOrder = 'dmy';
    else if (bigSecond && !bigFirst) globalOrder = 'mdy';
  }

  const messages = [];
  let skipped = 0;
  let cur = null;
  const senders = new Map();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;
    const sp = splitLine(rawLine);
    let parsed = null;
    if (sp) parsed = parseStamp(sp.stamp, globalOrder);
    if (!parsed) {
      // 戳里有数字但解析不出来 → 记一跳过；否则当续行
      if (/^\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}/.test(rawLine)) { skipped++; continue; }
      if (cur) cur.text += '\n' + rawLine.replace(INVISIBLE, '').trimEnd();
      else skipped++;
      continue;
    }
    const body = String(sp.rest || '');
    const sm = RE_SENDER.exec(body);
    let sender = '', content = body, kind = 'text', fromMe = false;
    if (sm && sm[2] !== '') {
      sender = sm[1].trim();
      content = sm[2];
      if (/^(you|me|你|我自己)(\s*[(（].*[)）])?$/i.test(sender)) { fromMe = true; sender = '我方'; }
    } else if (!sm) {
      kind = 'system';
    }
    const label = mediaLabel(content);
    const refName = mediaRefName(content, opts.mediaNames);
    if (label) kind = 'media';
    if (refName) kind = 'media';
    cur = {
      ts: parsed.ts, date: parsed.date, time: parsed.time,
      fromMe, sender: sender || '对方',
      text: refName ? '[' + labelOfMediaName(refName) + ']' : (label ? '[' + label + ']' : String(content).trim()),
      kind,
      mediaName: refName || '',
    };
    messages.push(cur);
    if (kind !== 'system') senders.set(cur.fromMe ? '我方' : cur.sender, (senders.get(cur.fromMe ? '我方' : cur.sender) || 0) + 1);
  }

  const real = messages.filter(m => m.kind !== 'system' && m.text);
  return {
    dateOrder: globalOrder,
    messages,
    total: messages.length,
    skipped,
    systemCount: messages.filter(m => m.kind === 'system').length,
    mediaCount: messages.filter(m => m.kind === 'media').length,
    realCount: real.length,
    participants: [...senders.keys()],
    senders: [...senders.entries()].map(([name, count]) => ({ name, count })),
    firstTs: real.length ? real[0].ts : '',
    lastTs: real.length ? real[real.length - 1].ts : '',
  };
}

/* ---------------- 分组 / 正文 / 导入 ---------------- */

function fmtLine(m) {
  const who = m.fromMe ? '我方' : (m.sender || '对方');
  const head = '[' + m.date.slice(5) + ' ' + m.time + '] ' + who + '：';
  const body = String(m.text || '').trimEnd();
  return head + (body.indexOf('\n') >= 0 ? '\n' + body.split('\n').map(l => '    ' + l).join('\n') : body);
}

function buildDayContent(msgs) {
  let s = msgs.map(fmtLine).join('\n');
  if (s.length > MAX_DAY_CHARS) s = s.slice(0, MAX_DAY_CHARS) + '\n…（当天内容过长，后面的 ' + (s.length - MAX_DAY_CHARS) + ' 字已截断）';
  return s;
}

/** 会话指纹：同一客户下按「对方是谁」区分不同聊天（不同号码/群）。 */
function deriveChatKey(participants) {
  const names = (participants || []).filter(n => n && n !== '我方').slice().sort();
  const raw = names.join('|') || 'unknown';
  return 'wa:' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function groupByDay(messages) {
  const map = new Map();
  for (const m of messages) {
    if (m.kind === 'system' || !m.text) continue;
    if (!map.has(m.date)) map.set(m.date, []);
    map.get(m.date).push(m);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function hashOf(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

/**
 * 按天幂等导入：同一天重复导入是改写已有那条，不会产生重复记录。
 * @returns {{ok:boolean, inserted:number, updated:number, days:number, messages:number, activityIds:number[], chatKey:string}}
 */
function importMessages(opts) {
  const msgs = (opts.messages || []).filter(m => m.kind !== 'system' && m.text);
  if (!msgs.length) return { ok: false, error: '没有可导入的消息' };
  const user = opts.user || {};
  const createdBy = user.display_name || user.username || '系统';
  const chatKey = opts.chatKey || deriveChatKey(msgs.map(m => (m.fromMe ? '我方' : m.sender)));
  const groups = groupByDay(msgs);
  let inserted = 0, updated = 0, merged = 0;
  const ids = [];
  const mergeActivityId = Number(opts.mergeActivityId) || 0;
  const mergeDay = String(opts.mergeDay || '');

  for (const [day, group] of groups) {
    const last = group[group.length - 1];
    const content = buildDayContent(group);
    const mergeThisDay = !!(mergeActivityId && day === mergeDay);
    // 当天消息里引用的媒体文件，挂到跟进记录的图片栏
    const imgs = [];
    if (opts.mediaMap) {
      for (const m of group) {
        if (!m.mediaName) continue;
        const p = opts.mediaMap[m.mediaName];
        if (p && imgs.indexOf(p) < 0) imgs.push(p);
      }
    }
    const imagesJson = imgs.length ? JSON.stringify(imgs) : '[]';
    const subject = 'WhatsApp 聊天记录 · ' + day + '（' + group.length + ' 条）';
    const existing = get('SELECT * FROM wa_imports WHERE customer_id=? AND chat_key=? AND day=?', opts.customerId, chatKey, day);
    const now = nowStr();
    let activityId;

    // 当天已有计划跟进：聊天直接覆盖这条跟进，不再额外生成一条聊天记录。
    if (mergeThisDay) {
      const target = get('SELECT * FROM activities WHERE id=? AND user_id=? AND customer_id=?', mergeActivityId, user.id || 0, opts.customerId);
      if (target) {
        const oldImages = (() => {
          try { const v = JSON.parse(target.images || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
        })();
        const allImages = oldImages.slice();
        for (const p of imgs) if (p && allImages.indexOf(p) < 0) allImages.push(p);
        const suffix = String(opts.mergeSuffix || '').trim();
        const mergedContent = suffix
          ? content + '\n\n────────\n【原跟进记录】\n' + suffix
          : content;
        run(`UPDATE activities SET subject=?,content=?,activity_date=?,type='WhatsApp',images=?,
          contact_person=CASE WHEN COALESCE(contact_person,'')='' THEN ? ELSE contact_person END,
          next_follow_date=?,next_follow_notes=?,outcome=? WHERE id=? AND user_id=?`,
          subject, mergedContent, last.ts, JSON.stringify(allImages), String(opts.mergeContactPerson || ''),
          opts.mergeNextDate || null, String(opts.mergeNextFollowNotes || ''), String(opts.mergeOutcome || ''),
          target.id, user.id || 0);
        if (existing) {
          run('UPDATE wa_imports SET activity_id=?,msg_count=?,content_hash=?,source=?,updated_at=? WHERE id=?',
            target.id, group.length, hashOf(mergedContent), String(opts.source || ''), now, existing.id);
        } else {
          run('INSERT INTO wa_imports(customer_id,chat_key,day,activity_id,msg_count,content_hash,source,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            opts.customerId, chatKey, day, target.id, group.length, hashOf(mergedContent), String(opts.source || ''), createdBy, now, now);
        }
        activityId = target.id;
        merged++;
        updated++;
        ids.push(Number(activityId));
        continue;
      }
    }
    if (existing && existing.activity_id) {
      const act = get('SELECT id FROM activities WHERE id=?', existing.activity_id);
      if (act) {
        run('UPDATE activities SET subject=?,content=?,activity_date=?,type=?,images=? WHERE id=?',
          subject, content, last.ts, 'WhatsApp', imagesJson, existing.activity_id);
        run('UPDATE wa_imports SET msg_count=?,content_hash=?,source=?,updated_at=? WHERE id=?',
          group.length, hashOf(content), String(opts.source || ''), now, existing.id);
        activityId = existing.activity_id;
        updated++;
        ids.push(Number(activityId));
        continue;
      }
    }
    const r = run('INSERT INTO activities(customer_id,type,subject,content,contact_person,activity_date,next_follow_date,next_follow_notes,images,created_by,user_id,created_at,priority,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      opts.customerId, 'WhatsApp', subject, content, '', last.ts, null, '', imagesJson, createdBy, user.id || null, now, '中', '');
    activityId = Number(r.lastInsertRowid);
    if (existing) {
      run('UPDATE wa_imports SET activity_id=?,msg_count=?,content_hash=?,source=?,updated_at=? WHERE id=?',
        activityId, group.length, hashOf(content), String(opts.source || ''), now, existing.id);
    } else {
      try {
        run('INSERT INTO wa_imports(customer_id,chat_key,day,activity_id,msg_count,content_hash,source,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          opts.customerId, chatKey, day, activityId, group.length, hashOf(content), String(opts.source || ''), createdBy, now, now);
      } catch (e) {
        // 并发双提交撞唯一键：退回更新，别把 500 抛给用户
        run('UPDATE wa_imports SET activity_id=?,msg_count=?,content_hash=?,source=?,updated_at=? WHERE customer_id=? AND chat_key=? AND day=?',
          activityId, group.length, hashOf(content), String(opts.source || ''), now, opts.customerId, chatKey, day);
      }
    }
    inserted++;
    ids.push(activityId);
  }

  return { ok: true, inserted, updated, merged, mergedToday: merged > 0, days: groups.length, messages: msgs.length, activityIds: ids, chatKey };
}

/* ---------------- 媒体落盘 ---------------- */

const MEDIA_DIR = path.join(__dirname, '..', 'uploads', 'wa-media');

/** 把 zip 里的图片/语音/文件存到 uploads/wa-media，返回 {原文件名: /uploads/...}。 */
function saveMediaFiles(files) {
  const map = {};
  if (!files || !files.length) return map;
  try {
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
    for (const f of files) {
      const ext = (String(f.name).split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
      const h = crypto.createHash('sha1').update(f.data).digest('hex').slice(0, 16);
      const fn = h + '.' + ext;
      const p = path.join(MEDIA_DIR, fn);
      if (!fs.existsSync(p)) fs.writeFileSync(p, f.data);
      map[f.name] = '/uploads/wa-media/' + fn;
    }
  } catch (e) { /* 存不下就只导文字 */ }
  return map;
}

/* ---------------- 预览用的临时文件 ---------------- */

function saveTemp(text, mediaMap) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const token = randomToken(16);
  fs.writeFileSync(path.join(TMP_DIR, token + '.txt'), text, 'utf8');
  if (mediaMap && Object.keys(mediaMap).length) {
    fs.writeFileSync(path.join(TMP_DIR, token + '.json'), JSON.stringify(mediaMap), 'utf8');
  }
  cleanTemp();
  return token;
}

function saveTempText(text) { return saveTemp(text, null); }

function readTemp(token) {
  if (!/^[a-f0-9]{8,64}$/i.test(String(token || ''))) return null;
  const p = path.join(TMP_DIR, token + '.txt');
  if (!fs.existsSync(p)) return null;
  let mediaMap = {};
  const jp = path.join(TMP_DIR, token + '.json');
  try { if (fs.existsSync(jp)) mediaMap = JSON.parse(fs.readFileSync(jp, 'utf8')) || {}; } catch (e) { mediaMap = {}; }
  return { text: fs.readFileSync(p, 'utf8'), mediaMap };
}

function readTempText(token) {
  const r = readTemp(token);
  return r ? r.text : null;
}

function cleanTemp() {
  try {
    const now = Date.now();
    for (const n of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, n);
      try { if (now - fs.statSync(p).mtimeMs > 2 * 86400000) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}

function normalizePhone(s) {
  return String(s || '').replace(/[^\d]/g, '');
}

module.exports = {
  parseChatText, extractZip, extractZipText, decodeBuffer,
  importMessages, groupByDay, deriveChatKey,
  saveTemp, saveTempText, readTemp, readTempText, saveMediaFiles,
  mediaLabel, mediaRefName, normalizePhone, MAX_TEXT_BYTES,
};
