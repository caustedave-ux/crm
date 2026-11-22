'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const SRC = 'D:/外贸CRM/data/leads/maps-leads-Nigeria-全部城市-2026-09-12.csv';
const DB = 'D:/外贸CRM/data/crm.db';
const BACKUP_DIR = 'D:/外贸CRM/data/backups';

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
function nowStr() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

// 1) 导入前备份
const stamp = nowStr().replace(/[-: ]/g, '');
const backup = path.join(BACKUP_DIR, 'pre-maps-import-' + stamp + '.db');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
{
  const bdb = new DatabaseSync(DB, { readOnly: true });
  bdb.exec("VACUUM INTO '" + backup.replace(/\\/g, '/') + "'");
  bdb.close();
  console.log('导入前备份: ' + backup);
}

// 2) 读取线索
const rows = parseCsv(fs.readFileSync(SRC, 'utf8'));
const head = rows.shift(); const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
const leads = rows.map(r => ({
  name: (r[idx['公司名']] || '').trim(), category: (r[idx['类别']] || '').trim(), address: (r[idx['地址']] || '').trim(),
  phone: (r[idx['电话']] || '').trim(), website: (r[idx['网站']] || '').trim(), rating: (r[idx['评分']] || '').trim(),
  reviews: (r[idx['评论数']] || '').trim(), city: (r[idx['城市']] || '').trim(), query: (r[idx['搜索词']] || '').trim(), maps: (r[idx['Google地图链接']] || '').trim(),
})).filter(x => x.name);

// 3) 写入 CRM
const db = new DatabaseSync(DB);
const exists = db.prepare('SELECT id FROM customers WHERE company_name=?');
const insert = db.prepare(`INSERT INTO customers(company_name,name_en,country,address,website,source,industry,status,level,phone,fax,email,whatsapp,wechat,notes,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let added = 0, skipped = 0; const t = nowStr();
for (const l of leads) {
  if (exists.get(l.name)) { skipped++; continue; }
  const notes = [l.query ? '来源搜索:' + l.query : '', l.rating ? '地图评分:' + l.rating : '', l.reviews ? '评论数:' + l.reviews : '', l.maps ? '地图:' + l.maps : ''].filter(Boolean).join(' | ');
  insert.run(l.name, '', 'Nigeria', l.address, l.website, 'Google地图-' + l.city, l.category || 'Door hardware / security', '潜在客户', '普通', l.phone, '', '', '', '', notes, t, t);
  added++;
}
const total = db.prepare("SELECT COUNT(*) c FROM customers WHERE source LIKE 'Google地图-%'").get().c;
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
console.log('导入完成：新增 ' + added + ' 家，跳过重名 ' + skipped + ' 家');
console.log('CRM 中来源=Google地图 的客户总数: ' + total);