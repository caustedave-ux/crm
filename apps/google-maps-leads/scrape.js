'use strict';
// Google 地图线索采集：公司名 / 类别 / 地址 / 电话 / 网站 / 评分 / 评论数
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CITIES = (process.env.CITIES || 'Lagos,Abuja,Port Harcourt').split(',').map(s => s.trim()).filter(Boolean);
const QUERIES = (process.env.QUERIES || 'door lock shop,door hardware store,security door company').split(',').map(s => s.trim()).filter(Boolean);
const MAX_PER_QUERY = Number(process.env.MAX_PER_QUERY || 12);
const OUT_DIR = process.env.OUT_DIR || 'D:/外贸CRM/data/leads';
fs.mkdirSync(OUT_DIR, { recursive: true });

function csvCell(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\r?\n/g, ' ').trim();
  return '"' + s.replace(/"/g, '""') + '"';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function acceptConsent(page) {
  const texts = ['Accept all', 'I agree', 'Agree to all', '同意全部', '全部接受'];
  for (const t of texts) {
    try {
      const btn = page.locator('button:has-text("' + t + '")').first();
      if (await btn.count()) { await btn.click({ timeout: 3000 }); await sleep(1500); return; }
    } catch (e) {}
  }
}

async function collectPlaceLinks(page, max) {
  const links = new Set();
  for (let i = 0; i < 25 && links.size < max; i++) {
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a.hfpxzc')).map(a => a.href).filter(Boolean));
    hrefs.forEach(h => links.add(h));
    if (links.size >= max) break;
    const feed = await page.$('div[role="feed"]');
    if (feed) {
      await feed.evaluate(el => { el.scrollTop = el.scrollHeight; });
    } else {
      await page.mouse.wheel(0, 1500);
    }
    await sleep(1200 + Math.random() * 800);
  }
  return Array.from(links).slice(0, max);
}

async function extractPlace(page) {
  await page.waitForSelector('h1', { timeout: 25000 }).catch(() => {});
  return await page.evaluate(() => {
    const txt = (el) => el ? (el.getAttribute('aria-label') || el.textContent || '').trim() : '';
    const name = txt(document.querySelector('h1.DUwDvf') || document.querySelector('h1'));
    const category = txt(document.querySelector('button[jsaction*="category"]') || document.querySelector('.DkEaL'));
    const addressEl = document.querySelector('button[data-item-id="address"]');
    const phoneEl = document.querySelector('button[data-item-id^="phone"]');
    const webEl = document.querySelector('a[data-item-id="authority"]');
    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
    const reviewEl = document.querySelector('div.F7nice span[aria-label*="review"]') || document.querySelector('div.F7nice span[aria-label*="评论"]');
    return {
      name: name.replace(/^·\s*/, ''),
      category,
      address: addressEl ? txt(addressEl).replace(/^地址[:：]\s*/, '') : '',
      phone: phoneEl ? txt(phoneEl).replace(/^电话[:：]\s*/, '') : '',
      website: webEl ? webEl.href : '',
      rating: ratingEl ? txt(ratingEl) : '',
      reviews: reviewEl ? txt(reviewEl).replace(/[^\d,]/g, '') : '',
    };
  });
}

(async () => {
  const rows = [];
  const seen = new Set();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-NG'] });
  const ctx = await browser.newContext({ locale: 'en-NG', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();

  for (const city of CITIES) {
    for (const q of QUERIES) {
      const query = q + ' in ' + city + ', Nigeria';
      const url = 'https://www.google.com/maps/search/' + encodeURIComponent(query) + '?hl=en&gl=ng';
      console.log('[搜索] ' + query);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await acceptConsent(page);
        await sleep(2500);
        const links = await collectPlaceLinks(page, MAX_PER_QUERY);
        console.log('  找到 ' + links.length + ' 个地点链接');
        for (const href of links) {
          try {
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(1200 + Math.random() * 800);
            const info = await extractPlace(page);
            if (!info.name) { continue; }
            const key = (info.name + '|' + (info.phone || info.website || info.address)).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push(Object.assign({ city, query: q, mapsUrl: href }, info));
            console.log('  + ' + info.name + (info.phone ? ' | ' + info.phone : '') + (info.website ? ' | ' + info.website : ''));
          } catch (e) {
            console.log('  [跳过] ' + e.message.split('\n')[0]);
          }
        }
      } catch (e) {
        console.log('  [搜索失败] ' + e.message.split('\n')[0]);
      }
      await sleep(1500);
    }
  }
  await browser.close();

  const stamp = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const fname = 'maps-leads-Nigeria-' + stamp.getFullYear() + '-' + p2(stamp.getMonth() + 1) + '-' + p2(stamp.getDate()) + '.csv';
  const file = path.join(OUT_DIR, fname);
  const headers = ['公司名', '类别', '地址', '电话', '网站', '评分', '评论数', '城市', '搜索词', 'Google地图链接'];
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push([r.name, r.category, r.address, r.phone, r.website, r.rating, r.reviews, r.city, r.query, r.mapsUrl].map(csvCell).join(','));
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log('');
  console.log('完成：共 ' + rows.length + ' 条线索');
  console.log('CSV: ' + file);
})().catch(e => { console.error('运行失败：', e); process.exit(1); });