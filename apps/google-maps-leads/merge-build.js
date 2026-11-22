'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('D:/外贸CRM/node_modules/exceljs');
const DIR = 'D:/外贸CRM/data/leads';

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
function extractPhone(s) { const m = String(s).match(/Phone:\s*(\+?[\d\s\-()]{7,})/i); return m ? m[1].trim() : ''; }
function cleanName(s) {
  let x = String(s || '');
  const m = x.match(/Phone:\s*\+?[\d\s\-()]{7,}/i);
  if (m) x = x.slice(0, m.index);
  x = x.replace(/\|\s*$/g, '').trim();
  const parts = x.split('|').map(t => t.trim()).filter(Boolean);
  if (parts.length > 1) x = parts[0];
  return x.replace(/[|\s]+$/g, '').trim();
}
function readLeads(file) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return [];
  const head = rows.shift();
  const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
  return rows.map(r => ({
    name: (r[idx['公司名']] || '').trim(), category: (r[idx['类别']] || '').trim(), address: (r[idx['地址']] || '').trim(),
    phone: (r[idx['电话']] || '').trim(), website: (r[idx['网站']] || '').trim(), rating: (r[idx['评分']] || '').trim(), reviews: (r[idx['评论数']] || '').trim(),
    city: (r[idx['城市']] || '').trim(), query: (r[idx['搜索词']] || '').trim(), maps: (r[idx['Google地图链接']] || '').trim(),
  })).filter(x => x.name);
}

(async () => {
  const all = [].concat(
    readLeads(path.join(DIR, 'maps-leads-Nigeria-2026-09-12-phase1-clean.csv')),
    readLeads(path.join(DIR, 'maps-leads-Nigeria-2026-09-12.csv'))
  );
  all.forEach(l => {
    l.phone = String(l.phone || '').replace(/^Phone[:：]\s*/i, '').replace(/\s+/g, ' ').trim();
    l.address = String(l.address || '').replace(/^Address[:：]\s*/i, '').trim();
    if (!l.phone) l.phone = extractPhone(l.name);
    l.name = cleanName(l.name);
  });
  const seen = new Set(); const leads = [];
  for (const l of all) {
    if (!l.name) continue;
    const k = (l.name + '|' + (l.phone || l.website)).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); leads.push(l);
  }

  const headers = ['公司名', '类别', '地址', '电话', '网站', '评分', '评论数', '城市', '搜索词', 'Google地图链接'];
  const lines = [headers.map(csvCell).join(',')];
  for (const l of leads) lines.push([l.name, l.category, l.address, l.phone, l.website, l.rating, l.reviews, l.city, l.query, l.maps].map(csvCell).join(','));
  const cleanCsv = path.join(DIR, 'maps-leads-Nigeria-全部城市-2026-09-12.csv');
  fs.writeFileSync(cleanCsv, '\ufeff' + lines.join('\r\n'), 'utf8');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('客户导入');
  const ch = ['公司名称','英文名称','国家/地区','地址','网站','行业','状态','级别','联系电话','传真','邮箱','WhatsApp','微信','客户来源','主要联系人','联系人职位','联系人电话','联系人邮箱','备注'];
  ws.columns = ch.map(h => ({ header: h, width: Math.max(12, Math.min(30, h.length * 2 + 6)) }));
  ws.getRow(1).font = { bold: true };
  for (const l of leads) ws.addRow([l.name, '', 'Nigeria', l.address, l.website, l.category || 'Door hardware / security', '潜在客户', '普通', l.phone, '', '', '', '', 'Google地图-' + l.city, '', '', '', '', [l.query ? '搜索词:' + l.query : '', l.rating ? '评分:' + l.rating : '', l.reviews ? '评论:' + l.reviews : '', l.maps ? '地图:' + l.maps : ''].filter(Boolean).join(' | ')]);
  const xlsx = path.join(DIR, 'CRM客户导入-Google地图-Nigeria-全部城市-2026-09-12.xlsx');
  await wb.xlsx.writeFile(xlsx);

  const cities = {};
  leads.forEach(l => cities[l.city] = (cities[l.city] || 0) + 1);
  console.log('合并去重后线索总数: ' + leads.length);
  console.log('有电话: ' + leads.filter(x => x.phone).length + ' | 有网站: ' + leads.filter(x => x.website).length);
  console.log('按城市: ' + Object.entries(cities).map(([k, v]) => k + '=' + v).join(', '));
  console.log('合并CSV: ' + cleanCsv);
  console.log('CRM导入文件: ' + xlsx);
})().catch(e => { console.error('合并失败:', e); process.exit(1); });