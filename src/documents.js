'use strict';
// ============ 单据业务：单号、明细、渲染上下文、模板 ============
const { run, get, all, getCompany } = require('./db');
const { DOC_TYPES, DOC_TYPE_MAP } = require('./defaultTemplates');
const { esc, todayStr, nowStr, money, num, cnMoney, addDays } = require('./util');
const { renderTemplate } = require('./rendering');

// ---------- 模板 ----------
function templatesByType(docType) {
  return all('SELECT * FROM doc_templates WHERE doc_type=? ORDER BY is_system DESC, id ASC', docType);
}
function getTemplate(id) {
  return get('SELECT * FROM doc_templates WHERE id=?', id);
}
function defaultTemplateFor(docType) {
  return get('SELECT * FROM doc_templates WHERE doc_type=? ORDER BY is_system DESC, id ASC LIMIT 1', docType);
}
function typeName(docType) { const t = DOC_TYPE_MAP[docType]; return t ? t.name : docType; }

// ---------- 单号 ----------
function generateDocNo(docType) {
  const t = DOC_TYPE_MAP[docType] || DOC_TYPES[0];
  const prefix = t.prefix;
  const ymd = todayStr().replace(/-/g, '');
  const like = prefix + '-' + ymd + '-%';
  const r = get('SELECT COUNT(*) c FROM documents WHERE doc_no LIKE ?', like);
  const n = (r.c || 0) + 1;
  return prefix + '-' + ymd + '-' + String(n).padStart(3, '0');
}

// ---------- 明细 & 金额 ----------
function parseItems(arr) {
  if (!Array.isArray(arr)) return [];
  const items = [];
  arr.forEach((it, i) => {
    const ctn = parseFloat(it.ctn);
    const per = parseFloat(it.per_ctn);
    const c = isFinite(ctn) ? ctn : 0;
    const pc = isFinite(per) ? per : 0;
    // 填了 箱数 CTN 与 每箱数量 QTY 时，总数量 T.T QTY = CTN x QTY；否则用填写的总数量
    let q = c > 0 && pc > 0 ? c * pc : (isFinite(parseFloat(it.qty)) ? parseFloat(it.qty) : 0);
    const price = parseFloat(it.price);
    if (!it.name) return;
    let p = isFinite(price) ? price : 0;
    if (p === 0) { const rawAmt = parseFloat(it.amount); if (q > 0 && isFinite(rawAmt) && rawAmt > 0) { p = Math.round(rawAmt / q * 100) / 100; } }
    const amount = Math.round(q * p * 100) / 100;
    items.push({
      seq: i + 1,
      name: String(it.name || '').trim(),
      name_en: String(it.name_en || '').trim(),
      model: String(it.model || '').trim(),
      color: String(it.color || '').trim(),
      unit: String(it.unit || 'PCS').trim(),
      ctn: c,
      per_ctn: pc,
      volume: (isFinite(parseFloat(it.volume)) ? parseFloat(it.volume) : 0),
      weight: (isFinite(parseFloat(it.weight)) ? parseFloat(it.weight) : 0),
      qty: q,
      price: p,
      amount,
      remark: String(it.remark || '').trim(),
      product_id: it.product_id ? Number(it.product_id) : null,
      image: String(it.image || '').trim(),
    });
  });
  return items;
}
function computeTotals(items) {
  const subtotal = Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
  return { subtotal, total_amount: subtotal };
}
function itemsToJson(items) { return JSON.stringify(items); }
function itemsFromDoc(docRow) {
  try { const a = JSON.parse(docRow.items || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

// ---------- 渲染上下文 ----------
function nl2br(s) { return String(s || '').replace(/\r\n/g, '\n').replace(/\n/g, '<br>'); }

function buildDocContext(opts) {
  const company = opts.company || getCompany();
  const customer = opts.customer || {};
  const contact = opts.contact || {};
  const doc = opts.doc || {};
  const items = opts.items || [];
  const logo = company.logo || '';
  const companyCtx = {
    name: esc(company.name),
    name_en: esc(company.name_en),
    address: nl2br(esc(company.address)),
    tel: esc(company.tel),
    fax: esc(company.fax),
    email: esc(company.email),
    website: esc(company.website),
    salesman: esc(company.salesman),
    bank_name: esc(company.bank_name),
    bank_account: esc(company.bank_account),
    bank_swift: esc(company.bank_swift),
    logo_html: logo ? '<img src="' + esc(logo) + '" alt="logo">' : '',
  };
  const contactParts = [];
  if (customer.phone) contactParts.push('Tel: ' + esc(customer.phone));
  if (customer.fax) contactParts.push('Fax: ' + esc(customer.fax));
  if (customer.email) contactParts.push('Email: ' + esc(customer.email));
  if (customer.whatsapp) contactParts.push('WhatsApp: ' + esc(customer.whatsapp));
  if (customer.wechat) contactParts.push('WeChat: ' + esc(customer.wechat));
  const customerCtx = {
    company_name: esc(customer.company_name),
    name_en: esc(customer.name_en),
    country: esc(customer.country),
    address: nl2br(esc(customer.address)),
    website: esc(customer.website),
    tax_no: esc(customer.tax_no),
    contact_person: esc(customer.contact_person),
    contact_phone: esc(customer.contact_phone),
    phone: esc(customer.phone),
    fax: esc(customer.fax),
    email: esc(customer.email),
    whatsapp: esc(customer.whatsapp),
    wechat: esc(customer.wechat),
    contact_line: contactParts.length ? contactParts.join('　') : '—',
  };
  const contactCtx = {
    name: esc(contact.name) || '　',
    position: esc(contact.position),
    position_html: contact.position ? '（' + esc(contact.position) + '）' : '',
    mobile: esc(contact.mobile),
    phone: esc(contact.phone),
    phone_html: contact.phone ? ' / ' + esc(contact.phone) : '',
    email: esc(contact.email),
  };
  const supplier = opts.supplier || {};
  const supParts = [];
  if (supplier.phone) supParts.push('Tel: ' + esc(supplier.phone));
  if (supplier.fax) supParts.push('Fax: ' + esc(supplier.fax));
  if (supplier.email) supParts.push('Email: ' + esc(supplier.email));
  const supplierCtx = {
    name: esc(supplier.name),
    name_en: esc(supplier.name_en),
    country: esc(supplier.country),
    address: nl2br(esc(supplier.address)),
    website: esc(supplier.website),
    contact_name: esc(supplier.contact_name) || '　',
    contact_position: esc(supplier.contact_position),
    contact_position_html: supplier.contact_position ? '（' + esc(supplier.contact_position) + '）' : '',
    phone: esc(supplier.phone),
    fax: esc(supplier.fax),
    email: esc(supplier.email),
    main_products: esc(supplier.main_products),
    payment_terms: nl2br(esc(supplier.payment_terms)),
    contact_line: supParts.length ? supParts.join('　') : '—',
  };
  const totalCtn = Math.round(items.reduce((s, it) => s + (Number(it.ctn) || 0), 0) * 1000) / 1000;
  const totalVolume = items.reduce((s, it) => s + ((Number(it.volume) || 0) * (Number(it.per_ctn) || 0)), 0);
  const totalWeight = items.reduce((s, it) => s + ((Number(it.weight) || 0) * (Number(it.per_ctn) || 0)), 0);  const total = doc.total_amount || 0;
  const docCtx = {
    doc_no: esc(doc.doc_no),
    doc_type: typeName(doc.doc_type),
    type_name: typeName(doc.doc_type),
    title: esc(doc.title),
    issue_date: esc(doc.issue_date),
    valid_until: esc(doc.valid_until),
    delivery_date: esc(doc.delivery_date),
    currency: esc(doc.currency) || 'USD',
    payment_terms: nl2br(esc(doc.payment_terms)),
    trade_terms: nl2br(esc(doc.trade_terms)),
    port_loading: esc(doc.port_loading),
    port_destination: esc(doc.port_destination),
    shipping_marks: nl2br(esc(doc.shipping_marks)),
    remarks: nl2br(esc(doc.remarks)),
    subtotal: money(doc.subtotal),
    discount: money(doc.discount),
    tax_rate: num(doc.tax_rate),
    tax_amount: money(doc.tax_amount),
    total_amount: money(total),
    total_amount_cn: cnMoney(total),
    total_volume: String(Math.round(totalVolume * 1000) / 1000),
    total_ctn: String(totalCtn),
    remark_images_block: (function () {
      var imgs = [];
      try { var arr = JSON.parse(doc.remark_images || '[]'); imgs = Array.isArray(arr) ? arr : []; } catch (e) { imgs = []; }
      if (!imgs.length) return '';
      return '<div class="terms"><b>备注图片 Remark Images：</b><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">' +
        imgs.map(function (u) { return '<img src="' + esc(u) + '" style="max-width:170px;max-height:170px;border:1px solid #ddd;border-radius:6px;padding:2px;background:#fff">'; }).join('') +
        '</div></div>';
    })(),
    total_weight: String(Math.round(totalWeight * 1000) / 1000),
    created_by: esc(doc.created_by),
    status: esc(doc.status),
  };
  const itemsCtx = items.map((it, i) => {
    const nameHtml = esc(it.name) + (it.name_en ? ' <span style="color:#555;font-size:11px;">' + esc(it.name_en) + '</span>' : '');
    const img = String(it.image || '').trim();
    const imageHtml = img
      ? '<img src="' + esc(img) + '" style="max-width:132px;max-height:132px;width:auto;height:auto;object-fit:contain;background:#fff;border:1px solid #e5e7eb;border-radius:6px;margin-right:8px;float:left;" alt="">'
      : '';
    return {
      seq: i + 1,
      name: esc(it.name),
      name_en: esc(it.name_en),
      name_html: nameHtml,
      image: esc(img),
      image_html: imageHtml,
      model: esc(it.model),
      color: esc(it.color),
      unit: esc(it.unit),
      ctn: num(it.ctn),
      per_ctn: num(it.per_ctn),
      qty: num(it.qty),
      price: money(it.price),
      amount: money(it.amount),
      volume: num(it.volume),
      total_volume: String(Math.round((Number(it.volume) || 0) * (Number(it.per_ctn) || 0) * 1000) / 1000),
      weight: num(it.weight),
      total_weight: String(Math.round((Number(it.weight) || 0) * (Number(it.per_ctn) || 0) * 1000) / 1000),
      remark: nl2br(esc(it.remark)),
    };
  });
  return {
    company: companyCtx,
    customer: customerCtx,
    contact: contactCtx,
    supplier: supplierCtx,
    doc: docCtx,
    items: itemsCtx,
  };
}

// 渲染一张单据的内容（快照），返回 HTML
function renderDocument(docRow, items) {
  const template = docRow.template_id ? getTemplate(docRow.template_id) : null;
  const content = (template && template.content) ? template.content : (defaultTemplateFor(docRow.doc_type) || {}).content || '';
  const customer = get('SELECT * FROM customers WHERE id=?', docRow.customer_id) || {};
  const contact = docRow.contact_id ? (get('SELECT * FROM contacts WHERE id=?', docRow.contact_id) || {}) : (customer.contact_person ? { name: customer.contact_person, position: '', mobile: customer.contact_phone || '', phone: customer.contact_phone || '', email: customer.email || '' } : {});
  const supplier = docRow.supplier_id ? (get('SELECT * FROM suppliers WHERE id=?', docRow.supplier_id) || {}) : {};
  const ctx = buildDocContext({ customer, contact, supplier, doc: docRow, items });
  return renderTemplate(content, ctx);
}

// ---------- 增删改查 ----------
function createDocument(p) {
  const items = parseItems(p.items);
  const totals = computeTotals(items);
  const docNo = generateDocNo(p.doc_type);
  const now = nowStr();
  const issueDate = p.issue_date || todayStr();
  const defaultOwner = (get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1") || {}).id || null;
  const row = {
    doc_no: docNo, doc_type: p.doc_type, template_id: p.template_id || null, user_id: p.user_id || defaultOwner,
    customer_id: p.customer_id, contact_id: p.contact_id || null, supplier_id: p.supplier_id || null,
    title: p.title || '', issue_date: issueDate, valid_until: p.valid_until || '', delivery_date: p.delivery_date || '',
    currency: p.currency || 'USD', payment_terms: p.payment_terms || '', trade_terms: p.trade_terms || '',
    port_loading: p.port_loading || '', port_destination: p.port_destination || '', shipping_marks: p.shipping_marks || '',
    remarks: p.remarks || '', status: p.status || '草稿',
    remark_images: p.remark_images || '',
    subtotal: totals.subtotal, discount: 0, tax_rate: 0, tax_amount: 0, total_amount: totals.total_amount,
    items: itemsToJson(items), created_by: p.created_by || '', created_at: now, updated_at: now,
  };
  const contentHtml = renderDocument(row, items);
  const r = run(`INSERT INTO documents(doc_no,doc_type,template_id,customer_id,contact_id,supplier_id,user_id,title,issue_date,valid_until,delivery_date,currency,payment_terms,trade_terms,port_loading,port_destination,shipping_marks,remarks,remark_images,status,subtotal,discount,tax_rate,tax_amount,total_amount,items,content_html,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.doc_no, row.doc_type, row.template_id, row.customer_id, row.contact_id, row.supplier_id, row.user_id, row.title, row.issue_date, row.valid_until, row.delivery_date,
    row.currency, row.payment_terms, row.trade_terms, row.port_loading, row.port_destination, row.shipping_marks, row.remarks, row.remark_images, row.status,
    row.subtotal, row.discount, row.tax_rate, row.tax_amount, row.total_amount, row.items, contentHtml, row.created_by, row.created_at, row.updated_at);
  return Number(r.lastInsertRowid);
}

function updateDocument(id, p) {
  const old = get('SELECT * FROM documents WHERE id=?', id);
  if (!old) return null;
  const items = parseItems(p.items);
  const totals = computeTotals(items);
  const row = Object.assign({}, old, {
    doc_type: p.doc_type, template_id: p.template_id || null, customer_id: p.customer_id, contact_id: p.contact_id || null, user_id: old.user_id,
    supplier_id: p.supplier_id || null, title: p.title || '', issue_date: p.issue_date || todayStr(),
    valid_until: p.valid_until || '', delivery_date: p.delivery_date || '', currency: p.currency || 'USD',
    payment_terms: p.payment_terms || '', trade_terms: p.trade_terms || '', port_loading: p.port_loading || '',
    port_destination: p.port_destination || '', shipping_marks: p.shipping_marks || '', remarks: p.remarks || '',
    remark_images: (p.remark_images !== undefined ? p.remark_images : (old.remark_images || '')),
    status: p.status || old.status || '草稿',
    subtotal: totals.subtotal, discount: 0, tax_rate: 0, tax_amount: 0, total_amount: totals.total_amount,
    items: itemsToJson(items), updated_at: nowStr(),
  });
  const contentHtml = renderDocument(row, items);
  row.content_html = contentHtml;
  run(`UPDATE documents SET doc_type=?,template_id=?,customer_id=?,contact_id=?,supplier_id=?,title=?,issue_date=?,valid_until=?,delivery_date=?,currency=?,payment_terms=?,trade_terms=?,port_loading=?,port_destination=?,shipping_marks=?,remarks=?,remark_images=?,status=?,subtotal=?,discount=?,tax_rate=?,tax_amount=?,total_amount=?,items=?,content_html=?,updated_at=? WHERE id=?`,
    row.doc_type, row.template_id, row.customer_id, row.contact_id, row.supplier_id, row.title, row.issue_date, row.valid_until, row.delivery_date,
    row.currency, row.payment_terms, row.trade_terms, row.port_loading, row.port_destination, row.shipping_marks, row.remarks, row.remark_images, row.status,
    row.subtotal, row.discount, row.tax_rate, row.tax_amount, row.total_amount, row.items, contentHtml, row.updated_at, id);
  return id;
}

function setDocStatus(id, status) {
  run('UPDATE documents SET status=?,updated_at=? WHERE id=?', status, nowStr(), id);
}
function deleteDocument(id) {
  run('DELETE FROM documents WHERE id=?', id);
}
function getDoc(id) {
  const d = get('SELECT * FROM documents WHERE id=?', id);
  if (d) d.items = itemsFromDoc(d);
  return d;
}

// ---------- 演示单据 ----------
function seedSampleDocuments() {
  const docCount = get('SELECT COUNT(*) c FROM documents').c || 0;
  const custCount = get('SELECT COUNT(*) c FROM customers').c || 0;
  if (docCount > 0 || custCount > 0) return;
  const cust = get('SELECT * FROM customers ORDER BY id LIMIT 1');
  const cust2 = get('SELECT * FROM customers ORDER BY id LIMIT 1 OFFSET 3');
  if (!cust) return;
  const contact = get('SELECT * FROM contacts WHERE customer_id=? ORDER BY is_primary DESC LIMIT 1', cust.id);
  const contact2 = get('SELECT * FROM contacts WHERE customer_id=? ORDER BY is_primary DESC LIMIT 1', cust2 ? cust2.id : cust.id);
  const prods = all('SELECT * FROM products ORDER BY id');
  const tplQ = defaultTemplateFor('quotation');
  const tplPI = defaultTemplateFor('pi');
  const d1 = createDocument({
    doc_type: 'quotation', template_id: tplQ.id, customer_id: cust.id, contact_id: contact ? contact.id : null,
    title: '圣诞季保温杯报价', currency: 'USD', issue_date: todayStr(), valid_until: addDays(todayStr(), 15),
    delivery_date: addDays(todayStr(), 45), payment_terms: 'T/T 30% 定金，余款见提单副本付清',
    trade_terms: 'FOB Shenzhen', port_loading: '深圳盐田 Yantian, Shenzhen', port_destination: '洛杉矶 Los Angeles',
    shipping_marks: 'ALPHA MART / LOS ANGELES / C/NO.1-UP', remarks: '单价含中性彩盒包装；印客户Logo需另行确认打样。',
    status: '已发送', created_by: '外贸业务员',
    items: [
      { name: prods[0].name, name_en: prods[0].name_en, model: prods[0].model, unit: prods[0].unit, qty: 6000, price: prods[0].price, remark: '白色 3000 / 黑色 3000' },
      { name: prods[2].name, name_en: prods[2].name_en, model: prods[2].model, unit: prods[2].unit, qty: 3000, price: prods[2].price, remark: '' },
      { name: prods[1].name, name_en: prods[1].name_en, model: prods[1].model, unit: prods[1].unit, qty: 3000, price: prods[1].price, remark: '四色混装' },
    ],
  });
  if (cust2) {
    createDocument({
      doc_type: 'pi', template_id: tplPI.id, customer_id: cust2.id, contact_id: contact2 ? contact2.id : null,
      title: '竹木砧板试单形式发票', currency: 'USD', issue_date: todayStr(), valid_until: addDays(todayStr(), 20),
      delivery_date: addDays(todayStr(), 40), payment_terms: 'T/T 30% 定金，70% 发货前付清',
      trade_terms: 'CIF Felixstowe', port_loading: '深圳蛇口 Shekou, Shenzhen', port_destination: '费利克斯托 Felixstowe',
      shipping_marks: 'SUNRISE / FELIXSTOWE / C/NO.1-UP', remarks: '含丝印Logo，先出样确认后投产。',
      status: '草稿', created_by: '外贸业务员',
      items: [
        { name: prods[3].name, name_en: prods[3].name_en, model: prods[3].model, unit: prods[3].unit, qty: 3000, price: prods[3].price, remark: '' },
      ],
    });
  }
  console.log('已生成演示单据 ' + d1);
}

module.exports = {
  templatesByType, getTemplate, defaultTemplateFor, typeName, generateDocNo, parseItems, computeTotals,
  itemsToJson, itemsFromDoc, buildDocContext, renderDocument, createDocument, updateDocument,
  setDocStatus, deleteDocument, getDoc, seedSampleDocuments,
};










