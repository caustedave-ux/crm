'use strict';
/** 获客工作台自测：数据迁移 / places mock / 导入去重。
 * 只用 /tmp 临时库，不碰 lead-gen/data/ 与 suite/data/ 下的真实数据库，不联网。 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SUITE_ROOT = path.join(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-suite-selftest-'));
function tmp(name) { return path.join(tmpRoot, name); }
function hash(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function rm(f) { try { fs.unlinkSync(f); } catch {} }

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}
function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// ── [0] 数据迁移（子进程跑，避免与本进程的库互相干扰）──
console.log('\n[0] 数据迁移：复制旧库（.db + -wal），源文件不动，失败不崩启动');
// 0a. 造一个带 -wal 的假旧库：子进程里建库、写 3 行、不 close 直接 process.exit，-wal 留在磁盘上。
const legacyDb = tmp('legacy-leads.db');
const mkLegacy = tmp('mk-legacy.js');
fs.writeFileSync(mkLegacy, `'use strict';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode=WAL;');
db.exec("CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, company_name TEXT NOT NULL, website TEXT, domain TEXT, country TEXT, industry_hint TEXT, size_hint TEXT, employee_hint TEXT, source TEXT, status TEXT DEFAULT 'new', overall_score REAL DEFAULT 0, dedup_key TEXT UNIQUE, notes TEXT, created_at TEXT, updated_at TEXT)");
db.exec("INSERT INTO leads(company_name, dedup_key) VALUES('Mig Shop A','n:migshopa'),('Mig Shop B','n:migshopb'),('Mig Shop C','n:migshopc')");
process.exit(0);
`);
spawnSync(process.execPath, [mkLegacy, legacyDb], { encoding: 'utf8' });
ok(fs.existsSync(legacyDb), '假旧库 .db 已生成');
ok(fs.existsSync(legacyDb + '-wal'), '假旧库 -wal 已生成（未 checkpoint 的数据在 wal 里）');

const childScript = tmp('run-db.js');
fs.writeFileSync(childScript, `'use strict';
const { get } = require(${JSON.stringify(path.join(SUITE_ROOT, 'src', 'db.js'))});
console.log('LEADS=' + get('SELECT COUNT(*) c FROM leads').c);
`);
// 0b. 目标库不存在 → 跑迁移，子进程应打迁移日志、新库读到 3 行。
const newDb = tmp('suite-leads.db');
const beforeDbHash = hash(legacyDb);
const beforeWalHash = fs.existsSync(legacyDb + '-wal') ? hash(legacyDb + '-wal') : null;
const r0 = spawnSync(process.execPath, [childScript], {
  encoding: 'utf8',
  env: { ...process.env, SUITE_DB: newDb, SUITE_LEGACY_DB: legacyDb },
});
ok(/\[数据迁移\] 已从 lead-gen 复制线索库（3 条线索）/.test(r0.stdout), '迁移打日志并校验到 3 条线索');
ok(/LEADS=3/.test(r0.stdout), '迁移后新库读到 3 行（含 -wal 里的数据）');
ok(fs.existsSync(newDb), '新库文件已生成');
ok(hash(legacyDb) === beforeDbHash, '源 .db 文件 hash 不变');
ok(beforeWalHash === null || hash(legacyDb + '-wal') === beforeWalHash, '源 -wal 文件 hash 不变');
// 0c. 目标库已存在 → 不再迁移。
const r0c = spawnSync(process.execPath, [childScript], {
  encoding: 'utf8',
  env: { ...process.env, SUITE_DB: newDb, SUITE_LEGACY_DB: legacyDb },
});
ok(!/\[数据迁移\]/.test(r0c.stdout) && /LEADS=3/.test(r0c.stdout), '目标库已存在时不重复迁移');
// 0d. 旧库不存在 → 不崩启动，空库打开。
const r0d = spawnSync(process.execPath, [childScript], {
  encoding: 'utf8',
  env: { ...process.env, SUITE_DB: tmp('empty.db'), SUITE_LEGACY_DB: tmp('no-such-legacy.db') },
});
ok(r0d.status === 0 && /LEADS=0/.test(r0d.stdout), '无旧库时空库正常启动');

// ── 主进程库：临时库 + 不存在的旧库路径（不触发真实迁移）──
const mainDb = tmp('main.db');
process.env.SUITE_DB = mainDb;
process.env.SUITE_LEGACY_DB = tmp('no-such-legacy.db');

const { db, run, get, all, getSetting, setSetting, now } = require('../src/db');
const places = require('../src/places');
const importer = require('../src/importer');

ok(get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='tasks'").c === 1, '新表 tasks 已建');
ok(get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='send_records'").c === 1, '新表 send_records 已建');
ok(get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='letter_templates'").c === 1, '新表 letter_templates 已建');
ok(get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='leads'").c === 1, '旧表 leads 仍在');
ok(getSetting('google_places_key', 'X') === '', '默认设置含 google_places_key 空值');
ok(getSetting('proxy_url') === 'http://127.0.0.1:7897', '默认代理 127.0.0.1:7897');

setSetting('google_places_key', 'FAKE-KEY-123');
setSetting('request_delay_ms', '0');
setSetting('request_timeout_ms', '5000');

const calls = [];
function jsonRes(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function makeMock(handler) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || null });
    return handler(String(url), opts);
  };
}
function searchPlace(i, over = {}) {
  return {
    id: 'places/ChIJTEST' + String(i).padStart(3, '0'),
    displayName: { text: 'Test Shop ' + i },
    formattedAddress: i + ' Test Street, Lagos',
    location: { latitude: 6.45, longitude: 3.39 },
    ...over,
  };
}
function detailsFor(placeId, over = {}) {
  const n = String(placeId).replace(/^places\/ChIJTEST/, '');
  return {
    id: placeId,
    displayName: { text: 'Test Shop ' + n },
    formattedAddress: n + ' Test Street, Lagos',
    internationalPhoneNumber: '+234 800 000 ' + n,
    websiteUri: 'https://shop' + n + '.example.com',
    rating: 4.5,
    userRatingCount: 12,
    businessStatus: 'OPERATIONAL',
    types: ['locksmith'],
    ...over,
  };
}
function searchHandler(pages) {
  let pageIdx = 0;
  return (url) => {
    if (url.includes(':searchText')) {
      const page = pages[pageIdx++] || [];
      const hasMore = pageIdx < pages.length;
      return jsonRes(200, { places: page, ...(hasMore ? { nextPageToken: 'tok' + pageIdx } : {}) });
    }
    if (url.includes('/v1/places/')) {
      const pid = decodeURIComponent(url.split('/v1/places/')[1]);
      return jsonRes(200, detailsFor(pid));
    }
    throw new Error('unexpected url ' + url);
  };
}

(async () => {
  console.log('\n[1] places：无 Key 不发起任何请求');
  setSetting('google_places_key', '');
  calls.length = 0;
  let err1 = null;
  try { await places.collectLeads({ keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 20 }, { fetchImpl: makeMock(() => jsonRes(200, {})) }); }
  catch (e) { err1 = e; }
  ok(err1 && err1.code === 'NO_API_KEY', '无 Key 抛 NO_API_KEY');
  ok(err1 && /未配置 Google Places API Key/.test(err1.message), '无 Key 错误文案友好并指引去设置');
  ok(calls.length === 0, '无 Key 时零请求');
  setSetting('google_places_key', 'FAKE-KEY-123');

  console.log('\n[2] places：搜索翻页 + 上限 60 截断');
  calls.length = 0;
  const pages = [0, 1, 2, 3].map(p => Array.from({ length: 20 }, (_, i) => searchPlace(p * 20 + i + 1)));
  const r2 = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 60 },
    { fetchImpl: makeMock(searchHandler(pages)) });
  const searchCalls = calls.filter(c => c.url.includes(':searchText'));
  const detailCalls = calls.filter(c => c.url.includes('/v1/places/'));
  ok(r2.found === 60 && r2.results.length === 60, '最多取 60 条');
  ok(searchCalls.length === 3, '60 条只翻 3 页搜索');
  ok(detailCalls.length === 60, '每家查 1 次详情');
  ok(r2.inserted === 60 && r2.duplicates === 0, '60 条全部新增入库');
  ok(r2.calls.search === 3 && r2.calls.details === 60 && r2.calls.total === 63, '调用次数明细正确');
  ok(r2.batch_id && get('SELECT source FROM batches WHERE id=?', r2.batch_id).source === 'google_places', '批次来源为 google_places');

  console.log('\n[3] places：去重（同域名、同公司名各跳过一次）');
  const t = now();
  run("INSERT INTO leads(company_name,website,domain,status,dedup_key,created_at,updated_at) VALUES('Dup Domain Ltd','https://dup-example.com','dup-example.com','new','d:dup-example.com',?,?)", t, t);
  run("INSERT INTO leads(company_name,status,dedup_key,created_at,updated_at) VALUES('NoSite Hardware','new','n:nositehardware',?,?)", t, t);
  calls.length = 0;
  const dupPlaces = [
    searchPlace(901, { displayName: { text: 'Dup Domain Ltd' } }),
    searchPlace(902, { displayName: { text: 'NoSite Hardware Ltd.' } }),
    searchPlace(903, { displayName: { text: 'Brand New Shop' } }),
  ];
  const dupDetails = {
    'places/ChIJTEST901': detailsFor('places/ChIJTEST901', { displayName: { text: 'Dup Domain Ltd' }, websiteUri: 'https://www.dup-example.com/about' }),
    'places/ChIJTEST902': detailsFor('places/ChIJTEST902', { displayName: { text: 'NoSite Hardware Ltd.' }, websiteUri: '' }),
    'places/ChIJTEST903': detailsFor('places/ChIJTEST903', { displayName: { text: 'Brand New Shop' }, websiteUri: 'https://brand-new.example.com' }),
  };
  const r3 = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 20 },
    { fetchImpl: makeMock((url) => {
      if (url.includes(':searchText')) return jsonRes(200, { places: dupPlaces });
      if (url.includes('/v1/places/')) {
        const pid = decodeURIComponent(url.split('/v1/places/')[1]);
        return jsonRes(200, dupDetails['places/' + pid]);
      }
      throw new Error('unexpected url ' + url);
    }) });
  ok(r3.inserted === 1 && r3.duplicates === 2, '新增 1 家、重复跳过 2 家');
  ok(r3.results.find(x => x.name === 'Dup Domain Ltd').status === 'duplicate', '同域名判定重复');
  ok(r3.results.find(x => x.name === 'NoSite Hardware Ltd.').status === 'duplicate', '同公司名（无网址）判定重复');
  ok(get("SELECT COUNT(*) c FROM leads WHERE domain='dup-example.com'").c === 1, '重复域名未重复入库');
  const newLead = get("SELECT * FROM leads WHERE domain='brand-new.example.com'");
  ok(!!newLead && newLead.source === 'google_places' && newLead.industry_hint === 'locksmith', '新线索写对来源/关键词');
  const evs = all("SELECT field FROM evidence WHERE lead_id=? AND source='google_places'", newLead.id).map(r => r.field);
  ok(evs.includes('website') && evs.includes('phone') && evs.includes('address'), '新线索写了 website/phone/address 三条证据');

  console.log('\n[4] places：fieldMask 只含 Pro 字段，Key 不进 URL/请求体');
  const searchCall = calls.find(c => c.url.includes(':searchText'));
  const detailCall = calls.find(c => c.url.includes('/v1/places/'));
  ok(searchCall.headers['X-Goog-FieldMask'] === places.SEARCH_FIELD_MASK, '搜索 fieldMask 为约定值');
  ok(detailCall.headers['X-Goog-FieldMask'] === places.DETAILS_FIELD_MASK, '详情 fieldMask 为约定值');
  ok(!/reviews|photos|priceLevel|priceRange/.test(places.DETAILS_FIELD_MASK), '详情不含 Enterprise 档字段');
  ok(calls.every(c => !c.url.includes('FAKE-KEY-123') && !(c.body || '').includes('FAKE-KEY-123')), 'Key 不出现在 URL 或请求体里（只走请求头）');

  console.log('\n[5] places：预估调用量');
  const est = places.estimateCalls({ maxResults: 20, radiusKm: 5, location: 'Lagos, Nigeria' });
  ok(est.geocode === 1 && est.search === 1 && est.details === 20 && est.total === 22, '20 条+半径预估 22 次');
  const est2 = places.estimateCalls({ maxResults: 60, radiusKm: null, location: '' });
  ok(est2.geocode === 0 && est2.search === 3 && est2.details === 60 && est2.total === 63, '60 条无半径预估 63 次');

  console.log('\n[6] 导入解析与去重（复用 importer）');
  const rows = importer.parseRows('公司名称,网址,国家,行业\nA公司,a.com,USA,hardware\nB公司,b.com,Germany,electronics');
  ok(rows.length === 2 && rows[0].company_name === 'A公司', 'CSV 列名识别');
  const rows2 = importer.parseRows('A公司\tb.com\nC公司\tc.com');
  ok(rows2[0].company_name === 'A公司' && rows2[0].website === 'b.com', '无表头 TSV 解析');
  const imp1 = importer.importLeads([{ company_name: 'Dup Co', website: 'https://dup-example.com' }, { company_name: 'Fresh Co', website: 'https://fresh.example.com' }], { source: 'manual' });
  ok(imp1.inserted === 1 && imp1.duplicates === 1, '导入按域名去重：已存在域名跳过');
  const imp2a = importer.importLeads([{ company_name: 'NoSite Co' }], { source: 'manual' });
  ok(imp2a.inserted === 1, '无网址公司首次导入新增');
  const imp2 = importer.importLeads([{ company_name: 'NoSite Co Ltd.' }], { source: 'manual' });
  ok(imp2.inserted === 0 && imp2.duplicates === 1, '导入按规范化公司名去重（无网址）');

  db.close();
  cleanup();
  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('自测异常：', e);
  try { db.close(); } catch {}
  cleanup();
  process.exit(1);
});
