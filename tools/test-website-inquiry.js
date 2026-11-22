'use strict';
// FOEVE 独立站询盘接口集成测试：使用 D:\Codex\tmp 下的临时数据库，不碰生产数据。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = 'D:/Codex/tmp';
const TMP_DB = path.join(TMP_DIR, 'crm-inquiry-test-' + process.pid + '.db');
const PORT = 5200 + (process.pid % 300);
const BASE = 'http://127.0.0.1:' + PORT;
const SECRET = 'test-secret-' + crypto.randomBytes(24).toString('hex');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sign(timestamp, raw, secret) {
  return 'v1=' + crypto.createHmac('sha256', secret || SECRET).update(timestamp + '.' + raw).digest('hex');
}

async function waitReady(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(BASE + '/login');
      if (response.ok) return true;
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function postInquiry(body, options) {
  const opts = options || {};
  const raw = opts.raw || JSON.stringify(body);
  const timestamp = String(opts.timestamp || Math.floor(Date.now() / 1000));
  const key = opts.key || crypto.randomUUID();
  return fetch(BASE + '/api/public/website-inquiry', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'X-FO-Timestamp': timestamp,
      'X-FO-Signature': opts.signature || sign(timestamp, raw, opts.secret),
      'X-FO-Idempotency-Key': key,
    },
    body: raw,
  });
}

(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  try { fs.rmSync(TMP_DB, { force: true }); } catch (error) {}
  try { fs.rmSync(TMP_DB + '-wal', { force: true }); } catch (error) {}
  try { fs.rmSync(TMP_DB + '-shm', { force: true }); } catch (error) {}

  let stderr = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      CRM_DB: TMP_DB,
      WEBSITE_INQUIRY_SECRET: SECRET,
      WEBSITE_INQUIRY_OWNER_MODE: 'pool',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  let db = null;
  try {
    if (!(await waitReady(25000))) throw new Error('CRM 测试实例未能在 25 秒内启动\n' + stderr);

    db = new DatabaseSync(TMP_DB);
    db.exec('PRAGMA busy_timeout=5000;');
    const admin = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get();
    assert(admin, '测试库缺少管理员账号');
    const token = 'inquiry-test-' + Date.now().toString(36);
    db.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .run(token, admin.id, '2099-01-01 00:00:00', '2000-01-01 00:00:00');

    const plain = await fetch(BASE + '/api/public/website-inquiry', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert(plain.status === 400, '非 JSON 请求应返回 400，实际 ' + plain.status);

    const unsigned = await fetch(BASE + '/api/public/website-inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unsigned@example.com' }),
    });
    assert(unsigned.status === 401, '缺少签名应返回 401，实际 ' + unsigned.status);

    const badSignature = await postInquiry({ email: 'bad@example.com' }, { signature: 'v1=' + '0'.repeat(64) });
    assert(badSignature.status === 401, '错误签名应返回 401，实际 ' + badSignature.status);

    const oldTimestamp = await postInquiry({ email: 'old@example.com' }, {
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    assert(oldTimestamp.status === 401, '过期时间戳应返回 401，实际 ' + oldTimestamp.status);

    const invalidContact = await postInquiry({ name: 'No Contact', message: 'hello' });
    assert(invalidContact.status === 400, '缺少邮箱和 WhatsApp 应返回 400，实际 ' + invalidContact.status);

    const oversized = await postInquiry({ email: 'large@example.com', message: 'x'.repeat(257 * 1024) });
    assert(oversized.status === 413, '超过 256KB 应返回 413，实际 ' + oversized.status);

    const firstKey = crypto.randomUUID();
    const firstBody = {
      name: 'Jamie Rivera',
      company: 'Rivera Hospitality',
      email: 'Jamie@Rivera-Example.com',
      whatsapp: '+1 202 555 0198',
      country: 'United States',
      preferredChannel: 'WhatsApp',
      projectType: 'Hotel project',
      product: 'FOEVE Lever Handle LH-201',
      sku: 'LH-201',
      quantity: '500',
      finish: 'Satin Nickel',
      message: 'Need 500 hotel door handles. Please send a quotation.',
      pageUrl: 'https://foeve.com/products/lh-201',
      locale: 'en',
      utm: { source: 'google', medium: 'cpc', campaign: 'hotel-hardware' },
      consent: true,
    };
    const first = await postInquiry(firstBody, { key: firstKey });
    const firstJson = await first.json();
    assert(first.status === 201, '正常询盘应返回 201，实际 ' + first.status + ' ' + JSON.stringify(firstJson));
    assert(firstJson.status === 'public_pool', '新询盘应默认进入公共客户池');

    const inquiry = db.prepare('SELECT * FROM website_inquiries WHERE idempotency_key=?').get(firstKey);
    assert(inquiry, '询盘台账未写入');
    assert(inquiry.preferred_channel === 'WhatsApp', '回复偏好未保存');
    assert(inquiry.utm_campaign === 'hotel-hardware', 'UTM 未保存');
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(inquiry.customer_id);
    assert(customer && Number(customer.in_pool) === 1, '新客户未进入公共客户池');
    assert(customer.source === 'Website / FOEVE', '客户来源不正确');
    const contact = db.prepare('SELECT * FROM contacts WHERE customer_id=?').get(customer.id);
    assert(contact && Number(contact.is_primary) === 1, '主要联系人未创建');
    const activity = db.prepare('SELECT * FROM activities WHERE customer_id=?').get(customer.id);
    assert(activity && activity.type === '询盘', '询盘跟进未创建');
    assert(activity.next_follow_date, '询盘跟进未设置下次跟进日期');

    const duplicate = await postInquiry(firstBody, { key: firstKey });
    const duplicateJson = await duplicate.json();
    assert(duplicate.status === 200 && duplicateJson.duplicate === true, '重复幂等键应返回 duplicate=true');
    assert(db.prepare('SELECT COUNT(*) c FROM website_inquiries').get().c === 1, '重复请求不应新增询盘');

    const second = await postInquiry(Object.assign({}, firstBody, {
      product: 'FOEVE Pull Handle PH-88',
      message: 'Also need pull handles for the lobby.',
    }), { key: crypto.randomUUID() });
    assert(second.status === 201, '同邮箱第二封询盘应成功，实际 ' + second.status);
    assert(db.prepare('SELECT COUNT(*) c FROM customers WHERE lower(email)=?').get('jamie@rivera-example.com').c === 1, '同邮箱不应重复建客户');
    assert(db.prepare('SELECT COUNT(*) c FROM website_inquiries').get().c === 2, '第二封询盘未写入');

    const list = await fetch(BASE + '/inquiries', { headers: { Cookie: 'crm_sid=' + token } });
    const listHtml = await list.text();
    assert(list.status === 200, '询盘列表页应返回 200，实际 ' + list.status);
    assert(listHtml.includes('独立站询盘') && listHtml.includes('Jamie Rivera'), '询盘列表页缺少数据或菜单');

    const detail = await fetch(BASE + '/inquiries/' + inquiry.id, { headers: { Cookie: 'crm_sid=' + token } });
    const detailHtml = await detail.text();
    assert(detail.status === 200, '询盘详情页应返回 200，实际 ' + detail.status);
    assert(detailHtml.includes('Need 500 hotel door handles'), '详情页缺少客户留言');
    assert(detailHtml.includes('用 Email 回复') && detailHtml.includes('用 WhatsApp 回复'), '详情页缺少回复入口');

    const claim = await fetch(BASE + '/customers/' + customer.id + '/claim', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: 'crm_sid=' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'return_to=' + encodeURIComponent('/inquiries/' + inquiry.id),
    });
    assert(claim.status === 302 && claim.headers.get('location') === '/inquiries/' + inquiry.id, '领取后应返回询盘详情');
    const claimed = db.prepare('SELECT * FROM customers WHERE id=?').get(customer.id);
    assert(Number(claimed.in_pool) === 0 && Number(claimed.user_id) === Number(admin.id), '领取后客户归属不正确');
    const websiteActivities = db.prepare("SELECT * FROM activities WHERE customer_id=? AND created_by='Website'").all(customer.id);
    assert(websiteActivities.length === 2 && websiteActivities.every(a => Number(a.user_id) === Number(admin.id)), '领取后询盘跟进未转给负责人');

    console.log('FOEVE 独立站询盘测试通过：签名 / 幂等 / 公共池 / 客户复用 / 页面 / 领取');
  } catch (error) {
    console.error('FOEVE 独立站询盘测试失败：', error.message);
    if (stderr) console.error(stderr.slice(-4000));
    process.exitCode = 1;
  } finally {
    try { if (db) db.close(); } catch (error) {}
    try { child.kill(); } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const file of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
      try { fs.rmSync(file, { force: true }); } catch (error) {}
    }
  }
})();
