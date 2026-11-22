'use strict';
// ============ WhatsApp 跟进记录的富文本渲染 ============
// activities.content 里存的是纯文本（保持可搜索、可导出、向后兼容）：
//   [10-15 09:12] Tom Smith：Hi, price?
//       缩进行是上一条的续行
// 这里把它还原成结构化消息，渲染成对话气泡 + 关键信息 chips + 默认折叠。
const { esc } = require('./util');

const RE_LINE = /^\[(\d{2}-\d{2}) (\d{2}:\d{2})\] ([^：]{1,40})：([\s\S]*)$/;

/** 把纯文本还原成 [{date, time, who, mine, text}] */
function parseContent(content) {
  const out = [];
  const lines = String(content || '').split('\n');
  for (const line of lines) {
    const m = RE_LINE.exec(line);
    if (m) {
      out.push({ date: m[1], time: m[2], who: m[3].trim(), mine: m[3].trim() === '我方', text: m[4] });
      continue;
    }
    if (!out.length) continue;
    // 续行：去掉开头 4 空格缩进
    out[out.length - 1].text += '\n' + line.replace(/^ {1,4}/, '');
  }
  return out;
}

const KEY_PATTERNS = [
  [/(?:\$|USD\s?|US\$)\s?\d+(?:[.,]\d+)?(?:\s?\/\s?(?:pc|pcs|set|ctn|kg))?/gi, 'money'],
  [/\b\d+(?:[.,]\d+)?\s?(?:USD|RMB|CNY|EUR|GBP|JPY|AUD|CAD)\b/gi, 'money'],
  [/\b\d+(?:[.,]\d+)?\s?(?:pcs|pc|pairs?|sets?|ctns?|cartons?|kgs?|tons?|m2|m3)\b/gi, 'qty'],
  [/\b\d+(?:[.,]\d+)?\s?%/g, 'pct'],
  [/\b(?:MOQ|FOB|CIF|CFR|EXW|DDP|T\/T|L\/C|PI|PO|ETA|ETD)\b/gi, 'biz'],
  [/\b[A-Z]{2,}[-]?\d{3,}\b/g, 'model'],
  [/\b(?:20\d{2}[-.\/]\d{1,2}[-.\/]\d{1,2}|\d{1,2}\s?(?:月|\/)\s?\d{1,2}\s?(?:日|号)?)\b/g, 'date'],
];
const KIND_CLS = { money: 'wa-chip-money', qty: 'wa-chip-qty', pct: 'wa-chip-qty', biz: 'wa-chip-biz', model: 'wa-chip-model', date: 'wa-chip-date' };/** 从整天的对话里抽关键信息（去重、限量） */
function keyPoints(messages) {
  const text = messages.map(m => m.text).join('\n');
  const seen = new Set();
  const out = [];
  for (const [re, kind] of KEY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 400) {
      const v = m[0].trim();
      const k = kind + '|' + v.toLowerCase();
      if (v.length < 2 || seen.has(k)) continue;
      seen.add(k);
      out.push({ v, kind });
      if (out.length >= 24) break;
    }
    if (out.length >= 24) break;
  }
  // 金额和数量优先
  const rank = { money: 0, qty: 1, biz: 2, model: 3, pct: 4, date: 5 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return out.slice(0, 8);
}

function fmtText(t) {
  return esc(t).replace(/\n/g, '<br>');
}



/**
 * 渲染一条 WhatsApp 类型的跟进记录。
 * @param {object} a activity 行
 * @param {string} summary 可选：已生成的中文摘要
 */
function renderActivity(a, summary) {
  const msgs = parseContent(a.content);
  if (!msgs.length) return `<div class="text-muted small">${esc(a.content || '')}</div>`;

  const mineCount = msgs.filter(m => m.mine).length;
  const chips = keyPoints(msgs);
  const HEAD = 6;                                  // 默认显示最后 6 条
  const head = msgs.slice(-HEAD);
  const rest = msgs.slice(0, Math.max(0, msgs.length - HEAD));

  const bubble = (m) => `<div class="wa-row ${m.mine ? 'mine' : ''}">
      <div>
        <div class="wa-meta" style="text-align:${m.mine ? 'right' : 'left'}">${esc(m.mine ? '我方' : m.who)} · ${esc(m.time)}</div>
        <div class="wa-bubble">${fmtText(m.text)}</div>
      </div>
    </div>`;

  const thread = (list) => `<div class="wa-thread">${list.map(bubble).join('')}</div>`;

  return `
    ${chips.length ? `<div class="wa-chips">${chips.map(c => `<span class="wa-chip ${KIND_CLS[c.kind] || ''}">${esc(c.v)}</span>`).join('')}</div>` : ''}
    ${summary ? `<div class="wa-summary"><b>要点：</b>${esc(summary)}</div>` : ''}
    ${rest.length ? `<details class="wa-fold"><summary>展开更早的 ${rest.length} 条</summary>${thread(rest)}</details>` : ''}
    ${thread(head)}
    <div class="text-muted" style="font-size:11px;margin-top:4px">共 ${msgs.length} 条 · 客户 ${msgs.length - mineCount} 条 / 我方 ${mineCount} 条</div>`;
}

module.exports = { parseContent, keyPoints, renderActivity };
