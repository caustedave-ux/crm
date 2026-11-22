'use strict';
// ============ 云端数据访问层 ============
// 所有查询都经过 cloud.database，身份由 SDK 自动携带；
// 行级权限（RLS）在云端生效，这里不传 owner_id。
const { cloud } = require('./cloud');
const fmt = require('./format');
const images = require('./images');

const PAGE_SIZE = 20;

const CUSTOMER_STATUS = ['潜在客户', '报价中', '意向客户', '合作客户'];
const CURRENCIES = ['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'HKD'];
const PRODUCT_FIELDS = [
  'name', 'name_en', 'model', 'hs_code', 'unit', 'price', 'currency', 'cost_price',
  'origin', 'stock', 'stock_alert', 'pcs_per_ctn', 'volume', 'weight', 'ctn_count', 'color', 'notes',
];
const STOCK_MOVE_TYPES = [
  { key: 'in', name: '入库' },
  { key: 'out', name: '出库' },
  { key: 'set', name: '盘点' },
];
const DOC_TYPES = [
  { key: 'quotation', name: '报价单' },
  { key: 'pi', name: '形式发票 PI' },
  { key: 'so', name: '销售合同' },
  { key: 'ci', name: '商业发票 CI' },
  { key: 'pl', name: '装箱单' },
  { key: 'po', name: '采购单' },
];

function docTypeName(key) {
  const t = DOC_TYPES.filter((x) => x.key === key)[0];
  return t ? t.name : key;
}

function fail(err, fallback) {
  const e = new Error((err && err.message) || fallback || '数据加载失败');
  e.code = err && err.code;
  return e;
}

// PostgREST 的 or() 里 , ( ) . 都是语法分隔符，搜索词需剔除
function safeKw(kw) {
  return String(kw || '').trim().replace(/[,().*%_\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function likePattern(kw) {
  return '%' + safeKw(kw) + '%';
}

async function countRows(table, build) {
  let q = cloud.database.from(table).select('*', { count: 'exact', head: true });
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) throw fail(error, '统计数据加载失败');
  return count || 0;
}

// 给含 customer_id 的行补上客户名称（两端无外键约束，用批量回查替代 join）
async function attachCustomerNames(rows) {
  const list = rows || [];
  const ids = [];
  list.forEach((r) => {
    if (r.customer_id && ids.indexOf(r.customer_id) < 0) ids.push(r.customer_id);
  });
  if (!ids.length) return list;
  const { data } = await cloud.database.from('customers').select('id,company_name').in('id', ids);
  const map = {};
  (data || []).forEach((c) => { map[c.id] = c.company_name; });
  list.forEach((r) => { r.company_name = map[r.customer_id] || ''; });
  return list;
}

// ---------- 工作台 ----------
async function getOverview() {
  const ms = fmt.monthStart();

  const [totalCustomers, newCustomersMonth, monthDocsRes, upcomingRes, recentDocsRes, stockRes] = await Promise.all([
    countRows('customers'),
    countRows('customers', (q) => q.gte('created_at', ms)),
    cloud.database.from('documents').select('doc_no,doc_type,status,total_amount,currency,created_at').gte('created_at', ms).limit(500),
    cloud.database.from('activities')
      .select('id,customer_id,type,subject,next_follow_date,next_follow_notes,priority,contact_person')
      .neq('next_follow_date', '')
      .lte('next_follow_date', fmt.daysAfter(1))
      .eq('archived', 0)
      .order('next_follow_date', { ascending: true })
      .limit(30),
    cloud.database.from('documents')
      .select('id,doc_no,doc_type,status,total_amount,currency,issue_date,created_at,customer_id')
      .order('id', { ascending: false })
      .limit(8),
    cloud.database.from('products').select('stock,stock_alert').limit(1000),
  ]);

  if (monthDocsRes.error) throw fail(monthDocsRes.error, '单据统计加载失败');
  if (upcomingRes.error) throw fail(upcomingRes.error, '待跟进加载失败');
  if (recentDocsRes.error) throw fail(recentDocsRes.error, '最近单据加载失败');

  const monthDocs = monthDocsRes.data || [];
  let docMonthAmount = 0;
  monthDocs.forEach((d) => {
    if (d.status !== '已作废') docMonthAmount += Number(d.total_amount) || 0;
  });

  const today = fmt.today();
  let upcoming = upcomingRes.data || [];
  upcoming.forEach((a) => { a.overdue = !!a.next_follow_date && a.next_follow_date < today; });
  upcoming = await attachCustomerNames(upcoming);

  const recentDocs = await attachCustomerNames(recentDocsRes.data || []);

  // 低库存预警需按 stock <= stock_alert 比较，PostgREST 不支持列间比较，取回后本地算
  let lowStock = 0;
  (stockRes.data || []).forEach((p) => {
    const alert = Number(p.stock_alert) || 0;
    if (alert > 0 && (Number(p.stock) || 0) <= alert) lowStock += 1;
  });

  return {
    today,
    stats: {
      totalCustomers,
      newCustomersMonth,
      docMonth: monthDocs.length,
      docMonthAmount,
      lowStock,
      productCount: (stockRes.data || []).length,
    },
    upcoming,
    recentDocs,
  };
}

// ---------- 客户 ----------
async function listCustomers(opts) {
  const o = opts || {};
  const kw = o.kw || '';
  const status = o.status || '';
  const page = o.page || 1;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = cloud.database.from('customers').select('*', { count: 'exact' });
  const k = safeKw(kw);
  if (k) {
    const p = likePattern(k);
    q = q.or('company_name.ilike.' + p + ',name_en.ilike.' + p + ',country.ilike.' + p + ',contact_person.ilike.' + p + ',phone.ilike.' + p);
  }
  if (status) q = q.eq('status', status);
  const { data, error, count } = await q.order('id', { ascending: false }).range(from, to);
  if (error) throw fail(error, '客户列表加载失败');
  return { list: data || [], total: count || 0, page, pageSize: PAGE_SIZE };
}

async function getCustomer(id) {
  const { data: customer, error } = await cloud.database
    .from('customers').select('*').eq('id', id).maybeSingle();
  if (error) throw fail(error, '客户加载失败');
  if (!customer) throw new Error('客户不存在或无权访问');

  const [{ data: contacts }, { data: activities, error: actErr }] = await Promise.all([
    cloud.database.from('contacts').select('*').eq('customer_id', id).order('is_primary', { ascending: false }).order('id', { ascending: true }),
    cloud.database.from('activities').select('*').eq('customer_id', id).order('activity_date', { ascending: false }).order('id', { ascending: false }).limit(20),
  ]);
  if (actErr) throw fail(actErr, '跟进记录加载失败');

  return { customer, contacts: contacts || [], activities: activities || [] };
}

// ---------- 产品 ----------
async function listProducts(opts) {
  const o = opts || {};
  const kw = o.kw || '';
  const page = o.page || 1;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = cloud.database.from('products').select('*', { count: 'exact' });
  const k = safeKw(kw);
  if (k) {
    const p = likePattern(k);
    q = q.or('name.ilike.' + p + ',name_en.ilike.' + p + ',model.ilike.' + p + ',hs_code.ilike.' + p);
  }
  const { data, error, count } = await q.order('id', { ascending: false }).range(from, to);
  if (error) throw fail(error, '产品列表加载失败');
  const list = await images.attachCovers(data || []);
  return { list, total: count || 0, page, pageSize: PAGE_SIZE };
}

// ---------- 产品（管理） ----------
const PRODUCT_NUM_FIELDS = ['price', 'cost_price', 'stock', 'stock_alert', 'pcs_per_ctn', 'volume', 'weight', 'ctn_count'];

function num(v) {
  const n = Number(String(v === null || v === undefined ? '' : v).trim());
  return isFinite(n) ? n : 0;
}

// 表单值 -> 云端行：数值字段转数字，空串保持空串
function normalizeProduct(form, includeOwner) {
  const row = {};
  PRODUCT_FIELDS.forEach((k) => {
    let v = form[k];
    if (v === undefined || v === null) v = '';
    if (PRODUCT_NUM_FIELDS.indexOf(k) >= 0) v = num(v);
    else v = String(v).trim();
    row[k] = v;
  });
  // 图片存云端对象路径的 JSON 数组
  row.images = JSON.stringify(images.parseImages(form.images));
  row.updated_at = fmt.nowStr();
  if (includeOwner) row.created_at = fmt.nowStr();
  return row;
}

async function createProduct(form) {
  const row = normalizeProduct(form, true);
  row.is_shared = !!form.is_shared;
  const { data, error } = await cloud.database.from('products').insert(row).select().single();
  if (error) throw fail(error, '产品创建失败');
  return data;
}

async function updateProduct(id, form) {
  const row = normalizeProduct(form, false);
  const { data, error } = await cloud.database.from('products').update(row).eq('id', id).select().single();
  if (error) throw fail(error, '产品保存失败');
  return data;
}

async function deleteProduct(id) {
  const { error } = await cloud.database.from('products').delete().eq('id', id);
  if (error) throw fail(error, '产品删除失败');
  return true;
}

async function getProduct(id) {
  const { data, error } = await cloud.database.from('products').select('*').eq('id', id).maybeSingle();
  if (error) throw fail(error, '产品加载失败');
  if (!data) throw new Error('产品不存在或无权访问');
  return data;
}

// ---------- 库存 ----------
// 一次取回库存视图所需字段（产品量级在千级以内，预警需在客户端按 stock/stock_alert 比较）
async function listStockProducts() {
  const { data, error } = await cloud.database
    .from('products')
    .select('id,name,name_en,model,unit,price,currency,stock,stock_alert,cost_price')
    .order('name', { ascending: true })
    .limit(1000);
  if (error) throw fail(error, '库存数据加载失败');
  const rows = (data || []).map((p) => {
    const stock = num(p.stock);
    const alert = num(p.stock_alert);
    const currency = String(p.currency || 'USD').toUpperCase();
    return Object.assign({}, p, {
      currency,
      stock,
      stock_alert: alert,
      stockText: fmt.qty(stock),
      priceText: fmt.amount(p.price),
      hasAlert: alert > 0,
      low: alert > 0 && stock <= alert,
      zero: stock <= 0,
      value: stock * num(p.price),
    });
  });
  return rows;
}

// 库存按币种分别统计：USD 与 CNY 混加没有意义
function summarizeStock(rows) {
  const byCurrency = {};
  let low = 0;
  let zero = 0;
  let noAlert = 0;
  let qty = 0;
  (rows || []).forEach((r) => {
    if (r.low) low += 1;
    if (r.zero) zero += 1;
    else qty += r.stock;
    if (!r.hasAlert) noAlert += 1;
    const c = r.currency || 'USD';
    byCurrency[c] = (byCurrency[c] || 0) + r.value;
  });
  const values = Object.keys(byCurrency)
    .map((c) => ({ currency: c, value: byCurrency[c], valueText: fmt.amount(byCurrency[c]) }))
    .sort((a, b) => b.value - a.value);
  return { total: (rows || []).length, low, zero, noAlert, qty, qtyText: fmt.qty(qty), values };
}

// 库存变动：更新产品库存 + 写一条流水（与电脑版 stock_movements 同结构）
// type: in 入库 / out 出库 / set 盘点
async function adjustStock(opts) {
  const o = opts || {};
  const product = o.product || {};
  const id = Number(o.productId || product.id);
  const type = o.type || 'in';
  const before = num(product.stock);
  let qty = num(o.qty);
  let after = before;

  if (type === 'in') {
    qty = Math.abs(qty);
    after = before + qty;
  } else if (type === 'out') {
    qty = Math.abs(qty);
    after = before - qty;
  } else {
    after = qty;
    qty = after - before;
  }
  if (qty === 0) throw new Error('变动数量为 0，未产生库存变动');

  const { data: updated, error: upErr } = await cloud.database
    .from('products').update({ stock: after, updated_at: fmt.nowStr() }).eq('id', id).select('id,stock').single();
  if (upErr) throw fail(upErr, '库存更新失败（可能无权修改该产品）');

  const move = {
    product_id: id,
    product_name: product.name || '',
    doc_id: 0,
    doc_no: '',
    doc_type: '',
    party: '',
    change: qty,
    balance_after: after,
    remark: o.remark || '',
    created_by: o.operator || '小程序',
    created_at: fmt.nowStr(),
  };
  const { error: mvErr } = await cloud.database.from('stock_movements').insert(move);
  // 流水写入失败不影响库存结果，但要让用户知道
  if (mvErr) throw fail(mvErr, '库存已更新，但流水记录写入失败');

  return { before, after, change: qty };
}

async function listStockMovements(opts) {
  const o = opts || {};
  const page = o.page || 1;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = cloud.database.from('stock_movements').select('*', { count: 'exact' });
  if (o.productId) q = q.eq('product_id', Number(o.productId));
  const { data, error, count } = await q.order('id', { ascending: false }).range(from, to);
  if (error) throw fail(error, '库存流水加载失败');
  const list = (data || []).map((m) => {
    const c = num(m.change);
    return Object.assign({}, m, {
      changeText: (c > 0 ? '+' : '') + fmt.qty(c),
      inOut: c > 0 ? 'in' : 'out',
      balanceText: fmt.qty(m.balance_after),
      timeText: m.created_at ? String(m.created_at).slice(0, 16) : '',
    });
  });
  return { list, total: count || 0, page, pageSize: PAGE_SIZE };
}

// ---------- 单据 ----------
async function listDocuments(opts) {
  const o = opts || {};
  const kw = o.kw || '';
  const type = o.type || '';
  const page = o.page || 1;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = cloud.database.from('documents').select('*', { count: 'exact' });
  const k = safeKw(kw);
  if (k) {
    const p = likePattern(k);
    q = q.or('doc_no.ilike.' + p + ',title.ilike.' + p);
  }
  if (type) q = q.eq('doc_type', type);
  const { data, error, count } = await q.order('id', { ascending: false }).range(from, to);
  if (error) throw fail(error, '单据列表加载失败');
  const list = await attachCustomerNames(data || []);
  return { list, total: count || 0, page, pageSize: PAGE_SIZE };
}

async function getDocument(id) {
  const { data: doc, error } = await cloud.database
    .from('documents').select('*').eq('id', id).maybeSingle();
  if (error) throw fail(error, '单据加载失败');
  if (!doc) throw new Error('单据不存在或无权访问');

  let items = [];
  try { items = doc.items ? JSON.parse(doc.items) : []; } catch (e) { items = []; }
  if (!Array.isArray(items)) items = [];

  await attachCustomerNames([doc]);
  return { document: doc, items };
}

module.exports = {
  PAGE_SIZE,
  CUSTOMER_STATUS,
  CURRENCIES,
  PRODUCT_FIELDS,
  STOCK_MOVE_TYPES,
  DOC_TYPES,
  docTypeName,
  getOverview,
  listCustomers,
  getCustomer,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  listStockProducts,
  summarizeStock,
  adjustStock,
  listStockMovements,
  listDocuments,
  getDocument,
};
