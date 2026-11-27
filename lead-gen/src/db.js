'use strict';
/**
 * lead-gen 独立数据库层
 * 使用 Node 内置 node:sqlite（与主系统同款），数据库文件独立放在 lead-gen/data/，
 * 不会打开或改写主系统 data/crm.db。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.LEADGEN_DB || path.join(DATA_DIR, 'leads.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

function run(sql, ...p) { return db.prepare(sql).run(...p); }
function get(sql, ...p) { return db.prepare(sql).get(...p); }
function all(sql, ...p) { return db.prepare(sql).all(...p); }

function now() { return new Date().toISOString(); }

db.exec(`
-- 导入批次
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT,
  source TEXT DEFAULT 'manual',
  note TEXT,
  row_count INTEGER DEFAULT 0,
  created_at TEXT
);

-- 线索主表（去重键：规范化域名，没有域名时用规范化公司名）
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER,
  company_name TEXT NOT NULL,
  website TEXT,
  domain TEXT,
  country TEXT,
  industry_hint TEXT,
  size_hint TEXT,
  employee_hint TEXT,
  source TEXT,
  status TEXT DEFAULT 'new',          -- new / queued / verifying / verified / review / failed
  overall_score REAL DEFAULT 0,
  dedup_key TEXT UNIQUE,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_batch ON leads(batch_id);

-- 原始证据：每个来源对某个字段的一条声明（可多条）
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  source TEXT NOT NULL,               -- bing / website / linkedin_search / facebook_search / instagram_search / manual / google_cse / serpapi
  field TEXT NOT NULL,                -- industry / size / employees / country / website / social / founded / description
  raw_value TEXT,
  value TEXT,                         -- 归一化后的值
  url TEXT,
  snippet TEXT,
  confidence REAL DEFAULT 0.5,        -- 来源权重 0~1
  captured_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_lead ON evidence(lead_id);
CREATE INDEX IF NOT EXISTS idx_ev_field ON evidence(lead_id, field);

-- 核验运行记录
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  engine_version TEXT,
  overall_score REAL,
  field_count INTEGER,
  conflict_count INTEGER,
  duration_ms INTEGER,
  result_json TEXT,                   -- 完整结论 JSON
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ver_lead ON verifications(lead_id);

-- 字段级结论（从最新一次核验拆出，便于查询/导出）
CREATE TABLE IF NOT EXISTS field_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  confidence REAL,
  status TEXT,                        -- confirmed / weak / conflict / missing
  evidence_count INTEGER DEFAULT 0,
  detail TEXT                         -- JSON：各候选值及支持来源
);

-- 后台任务队列
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- verify_one / verify_batch / import
  payload TEXT,
  status TEXT DEFAULT 'queued',       -- queued / running / done / failed
  progress INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- 配置（API key、限速等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

-- 操作日志
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT DEFAULT 'info',
  message TEXT,
  lead_id INTEGER,
  created_at TEXT
);
`);

// 幂等迁移：借鉴 GoodJob 的「候选 → 清洗 → 人工审批 → 线索」闭环，旧库自动补列
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) run(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
ensureColumn('leads', 'stage', "TEXT DEFAULT 'candidate'");
ensureColumn('leads', 'reviewed_at', 'TEXT');
ensureColumn('leads', 'review_note', "TEXT DEFAULT ''");
ensureColumn('leads', 'recommend_score', 'INTEGER DEFAULT 0');
run("UPDATE settings SET value='1.2.0', updated_at=? WHERE key='engine_version' AND COALESCE(value,'')<>'1.2.0'", now());

// 默认配置
const DEFAULT_SETTINGS = {
  google_cse_key: '',
  google_cse_cx: '',
  serpapi_key: '',
  request_delay_ms: '1200',
  request_timeout_ms: '15000',
  max_results_per_query: '8',
  engine_version: '1.2.0',
  // GoodJob 式 provider 开关：只跑勾选的通道，未配置 Key 的源自动跳过
  enabled_sources: 'website,bing,linkedin_search,facebook_search,instagram_search,google_cse,serpapi',
  // 推荐分达到该阈值才建议人工审批通过（仍须人工点确认）
  approval_min_score: '70',
  // 代理：社媒/搜索需走代理时填写，如 http://127.0.0.1:7897；留空则直连
  proxy_url: 'http://127.0.0.1:7897',
  // r.jina.ai 文本阅读器代理（把 FB/LinkedIn 页面转成可读文本，绕过反爬）
  jina_reader: '1',
  jina_base: 'https://r.jina.ai/',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  run('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)', k, v, now());
}

function getSetting(key, fallback = '') {
  const r = get('SELECT value FROM settings WHERE key=?', key);
  return r && r.value !== null ? r.value : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, String(value), now());
}
function allSettings() {
  const out = {};
  for (const r of all('SELECT key,value FROM settings')) out[r.key] = r.value;
  return out;
}

function log(level, message, leadId = null) {
  run('INSERT INTO activity_log(level,message,lead_id,created_at) VALUES(?,?,?,?)', level, String(message), leadId, now());
}

// 统计
function stats() {
  return {
    leads: get('SELECT COUNT(*) c FROM leads').c,
    verified: get("SELECT COUNT(*) c FROM leads WHERE status IN ('verified','review')").c,
    review: get("SELECT COUNT(*) c FROM leads WHERE status='review'").c,
    candidate: get("SELECT COUNT(*) c FROM leads WHERE COALESCE(stage,'candidate')='candidate'").c,
    approved: get("SELECT COUNT(*) c FROM leads WHERE stage='approved'").c,
    rejected: get("SELECT COUNT(*) c FROM leads WHERE stage='rejected'").c,
    evidence: get('SELECT COUNT(*) c FROM evidence').c,
    batches: get('SELECT COUNT(*) c FROM batches').c,
  };
}

module.exports = {
  db, DB_PATH, DATA_DIR, run, get, all, now,
  getSetting, setSetting, allSettings, log, stats,
};
