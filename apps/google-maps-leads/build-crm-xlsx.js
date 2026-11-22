'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('D:/外贸CRM/node_modules/exceljs');

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

(async () => {
  const dir = 'D:/外贸CRM/data/leads';
  const src = path.join(dir, 'maps-leads-Nigeria-2026-09-12.csv');
  const rows = parseCsv(fs.readFileSync(src, 'utf8'));
  const head = rows.shift();
  const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
  let leads = rows.map(r => ({
    name: (r[idx['公司名']] || '').trim(), category: (r[idx['类别']] || '').trim(), address: (r[idx['地址']] || '').trim(),
    phone: (r[idx['电话']] || '').trim(), website: (r[idx['网站']] || '').trim(), rating: (r[idx['评分']] || '').trim(), reviews: (r[idx['评论数']] || '').trim(),
    city: (r[idx['城市']] || '').trim(), query: (r[idx['搜索词']] || '').trim(), maps: (r[idx['Google地图链接']] || '').trim(),
  })).filter(x => x.name);
  // 清洗：从名称提取电话、取公司主名
  leads.forEach(l => {
    l.phone = String(l.phone || '').replace(/^Phone[:：]\s*/i, '').replace(/\s+/g, ' ').trim();
    l.address = String(l.address || '').replace(/^Address[:：]\s*/i, '').trim();
    if (!l.phone) l.phone = extractPhone(l.name);
    l.name = cleanName(l.name);
  });
  leads = leads.filter(l => l.name);
  // 去重（名称+电话）
  const seen = new Set(); const out = [];
  for (const l of leads) { const k = (l.name + '|' + (l.phone || l.website)).toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(l); }
  leads = out;

  // 清洗后的 CSV
  const headers = ['公司名', '类别', '地址', '电话', '网站', '评分', '评论数', '城市', '搜索词', 'Google地图链接'];
  const lines = [headers.map(csvCell).join(',')];
  for (const l of leads) lines.push([l.name, l.category, l.address, l.phone, l.website, l.rating, l.reviews, l.city, l.query, l.maps].map(csvCell).join(','));
  const cleanedCsv = path.join(dir, 'maps-leads-Nigeria-2026-09-12-clean.csv');
  fs.writeFileSync(cleanedCsv, '\ufeff' + lines.join('\r\n'), 'utf8');

  // CRM 导入 xlsx
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('客户导入');
  const crmHeaders = ['公司名称','英文名称','国家/地区','地址','网站','行业','状态','级别','联系电话','传真','邮箱','WhatsApp','微信','客户来源','主要联系人','联系人职位','联系人电话','联系人邮箱','备注'];
  ws.columns = crmHeaders.map(h => ({ header: h, width: Math.max(12, Math.min(30, h.length * 2 + 6)) }));
  ws.getRow(1).font = { bold: true };
  for (const l of leads) ws.addRow([l.name, '', 'Nigeria', l.address, l.website, l.category || 'Door hardware / security', '潜在客户', '普通', l.phone, '', '', '', '', 'Google地图-' + l.city, '', '', '', '', [l.query ? '搜索词:' + l.query : '', l.rating ? '评分:' + l.rating : '', l.reviews ? '评论:' + l.reviews : '', l.maps ? '地图:' + l.maps : ''].filter(Boolean).join(' | ')]);
  const xlsx = path.join(dir, 'CRM客户导入-Google地图-Nigeria-2026-09-12.xlsx');
  await wb.xlsx.writeFile(xlsx);

  const withPhone = leads.filter(x => x.phone).length, withWeb = leads.filter(x => x.website).length;
  console.log('清洗后线索总数: ' + leads.length + ' | 有电话: ' + withPhone + ' | 有网站: ' + withWeb);
  console.log('清洗CSV: ' + cleanedCsv);
  console.log('CRM导入文件: ' + xlsx);
  console.log('示例:');
  leads.slice(0, 8).forEach((l, i) => console.log('  ' + (i + 1) + '. ' + l.name + ' | ' + l.phone + (l.website ? ' | ' + l.website : '')));
})().catch(e => { console.error('生成失败:', e); process.exit(1); });