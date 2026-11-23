'use strict';
/**
 * 获客工作台（lead-suite）独立数据库层
 * 使用 Node 内置 node:sqlite（与主系统同款），数据库文件独立放在 suite/data/，
 * 不会打开或改写主系统 data/crm.db，也不会改动 lead-gen/data/ 下的任何文件。
 *
 * 首次启动数据迁移：若套件库文件不存在，且旧服务 lead-gen/data/leads.db 存在，
 * 则把旧库（.db 以及同名的 -wal、-shm，若存在）复制过来再打开；复制后对新库
 * 执行 PRAGMA wal_checkpoint(TRUNCATE)，再 SELECT COUNT(*) FROM leads 校验。
 * 任何一步失败都 catch：打日志、不崩启动、改用空库继续。源文件绝不改动。
 * 测试可用环境变量 SUITE_LEGACY_DB 覆盖旧库路径（默认 ../../lead-gen/data/leads.db）。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.SUITE_DB || path.join(DATA_DIR, 'leads.db');
const LEGACY_DB_PATH = process.env.SUITE_LEGACY_DB
  || path.join(__dirname, '..', '..', 'lead-gen', 'data', 'leads.db');

/** 启动迁移：目标库不存在且旧库存在时，复制旧库文件（.db + -wal + -shm）到目标位置。 */
function migrateFromLegacy() {
  if (fs.existsSync(DB_PATH)) return; // 已有套件库，不迁移
  if (!fs.existsSync(LEGACY_DB_PATH)) return; // 没有旧库，从空库起步
  const files = [LEGACY_DB_PATH, LEGACY_DB_PATH + '-wal', LEGACY_DB_PATH + '-shm']
    .filter(f => fs.existsSync(f));
  if (!files.length) return;
  try {
    for (const f of files) {
      const dest = f === LEGACY_DB_PATH ? DB_PATH : DB_PATH + f.slice(LEGACY_DB_PATH.length);
      fs.copyFileSync(f, dest);
    }
    // 复制后打开新库做 checkpoint + 行数校验（只读源文件，校验只针对新库）。
    const probe = new DatabaseSync(DB_PATH);
    try {
      probe.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      const row = probe.prepare('SELECT COUNT(*) c FROM leads').get();
      const n = row ? Number(row.c) : 0;
      console.log(`[数据迁移] 已从 lead-gen 复制线索库（${n} 条线索）`);
    } finally {
      probe.close();
    }
  } catch (e) {
    console.error('[数据迁移] 复制旧线索库失败，改用空库继续启动：', e && e.message ? e.message : e);
    // 复制了一半的残文件删掉，避免打开一个损坏的半库；删失败也不阻塞启动。
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + suffix); } catch {}
    }
  }
}

migrateFromLegacy();

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
  source TEXT NOT NULL,               -- bing / website / linkedin_search / facebook_search / instagram_search / manual / google_cse / serpapi / google_places
  field TEXT NOT NULL,                -- industry / size / employees / country / website / social / founded / description / phone / address
  raw_value TEXT,
  value TEXT,                         -- 归一化后的值
  url TEXT,
  snippet TEXT,
  confidence REAL DEFAULT 0.5,        -- 来源权重 0~1
  captured_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_lead ON evidence(lead_id);
CREATE INDEX IF NOT EXISTS idx_ev_field ON evidence(lead_id, field);

-- 核验运行记录（旧表结构保留，新服务不再写旧核验引擎）
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

-- 字段级结论（旧表结构保留）
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

-- 后台任务队列（旧表结构保留）
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

-- 获客工作台新增：采集任务（任务流）
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT,
  location TEXT,
  radius_km REAL,
  max_results INTEGER,
  status TEXT DEFAULT 'queued',       -- queued / running / organizing / done / failed
  total INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  batch_id INTEGER,
  error TEXT,
  results_json TEXT,             -- 任务完成后的 results 原文（JSON，供地图打点与结果展示）
  created_at TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- 获客工作台新增：开发信发送记录
CREATE TABLE IF NOT EXISTS send_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  template_id INTEGER,
  channel TEXT,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'sent',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_lead ON send_records(lead_id);

-- 获客工作台新增：开发信模板
CREATE TABLE IF NOT EXISTS letter_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  lang TEXT DEFAULT 'en',
  subject TEXT,
  body TEXT,
  created_at TEXT,
  updated_at TEXT
);
`);

// 幂等迁移：旧库自动补列（沿用 lead-gen 的做法）
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) run(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
ensureColumn('leads', 'stage', "TEXT DEFAULT 'candidate'");
ensureColumn('leads', 'reviewed_at', 'TEXT');
ensureColumn('leads', 'review_note', "TEXT DEFAULT ''");
ensureColumn('leads', 'recommend_score', 'INTEGER DEFAULT 0');

// 默认配置（沿用旧 db.js 的默认设置写法）
const DEFAULT_SETTINGS = {
  google_cse_key: '',
  google_cse_cx: '',
  serpapi_key: '',
  google_places_key: '',
  request_delay_ms: '1200',
  request_timeout_ms: '15000',
  max_results_per_query: '8',
  engine_version: '1.2.0',
  enabled_sources: 'website,bing,linkedin_search,facebook_search,instagram_search,google_cse,serpapi',
  approval_min_score: '70',
  // 代理：社媒/搜索需走代理时填写，如 http://127.0.0.1:7897；留空则直连
  proxy_url: 'http://127.0.0.1:7897',
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

// 统计（沿用旧 dashboard 口径）
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
  db, DB_PATH, DATA_DIR, LEGACY_DB_PATH, run, get, all, now,
  getSetting, setSetting, allSettings, log, stats,
  // 供自测校验源文件未被改动（只读哈希，不写库）
  _hashFile: f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
};
