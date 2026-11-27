'use strict';

const { esc } = require('./util');
const { get, getCompany } = require('./db');
const documentPdf = require('./documentPdf');

function localImage(value) {
  const url = String(value || '').trim();
  if (!/^\/(?:uploads|static)\/[\p{L}\p{N}_./% -]+\.(?:png|jpe?g|gif|webp)$/iu.test(url)) return '';
  try {
    return decodeURIComponent(url).split('/').includes('..') ? '' : url;
  } catch (error) {
    return '';
  }
}

function quoteFilename(value) {
  return (String(value || 'quotation').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim() || 'quotation') + '.png';
}

function money(value) {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 4,
  });
}

function quoteHtml(quote, userId) {
  const customer = get('SELECT * FROM customers WHERE id=? AND user_id=?', quote.customer_id, userId);
  if (!customer) return '';
  const company = getCompany();
  const currency = esc(quote.currency || 'USD');
  let items = [];
  try { items = JSON.parse(quote.items || '[]'); } catch (error) {}
  if (!Array.isArray(items) || !items.length) {
    const product = quote.product_id ? get('SELECT image FROM products WHERE id=?', quote.product_id) : null;
    items = [{
      product_name: quote.product_name,
      product_name_en: quote.product_name_en,
      model: quote.model,
      unit: quote.unit,
      quantity: quote.quantity,
      unit_price: quote.unit_price,
      amount: quote.amount,
      image: quote.image || (product && product.image),
    }];
  }
  const rows = items.map((item, index) => {
    const image = localImage(item.image);
    return '<tr><td class="number index">' + (index + 1) + '</td><td>' +
      (image ? '<img class="product-image" src="' + esc(image) + '" alt="">' : '<span class="product-placeholder"></span>') +
      '</td><td class="product"><strong>' + esc(item.product_name || '-') + '</strong>' +
      (item.product_name_en ? '<span>' + esc(item.product_name_en) + '</span>' : '') +
      (item.model ? '<span>Ref. ' + esc(item.model) + '</span>' : '') +
      (item.color ? '<span>' + esc(item.color) + '</span>' : '') +
      '</td><td class="number">' + money(item.quantity) + '</td><td>' + esc(item.unit || 'PCS') +
      '</td><td class="number">' + currency + ' ' + money(item.unit_price) +
      '</td><td class="number total">' + currency + ' ' + money(item.amount === undefined || item.amount === null || item.amount === '' ? Number(item.quantity || 0) * Number(item.unit_price || 0) : item.amount) + '</td></tr>';
  }).join('');
  const logo = localImage(company.logo);
  const companyName = company.name_en || company.name || '';
  const companyDetails = [company.address, company.tel, company.email, company.website].filter(Boolean);
  const meta = [
    ['Quote No.', quote.quote_no],
    ['Date', quote.quote_date || '-'],
    ['Valid until', quote.valid_until || '-'],
    ['Currency', currency],
  ].map(([label, value]) => '<div><span>' + label + '</span><strong>' + esc(value) + '</strong></div>').join('');
  const total = money(quote.amount);
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + esc(quote.quote_no) + ' · ' + esc(companyName) + '</title>',
    '<style>*{box-sizing:border-box}body{margin:0;background:#eef0f4;color:#202938;font:15px/1.5 Arial,"Microsoft YaHei",sans-serif}',
    '.quote-sheet{width:1080px;min-height:680px;margin:0 auto;padding:58px 64px;background:#fff}',
    '.topline{display:flex;justify-content:space-between;align-items:flex-start;gap:32px;padding-bottom:34px;border-bottom:2px solid #263650}',
    '.brand{display:flex;align-items:center;gap:18px;min-width:0}.logo{width:auto;max-width:180px;max-height:72px;object-fit:contain}',
    '.company h2{margin:0;color:#17283f;font-size:23px;line-height:1.25}.company p{margin:6px 0 0;color:#637086;font-size:13px}',
    '.document-kind{text-align:right;flex:0 0 auto}.document-kind h1{margin:0;color:#17283f;font-size:32px;line-height:1.15}.document-kind p{margin:6px 0 0;color:#66738a;font-size:12px}',
    '.summary{display:flex;justify-content:space-between;gap:28px;padding:32px 0 28px}.customer h2{margin:5px 0 0;color:#17283f;font-size:21px}.customer p{margin:4px 0;color:#5c687b}',
    '.label{color:#7b8492;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase}.meta{display:grid;grid-template-columns:1fr 1fr;gap:14px 26px;min-width:285px}.meta div{display:flex;flex-direction:column;gap:3px}.meta strong{color:#253248;font-size:14px}',
    'table{width:100%;border-collapse:collapse;table-layout:fixed}thead th{padding:12px 9px;background:#f0f3f7;color:#536176;text-align:left;font-size:11px;letter-spacing:.5px;text-transform:uppercase}',
    'tbody td{padding:13px 9px;border-bottom:1px solid #e4e8ee;vertical-align:middle;font-size:13px}.index{width:40px;color:#7c8797;text-align:center}',
    '.product-image,.product-placeholder{display:block;width:64px;height:64px;border-radius:5px}.product-image{object-fit:contain}.product-placeholder{background:#f0f3f7}',
    '.product strong,.product span{display:block}.product strong{color:#202d41;font-size:13px}.product span{margin-top:2px;color:#738094;font-size:11px}',
    '.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.total{color:#17283f;font-weight:700}',
    '.totals{display:flex;justify-content:flex-end;padding:22px 8px 25px}.grand-total{width:300px;padding-top:14px;border-top:2px solid #263650}',
    '.grand-total div{display:flex;justify-content:space-between;align-items:baseline}.grand-total span{color:#66738a;font-size:13px}.grand-total strong{color:#17283f;font-size:23px}',
    '.footer{margin-top:42px;padding-top:16px;border-top:1px solid #e4e8ee;color:#7b8492;font-size:11px}</style></head><body>',
    '<main class="quote-sheet" id="quoteImage"><header class="topline"><div class="brand">',
    logo ? '<img class="logo" src="' + esc(logo) + '" alt="">' : '',
    '<div class="company"><h2>' + esc(companyName) + '</h2><p>' + companyDetails.map(esc).join(' · ') + '</p></div></div>',
    '<div class="document-kind"><h1>QUOTATION</h1><p>报价单</p></div></header>',
    '<section class="summary"><div class="customer"><span class="label">Prepared for</span><h2>' + esc(customer.company_name) + '</h2>',
    customer.country ? '<p>' + esc(customer.country) + '</p>' : '',
    quote.contact_person ? '<p>Attn. ' + esc(quote.contact_person) + '</p>' : '',
    '</div><div class="meta">' + meta + '</div></section><table><thead><tr>',
    '<th class="index">#</th><th style="width:84px">Image</th><th>Product</th><th style="width:100px;text-align:right">Qty</th>',
    '<th style="width:75px">Unit</th><th style="width:145px;text-align:right">Unit price</th><th style="width:160px;text-align:right">Amount</th>',
    '</tr></thead><tbody>' + rows + '</tbody></table>',
    '<section class="totals"><div class="grand-total"><div><span>Total</span><strong>' + currency + ' ' + total + '</strong></div></div></section>',
    '<footer class="footer">' + esc(companyName) + ' · ' + esc(quote.quote_no) + ' · ' + esc(quote.quote_date || '') + '</footer></main></body></html>',
  ].join('');
  return html;
}

async function generateQuoteImage(quote, userId) {
  const html = quoteHtml(quote, userId);
  if (!html) throw new Error('报价不存在或无权访问');
  return documentPdf.generateImage(html, '#quoteImage');
}

module.exports = { generateQuoteImage, quoteFilename, quoteHtml };
