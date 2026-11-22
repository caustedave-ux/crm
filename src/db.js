'use strict';
// ============ SQLite 数据库：建表 + 基础数据初始化 ============
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { DEFAULT_TEMPLATES, DOC_TYPES, DOC_TYPE_MAP } = require('./defaultTemplates');
const { todayStr, nowStr, addDays } = require('./util');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.CRM_DB || path.join(DATA_DIR, 'crm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

function run(sql, ...p) { return db.prepare(sql).run(...p); }
function get(sql, ...p) { return db.prepare(sql).get(...p); }
function all(sql, ...p) { return db.prepare(sql).all(...p); }

// ---------- 建表 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'staff',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS supplier_products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_en TEXT,
  model TEXT,
  unit TEXT,
  price REAL DEFAULT 0,
  currency TEXT DEFAULT 'CNY',
  image TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sp_supplier ON supplier_products(supplier_id);
CREATE TABLE IF NOT EXISTS todos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  created_at TEXT,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS document_payments(
  doc_id INTEGER PRIMARY KEY,
  deposit REAL DEFAULT 0,
  paid REAL DEFAULT 0,
  remark TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS payment_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  amount REAL DEFAULT 0,
  paid_at TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS document_shipments(
  doc_id INTEGER PRIMARY KEY,
  warehouse_address TEXT,
  contact TEXT,
  marks TEXT,
  ship_date TEXT,
  receive_image TEXT,
  inspect_image TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS suppliers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_en TEXT,
  country TEXT,
  contact_name TEXT,
  contact_position TEXT,
  phone TEXT,
  fax TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  main_products TEXT,
  payment_terms TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  company_name TEXT NOT NULL,
  name_en TEXT,
  country TEXT,
  address TEXT,
  website TEXT,
  source TEXT,
  industry TEXT,
  status TEXT DEFAULT '潜在客户',
  level TEXT DEFAULT '普通',
  customer_tier TEXT DEFAULT '',
  tier_override TEXT DEFAULT '',
  tier_source TEXT DEFAULT 'auto',
  tier_score REAL DEFAULT 0,
  tier_reason TEXT DEFAULT '',
  tier_updated_at TEXT,
  do_not_contact INTEGER DEFAULT 0,
  tax_no TEXT,
  image TEXT,
  phone TEXT,
  fax TEXT,
  email TEXT,
  whatsapp TEXT,
  wechat TEXT,
  contact_person TEXT,
  contact_phone TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS contacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  position TEXT,
  department TEXT,
  phone TEXT,
  mobile TEXT,
  email TEXT,
  is_primary INTEGER DEFAULT 0,
  image TEXT,
  notes TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS activities(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  type TEXT,
  subject TEXT,
  content TEXT,
  contact_person TEXT,
  activity_date TEXT,
  next_follow_date TEXT,
  next_follow_notes TEXT,
  images TEXT,
  created_by TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS website_inquiries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  company TEXT DEFAULT '',
  email TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  country TEXT DEFAULT '',
  preferred_channel TEXT DEFAULT '',
  project_type TEXT DEFAULT '',
  product TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  quantity TEXT DEFAULT '',
  finish TEXT DEFAULT '',
  message TEXT DEFAULT '',
  page_url TEXT DEFAULT '',
  locale TEXT DEFAULT '',
  utm_source TEXT DEFAULT '',
  utm_medium TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  utm_content TEXT DEFAULT '',
  utm_term TEXT DEFAULT '',
  payload_json TEXT DEFAULT '',
  customer_id INTEGER,
  contact_id INTEGER,
  activity_id INTEGER,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_website_inquiries_created ON website_inquiries(created_at);
CREATE INDEX IF NOT EXISTS idx_website_inquiries_customer ON website_inquiries(customer_id);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_en TEXT,
  model TEXT,
  hs_code TEXT,
  unit TEXT,
  price REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  origin TEXT,
  supplier_id INTEGER,
  image TEXT,
  stock REAL DEFAULT 0,
  stock_alert REAL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  pcs_per_ctn REAL DEFAULT 0,
  ctn_count REAL DEFAULT 0,
  volume REAL DEFAULT 0,
  weight REAL DEFAULT 0,
  notes TEXT,
  positioning TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS product_categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS product_attachments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  kind TEXT DEFAULT '图片',
  title TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS doc_templates(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,
  name TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  description TEXT,
  content TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  doc_no TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  template_id INTEGER,
  customer_id INTEGER NOT NULL,
  contact_id INTEGER,
  supplier_id INTEGER,
  title TEXT,
  issue_date TEXT,
  valid_until TEXT,
  delivery_date TEXT,
  currency TEXT DEFAULT 'USD',
  payment_terms TEXT,
  trade_terms TEXT,
  port_loading TEXT,
  port_destination TEXT,
  shipping_marks TEXT,
  remarks TEXT,
  status TEXT DEFAULT '草稿',
  stock_applied INTEGER DEFAULT 0,
  stock_in_applied INTEGER DEFAULT 0,
  stock_restored INTEGER DEFAULT 0,
  subtotal REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  items TEXT,
  content_html TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id);
CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities(customer_id);
CREATE TABLE IF NOT EXISTS quote_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  contact_person TEXT DEFAULT '',
  product_id INTEGER,
  product_name TEXT DEFAULT '',
  product_name_en TEXT DEFAULT '',
  model TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  quantity REAL DEFAULT 0,
  unit_price REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  amount REAL DEFAULT 0,
  quote_date TEXT,
  valid_until TEXT,
  status TEXT DEFAULT '已报价',
  priority TEXT DEFAULT '中',
  notes TEXT DEFAULT '',
  items TEXT DEFAULT '',
  followup_notes TEXT DEFAULT '',
  activity_id INTEGER,
  user_id INTEGER,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_quote_history_customer ON quote_history(customer_id);
CREATE INDEX IF NOT EXISTS idx_quote_history_product ON quote_history(product_id);
CREATE INDEX IF NOT EXISTS idx_quote_history_date ON quote_history(quote_date);
CREATE TABLE IF NOT EXISTS stock_movements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  product_name TEXT,
  doc_id INTEGER,
  doc_no TEXT,
  doc_type TEXT,
  party TEXT,
  change REAL,
  balance_after REAL,
  remark TEXT,
  created_by TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS wa_imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  chat_key TEXT NOT NULL DEFAULT 'wa:unknown',
  day TEXT NOT NULL,
  activity_id INTEGER,
  msg_count INTEGER DEFAULT 0,
  content_hash TEXT DEFAULT '',
  source TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(customer_id, chat_key, day)
);
CREATE INDEX IF NOT EXISTS idx_wa_imports_customer ON wa_imports(customer_id);
CREATE TABLE IF NOT EXISTS wa_accounts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  jid TEXT DEFAULT '',
  status TEXT DEFAULT 'offline',
  last_error TEXT DEFAULT '',
  last_seen TEXT,
  auto_translate INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(user_id)
);
CREATE TABLE IF NOT EXISTS wa_chats(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  jid TEXT NOT NULL,
  phone TEXT DEFAULT '',
  name TEXT DEFAULT '',
  is_group INTEGER DEFAULT 0,
  customer_id INTEGER,
  last_msg_at TEXT,
  last_msg_text TEXT,
  unread INTEGER DEFAULT 0,
  sync_followup INTEGER DEFAULT 1,
  last_inbound_at TEXT,
  manual_category TEXT DEFAULT '',
  manual_category_at TEXT,
  remark TEXT DEFAULT '',
  remark_updated_at TEXT,
  avatar_path TEXT DEFAULT '',
  avatar_updated_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(account_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_account ON wa_chats(account_id, last_msg_at);
CREATE TABLE IF NOT EXISTS wa_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  chat_jid TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  from_me INTEGER DEFAULT 0,
  kind TEXT DEFAULT 'text',
  text TEXT DEFAULT '',
  translated TEXT DEFAULT '',
  media_path TEXT DEFAULT '',
  media_name TEXT DEFAULT '',
  media_mime TEXT DEFAULT '',
  sender_name TEXT DEFAULT '',
  sender_jid TEXT DEFAULT '',
  quoted_msg_id TEXT DEFAULT '',
  quoted_preview TEXT DEFAULT '',
  receipt_status INTEGER DEFAULT 0,
  delivered_at TEXT DEFAULT '',
  read_at TEXT DEFAULT '',
  receipt_updated_at TEXT DEFAULT '',
  ts TEXT,
  created_at TEXT,
  UNIQUE(account_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON wa_messages(account_id, chat_jid, ts);
CREATE TABLE IF NOT EXISTS wa_quick_replies(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  usage_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_quick_replies_user ON wa_quick_replies(user_id, usage_count);
CREATE TABLE IF NOT EXISTS wa_ad_sources(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  campaign_name TEXT DEFAULT '',
  ad_set_name TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(user_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_ad_sources_user ON wa_ad_sources(user_id, source_id);
CREATE TABLE IF NOT EXISTS logistics_shipments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  direction TEXT NOT NULL DEFAULT 'out',
  waybill_no TEXT DEFAULT '',
  carrier TEXT DEFAULT '',
  status TEXT DEFAULT '已下单',
  sender_name TEXT DEFAULT '',
  receiver_name TEXT DEFAULT '',
  reference_no TEXT DEFAULT '',
  ship_date TEXT,
  eta TEXT,
  cost REAL DEFAULT 0,
  currency TEXT DEFAULT 'CNY',
  check_days INTEGER DEFAULT 2,
  next_check_at TEXT,
  images TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lgs_dir ON logistics_shipments(direction, status);
CREATE TABLE IF NOT EXISTS logistics_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  customer_id INTEGER,
  supplier_id INTEGER,
  customer_text TEXT DEFAULT '',
  supplier_text TEXT DEFAULT '',
  doc_id INTEGER,
  order_no TEXT DEFAULT '',
  marks TEXT DEFAULT '',
  description TEXT DEFAULT '',
  qty REAL DEFAULT 0,
  unit TEXT DEFAULT 'PCS',
  ctn REAL DEFAULT 0,
  weight REAL DEFAULT 0,
  volume REAL DEFAULT 0,
  notes TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_lgs_items ON logistics_items(shipment_id);
CREATE TABLE IF NOT EXISTS logistics_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  at TEXT,
  status TEXT DEFAULT '',
  location TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lgs_events ON logistics_events(shipment_id, at);
CREATE TABLE IF NOT EXISTS stock_reminders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER,
  doc_no TEXT,
  doc_type TEXT,
  party TEXT,
  product_id INTEGER,
  product_name TEXT,
  need_qty REAL,
  have_qty REAL,
  shortage REAL,
  status TEXT DEFAULT '待处理',
  created_at TEXT,
  handled_at TEXT
);
CREATE TABLE IF NOT EXISTS tier_actions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  tier TEXT NOT NULL,
  action_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  activity_id INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TEXT,
  completed_at TEXT,
  UNIQUE(customer_id, action_type, period_key)
);
CREATE INDEX IF NOT EXISTS idx_tier_actions_user ON tier_actions(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_tier_actions_activity ON tier_actions(activity_id);
CREATE TABLE IF NOT EXISTS tier_campaigns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tier TEXT DEFAULT 'C',
  message TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  details TEXT DEFAULT '',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tier_campaigns_user ON tier_campaigns(user_id, created_at);
CREATE TABLE IF NOT EXISTS briefing_sources(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'rss',
  url TEXT DEFAULT '',
  content TEXT DEFAULT '',
  category TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  last_fetch_at TEXT,
  last_error TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefing_sources_user ON briefing_sources(user_id, active);
CREATE TABLE IF NOT EXISTS briefings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  language TEXT DEFAULT 'en',
  status TEXT DEFAULT 'draft',
  content TEXT NOT NULL,
  content_zh TEXT DEFAULT '',
  sources TEXT DEFAULT '[]',
  article_count INTEGER DEFAULT 0,
  tier_action_id INTEGER,
  channel TEXT DEFAULT '',
  error TEXT DEFAULT '',
  generated_at TEXT,
  reviewed_at TEXT,
  sent_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(user_id, customer_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_briefings_user_period ON briefings(user_id, period_key, status);
CREATE INDEX IF NOT EXISTS idx_briefings_customer ON briefings(customer_id, period_key);
CREATE TABLE IF NOT EXISTS knowledge_articles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '历史经验',
  tags TEXT DEFAULT '',
  content TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_category ON knowledge_articles(category, updated_at DESC);
`);

// ---------- 结构迁移（兼容旧数据库） ----------
// wa_imports 早期草案没有 chat_key，直接重建（该表只存导入台账，可安全重建）
try {
  const waCols = all('PRAGMA table_info(wa_imports)');
  if (waCols.length && !waCols.some(c => c.name === 'chat_key')) {
    run('DROP TABLE wa_imports');
    run(`CREATE TABLE wa_imports(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      chat_key TEXT NOT NULL DEFAULT 'wa:unknown',
      day TEXT NOT NULL,
      activity_id INTEGER,
      msg_count INTEGER DEFAULT 0,
      content_hash TEXT DEFAULT '',
      source TEXT DEFAULT '',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(customer_id, chat_key, day)
    )`);
  }
} catch (e) {}

function ensureColumn(table, col, decl) {
  const cols = all('PRAGMA table_info(' + table + ')');
  if (!cols.some(x => x.name === col)) run('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + decl);
}
function syncProductToSupplier(productId) {
  const p = get('SELECT * FROM products WHERE id=?', productId);
  if (!p) return false;
  const supplierId = parseInt(p.supplier_id, 10) || null;
  if (!supplierId) return false;
  const sup = get('SELECT id FROM suppliers WHERE id=?', supplierId);
  if (!sup) return false;
  const t = nowStr();
  const name = String(p.name || '').trim();
  const nameEn = String(p.name_en || '').trim();
  const model = String(p.model || '').trim();
  const unit = p.unit || 'PCS';
  const image = p.image || '';
  const existing = get('SELECT * FROM supplier_products WHERE product_id=? AND supplier_id=? ORDER BY id LIMIT 1', p.id, supplierId);
  const color = String(p.color || '').trim();
  if (existing) {
    run('UPDATE supplier_products SET name=?, name_en=?, model=?, unit=?, color=?, product_id=?, image=CASE WHEN ?<>? THEN ? ELSE image END, updated_at=? WHERE id=?',
      name, nameEn, model, unit, color, p.id, image, '', image, t, existing.id);
    return true;
  }
  const other = get('SELECT * FROM supplier_products WHERE product_id=? ORDER BY id LIMIT 1', p.id);
  if (other) {
    const keepImage = image || other.image || '';
    run('UPDATE supplier_products SET supplier_id=?, name=?, name_en=?, model=?, unit=?, color=?, product_id=?, image=?, updated_at=? WHERE id=?',
      supplierId, name, nameEn, model, unit, color, p.id, keepImage, t, other.id);
    return true;
  }
  const price = Number(p.cost_price) || Number(p.price) || 0;
  const currency = p.currency || 'CNY';
  run('INSERT INTO supplier_products(supplier_id,name,name_en,model,unit,color,price,currency,product_id,image,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    supplierId, name, nameEn, model, unit, color, price, currency, p.id, image, '系统自动关联产品管理', t, t);
  return true;
}

function migrate() {
  ensureColumn('customers', 'phone', "TEXT DEFAULT ''");
  ensureColumn('customers', 'fax', "TEXT DEFAULT ''");
  ensureColumn('customers', 'email', "TEXT DEFAULT ''");
  ensureColumn('customers', 'whatsapp', "TEXT DEFAULT ''");
  ensureColumn('customers', 'wechat', "TEXT DEFAULT ''");
  ensureColumn('customers', 'user_id', "INTEGER");
  ensureColumn('documents', 'user_id', "INTEGER");
  ensureColumn('quote_history', 'user_id', "INTEGER");
  ensureColumn('quote_history', 'items', "TEXT DEFAULT ''");
  try {
    const oldQuotes = all("SELECT * FROM quote_history WHERE (items IS NULL OR items='') AND product_name<>''");
    for (const q of oldQuotes) {
      const one = [{ product_id:q.product_id||null, product_name:q.product_name||'', product_name_en:q.product_name_en||'', model:q.model||'', unit:q.unit||'PCS', quantity:Number(q.quantity)||0, unit_price:Number(q.unit_price)||0, currency:q.currency||'USD', amount:Number(q.amount)||0, image:'' }];
      run('UPDATE quote_history SET items=? WHERE id=?', JSON.stringify(one), q.id);
    }
  } catch(e) {}
  run("UPDATE customers SET user_id=(SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1) WHERE user_id IS NULL");
  run("UPDATE documents SET user_id=(SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1) WHERE user_id IS NULL");
  ensureColumn('products', 'supplier_id', "INTEGER");
  ensureColumn('products', 'image', "TEXT DEFAULT ''");
  ensureColumn('customers', 'image', "TEXT DEFAULT ''");
  ensureColumn('customers', 'contact_person', "TEXT DEFAULT ''");
  ensureColumn('customers', 'contact_phone', "TEXT DEFAULT ''");
  ensureColumn('contacts', 'image', "TEXT DEFAULT ''");
  ensureColumn('products', 'stock', "REAL DEFAULT 0");
  ensureColumn('products', 'stock_alert', "REAL DEFAULT 0");
  ensureColumn('products', 'cost_price', "REAL DEFAULT 0");
  ensureColumn('products', 'pcs_per_ctn', "REAL DEFAULT 0");
  ensureColumn('products', 'ctn_count', "REAL DEFAULT 0");
  run("UPDATE products SET ctn_count=ROUND(stock / pcs_per_ctn, 2) WHERE (ctn_count IS NULL OR ctn_count=0) AND pcs_per_ctn>0 AND stock<>0");
  ensureColumn('products', 'volume', "REAL DEFAULT 0");
  ensureColumn('products', 'weight', "REAL DEFAULT 0");
  ensureColumn('documents', 'stock_applied', "INTEGER DEFAULT 0");
  ensureColumn('documents', 'supplier_id', "INTEGER");
  ensureColumn('documents', 'stock_in_applied', "INTEGER DEFAULT 0");
  ensureColumn('activities', 'images', "TEXT DEFAULT ''");
  // WhatsApp 收件箱：会话级自动跟进、未读时间和消息媒体元数据
  ensureColumn('wa_chats', 'sync_followup', "INTEGER DEFAULT 1");
  ensureColumn('wa_chats', 'last_inbound_at', "TEXT");
  ensureColumn('wa_chats', 'manual_category', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'manual_category_at', "TEXT");
  // WhatsApp 会话备注：只属于当前聊天，不覆盖客户档案和跟进记录。
  ensureColumn('wa_chats', 'remark', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'remark_updated_at', "TEXT");
  // 会话置顶：记录置顶时间，空字符串表示未置顶
  ensureColumn('wa_chats', 'pinned_at', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'avatar_path', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'avatar_updated_at', "TEXT");
  ensureColumn('wa_chats', 'ad_source_id', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_source_type', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_source_url', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_title', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_body', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_media_type', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_thumbnail_url', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_ctwa_clid', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_ref', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_data', "TEXT DEFAULT ''");
  ensureColumn('wa_chats', 'ad_first_seen_at', "TEXT");
  ensureColumn('wa_chats', 'ad_last_seen_at', "TEXT");
  ensureColumn('wa_messages', 'ad_source_id', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_source_type', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_source_url', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_title', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_body', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_media_type', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_thumbnail_url', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_ctwa_clid', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_ref', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'ad_data', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'media_name', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'media_mime', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'sender_jid', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'quoted_msg_id', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'quoted_preview', "TEXT DEFAULT ''");
  // 我方发出消息的客户回执：3=已送达，4=客户已读；read_at 保存客户实际读取时间
  ensureColumn('wa_messages', 'receipt_status', "INTEGER DEFAULT 0");
  ensureColumn('wa_messages', 'delivered_at', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'read_at', "TEXT DEFAULT ''");
  ensureColumn('wa_messages', 'receipt_updated_at', "TEXT DEFAULT ''");
  // WhatsApp 导入台账：AI 摘要（按天一条，单独存，不改正文）
  ensureColumn('wa_imports', 'summary', "TEXT DEFAULT ''");
  // 物流跟踪：运单图片（物流单/面单拍照）
  ensureColumn('logistics_shipments', 'images', "TEXT DEFAULT ''");
  // 物流跟踪：分票里的客户/供应商允许手填（不在系统里的名字）
  ensureColumn('logistics_items', 'customer_text', "TEXT DEFAULT ''");
  ensureColumn('logistics_items', 'supplier_text', "TEXT DEFAULT ''");
  ensureColumn('documents', 'stock_restored', "INTEGER DEFAULT 0");
  ensureColumn('documents', 'stock_backorder', "TEXT DEFAULT ''");
  ensureColumn('stock_movements', 'is_backorder', "INTEGER DEFAULT 0");
  ensureColumn('activities', 'archived', "INTEGER DEFAULT 0");
  ensureColumn('activities', 'user_id', "INTEGER");
  ensureColumn('activities', 'priority', "TEXT DEFAULT '中'");
  ensureColumn('activities', 'outcome', "TEXT DEFAULT ''");
  ensureColumn('activities', 'completed_at', "TEXT");
  run('CREATE INDEX IF NOT EXISTS idx_activities_due ON activities(user_id, archived, next_follow_date)');
  run("UPDATE activities SET priority='中' WHERE priority IS NULL OR priority=''");
  run("UPDATE activities SET completed_at=COALESCE(completed_at,activity_date,created_at) WHERE archived=1 AND (completed_at IS NULL OR completed_at='')");
  ensureColumn('customers', 'in_pool', "INTEGER DEFAULT 0");
  ensureColumn('customers', 'pool_at', "TEXT");
  ensureColumn('customers', 'pool_reason', "TEXT");
  ensureColumn('customers', 'claimed_by', "INTEGER");
  // 客户 A/B/C/D 分层：自动贡献值分档 + 人工覆盖，不改动旧 level 字段，保证历史数据兼容。
  ensureColumn('customers', 'customer_tier', "TEXT DEFAULT ''");
  ensureColumn('customers', 'tier_override', "TEXT DEFAULT ''");
  ensureColumn('customers', 'tier_source', "TEXT DEFAULT 'auto'");
  ensureColumn('customers', 'tier_score', "REAL DEFAULT 0");
  ensureColumn('customers', 'tier_reason', "TEXT DEFAULT ''");
  ensureColumn('customers', 'tier_updated_at', "TEXT");
  ensureColumn('customers', 'do_not_contact', "INTEGER DEFAULT 0");
  ensureColumn('customers', 'ad_source_id', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_source_type', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_source_url', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_title', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_body', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_media_type', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_thumbnail_url', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_ctwa_clid', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_ref', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_data', "TEXT DEFAULT ''");
  ensureColumn('customers', 'ad_first_seen_at', "TEXT");
  ensureColumn('customers', 'ad_last_seen_at', "TEXT");
  ensureColumn('supplier_products', 'product_id', "INTEGER");
  // 颜色模块：产品与供应产品均增加颜色字段（原产品 HS 编码在业务上改为颜色）
  ensureColumn('products', 'color', "TEXT DEFAULT ''");
  ensureColumn('supplier_products', 'color', "TEXT DEFAULT ''");
  // 产品管理 × 知识库合并（2026-11-22）：products 为唯一事实源，知识库文章挂 product_id
  ensureColumn('products', 'category_id', "INTEGER");
  ensureColumn('products', 'material', "TEXT DEFAULT ''");
  ensureColumn('products', 'finish', "TEXT DEFAULT ''");
  ensureColumn('products', 'moq', "REAL DEFAULT 0");
  ensureColumn('products', 'moq_unit', "TEXT DEFAULT 'PCS'");
  ensureColumn('products', 'lead_time_days', "INTEGER DEFAULT 0");
  ensureColumn('products', 'sample_lead_time_days', "INTEGER DEFAULT 0");
  ensureColumn('products', 'status', "TEXT DEFAULT '在售'");
  ensureColumn('products', 'specs', "TEXT DEFAULT '{}'");
  ensureColumn('products', 'description', "TEXT DEFAULT ''");
  // 产品定位分类（2026-11-23）：''=未分类、'高端款'、'高流通款'；自动回复挑款按此字段选，未分类不参与自动挑款
  ensureColumn('products', 'positioning', "TEXT DEFAULT ''");
  ensureColumn('knowledge_articles', 'product_id', "INTEGER");
  run('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)');
  run('CREATE INDEX IF NOT EXISTS idx_knowledge_articles_product ON knowledge_articles(product_id)');
  run('CREATE INDEX IF NOT EXISTS idx_product_attachments_product ON product_attachments(product_id)');
  // 初始产品分类（门锁五金）：逐个补齐缺失项，老库升级也会补上智能锁、门吸；用户可在产品管理里按需添加
  try {
    const t = nowStr();
    const want = ['锁体', '把手', '锁芯', '合页', '智能锁', '门吸', '其他'];
    want.forEach((name, i) => {
      const exists = get('SELECT id FROM product_categories WHERE name=? AND parent_id IS NULL', name);
      if (exists) {
        run('UPDATE product_categories SET sort_order=? WHERE id=?', i + 1, exists.id);
      } else {
        run('INSERT INTO product_categories(name,parent_id,sort_order,created_at,updated_at) VALUES(?,?,?, ?,?)', name, null, i + 1, t, t);
      }
    });
  } catch (e) {}
  // 删除针织服装示例文章：只删标题明确是服装的“产品资料”，且标题不含“锁”字；门锁五金文章不受影响
  try {
    const garment = all(`SELECT id,title FROM knowledge_articles WHERE category='产品资料' AND title NOT LIKE '%锁%' AND (
      title LIKE '%针织%' OR title LIKE '%开衫%' OR title LIKE '%提花%' OR title LIKE '%毛衣%' OR
      title LIKE '%卫衣%' OR title LIKE '%服装%' OR title LIKE '%Jacquard%' OR title LIKE '%Cardigan%' OR
      title LIKE '%Knit%' OR title LIKE '%针织衫%' OR content LIKE '%提花开衫%')`);
    for (const g of garment) {
      run('DELETE FROM knowledge_articles WHERE id=?', g.id);
      console.log('删除服装示例文章：', g.title);
    }
  } catch (e) {}
  ensureColumn('documents', 'remark_images', "TEXT DEFAULT ''");
  // 跟进历史数据回填所属账号（按创建人名称匹配，匹配不到归第一个管理员）
  try {
    const orphan = all('SELECT id, created_by FROM activities WHERE user_id IS NULL');
    if (orphan.length) {
      const fallback = get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1") || get('SELECT id FROM users ORDER BY id LIMIT 1');
      const fallbackId = fallback ? fallback.id : null;
      for (const a of orphan) {
        let uid = null;
        if (a.created_by) uid = (get('SELECT id FROM users WHERE username=? OR display_name=? LIMIT 1', a.created_by, a.created_by) || {}).id || null;
        run('UPDATE activities SET user_id=? WHERE id=?', uid || fallbackId, a.id);
      }
    }
  } catch (e) {}

  // 货款：旧 paid 数据转成分笔收款（仅一次，已有分笔的不复制）
  try {
    const prowRows = all('SELECT * FROM document_payments');
    for (const pr of prowRows) {
      const hasRec = get('SELECT COUNT(*) c FROM payment_records WHERE doc_id=?', pr.doc_id).c;
      if (hasRec === 0 && (Number(pr.paid) || 0) > 0) {
        run('INSERT INTO payment_records(doc_id,amount,paid_at,note,created_by,created_at) VALUES(?,?,?,?,?,?)',
          pr.doc_id, Number(pr.paid) || 0, String(pr.updated_at || pr.created_at || '').slice(0, 16).replace(' ', 'T'), '历史收款（升级为分笔记录）', '系统', nowStr());
      }
    }
  } catch (e) {}

  // 旧版内置模板：去掉“客户税号”行，改为联系方式行
  const rows = all('SELECT id, content FROM doc_templates');
  const OLD = '<div>客户税号/注册号 Customer Tax No.：{{customer.tax_no}}</div>';
  const NEW = '<div>联系方式 Contact：{{customer.contact_line}}</div>';
  for (const r of rows) {
    if (r.content && r.content.indexOf(OLD) >= 0) {
      run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', r.content.split(OLD).join(NEW), nowStr(), r.id);
    }
  }
  // 内置模板明细行：产品图片随明细显示
  const tplRows = all('SELECT id, content FROM doc_templates');
  const OLD2 = '<td>{{item.name_html}}</td>';
  const NEW2 = '<td>{{item.image_html}}{{item.name_html}}</td>';
  for (const r of tplRows) {
    if (r.content && r.content.indexOf(OLD2) >= 0) {
      run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', r.content.split(OLD2).join(NEW2), nowStr(), r.id);
    }
  }
  // 演示/旧产品库存回填（仅当库存为 0 时给默认值）
  const prods0 = all('SELECT * FROM products WHERE stock IS NULL OR stock = 0');
  const stockMap = [['保温杯', 50000, 10000], ['调味瓶', 20000, 5000], ['马克杯', 80000, 12000], ['砧板', 30000, 6000], ['蜡烛', 100000, 20000]];
  for (const p of prods0) {
    const hit = stockMap.find((kv) => String(p.name || '').indexOf(kv[0]) >= 0);
    if (hit) run('UPDATE products SET stock=?, stock_alert=? WHERE id=?', hit[1], hit[2], p.id);
  }
  // PI / 销售合同：明细列升级为 CTN 版式（ITEM NO/PICTURE/COLOR/CTN/QTY/T.T QTY/PRICE/AMOUNT）
  const ctnMigrate = [
    ['pi', '标准形式发票 PI（中英双语）'],
    ['so', '标准销售合同（中英双语）'],
    ['pl', '标准装箱单 PL（中英双语）'],
  ];
  for (const [dt, dname] of ctnMigrate) {
    const t = get('SELECT * FROM doc_templates WHERE doc_type=? AND is_system=1', dt);
    const marker = dt === 'pl' ? 'item.ctn' : 'item.per_ctn';
    if (t && t.content && t.content.indexOf(marker) < 0) {
      const def = DEFAULT_TEMPLATES.find(x => x.doc_type === dt && x.name === dname);
      if (def) run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', def.content, nowStr(), t.id);
    }
  }
  // 采购单 PO：升级为纯中文模板（去英文/贸易条款/起运港/目的港，明细增加箱数、每箱、总数量）
  try {
    const poTpl = get("SELECT * FROM doc_templates WHERE doc_type='po' AND is_system=1 ORDER BY id LIMIT 1");
    if (poTpl && poTpl.content && (poTpl.content.indexOf('PURCHASE ORDER') >= 0 || poTpl.content.indexOf('{{item.ctn}}') < 0)) {
      const poDef = DEFAULT_TEMPLATES.find(x => x.doc_type === 'po');
      if (poDef) run('UPDATE doc_templates SET name=?,description=?,content=?,updated_at=? WHERE id=?', poDef.name, poDef.description, poDef.content, nowStr(), poTpl.id);
    }
  } catch (e) {}
  // DESCRIPTION 宽度自适应：所有模板表格改为按内容列宽
  const allTpl = all('SELECT id, content FROM doc_templates');
  const O_CSS = '.doc-box table.doc-items{width:100%;border-collapse:collapse;margin:6px 0;table-layout:fixed;}';
  const N_CSS = '.doc-box table.doc-items{width:auto;max-width:100%;border-collapse:collapse;margin:6px 0;table-layout:auto;}';
  for (const rt of allTpl) {
    if (rt.content && rt.content.indexOf(O_CSS) >= 0) {
      run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', rt.content.split(O_CSS).join(N_CSS), nowStr(), rt.id);
    }
  }
  // DESCRIPTION 拉宽铺满整行（模板 + 已保存单据快照同步升级：兼容旧固定版式）
  const W_FIX = '.doc-box table.doc-items{width:100%;border-collapse:collapse;margin:6px 0;table-layout:fixed;}';
  const W_O = '.doc-box table.doc-items{width:auto;max-width:100%;border-collapse:collapse;margin:6px 0;table-layout:auto;}';
  const W_N = '.doc-box table.doc-items{width:100%;max-width:100%;border-collapse:collapse;margin:6px 0;table-layout:auto;}';
  const fixWide = (html) => { if (!html) return html; let h = html; if (h.indexOf(W_FIX) >= 0) h = h.split(W_FIX).join(W_N); if (h.indexOf(W_O) >= 0) h = h.split(W_O).join(W_N); return h; };
  const wideTpls = all('SELECT id, content FROM doc_templates');
  for (const wt of wideTpls) {
    const nc = fixWide(wt.content);
    if (nc !== wt.content) run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', nc, nowStr(), wt.id);
  }
  const wideDocs = all('SELECT id, content_html FROM documents');
  for (const wd of wideDocs) {
    const nc = fixWide(wd.content_html);
    if (nc !== wd.content_html) run('UPDATE documents SET content_html=? WHERE id=?', nc, wd.id);
  }
  // PI：模板增加备注图片占位
  try {
    const piTpl3 = get("SELECT * FROM doc_templates WHERE doc_type='pi' AND is_system=1");
    if (piTpl3 && piTpl3.content && piTpl3.content.indexOf('remark_images_block') < 0) {
      const c3 = piTpl3.content.replace('<div class="terms"><b>收款信息 Bank Information：</b>', '{{doc.remark_images_block}}\n  <div class="terms"><b>收款信息 Bank Information：</b>');
      if (c3 !== piTpl3.content) run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', c3, nowStr(), piTpl3.id);
    }
  } catch (e) {}

  // PI：增加总箱数 Total CTN
  try {
    const piTpl2 = get("SELECT * FROM doc_templates WHERE doc_type='pi' AND is_system=1");
    if (piTpl2 && piTpl2.content && piTpl2.content.indexOf('总箱数') < 0 && piTpl2.content.indexOf('<table class="totals">') >= 0) {
      run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', piTpl2.content.replace('<table class="totals">', '<div class="info-line"><span>总箱数 Total CTN：<b>{{doc.total_ctn}}</b></span></div>\n<table class="totals">'), nowStr(), piTpl2.id);
    }
    const piDocs2 = all("SELECT id,items,content_html FROM documents WHERE doc_type='pi' AND content_html IS NOT NULL AND content_html<>''");
    for (const pd2 of piDocs2) {
      if (pd2.content_html.indexOf('总箱数') >= 0) continue;
      let arr2 = []; try { arr2 = JSON.parse(pd2.items || '[]'); } catch (e) { arr2 = []; }
      const ctn2 = Math.round(((Array.isArray(arr2) ? arr2 : []).reduce((s2, it2) => s2 + (Number(it2.ctn) || 0), 0)) * 1000) / 1000;
      if (pd2.content_html.indexOf('<table class="totals">') >= 0) {
        run('UPDATE documents SET content_html=? WHERE id=?', pd2.content_html.replace('<table class="totals">', '<div class="info-line"><span>总箱数 Total CTN：<b>' + ctn2 + '</b></span></div>\n<table class="totals">'), pd2.id);
      }
    }
  } catch (e) {}

  // PI：Description 只显示品名（去掉英文品名），迁移旧系统模板
  const piT = get("SELECT * FROM doc_templates WHERE doc_type='pi' AND is_system=1");
  if (piT && piT.content && piT.content.indexOf('{{item.name_html}}') >= 0) {
    const def = DEFAULT_TEMPLATES.find(x => x.doc_type === 'pi');
    if (def) run('UPDATE doc_templates SET content=?,updated_at=? WHERE id=?', def.content, nowStr(), piT.id);
  }
  // 旧客户数据：联系方式为空时，用主要联系人信息补全
  const custs = all('SELECT * FROM customers');
  for (const c of custs) {
    if (c.phone || c.email) continue;
    const p = get('SELECT * FROM contacts WHERE customer_id=? ORDER BY is_primary DESC, id ASC LIMIT 1', c.id);
    if (p) {
      const phone = p.mobile || p.phone || '';
      const email = p.email || '';
      if (phone || email) run('UPDATE customers SET phone=?, email=? WHERE id=?', phone, email, c.id);
    }
  }

  // 产品管理里的供应商信息自动同步到供应商产品报价
  try {
    const syncProducts = all('SELECT id FROM products WHERE supplier_id IS NOT NULL AND supplier_id<>0');
    for (const sp of syncProducts) syncProductToSupplier(sp.id);
  } catch (e) { console.error('产品供应商同步失败：', e.message); }

  // 单据明细图片放大为原先 3 倍（44px -> 132px）：已保存单据快照同步升级
  try {
    const IMG_OLD = 'width:44px;height:44px;object-fit:cover;';
    const IMG_NEW = 'width:132px;height:132px;object-fit:cover;';
    const imgDocs = all('SELECT id, content_html FROM documents');
    for (const imd of imgDocs) {
      if (imd.content_html && imd.content_html.indexOf(IMG_OLD) >= 0) {
        run('UPDATE documents SET content_html=? WHERE id=?', imd.content_html.split(IMG_OLD).join(IMG_NEW), imd.id);
      }
    }
  } catch (e) {}

  // 系统模板随代码版本同步升级（用户自定义模板 is_system=0 不受影响）
  try {
    for (const dt of DEFAULT_TEMPLATES) {
      const sysTpl = get('SELECT * FROM doc_templates WHERE doc_type=? AND is_system=1', dt.doc_type);
      if (sysTpl) run('UPDATE doc_templates SET name=?,description=?,content=?,updated_at=? WHERE id=?', dt.name, dt.description, dt.content, nowStr(), sysTpl.id);
    }
  } catch (e) {}
}
migrate();
// ---------- 设置 ----------
function getSetting(key, def) {
  const r = get('SELECT value FROM settings WHERE key=?', key);
  return r ? r.value : (def === undefined ? null : def);
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value === null || value === undefined ? '' : value));
}
function getCompany() {
  const rows = all("SELECT key,value FROM settings WHERE key LIKE 'company.%'");
  const o = {};
  for (const r of rows) o[r.key.replace('company.', '')] = r.value;
  return o;
}
function setCompany(obj) {
  for (const [k, v] of Object.entries(obj)) setSetting('company.' + k, v);
}

// ---------- 初始化 ----------
function ensureDefaultTemplates() {
  for (const t of DEFAULT_TEMPLATES) {
    const ex = get('SELECT id FROM doc_templates WHERE doc_type=? AND is_system=1 AND name=?', t.doc_type, t.name);
    if (!ex) {
      run('INSERT INTO doc_templates(doc_type,name,is_system,description,content,updated_at) VALUES(?,?,1,?,?,?)',
        t.doc_type, t.name, t.description, t.content, nowStr());
    }
  }
}

function seedBase() {
  const { hashPassword } = require('./auth');
  // 演示数据仅首次生成，已有真实数据后绝不再补（防止覆盖/误加）
  if (!getSetting('setup_seeded') && get('SELECT COUNT(*) c FROM customers').c > 0) setSetting('setup_seeded', '1');
  const demoOk = !getSetting('setup_seeded');
  // 账号
  if (get('SELECT COUNT(*) c FROM users').c === 0) {
    run('INSERT INTO users(username,password_hash,display_name,role,active,created_at) VALUES(?,?,?,?,1,?)', 'admin', hashPassword('admin123'), '系统管理员', 'admin', nowStr());
    run('INSERT INTO users(username,password_hash,display_name,role,active,created_at) VALUES(?,?,?,?,1,?)', 'sales', hashPassword('sales123'), '外贸业务员', 'staff', nowStr());
  }
  // 公司资料（模板使用）
  if (demoOk && !getSetting('company.name')) {
    const c = {
      name: '深圳市远洋国际贸易有限公司',
      name_en: 'Shenzhen Oceanwide Import & Export Co., Ltd.',
      address: '广东省深圳市南山区科技园南路88号创新大厦8楼',
      tel: '+86 755-8888 6666',
      fax: '+86 755-8888 6667',
      email: 'sales@example.com',
      website: 'www.example.com',
      salesman: '外贸业务员',
      bank_name: '中国银行股份有限公司深圳分行',
      bank_account: 'DEMO-ACCOUNT-0000',
      bank_swift: 'BKCHCNBJ45A',
      logo: '',
    };
    setCompany(c);
  }
  ensureDefaultTemplates();
  // 演示数据
  if (demoOk && get('SELECT COUNT(*) c FROM customers').c === 0) {
    const t = nowStr();
    const seedOwner = get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1") || get('SELECT id FROM users ORDER BY id LIMIT 1');
    const insC = (o) => { const _r = run('INSERT INTO customers(user_id,company_name,name_en,country,address,website,source,industry,status,level,phone,fax,email,whatsapp,wechat,contact_person,contact_phone,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      seedOwner ? seedOwner.id : null, o.company_name, o.name_en || '', o.country || '', o.address || '', o.website || '', o.source || '', o.industry || '', o.status || '潜在客户', o.level || '普通', o.phone || '', o.fax || '', o.email || '', o.whatsapp || '', o.wechat || '', o.contact_person || '', o.contact_phone || '', o.notes || '', t, t); return Number(_r.lastInsertRowid); };
    const c1 = insC({ company_name: 'Alpha Mart Inc.', country: '美国 United States', address: '1200 Commerce Blvd, Los Angeles, CA 90012, USA', website: 'www.example.com', contact_person: 'Tom Smith', contact_phone: '+1 213 555 0100', source: '广交会', industry: '商超零售', status: '合作客户', level: 'VIP', phone: '+1 213 555 0100', fax: '+1 213 555 0199', email: 'purchase@example.com', whatsapp: '+1 213 555 0100', notes: '北美连锁商超，主打厨房家居品类，返单稳定。' });
    const c2 = insC({ company_name: 'Nordic Home AB', country: '瑞典 Sweden', address: 'Industrivägen 12, 171 48 Solna, Stockholm, Sweden', website: 'www.example.com', contact_person: 'Erik Larsson', contact_phone: '+46 70 123 4567', source: '阿里巴巴国际站', industry: '家居零售', status: '意向客户', level: '重要', phone: '+46 8 5000 1234', email: 'info@example.com', whatsapp: '+46 70 123 4567', notes: '关注玻璃器皿与北欧风格家居用品。' });
    const c3 = insC({ company_name: 'Blue Ocean Trading LLC', country: '阿联酋 U.A.E.', address: 'Office 205, Deira, Dubai, U.A.E.', website: 'www.example.com', contact_person: 'Ahmed Al-Farsi', contact_phone: '+971 50 123 4567', source: '客户推荐', industry: '贸易批发', status: '潜在客户', level: '普通', phone: '+971 4 228 0000', email: 'sales@example.com', whatsapp: '+971 50 123 4567', notes: '中东礼品批发商。' });
    const c4 = insC({ company_name: 'Sunrise Distributors Ltd', country: '英国 United Kingdom', address: 'Unit 3, Riverside Park, London E14 9RL, UK', website: 'www.example.com', contact_person: 'James Carter', contact_phone: '+44 7700 900123', source: '展会', industry: '批发分销', status: '报价中', level: '重要', phone: '+44 20 7123 4567', email: 'info@example.com', whatsapp: '+44 7700 900123', notes: '对竹木砧板与厨房收纳感兴趣。' });
    const c5 = insC({ company_name: 'PT Samudera Niaga', country: '印度尼西亚 Indonesia', address: 'Jl. Thamrin 88, Jakarta 10310, Indonesia', website: 'www.example.com', contact_person: 'Budi Santoso', contact_phone: '+62 811 200 7788', source: 'LinkedIn', industry: '进口商', status: '潜在客户', level: '普通', phone: '+62 21 390 1234', email: 'contact@example.com', notes: '东南亚市场潜力客户。' });
    const insCt = (cid, o) => run('INSERT INTO contacts(customer_id,name,position,department,phone,mobile,email,is_primary,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      cid, o.name, o.position || '', o.department || '', o.phone || '', o.mobile || '', o.email || '', o.is_primary ? 1 : 0, o.notes || '', t);
    insCt(c1, { name: 'Tom Smith', position: 'Purchasing Manager', department: '采购部', phone: '+1 213 555 0100', email: 'tom.smith@example.com', is_primary: true, notes: '决策人，每年圣诞季前下单。' });
    insCt(c1, { name: 'Jessica Lee', position: 'Sourcing Specialist', department: '采购部', email: 'jessica.lee@example.com' });
    insCt(c2, { name: 'Anna Lindqvist', position: 'Product Manager', department: '商品部', mobile: '+46 70 123 4567', email: 'anna@example.com', is_primary: true });
    insCt(c3, { name: 'Mohammed Al Farsi', position: 'General Manager', mobile: '+971 50 123 4567', email: 'mohammed@example.com', is_primary: true });
    insCt(c4, { name: 'Jack Brown', position: 'Buyer', mobile: '+44 7700 900123', email: 'jack@example.com', is_primary: true });
    insCt(c5, { name: 'Budi Santoso', position: 'Owner', email: 'budi@example.com', is_primary: true });
    const insP = (o) => run('INSERT INTO products(name,name_en,model,color,unit,price,currency,origin,stock,stock_alert,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      o.name, o.name_en || '', o.model || '', o.color || '', o.unit || 'PCS', o.price || 0, 'USD', '中国 China', o.stock || 0, o.stock_alert || 0, o.notes || '', t, t);
    insP({ name: '不锈钢保温杯 500ml', name_en: 'Stainless Steel Tumbler 500ml', model: 'OW-500', color: '银色', unit: 'PCS', price: 3.2, stock: 50000, stock_alert: 10000, notes: '带吸管盖，可印Logo' });
    insP({ name: '玻璃调味瓶四件套', name_en: 'Glass Spice Jar Set of 4', model: 'OW-SJ04', color: '透明', unit: 'SET', price: 5.6, stock: 20000, stock_alert: 5000 });
    insP({ name: '陶瓷马克杯 350ml', name_en: 'Ceramic Mug 350ml', model: 'OW-MG350', color: '白色', unit: 'PCS', price: 1.8, stock: 80000, stock_alert: 12000 });
    insP({ name: '竹木砧板', name_en: 'Bamboo Cutting Board', model: 'OW-BC40', color: '原木色', unit: 'PCS', price: 2.4, stock: 30000, stock_alert: 6000 });
    insP({ name: 'LED 仿真蜡烛灯', name_en: 'LED Flicker Candle', model: 'OW-LC09', color: '暖白色', unit: 'PCS', price: 0.85, stock: 100000, stock_alert: 20000 });
    const insA = (o) => run('INSERT INTO activities(customer_id,type,subject,content,contact_person,activity_date,next_follow_date,next_follow_notes,created_by,user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      o.customer_id, o.type || '其他', o.subject, o.content || '', o.contact_person || '', o.activity_date || nowStr(), o.next_follow_date || null, o.next_follow_notes || '', '外贸业务员', seedOwner ? seedOwner.id : null, t);
    insA({ customer_id: c1, type: '邮件', subject: '发送圣诞季报价单', content: '已按 4 款保温杯、12000 件发送正式报价，等待客户确认。', contact_person: 'Tom Smith', activity_date: nowStr(new Date(Date.now() - 86400000)), next_follow_date: addDays(todayStr(), 2), next_follow_notes: '跟进客户议价意见' });
    insA({ customer_id: c2, type: '电话', subject: '样品寄样沟通', content: '客户确认样品地址，安排 DHL 寄样。', contact_person: 'Anna Lindqvist', activity_date: nowStr(new Date(Date.now() - 2 * 86400000)), next_follow_date: addDays(todayStr(), 5), next_follow_notes: '确认样品签收并跟进测试反馈' });
    insA({ customer_id: c4, type: '展会', subject: '英国展会接洽', content: '展会现场洽谈竹木砧板合作，客户要求寄样并报价。', contact_person: 'Jack Brown', activity_date: nowStr(new Date(Date.now() - 5 * 86400000)), next_follow_date: addDays(todayStr(), 1), next_follow_notes: '发送砧板报价' });
    run('UPDATE customers SET id=id WHERE 1=0'); // no-op
  }
    if (demoOk) setSetting('setup_seeded', '1');
}

  if (!getSetting('setup_seeded') && get('SELECT COUNT(*) c FROM customers').c > 0) setSetting('setup_seeded', '1');
  // 演示供应商
  if (!getSetting('setup_seeded') && get('SELECT COUNT(*) c FROM suppliers').c === 0) {
    const st = nowStr();
    run('INSERT INTO suppliers(name,name_en,country,contact_name,contact_position,phone,email,address,main_products,payment_terms,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      '佛山市宏发五金制品厂', 'Hongfa Hardware Factory', '中国 China', '刘经理', '销售经理', '+86 757 2333 6666', 'supplier1@example.com', '广东省佛山市顺德区北滘镇工业大道18号', '保温杯、不锈钢餐具', '月结30天', '供货稳定，交期 25-35 天。', st, st);
    run('INSERT INTO suppliers(name,name_en,country,contact_name,contact_position,phone,email,address,main_products,payment_terms,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      '德化万鑫陶瓷有限公司', 'Wanxin Ceramics Co., Ltd.', '中国 China', '陈总', '总经理', '+86 595 2351 8888', 'supplier2@example.com', '福建省泉州市德化县龙浔镇陶瓷科技园', '陶瓷马克杯、陶瓷餐具', '预付30%，余款发货前结清', '可定制花纸/Logo。', st, st);
    run('INSERT INTO suppliers(name,name_en,country,contact_name,contact_position,phone,email,address,main_products,payment_terms,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      '中山市星光玻璃制品厂', 'Xingguang Glass Factory', '中国 China', '黄小姐', '外贸跟单', '+86 760 8555 1234', 'supplier3@example.com', '广东省中山市古镇镇同益工业区', '玻璃调味瓶、玻璃罐', '月结60天', '', st, st);
  }
  // 演示供应产品（每款可传图、独立报价）
  if (!getSetting('setup_seeded') && get('SELECT COUNT(*) c FROM supplier_products').c === 0) {
    const allSup = all('SELECT * FROM suppliers ORDER BY id');
    const demo = [
      { keys: ['五金', '宏发'], items: [{ name: '不锈钢保温杯 500ml', name_en: 'Stainless Steel Tumbler 500ml', model: 'HF-500', price: 12.5, currency: 'CNY', notes: '含吸管盖，MOQ 3000' }, { name: '不锈钢饭盒', name_en: 'Steel Lunch Box', model: 'HF-LB', price: 18, currency: 'CNY' }] },
      { keys: ['万鑫', '陶瓷'], items: [{ name: '陶瓷马克杯 350ml', name_en: 'Ceramic Mug 350ml', model: 'WX-MG', price: 3.8, currency: 'CNY', notes: '可印Logo，MOQ 1000' }, { name: '陶瓷餐具套装', name_en: 'Ceramic Dinner Set', model: 'WX-SET', price: 45, currency: 'CNY' }] },
      { keys: ['星光', '玻璃'], items: [{ name: '玻璃调味瓶四件套', name_en: 'Glass Spice Jar Set', model: 'XG-SJ', price: 8.5, currency: 'CNY' }, { name: '玻璃储物罐', name_en: 'Glass Storage Jar', model: 'XG-JAR', price: 6, currency: 'CNY' }] },
    ];
    for (const sup of allSup) {
      const hit = demo.find(d => d.keys.some(k => String(sup.name || '').includes(k)));
      if (!hit) continue;
      const st2 = nowStr();
      for (const it of hit.items) {
        run('INSERT INTO supplier_products(supplier_id,name,name_en,model,unit,price,currency,image,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          sup.id, it.name, it.name_en || '', it.model || '', it.unit || 'PCS', it.price || 0, it.currency || 'CNY', '', it.notes || '', st2, st2);
      }
    }
  }
// 文档状态与单据类型字典
const DOC_STATUS = [
  { key: '草稿', cls: 'secondary' },
  { key: '已发送', cls: 'primary' },
  { key: '已确认', cls: 'info' },
  { key: '已完成', cls: 'success' },
  { key: '已作废', cls: 'danger' },
];

// 启动时自动备份数据库（防止版本升级/误操作丢数据）
function backupNow() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const stamp = nowStr().replace(/[-: ]/g, '').slice(0, 14);
    const file = path.join(dir, 'crm-' + stamp + '.db');
    fs.copyFileSync(DB_PATH, file);
    const allFiles = fs.readdirSync(dir).filter(n => n.startsWith('crm-') && n.endsWith('.db'))
      .map(n => ({ n, p: path.join(dir, n) }))
      .sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs);
    for (const x of allFiles.slice(30)) { try { fs.unlinkSync(x.p); } catch (e) {} }
    return file;
  } catch (e) {
    console.error('数据库自动备份失败：', e.message);
    return null;
  }
}

module.exports = { db, run, get, all, getSetting, setSetting, getCompany, setCompany, seedBase, ensureDefaultTemplates, DB_PATH, DOC_TYPES, DOC_TYPE_MAP, DOC_STATUS, backupNow, syncProductToSupplier };






























