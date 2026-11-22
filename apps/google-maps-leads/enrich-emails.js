'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { DatabaseSync } = require('node:sqlite');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = 'D:/外贸CRM/data/leads/maps-leads-Nigeria-全部城市-2026-09-12.csv';
const OUT = 'D:/外贸CRM/data/leads/emails-enriched-2026-09-12.csv';
const DB = 'D:/外贸CRM/data/crm.db';
const SKIP_HOSTS = ['facebook.com','instagram.com','wa.me','whatsapp.com','linktr.ee','tiktok.com','twitter.com','youtube.com','linkedin.com','sitesng.com'];

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizeUrl(u) { u = String(u || '').trim(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return u; }
function isSkipHost(u) { try { const h = new URL(u).hostname.toLowerCase(); return SKIP_HOSTS.some(s => h === s || h.endsWith('.' + s)); } catch (e) { return true; } }
function findEmails(text) {
  const out = new Set();
  const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  let m; while ((m = re.exec(text))) {
    const e = m[0].toLowerCase().replace(/[.,;:]+$/, '');
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e)) continue;
    if (/^(example|test|user|your|email|name)@/.test(e)) continue;
    if (/no-?reply|noreply|donotreply/.test(e)) continue;
    if (/sentry\.io$|wixpress\.com$|w3\.org$/.test(e)) continue;
    out.add(e);
  }
  return Array.from(out);
}
function scoreEmail(e, host) {
  let s = 0;
  if (host && e.endsWith('@' + host.replace(/^www\./, ''))) s += 5;
  if (/^(info|sales|export|contact|admin|office|enquiry|enquiries|marketing)@/.test(e)) s += 3;
  if (e.length < 40) s += 1;
  return s;
}

(async () => {
  const rows = parseCsv(fs.readFileSync(SRC, 'utf8'));
  const head = rows.shift(); const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
  const leads = rows.map(r => ({ name: (r[idx['公司名']]||'').trim(), website: (r[idx['网站']]||'').trim() })).filter(x => x.name && x.website && !isSkipHost(normalizeUrl(x.website)));
  console.log('待挖掘公司(有独立网站): ' + leads.length);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-NG'] });
  const ctx = await browser.newContext({ locale: 'en-NG', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(18000);
  const results = [];

  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    const url = normalizeUrl(l.website);
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();
    const found = new Set(); const pages = [];
    console.log('[' + (i + 1) + '/' + leads.length + '] ' + l.name + ' → ' + url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1200);
      const html = await page.content();
      const mailtos = await page.evaluate(() => Array.from(document.querySelectorAll('a[href^="mailto:"]')).map(a => a.getAttribute('href')));
      mailtos.forEach(h => { const e = String(h).replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); if (e) found.add(e); });
      findEmails(html).forEach(e => found.add(e));
      pages.push(url);
      // 找联系/关于页面
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href));
      const contactLinks = links.filter(h => /contact|about|enquir|reach|support/i.test(h) && !/facebook|instagram|wa\.me|whatsapp|twitter|linkedin/i.test(h));
      const uniq = Array.from(new Set(contactLinks)).slice(0, 2);
      for (const cu of uniq) {
        try {
          await page.goto(cu, { waitUntil: 'domcontentloaded', timeout: 18000 });
          await sleep(900);
          const h2 = await page.content();
          const m2 = await page.evaluate(() => Array.from(document.querySelectorAll('a[href^="mailto:"]')).map(a => a.getAttribute('href')));
          m2.forEach(h => { const e = String(h).replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); if (e) found.add(e); });
          findEmails(h2).forEach(e => found.add(e));
          pages.push(cu);
        } catch (e) {}
      }
    } catch (e) {
      console.log('   [跳过] ' + e.message.split('\n')[0]);
    }
    const emails = Array.from(found).filter(e => /@/.test(e)).sort((a, b) => scoreEmail(b, host) - scoreEmail(a, host)).slice(0, 5);
    results.push({ name: l.name, website: url, emails: emails.join(';'), pages: pages.length });
    if (emails.length) console.log('   ✓ ' + emails.join(', '));
    await sleep(600);
  }
  await browser.close();

  const lines = [['公司名','网站','邮箱','访问页数'].map(csvCell).join(',')];
  results.forEach(r => lines.push([r.name, r.website, r.emails, r.pages].map(csvCell).join(',')));
  fs.writeFileSync(OUT, '\ufeff' + lines.join('\r\n'), 'utf8');
  const ok = results.filter(r => r.emails).length;
  console.log('');
  console.log('邮箱挖掘完成：' + leads.length + ' 家网站，找到邮箱 ' + ok + ' 家');
  console.log('结果文件: ' + OUT);

  // 回填 CRM（只填空邮箱，不覆盖已有）
  const backup = 'D:/外贸CRM/data/backups/pre-email-fill-' + new Date().toISOString().replace(/[-:T]/g,'').slice(0,14) + '.db';
  { const b = new DatabaseSync(DB, { readOnly: true }); b.exec("VACUUM INTO '" + backup + "'"); b.close(); console.log('导入前备份: ' + backup); }
  const db = new DatabaseSync(DB);
  const find = db.prepare('SELECT id,email,notes FROM customers WHERE company_name=?');
  const upd = db.prepare('UPDATE customers SET email=?, notes=?, updated_at=? WHERE id=?');
  const t = new Date().toISOString().slice(0,19).replace('T',' ');
  let filled = 0, skipped = 0;
  for (const r of results) {
    if (!r.emails) continue;
    const c = find.get(r.name); if (!c) { skipped++; continue; }
    const first = r.emails.split(';')[0];
    if (c.email && c.email.trim()) { skipped++; continue; }
    const extra = r.emails.split(';').slice(1).join(';');
    const notes = (c.notes || '') + (extra ? ' | 其他邮箱:' + extra : '');
    upd.run(first, notes, t, c.id);
    filled++;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
  console.log('CRM 回填邮箱: ' + filled + ' 家（跳过已有邮箱/未匹配: ' + skipped + '）');
})().catch(e => { console.error('运行失败:', e); process.exit(1); });