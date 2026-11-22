'use strict';
// ============================================================
// HQ CRM 本地 SQLite <-> 小程序云端数据库 双向同步
//
// 独立工具，不修改主系统任何代码。
// 用法：
//   node tools/sync-cloud.js              双向同步
//   node tools/sync-cloud.js --dry        只看差异，不写入
//   node tools/sync-cloud.js --push-only  只把本地推到云端
//   node tools/sync-cloud.js --pull-only  只把云端拉回本地
//   node tools/sync-cloud.js --local-wins       冲突一律以本地为准（首次初始化用）
//   node tools/sync-cloud.js --verbose          打印差异样本
//   node tools/sync-cloud.js --table products   只同步指定表
//   node tools/sync-cloud.js --table products,customers
//
// 冲突规则：按更新时间（updated_at 优先，其次 created_at）新的覆盖旧的；
// 时间相同则以本地为准（电脑版是主数据源）。不同步删除。
// ============================================================
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// SDK 依赖浏览器 localStorage，Node 下补一个内存实现
const _ls = {};
globalThis.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
  clear: () => { Object.keys(_ls).forEach((k) => delete _ls[k]); },
};

const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const CLOUD = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_1hHj0Q74TfYdyMsSVONUUP_OpPmxETn3i2wfKhIH4GRIOAI6dQeeGQx',
};

const SEED_OWNER = '__seed__';
const DB_PATH = process.env.CRM_DB || path.join(__dirname, '..', 'data', 'crm.db');
const PAGE = 500;

// 参与同步的字段（两端都有的部分；id 作主键，owner_id/is_shared 由同步逻辑固定）
const FIELDS = {
  customers: ['company_name', 'name_en', 'country', 'address', 'website', 'source', 'industry',
    'status', 'level', 'tax_no', 'notes', 'phone', 'fax', 'email', 'whatsapp', 'wechat',
    'contact_person', 'contact_phone', 'customer_tier', 'tier_override', 'tier_source',
    'tier_score', 'tier_reason', 'tier_updated_at', 'do_not_contact', 'in_pool', 'created_at', 'updated_at'],
  contacts: ['customer_id', 'name', 'position', 'department', 'phone', 'mobile', 'email',
    'is_primary', 'notes', 'created_at'],
  activities: ['customer_id', 'type', 'subject', 'content', 'contact_person', 'activity_date',
    'next_follow_date', 'next_follow_notes', 'priority', 'outcome', 'archived', 'created_by', 'created_at'],
  documents: ['doc_no', 'doc_type', 'customer_id', 'title', 'issue_date', 'valid_until',
    'delivery_date', 'currency', 'payment_terms', 'trade_terms', 'port_loading', 'port_destination',
    'shipping_marks', 'remarks', 'status', 'subtotal', 'discount', 'tax_rate', 'tax_amount',
    'total_amount', 'items', 'created_by', 'created_at', 'updated_at'],
  products: ['name', 'name_en', 'model', 'hs_code', 'unit', 'price', 'currency', 'origin', 'notes',
    'stock', 'stock_alert', 'cost_price', 'pcs_per_ctn', 'volume', 'weight', 'ctn_count', 'color',
    'created_at', 'updated_at'],
  stock_movements: ['product_id', 'product_name', 'doc_id', 'doc_no', 'doc_type', 'party', 'change',
    'balance_after', 'remark', 'created_by', 'created_at'],
};

// 需要按数字写入的字段
const NUM_FIELDS = {
  customers: ['tier_score', 'do_not_contact', 'in_pool'],
  contacts: ['customer_id', 'is_primary'],
  activities: ['customer_id', 'archived'],
  documents: ['customer_id', 'subtotal', 'discount', 'tax_rate', 'tax_amount', 'total_amount'],
  products: ['price', 'stock', 'stock_alert', 'cost_price', 'pcs_per_ctn', 'volume', 'weight', 'ctn_count'],
  stock_movements: ['product_id', 'doc_id', 'change', 'balance_after'],
};

// 判断新旧所用的时间字段，取第一个非空值
const TIME_FIELDS = {
  customers: ['updated_at', 'created_at'],
  contacts: ['created_at'],
  activities: ['created_at', 'activity_date'],
  documents: ['updated_at', 'created_at'],
  products: ['updated_at', 'created_at'],
  stock_movements: ['created_at'],
};

const TABLES = Object.keys(FIELDS);

// ---------- 工具 ----------
function norm(value, isNum) {
  if (value === null || value === undefined) return isNum ? 0 : '';
  if (isNum) {
    const n = Number(value);
    return isFinite(n) ? n : 0;
  }
  return String(value);
}

// 取所有时间字段里最大的一个：两端口径必须一致，
// 否则会出现「本地比 updated_at、云端比 created_at」这种错位比较
function timeOf(row, table) {
  const keys = TIME_FIELDS[table] || [];
  let best = '';
  keys.forEach((k) => {
    const v = row[k];
    if (v === null || v === undefined) return;
    const s = String(v).trim();
    if (s !== '' && s > best) best = s;
  });
  return best;
}

function fingerprint(row, fields, table) {
  const nums = NUM_FIELDS[table] || [];
  const parts = [];
  fields.forEach((f) => {
    const isNum = nums.indexOf(f) >= 0;
    const v = norm(row[f], isNum);
    parts.push(isNum ? '#' + Number(v).toFixed(6) : String(v));
  });
  return parts.join('|');
}

function localColumns(db, table) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
  const want = FIELDS[table] || [];
  return want.filter((f) => cols.indexOf(f) >= 0);
}

function readLocal(db, table, fields) {
  const sql = 'SELECT id,' + fields.join(',') + ' FROM ' + table;
  const rows = db.prepare(sql).all();
  const map = new Map();
  rows.forEach((r) => map.set(Number(r.id), r));
  return map;
}

async function readCloud(cloud, table, fields) {
  const map = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await cloud.database.from(table)
      .select('id,' + fields.join(','))
      .range(from, from + PAGE - 1);
    if (error) throw new Error('读取云端 ' + table + ' 失败：' + (error.message || error));
    const rows = data || [];
    rows.forEach((r) => map.set(Number(r.id), r));
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// ---------- 计划 ----------
function diffFields(lrow, crow, fields, table) {
  const nums = NUM_FIELDS[table] || [];
  const out = [];
  fields.forEach((f) => {
    const a = norm(lrow[f], nums.indexOf(f) >= 0);
    const b = norm(crow[f], nums.indexOf(f) >= 0);
    if (String(a) !== String(b)) {
      out.push(f + ': 本地[' + String(a).slice(0, 20) + '] 云端[' + String(b).slice(0, 20) + ']');
    }
  });
  return out;
}

function planTable(table, localMap, cloudMap, fields, verbose, localWins) {
  const pushInserts = [];
  const pullInserts = [];
  const pushUpdates = [];
  const pullUpdates = [];
  let same = 0;
  const samples = { push: [], pull: [] };

  localMap.forEach((lrow, id) => {
    const crow = cloudMap.get(id);
    const lfp = fingerprint(lrow, fields, table);
    if (!crow) {
      pushInserts.push({ id, row: lrow });
      return;
    }
    const cfp = fingerprint(crow, fields, table);
    if (lfp === cfp) { same += 1; return; }
    const lt = timeOf(lrow, table);
    const ct = timeOf(crow, table);
    let dir;
    if (localWins) dir = 'push'; // 强制以本地为准（首次初始化或修复云端残缺字段时用）
    else if (lt > ct) dir = 'push';
    else if (ct > lt) dir = 'pull';
    else dir = 'push'; // 时间相同或都为空：本地优先
    if (verbose && samples[dir].length < 2) {
      samples[dir].push({ id, dir, lt, ct, diffs: diffFields(lrow, crow, fields, table).slice(0, 6) });
    }
    if (dir === 'push') pushUpdates.push({ id, row: lrow });
    else pullUpdates.push({ id, row: crow, local: lrow });
  });

  cloudMap.forEach((crow, id) => {
    if (!localMap.has(id)) pullInserts.push({ id, row: crow });
  });

  return { pushInserts, pullInserts, pushUpdates, pullUpdates, same, samples: samples || [] };
}

// ---------- 执行 ----------
function toCloudRow(row, fields, table) {
  const nums = NUM_FIELDS[table] || [];
  const out = { owner_id: SEED_OWNER, is_shared: true };
  fields.forEach((f) => { out[f] = norm(row[f], nums.indexOf(f) >= 0); });
  return out;
}

async function pushInsertsToCloud(cloud, table, fields, items, dry) {
  if (!items.length) return 0;
  const nums = NUM_FIELDS[table] || [];
  let done = 0;
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100).map((it) => {
      const r = toCloudRow(it.row, fields, table);
      r.id = it.id;
      return r;
    });
    if (dry) { done += batch.length; continue; }
    const { error } = await cloud.database.from(table).insert(batch);
    if (error) throw new Error('写入云端 ' + table + ' 失败：' + (error.message || error));
    done += batch.length;
  }
  return done;
}

async function pushUpdatesToCloud(cloud, table, fields, items, dry) {
  let done = 0;
  for (const it of items) {
    if (!dry) {
      const row = toCloudRow(it.row, fields, table);
      delete row.id;
      const { error } = await cloud.database.from(table).update(row).eq('id', it.id);
      if (error) throw new Error('更新云端 ' + table + ' id=' + it.id + ' 失败：' + (error.message || error));
    }
    done += 1;
  }
  return done;
}

function pullInsertsToLocal(db, table, fields, items, dry) {
  if (!items.length) return 0;
  const nums = NUM_FIELDS[table] || [];
  const cols = ['id'].concat(fields);
  const sql = 'INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')';
  const stmt = db.prepare(sql);
  let done = 0;
  let failed = 0;
  items.forEach((it) => {
    if (dry) { done += 1; return; }
    const vals = [it.id].concat(fields.map((f) => norm(it.row[f], nums.indexOf(f) >= 0)));
    try {
      stmt.run.apply(stmt, vals);
      done += 1;
    } catch (e) {
      failed += 1;
      console.log('  ! 本地插入失败 ' + table + ' id=' + it.id + '：' + e.message);
    }
  });
  return { done, failed };
}

// 云端为空、本地有值时保留本地：避免用云端的空字段抹掉电脑版里的真实数据
function pullValue(cloudVal, localVal, isNum) {
  const c = norm(cloudVal, isNum);
  const l = norm(localVal, isNum);
  if (!isNum && String(c).trim() === '' && String(l).trim() !== '') return l;
  return c;
}

function pullUpdatesToLocal(db, table, fields, items, dry) {
  const nums = NUM_FIELDS[table] || [];
  const setSql = fields.map((f) => f + '=?').join(',');
  const sql = 'UPDATE ' + table + ' SET ' + setSql + ' WHERE id=?';
  const stmt = db.prepare(sql);
  let done = 0;
  items.forEach((it) => {
    if (dry) { done += 1; return; }
    const vals = fields.map((f) => pullValue(it.row[f], it.local ? it.local[f] : '', nums.indexOf(f) >= 0)).concat([it.id]);
    try {
      stmt.run.apply(stmt, vals);
      done += 1;
    } catch (e) {
      console.log('  ! 本地更新失败 ' + table + ' id=' + it.id + '：' + e.message);
    }
  });
  return done;
}

// 云端 id 是显式写入的，需把自增序列推到最大 id 之后
async function fixSequence(cloud, table, dry) {
  if (dry) return;
  try {
    await cloud.database.rpc('fix_identity_seq', { tbl: table });
  } catch (e) {
    console.log('  ! 序列校准失败 ' + table + '（不影响本次同步）：' + (e && e.message));
  }
}

// ---------- 主流程 ----------
async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.indexOf('--dry') >= 0;
  const verbose = argv.indexOf('--verbose') >= 0;
  const localWins = argv.indexOf('--local-wins') >= 0;
  const pushOnly = argv.indexOf('--push-only') >= 0;
  const pullOnly = argv.indexOf('--pull-only') >= 0;
  const tIdx = argv.indexOf('--table');
  let tables = TABLES;
  if (tIdx >= 0 && argv[tIdx + 1]) {
    tables = argv[tIdx + 1].split(',').map((s) => s.trim()).filter((s) => TABLES.indexOf(s) >= 0);
    if (!tables.length) { console.log('未指定有效的表名，可选：' + TABLES.join(', ')); return; }
  }

  console.log('数据库：' + DB_PATH);
  console.log('模式：' + (dry ? '预演（不写入）' : pushOnly ? '仅推送' : pullOnly ? '仅拉取' : '双向')
    + (localWins ? ' + 本地优先' : '') + '\n');

  const db = new DatabaseSync(DB_PATH);
  const cloud = createWorkBuddyCloud(CLOUD);

  let total = { pushAdd: 0, pullAdd: 0, pushUpd: 0, pullUpd: 0, same: 0 };

  for (const table of tables) {
    const fields = localColumns(db, table);
    if (!fields.length) { console.log(table + '：本地无匹配字段，跳过'); continue; }

    const localMap = readLocal(db, table, fields);
    const cloudMap = await readCloud(cloud, table, fields);
    const p = planTable(table, localMap, cloudMap, fields, verbose, localWins);

    console.log('── ' + table + '  本地 ' + localMap.size + ' / 云端 ' + cloudMap.size + ' / 一致 ' + p.same);
    console.log('   推送新增 ' + p.pushInserts.length + '，推送更新 ' + p.pushUpdates.length
      + '；拉取新增 ' + p.pullInserts.length + '，拉取更新 ' + p.pullUpdates.length);
    if (verbose) {
      ['push', 'pull'].forEach((dir) => {
        p.samples[dir].forEach((s) => {
          console.log('   [' + dir + '] id=' + s.id + ' 本地时间(' + (s.lt || '空') + ') 云端时间(' + (s.ct || '空') + ')');
          s.diffs.forEach((d) => console.log('        ' + d));
        });
      });
    }

    if (!pullOnly) {
      const a = await pushInsertsToCloud(cloud, table, fields, p.pushInserts, dry);
      const b = await pushUpdatesToCloud(cloud, table, fields, p.pushUpdates, dry);
      total.pushAdd += a;
      total.pushUpd += b;
    }
    if (!pushOnly) {
      const r = pullInsertsToLocal(db, table, fields, p.pullInserts, dry);
      const c = pullUpdatesToLocal(db, table, fields, p.pullUpdates, dry);
      total.pullAdd += (r.done !== undefined ? r.done : r);
      total.pullUpd += c;
    }
    total.same += p.same;
    if (!pullOnly) await fixSequence(cloud, table, dry);
  }

  console.log('\n===== 汇总 =====');
  console.log('推送到云端：新增 ' + total.pushAdd + '，更新 ' + total.pushUpd);
  console.log('拉取到本地：新增 ' + total.pullAdd + '，更新 ' + total.pullUpd);
  console.log('一致未动：' + total.same);
  console.log(dry ? '\n这是预演，未写入任何数据。去掉 --dry 才会真正同步。' : '\n同步完成。');
}

main().catch((e) => {
  console.error('同步失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
