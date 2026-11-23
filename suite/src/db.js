'use strict';
/**
 * 获客工作台（lead-suite）独立数据库层
 * 使用 Node 内置 node:sqlite（与主系统同款），数据库文件独立放在 suite/data/，
 * 不会打开或改写主系统 data/crm.db，也不会改动 lead-gen/data/ 下的任何文件。
 *
 * 首次启动数据迁移：若套件库文件不存在，且旧服务 lead-gen/data/leads.db 存在，
 * 则把旧库（.db 以及同名的 -wal、-shm，若存在）复制过来再打开；复制后对新库
 * 执行 PRAGMA wal_checkpoint(TRUNCATE)，再做 PRAGMA integrity_check 完整性
 * 校验（只靠 COUNT(*) 不够：复制进行中 WAL 尾部帧损坏时会被静默丢弃），
 * 最后 SELECT COUNT(*) FROM leads 校验。完整性校验失败时删残文件并抛错，
 * 让进程报错退出（不要静默用空库，否则下次启动因“库已存在”跳过迁移）。
 * 复制本身失败（旧库被占着、读不到等）仍 catch：打日志、不崩启动、改用空库继续。
 * 任何一步都不改动源文件。
 * 测试可用环境变量 SUITE_LEGACY_DB 覆盖旧库路径（默认 ../../lead-gen/data/leads.db）。
 * 手动重迁：SUITE_FORCE_MIGRATE=1 时先删现有套件库再重新从旧库复制。
 * 注意：server.js 在 require 本模块之前会先确认端口空闲，避免“旧服务占着端口时
 * 新服务先复制旧库、再因 EADDRINUSE 崩溃，残留复制文件导致之后永不重迁”的竞态。
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
  if (!fs.existsSync(LEGACY_DB_PATH)) return; // 没有旧库，从空库起步
  if (fs.existsSync(DB_PATH)) {
    if (process.env.SUITE_FORCE_MIGRATE !== '1') return; // 已有套件库，不迁移
    // 手动重迁：先删现有套件库（及 -wal/-shm），再从旧库复制。
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + suffix); } catch {}
    }
    console.log('[数据迁移] SUITE_FORCE_MIGRATE=1：已删除现有套件库，重新从旧库迁移。');
  }
  const files = [LEGACY_DB_PATH, LEGACY_DB_PATH + '-wal', LEGACY_DB_PATH + '-shm']
    .filter(f => fs.existsSync(f));
  if (!files.length) return;
  try {
    for (const f of files) {
      const dest = f === LEGACY_DB_PATH ? DB_PATH : DB_PATH + f.slice(LEGACY_DB_PATH.length);
      fs.copyFileSync(f, dest);
    }
    // 复制后打开新库做 checkpoint + 完整性校验 + 行数校验（只针对新库，不碰源文件）。
    const probe = new DatabaseSync(DB_PATH);
    try {
      probe.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      // 只做 COUNT(*) 不够：复制进行中 WAL 尾部帧损坏时，损坏部分会被静默丢弃、
      // COUNT 照常返回一个数字。integrity_check 才能发现这种损坏。
      // 注意：integrity_check 在损坏严重时是直接抛错（database disk image is
      // malformed），而不是返回错误行，两种情况都算校验失败。
      let integrityOk = false;
      let integrityDetail = '';
      try {
        const chkRows = probe.prepare('PRAGMA integrity_check').all();
        integrityOk = chkRows.length > 0
          && chkRows.every(r => String(Object.values(r)[0]).trim() === 'ok');
        if (!integrityOk) {
          integrityDetail = chkRows.slice(0, 3).map(r => String(Object.values(r)[0])).join('；');
        }
      } catch (e) {
        integrityDetail = e && e.message ? String(e.message) : String(e);
      }
      if (!integrityOk) {
        throw new Error('新库完整性校验失败：' + (integrityDetail || '无返回'));
      }
      const row = probe.prepare('SELECT COUNT(*) c FROM leads').get();
      const n = row ? Number(row.c) : 0;
      console.log(`[数据迁移] 已从 lead-gen 复制线索库（${n} 条线索）`);
    } finally {
      probe.close();
    }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    // 复制了一半的残文件删掉，避免打开一个损坏的半库；删失败也不阻塞。
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + suffix); } catch {}
    }
    if (/完整性校验失败/.test(msg)) {
      // 完整性失败必须报错退出：静默改用空库的话，下次启动会因“库已存在”
      // （空库文件已被建出来）跳过迁移，旧数据就永久丢了还不自知。
      throw new Error('[数据迁移] ' + msg + '。残文件已删，请检查旧库是否损坏或正在被旧服务写入，确认旧服务已停后再重启。');
    }
    console.error('[数据迁移] 复制旧线索库失败，改用空库继续启动：', msg);
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

// 旧库的 leads 表若缺 status 列（极老的库），先补列再建索引：否则
// CREATE INDEX idx_leads_status 会在补列之前崩溃，且迁移已复制完、之后
// 每次启动都会在同一点崩。真实旧库一定有 status 列，这里只是健壮性。
// batch_id 同理（idx_leads_batch 要用它）。
// ensureColumn 是函数声明（会提升），在这里调用没问题。
ensureColumn('leads', 'status', "TEXT DEFAULT 'new'");
ensureColumn('leads', 'batch_id', 'INTEGER');

db.exec(`
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_batch ON leads(batch_id);
CREATE INDEX IF NOT EXISTS idx_ev_lead ON evidence(lead_id);
CREATE INDEX IF NOT EXISTS idx_ev_field ON evidence(lead_id, field);
CREATE INDEX IF NOT EXISTS idx_ver_lead ON verifications(lead_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_send_lead ON send_records(lead_id);
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
// 任务中心坐标（L3）：服务端定位后把城市坐标存这里，供地图页直接用，
// 不再让浏览器端 Geocoder 重算一次。
ensureColumn('tasks', 'center_lat', 'REAL');
ensureColumn('tasks', 'center_lng', 'REAL');
// 多关键词批次（轻量归属字段，不另起大表）：
// map_batch_id 指向 batches 表里 source='maps' 的一行（关键词批次归属；
// 注意 tasks.batch_id 仍是 collectLeads 内部 importLeads 建的导入批次 id，
// 两者不要混用）；calls_json 存 collectLeads 返回的 calls 计数 JSON；
// current_name 是当前正在查详情的商家名，供右侧栏实时显示，任务完成时置 NULL。
ensureColumn('tasks', 'map_batch_id', 'INTEGER');
ensureColumn('tasks', 'calls_json', 'TEXT');
ensureColumn('tasks', 'current_name', 'TEXT');

// 默认配置（沿用旧 db.js 的默认设置写法）
// 注意：旧核验引擎的设置项（google_cse_key、serpapi_key、jina_*、
// max_results_per_query、approval_min_score）已下线，无业务代码再读，
// 这里不再设默认值，启动时还会删掉库里残留的旧行（见下）。
const DEFAULT_SETTINGS = {
  google_places_key: '',
  request_delay_ms: '1200',
  request_timeout_ms: '15000',
  engine_version: '1.2.0',
  // google_places 在列表里：它现在真正守门地图采集（见 places.isMapsEnabled），
  // 旧库里若没有它，启动时补上（见下），保持“默认可用”。
  enabled_sources: 'website,bing,linkedin_search,facebook_search,instagram_search,google_cse,serpapi,google_places',
  // 代理：社媒/搜索需走代理时填写，如 http://127.0.0.1:7897；留空则直连
  proxy_url: 'http://127.0.0.1:7897',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  run('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)', k, v, now());
}
// 清理已下线设置项的残留行（旧库迁移过来时会带上），不留孤儿字段。
run(`DELETE FROM settings WHERE key IN ('google_cse_key','google_cse_cx','serpapi_key','jina_reader','jina_base','max_results_per_query','approval_min_score')`);
// google_places 开关现在真正守门地图采集：旧库里的 enabled_sources 若没有它，
// 补上——此前采集根本不看这个开关，补上可保持“默认可用”，用户取消勾选后才真正关闭。
{
  const enabled = String(getSetting('enabled_sources', '') || '');
  const parts = enabled.split(',').map(s => s.trim()).filter(Boolean);
  if (enabled && !parts.includes('google_places')) {
    setSetting('enabled_sources', parts.concat('google_places').join(','));
  }
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

// 统计：只返回真实在写的指标。旧口径的 verified/review/approved 全是死指标——
// 没有任何代码会写 overall_score（恒 0）、stage（恒 candidate）或 status 的
// verified/review，V1 不再展示它们（第二阶段再接）；review 还曾同时算进
// “已核验”和“待跟进”两张卡片，口径重复。待跟进 = status='new' 的真实条数。
function stats() {
  return {
    leads: get('SELECT COUNT(*) c FROM leads').c,
    pending: get("SELECT COUNT(*) c FROM leads WHERE status='new'").c,
    evidence: get('SELECT COUNT(*) c FROM evidence').c,
    batches: get('SELECT COUNT(*) c FROM batches').c,
    tasks: get('SELECT COUNT(*) c FROM tasks').c,
    tasksActive: get("SELECT COUNT(*) c FROM tasks WHERE status IN ('queued','running','organizing')").c,
  };
}

module.exports = {
  db, DB_PATH, DATA_DIR, LEGACY_DB_PATH, run, get, all, now,
  getSetting, setSetting, allSettings, log, stats,
  // 供自测校验源文件未被改动（只读哈希，不写库）
  _hashFile: f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
};
