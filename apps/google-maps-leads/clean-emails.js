'use strict';
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const DB = 'D:/外贸CRM/data/crm.db';
const CSV = 'D:/外贸CRM/data/leads/emails-enriched-2026-09-12.csv';

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  text = text.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || '').trim());
}
function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ').trim() + '"'; }
function cleanEmails(s) {
  const out = [];
  String(s || '').split(';').forEach(x => {
    let e = x.trim().toLowerCase().replace(/^u003e/, '').replace(/[.,;:]+$/, '');
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) return;
    if (/@(example\.com|company\.com|yourcompany\.com|domain\.com)$/.test(e)) return;
    if (/^(you|your\.email|email|name|test|user)@/.test(e)) return;
    if (/^info@yourcompany/.test(e)) return;
    if (out.indexOf(e) < 0) out.push(e);
  });
  return out;
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const head = rows.shift(); const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
let validCount = 0, removed = 0;
const cleaned = rows.map(r => {
  const raw = r[idx['邮箱']] || '';
  const emails = cleanEmails(raw);
  const rawCount = String(raw).split(';').map(x => x.trim()).filter(Boolean).length;
  removed += Math.max(0, rawCount - emails.length);
  if (emails.length) validCount++;
  return { name: (r[idx['公司名']] || '').trim(), website: (r[idx['网站']] || '').trim(), emails: emails.join(';'), pages: r[idx['访问页数']] || '' };
});
const lines = [['公司名','网站','邮箱','访问页数'].map(csvCell).join(',')];
cleaned.forEach(r => lines.push([r.name, r.website, r.emails, r.pages].map(csvCell).join(',')));
fs.writeFileSync(CSV, '\ufeff' + lines.join('\r\n'), 'utf8');

// 修正 CRM：无效邮箱置空，保留有效邮箱；notes 里的其他邮箱同步清洗
const db = new DatabaseSync(DB);
const find = db.prepare('SELECT id,email,notes FROM customers WHERE company_name=?');
const upd = db.prepare('UPDATE customers SET email=?, notes=?, updated_at=? WHERE id=?');
const t = new Date().toISOString().slice(0,19).replace('T',' ');
let fixed = 0, cleared = 0;
for (const r of cleaned) {
  const c = find.get(r.name); if (!c) continue;
  const list = r.emails ? r.emails.split(';') : [];
  const first = list[0] || '';
  const extra = list.slice(1).join(';');
  let notes = String(c.notes || '').replace(/\s*\|\s*其他邮箱:[^|]*/g, '');
  if (extra) notes += ' | 其他邮箱:' + extra;
  notes = notes.replace(/\s*\|\s*$/, '');
  if ((c.email || '') !== first || (c.notes || '') !== notes) {
    upd.run(first || null || '', notes, t, c.id);
    if (!first && c.email) cleared++; else fixed++;
  }
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
console.log('清洗完成：有效邮箱公司 ' + validCount + ' 家，剔除无效邮箱 ' + removed + ' 个');
console.log('CRM 修正 ' + fixed + ' 家，清空无效邮箱 ' + cleared + ' 家');
console.log('结果文件: ' + CSV);