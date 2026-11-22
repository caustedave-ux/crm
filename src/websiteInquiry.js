'use strict';
// ============ FOEVE 独立站询盘：签名校验 + 写入公共客户池 ============
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, run, get, all } = require('./db');
const { nowStr, todayStr, addDays, guessCountry, mapCountryName, COUNTRY_CODES } = require('./util');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const SECRET_FILE = path.join(__dirname, '..', 'data', 'website-inquiry-secret.txt');

function readSecret() {
  const fromEnv = String(process.env.WEBSITE_INQUIRY_SECRET || '').trim();
  if (fromEnv.length >= 32) return fromEnv;
  try {
    const fromFile = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (fromFile.length >= 32) return fromFile;
  } catch (e) {}
  return '';
}

function clean(value, max) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, max || 200);
}

function pick(body, keys, max) {
  for (const key of keys) {
    const value = clean(body[key], max);
    if (value) return value;
  }
  return '';
}

function digits(value) {
  return String(value || '').replace(/[^0-9]/g, '').replace(/^00/, '');
}

function phonesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 8 && b.length >= 8 && (a.endsWith(b) || b.endsWith(a));
}

function sameText(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function canonicalCountry(label) {
  const raw = clean(label, 120);
  if (!raw) return '';
  const en = String(mapCountryName(raw) || '').trim();
  const hit = COUNTRY_CODES.find(([, full]) => {
    const i = full.indexOf(' ');
    return i > -1 && full.slice(i + 1).trim().toLowerCase() === en.toLowerCase();
  });
  if (hit) return hit[1];
  const hitCn = COUNTRY_CODES.find(([, full]) => {
    const i = full.indexOf(' ');
    return i > -1 && full.slice(0, i).trim() === raw;
  });
  return hitCn ? hitCn[1] : raw;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function normalizeInquiry(body) {
  const company = pick(body, ['company', 'companyName', 'company_name'], 200);
  const email = pick(body, ['email', 'emailAddress', 'email_address'], 254);
  const whatsapp = pick(body, ['whatsapp', 'whatsApp', 'phone', 'phoneNumber', 'phone_number'], 80);
  const whatsappDigits = digits(whatsapp);
  if (!email && whatsappDigits.length < 6) return { error: 'email_or_whatsapp_required' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'invalid_email' };
  if (whatsapp && whatsappDigits.length < 6) return { error: 'invalid_whatsapp' };

  let name = pick(body, ['name', 'fullName', 'full_name', 'contactName', 'contact_name'], 160);
  if (!name) name = company || (email ? email.split('@')[0] : 'Website visitor');

  let country = canonicalCountry(pick(body, ['country', 'countryName', 'country_name'], 120));
  if (!country && whatsapp) country = guessCountry(whatsapp);

  const rawChannel = pick(body, ['preferredChannel', 'preferred_channel', 'channel'], 40);
  const preferredChannel = /whatsapp|\bwa\b/i.test(rawChannel)
    ? 'WhatsApp'
    : (/e-?mail/i.test(rawChannel) ? 'Email' : (whatsappDigits ? 'WhatsApp' : 'Email'));

  const utm = body.utm && typeof body.utm === 'object' && !Array.isArray(body.utm) ? body.utm : {};
  const utmValue = (key) => clean(utm[key] || body['utm_' + key], 160);

  return {
    name,
    company,
    email,
    whatsapp,
    whatsappDigits,
    country,
    preferredChannel,
    projectType: pick(body, ['projectType', 'project_type', 'projectCategory', 'project_category'], 120),
    product: pick(body, ['product', 'productName', 'product_name'], 240),
    sku: pick(body, ['sku', 'model', 'productSku', 'product_sku'], 120),
    quantity: pick(body, ['quantity', 'qty'], 80),
    finish: pick(body, ['finish', 'surfaceFinish', 'surface_finish'], 120),
    message: pick(body, ['message', 'requirements', 'notes', 'inquiry'], 8000),
    pageUrl: pick(body, ['pageUrl', 'page_url', 'sourceUrl', 'source_url'], 2000),
    locale: pick(body, ['locale', 'language'], 40),
    utmSource: utmValue('source'),
    utmMedium: utmValue('medium'),
    utmCampaign: utmValue('campaign'),
    utmContent: utmValue('content'),
    utmTerm: utmValue('term'),
    consent: body.consent === true || body.consent === 1 || body.consent === '1' || body.consent === 'true',
  };
}

function findCustomer(email, whatsappDigits) {
  if (email) {
    const direct = get("SELECT * FROM customers WHERE lower(trim(COALESCE(email,''))) = ? ORDER BY id LIMIT 1", email.toLowerCase());
    if (direct) return direct;
    const contact = get(`SELECT c.* FROM contacts ct JOIN customers c ON c.id=ct.customer_id
      WHERE lower(trim(COALESCE(ct.email,''))) = ? ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1`, email.toLowerCase());
    if (contact) return contact;
  }
  if (whatsappDigits) {
    const customers = all("SELECT * FROM customers WHERE COALESCE(whatsapp,'') <> '' ORDER BY id");
    for (const customer of customers) {
      if (phonesMatch(digits(customer.whatsapp), whatsappDigits)) return customer;
    }
    const contacts = all(`SELECT c.*, ct.mobile AS contact_mobile FROM contacts ct JOIN customers c ON c.id=ct.customer_id
      WHERE COALESCE(ct.mobile,'') <> '' ORDER BY ct.is_primary DESC, ct.id ASC`);
    for (const customer of contacts) {
      if (phonesMatch(digits(customer.contact_mobile), whatsappDigits)) return customer;
    }
  }
  return null;
}

function resolveOwner() {
  const configuredId = parseInt(process.env.WEBSITE_INQUIRY_OWNER_USER_ID, 10) || 0;
  const configured = configuredId ? get('SELECT * FROM users WHERE id=? AND active=1', configuredId) : null;
  const owner = configured
    || get("SELECT * FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1")
    || get('SELECT * FROM users WHERE active=1 ORDER BY id LIMIT 1');
  if (!owner) return null;
  const mode = String(process.env.WEBSITE_INQUIRY_OWNER_MODE || 'pool').toLowerCase() === 'user' && configured
    ? 'user'
    : 'pool';
  return { user: owner, mode };
}

function inquiryContent(inquiry) {
  const lines = [
    '来源：FOEVE 独立站',
    inquiry.preferredChannel ? '回复偏好：' + inquiry.preferredChannel : '',
    inquiry.email ? '邮箱：' + inquiry.email : '',
    inquiry.whatsapp ? 'WhatsApp：' + inquiry.whatsapp : '',
    inquiry.country ? '国家/地区：' + inquiry.country : '',
    inquiry.projectType ? '项目类型：' + inquiry.projectType : '',
    (inquiry.product || inquiry.sku) ? '产品：' + [inquiry.product, inquiry.sku ? '(' + inquiry.sku + ')' : ''].join(' ') : '',
    inquiry.quantity ? '数量：' + inquiry.quantity : '',
    inquiry.finish ? '表面处理：' + inquiry.finish : '',
    inquiry.message ? '留言：' + inquiry.message : '',
    inquiry.pageUrl ? '页面：' + inquiry.pageUrl : '',
    (inquiry.utmSource || inquiry.utmMedium || inquiry.utmCampaign)
      ? 'UTM：' + [inquiry.utmSource && 'source=' + inquiry.utmSource, inquiry.utmMedium && 'medium=' + inquiry.utmMedium, inquiry.utmCampaign && 'campaign=' + inquiry.utmCampaign].filter(Boolean).join(' / ')
      : '',
    inquiry.consent ? '隐私同意：是' : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function updateBlankCustomerFields(customer, inquiry) {
  const fields = [];
  const params = [];
  const add = (column, value) => {
    if (!String(customer[column] || '').trim() && value) {
      fields.push(column + '=?');
      params.push(value);
    }
  };
  add('email', inquiry.email);
  add('whatsapp', inquiry.whatsapp);
  add('country', inquiry.country);
  add('contact_person', inquiry.name);
  add('contact_phone', inquiry.whatsapp);
  add('source', 'Website / FOEVE');
  if (!fields.length) return;
  fields.push('updated_at=?');
  params.push(nowStr(), customer.id);
  run('UPDATE customers SET ' + fields.join(',') + ' WHERE id=?', ...params);
}

function findContact(customerId, email, whatsappDigits) {
  const rows = all('SELECT * FROM contacts WHERE customer_id=? ORDER BY is_primary DESC, id ASC', customerId);
  for (const contact of rows) {
    if (email && sameText(contact.email, email)) return contact;
  }
  for (const contact of rows) {
    if (whatsappDigits && phonesMatch(digits(contact.mobile || contact.phone), whatsappDigits)) return contact;
  }
  return null;
}

function saveContact(customerId, inquiry, existingContact) {
  if (existingContact) {
    const fields = [];
    const params = [];
    if (!String(existingContact.name || '').trim() && inquiry.name) { fields.push('name=?'); params.push(inquiry.name); }
    if (!String(existingContact.email || '').trim() && inquiry.email) { fields.push('email=?'); params.push(inquiry.email); }
    if (!String(existingContact.mobile || '').trim() && inquiry.whatsapp) { fields.push('mobile=?'); params.push(inquiry.whatsapp); }
    if (fields.length) {
      params.push(existingContact.id);
      run('UPDATE contacts SET ' + fields.join(',') + ' WHERE id=?', ...params);
    }
    return Number(existingContact.id);
  }
  const primary = get('SELECT COUNT(*) c FROM contacts WHERE customer_id=? AND COALESCE(is_primary,0)=1', customerId).c;
  const result = run(`INSERT INTO contacts(customer_id,name,position,department,phone,mobile,email,is_primary,notes,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, customerId, inquiry.name || '(未命名)', '', '', '', inquiry.whatsapp, inquiry.email,
    primary ? 0 : 1, 'FOEVE 独立站询盘', nowStr());
  return Number(result.lastInsertRowid);
}

function storeInquiry(inquiry, rawBody, idempotencyKey) {
  const owner = resolveOwner();
  if (!owner) throw new Error('no_active_crm_user');
  const now = nowStr();
  let result = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    let customer = findCustomer(inquiry.email, inquiry.whatsappDigits);
    let customerId;
    let contactId;
    let ownerId;
    let isNew = false;
    let inPool;

    if (customer) {
      customerId = Number(customer.id);
      ownerId = Number(customer.user_id || owner.user.id);
      inPool = Number(customer.in_pool) ? 1 : 0;
      updateBlankCustomerFields(customer, inquiry);
      const existingContact = findContact(customerId, inquiry.email, inquiry.whatsappDigits);
      contactId = saveContact(customerId, inquiry, existingContact);
    } else {
      isNew = true;
      ownerId = Number(owner.user.id);
      inPool = owner.mode === 'pool' ? 1 : 0;
      const companyName = inquiry.company || inquiry.name || ('Website lead - ' + (inquiry.email || inquiry.whatsapp));
      const customerResult = run(`INSERT INTO customers(user_id,company_name,country,source,status,level,phone,email,whatsapp,
        contact_person,contact_phone,notes,in_pool,pool_at,pool_reason,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ownerId, companyName, inquiry.country, 'Website / FOEVE',
        '潜在客户', '普通', inquiry.whatsapp, inquiry.email, inquiry.whatsapp, inquiry.name, inquiry.whatsapp,
        'FOEVE 独立站询盘客户', inPool, inPool ? now : null, inPool ? 'FOEVE 独立站询盘 · 待领取' : null, now, now);
      customerId = Number(customerResult.lastInsertRowid);
      contactId = saveContact(customerId, inquiry, null);
    }

    const subject = '独立站询盘 · ' + (inquiry.product || inquiry.projectType || inquiry.sku || 'General inquiry');
    const activityResult = run(`INSERT INTO activities(customer_id,type,subject,content,contact_person,activity_date,
      next_follow_date,next_follow_notes,images,created_by,user_id,created_at,priority,outcome)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, customerId, '询盘', subject, inquiryContent(inquiry), inquiry.name,
      now, addDays(todayStr(), 1), '查看独立站询盘，并选择 Email 或 WhatsApp 首次回复', '[]', 'Website', ownerId, now, '高', '');
    const activityId = Number(activityResult.lastInsertRowid);

    const inquiryResult = run(`INSERT INTO website_inquiries(idempotency_key,name,company,email,whatsapp,country,
      preferred_channel,project_type,product,sku,quantity,finish,message,page_url,locale,utm_source,utm_medium,
      utm_campaign,utm_content,utm_term,payload_json,customer_id,contact_id,activity_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, idempotencyKey, inquiry.name, inquiry.company,
      inquiry.email, inquiry.whatsapp, inquiry.country, inquiry.preferredChannel, inquiry.projectType, inquiry.product,
      inquiry.sku, inquiry.quantity, inquiry.finish, inquiry.message, inquiry.pageUrl, inquiry.locale, inquiry.utmSource,
      inquiry.utmMedium, inquiry.utmCampaign, inquiry.utmContent, inquiry.utmTerm, rawBody, customerId, contactId,
      activityId, now, now);

    result = {
      inquiryId: Number(inquiryResult.lastInsertRowid),
      customerId,
      contactId,
      activityId,
      status: inPool ? 'public_pool' : 'assigned',
      isNew,
    };
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    throw error;
  }
  return result;
}

function handle(ctx) {
  const secret = readSecret();
  if (!secret) return ctx.res.json(503, { ok: false, error: 'inquiry_endpoint_not_configured' });

  const contentType = String(ctx.req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    return ctx.res.json(400, { ok: false, error: 'content_type_must_be_json' });
  }

  const rawBody = String(ctx.rawBody || '');
  if (!rawBody) return ctx.res.json(400, { ok: false, error: 'empty_body' });
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return ctx.res.json(413, { ok: false, error: 'body_too_large' });
  }

  const timestamp = String(ctx.req.headers['x-fo-timestamp'] || '');
  const signature = String(ctx.req.headers['x-fo-signature'] || '').toLowerCase();
  const idempotencyKey = String(ctx.req.headers['x-fo-idempotency-key'] || '').trim();
  if (!/^\d{1,12}$/.test(timestamp)) return ctx.res.json(401, { ok: false, error: 'invalid_timestamp' });
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return ctx.res.json(401, { ok: false, error: 'timestamp_expired' });
  }
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return ctx.res.json(401, { ok: false, error: 'invalid_signature' });
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return ctx.res.json(400, { ok: false, error: 'invalid_idempotency_key' });
  }

  const expected = 'v1=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
  if (!safeEqual(signature, expected)) return ctx.res.json(401, { ok: false, error: 'invalid_signature' });

  const previous = get('SELECT id,customer_id FROM website_inquiries WHERE idempotency_key=?', idempotencyKey);
  if (previous) {
    const customer = previous.customer_id ? get('SELECT in_pool FROM customers WHERE id=?', previous.customer_id) : null;
    return ctx.res.json(200, {
      ok: true,
      inquiry_id: previous.id,
      status: customer && Number(customer.in_pool) ? 'public_pool' : 'assigned',
      duplicate: true,
    });
  }

  const inquiry = normalizeInquiry(ctx.body || {});
  if (inquiry.error) return ctx.res.json(400, { ok: false, error: inquiry.error });

  try {
    const saved = storeInquiry(inquiry, rawBody, idempotencyKey);
    console.log('FOEVE 独立站询盘已入库 #' + saved.inquiryId + '，客户 #' + saved.customerId);
    return ctx.res.json(201, {
      ok: true,
      inquiry_id: saved.inquiryId,
      status: saved.status,
      duplicate: false,
    });
  } catch (error) {
    if (/UNIQUE constraint failed: website_inquiries\.idempotency_key/i.test(String(error.message || ''))) {
      const row = get('SELECT id,customer_id FROM website_inquiries WHERE idempotency_key=?', idempotencyKey);
      if (row) {
        const customer = row.customer_id ? get('SELECT in_pool FROM customers WHERE id=?', row.customer_id) : null;
        return ctx.res.json(200, {
          ok: true,
          inquiry_id: row.id,
          status: customer && Number(customer.in_pool) ? 'public_pool' : 'assigned',
          duplicate: true,
        });
      }
    }
    console.error('FOEVE 独立站询盘写入失败：', error);
    return ctx.res.json(500, { ok: false, error: 'inquiry_write_failed' });
  }
}

module.exports = { handle, SECRET_FILE, normalizeInquiry, findCustomer, isHttpUrl };
