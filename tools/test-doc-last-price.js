'use strict';
// 客户上次卖价接口测试：临时 DB，不触碰生产数据
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TMP_DIR = 'D:/Codex/tmp';
fs.mkdirSync(TMP_DIR, { recursive: true });
const dbPath = path.join(TMP_DIR, 'crm-last-price-' + process.pid + '.db');
try { fs.unlinkSync(dbPath); } catch (e) {}
process.env.CRM_DB = dbPath;
const { db, run, get, seedBase } = require('../src/db');
const { nowStr, todayStr } = require('../src/util');
seedBase();
for (const t of ['documents', 'products', 'customers']) { try { run('DELETE FROM ' + t); } catch (e) {} }
const admin = get('SELECT * FROM users ORDER BY id LIMIT 1');
const stamp = nowStr();
const customerId = Number(run(`INSERT INTO customers(user_id,company_name,country,status,level,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`, admin.id, 'Last Price Buyer', 'Nigeria', '合作客户', '普通', stamp, stamp).lastInsertRowid);
const otherCustomerId = Number(run(`INSERT INTO customers(user_id,company_name,country,status,level,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`, admin.id, 'Other Buyer', 'Ghana', '潜在客户', '普通', stamp, stamp).lastInsertRowid);
const productId = Number(run(`INSERT INTO products(name,name_en,model,unit,price,currency,stock,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?)`, 'Test Lock', 'Test Lock', 'TL-100', 'PCS', 20, 'USD', 100, stamp, stamp).lastInsertRowid);
function doc(no, status, date, currency, items) {
  return Number(run(`INSERT INTO documents(user_id,doc_no,doc_type,customer_id,title,issue_date,currency,status,total_amount,items,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, admin.id, no, 'pi', customerId, no, date, currency, status, 0, JSON.stringify(items), stamp, stamp).lastInsertRowid);
}
doc('PI-OLD', '已发送', '2026-10-01', 'USD', [{ product_id: productId, name: 'Test Lock', model: 'TL-100', qty: 100, price: 12 }]);
const latestId = doc('PI-LATEST', '已确认', '2026-11-01', 'USD', [
  { product_id: productId, name: 'Test Lock', model: 'TL-100', qty: 100, price: 14.5, color: 'Black' },
  { product_id: productId, name: 'Test Lock', model: 'TL-100', qty: 200, price: 15.5, color: 'White' },
]);
doc('PI-DRAFT', '草稿', '2026-12-01', 'USD', [{ product_id: productId, name: 'Test Lock', model: 'TL-100', qty: 100, price: 99 }]);

(async () => {
  let server = null;
  try {
    const { createApp } = require('../src/web');
    const { registerRoutes } = require('../src/routes');
    const auth = require('../src/auth');
    const app = createApp({ before(ctx) {
      auth.authUser(ctx.req, ctx.res);
      if (!ctx.req.user) { ctx.res.json(401, { error: '未登录' }); return false; }
      ctx.user = ctx.req.user; ctx.sessionToken = ctx.req.sessionToken; return true;
    } });
    registerRoutes(app, app.router);
    server = app.server;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const token = auth.createSession(admin.id);
    async function call(cid, query) {
      const r = await fetch('http://127.0.0.1:' + port + '/api/customers/' + cid + '/last-price?' + new URLSearchParams(query), { headers: { Cookie: 'crm_sid=' + token } });
      return { status: r.status, data: await r.json() };
    }
    const hit = await call(customerId, { product_id: productId });
    assert.equal(hit.status, 200);
    assert.equal(hit.data.found, true, '应找到上次卖价');
    assert.equal(hit.data.price, 15.5, '按最近单据的最后一个同款明细价格返回');
    assert.equal(hit.data.doc_id, latestId);
    assert.equal(hit.data.doc_no, 'PI-LATEST');
    assert.equal(hit.data.currency, 'USD');
    assert.equal(hit.data.color, 'White');
    const miss = await call(otherCustomerId, { product_id: productId });
    assert.equal(miss.data.found, false, '其他客户没有采购记录时不能串价');
    const fallback = await call(customerId, { model: 'TL-100' });
    assert.equal(fallback.data.found, true, '老单据没有 product_id 时可按型号匹配');
    const missing = await call(customerId, {});
    assert.equal(missing.status, 400, '缺少产品标识应返回 400');
    const js = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'document-form.js'), 'utf8');
    assert(js.includes('/last-price?'), '前端应调用上次卖价接口');
    assert(js.includes('price_auto'), '前端应把自动带价与手工输入区分');
    assert(js.includes("typeSelect.value !== 'pi'"), '上次卖价只用于 PI');
    assert(js.includes("!String(priceInput.value || '').trim()"), '已手工输入时不能被历史价覆盖');
    console.log('document last price: all tests passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    try { fs.unlinkSync(dbPath); } catch (e) {}
  }
})().catch(e => { console.error(e); try { db.close(); } catch (e2) {} try { fs.unlinkSync(dbPath); } catch (e2) {} process.exit(1); });
