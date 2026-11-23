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

// 0e. SUITE_FORCE_MIGRATE=1：已有套件库时删旧库重迁（手动重迁逃生口）。
const forceDb = tmp('force-suite.db');
const r0e0 = spawnSync(process.execPath, [childScript], {
  encoding: 'utf8',
  env: { ...process.env, SUITE_DB: forceDb, SUITE_LEGACY_DB: tmp('no-such-legacy.db') },
});
ok(r0e0.status === 0 && /LEADS=0/.test(r0e0.stdout), '强制重迁前置：空库正常启动');
const mkMarker = tmp('mk-marker.js');
fs.writeFileSync(mkMarker, `'use strict';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec("INSERT INTO leads(company_name, dedup_key) VALUES('Marker Row','n:markerrow')");
db.close();
`);
spawnSync(process.execPath, [mkMarker, forceDb], { encoding: 'utf8' });
const r0e = spawnSync(process.execPath, [childScript], {
  encoding: 'utf8',
  env: { ...process.env, SUITE_DB: forceDb, SUITE_LEGACY_DB: legacyDb, SUITE_FORCE_MIGRATE: '1' },
});
ok(/SUITE_FORCE_MIGRATE=1/.test(r0e.stdout) && /\[数据迁移\] 已从 lead-gen 复制线索库（3 条线索）/.test(r0e.stdout), 'SUITE_FORCE_MIGRATE=1 时删现有库重迁并打日志');
ok(/LEADS=3/.test(r0e.stdout), '重迁后新库读到 3 行（标记行已被清掉）');

// 0f. 复制后完整性校验失败：删残文件并报错退出，不静默用空库。
const corruptLegacy = tmp('corrupt-legacy.db');
const mkCorrupt = tmp('mk-corrupt.js');
fs.writeFileSync(mkCorrupt, `'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode=DELETE;');
db.exec("CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, company_name TEXT NOT NULL, website TEXT, domain TEXT, country TEXT, industry_hint TEXT, size_hint TEXT, employee_hint TEXT, source TEXT, status TEXT DEFAULT 'new', overall_score REAL DEFAULT 0, dedup_key TEXT UNIQUE, notes TEXT, created_at TEXT, updated_at TEXT)");
for (let i = 0; i < 50; i++) db.prepare("INSERT INTO leads(company_name, dedup_key, notes) VALUES(?,?,?)").run('Corrupt Shop ' + i, 'n:corrupt' + i, 'x'.repeat(500));
db.close();
const buf = fs.readFileSync(process.argv[2]);
buf.fill(0, 4096, 8192);
fs.writeFileSync(process.argv[2], buf);
`);
spawnSync(process.execPath, [mkCorrupt, corruptLegacy], { encoding: 'utf8' });
const corruptDb = tmp('corrupt-suite.db');
const r0f = spawnSync(process.execPath, [childScript], {
  encoding: 'utf8',
  env: { ...process.env, SUITE_DB: corruptDb, SUITE_LEGACY_DB: corruptLegacy },
});
ok(r0f.status !== 0, '完整性校验失败时进程报错退出（不静默用空库）');
ok(/完整性校验失败/.test((r0f.stderr || '') + (r0f.stdout || '')), '报错信息提到完整性校验失败');
ok(!fs.existsSync(corruptDb) && !fs.existsSync(corruptDb + '-wal'), '完整性失败后残文件已删');

// 0g. 端口被占时启动 server.js：直接退出、不跑迁移、不留残文件。
const { spawn } = require('node:child_process');
const holdPort = tmp('hold-port.js');
fs.writeFileSync(holdPort, `'use strict'; const net = require('node:net'); const s = net.createServer(); s.listen(Number(process.argv[2]), '127.0.0.1', () => console.log('HOLDING')); setInterval(()=>{}, 1000);`);
const holder = spawn(process.execPath, [holdPort, '5399'], { stdio: 'ignore' });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // 等 1.5 秒让 holder 占住端口
const raceDb = tmp('race-suite.db');
const r0g = spawnSync(process.execPath, [path.join(SUITE_ROOT, 'server.js')], {
  encoding: 'utf8',
  timeout: 15000,
  env: { ...process.env, LEADGEN_PORT: '5399', SUITE_DB: raceDb, SUITE_LEGACY_DB: legacyDb },
});
holder.kill();
ok(r0g.status !== 0, '端口被占时 server.js 报错退出');
ok(!/\[数据迁移\]/.test(r0g.stdout || ''), '端口被占时不跑迁移');
ok(!fs.existsSync(raceDb), '端口被占时不留套件库残文件');

// 0h. 旧库 leads 表缺 status 列：补列后再建索引，启动不崩。
// （按审计说的真实场景造：标准 leads 表，只缺 status 一列。）
const noStatusLegacy = tmp('nostatus-legacy.db');
const mkNoStatus = tmp('mk-nostatus.js');
fs.writeFileSync(mkNoStatus, `'use strict';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode=DELETE;');
db.exec("CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, company_name TEXT NOT NULL, website TEXT, domain TEXT, country TEXT, industry_hint TEXT, size_hint TEXT, employee_hint TEXT, source TEXT, overall_score REAL DEFAULT 0, dedup_key TEXT UNIQUE, notes TEXT, created_at TEXT, updated_at TEXT)");
db.exec("INSERT INTO leads(company_name, dedup_key) VALUES('NoStatus A','n:nostatusa'),('NoStatus B','n:nostatusb')");
db.close();
`);
spawnSync(process.execPath, [mkNoStatus, noStatusLegacy], { encoding: 'utf8' });
const r0h = spawnSync(process.execPath, [childScript], {
  encoding: 'utf8',
  env: { ...process.env, SUITE_DB: tmp('nostatus-suite.db'), SUITE_LEGACY_DB: noStatusLegacy },
});
ok(r0h.status === 0 && /LEADS=2/.test(r0h.stdout), '旧库缺 status 列时迁移+启动正常（补列后建索引）');

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

  console.log('\n[7] M5 校验 + L9 电话归一化 + M6 统计口径 + M3 代理状态');
  const validate = require('../src/validate');
  ok(validate.isValidLeadStatus('review') === true, 'M5：review 是合法线索状态');
  ok(validate.isValidLeadStatus('bogus') === false, 'M5：bogus 不是合法线索状态');
  ok(validate.validateSettingsBody({ evil_key: 'pwned' }).ok === false, 'M5：未知设置项整单拒绝');
  ok(validate.validateSettingsBody({ proxy_url: 'http://127.0.0.1:7897' }).ok === true, 'M5：白名单内设置项通过');
  ok(validate.validateSettingsBody({ proxy_url: { x: 1 } }).ok === false, 'M5：设置值非字符串/数字拒绝');
  const views = require('../src/views');
  ok(views.normalizeWaNumber('0803 123 4567', 'Nigeria').digits === '2348031234567', 'L9：尼日利亚本地号 0803… 补区号 +234');
  ok(views.normalizeWaNumber('0803 123 4567', 'Nigeria').prefixed === true, 'L9：补区号时 prefixed 为 true');
  ok(views.normalizeWaNumber('+234 803 123 4567', 'Nigeria').digits === '2348031234567', 'L9：已有 +234 国际号不动');
  ok(views.normalizeWaNumber('01 42 68 53 00', 'France').digits === '33142685300', 'L9：法国本地号补区号 +33');
  ok(views.normalizeWaNumber('0803 123 4567', '').digits === '08031234567', 'L9：国家未知时不编造区号');
  const { proxyStatus } = require('../src/net');
  const ps = proxyStatus();
  ok(ps.proxyUrl === 'http://127.0.0.1:7897', 'M3：proxyStatus 读到默认代理地址');
  ok(ps.willUseProxy === (ps.proxyUrl !== '' && ps.proxyAgentLoaded), 'M3：willUseProxy 口径 = 地址已配且 undici 已加载');
  ok(ps.willUseProxy ? ps.warning === '' : ps.warning !== '', 'M3：代理不可用时有警告、可用时无警告');
  run("INSERT INTO leads(company_name,status,dedup_key,created_at,updated_at) VALUES('Stat Test','new','n:stattest',?,?)", t, t);
  const pendingCount = get("SELECT COUNT(*) c FROM leads WHERE status='new'").c;
  const st = require('../src/db').stats();
  ok(st.pending === pendingCount && pendingCount >= 1, 'M6：待跟进 = status=new 的真实条数');
  ok(st.verified === undefined && st.review === undefined && st.approved === undefined, 'M6：stats 不再返回 verified/review/approved 死指标');

  console.log('\n[8] places：翻页 token 未就绪重试 / 保留已取页 / 详情计数');
  setSetting('google_places_key', 'FAKE-KEY-123');
  setSetting('request_delay_ms', '0');
  // [8a] 第 2 页第一次 400 INVALID_ARGUMENT，重试后成功：40 条全取。
  let p2a = 0, p1aDone = false;
  const r8a = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 40 },
    {
      fetchImpl: makeMock((url) => {
        if (url.includes(':searchText')) {
          if (!p1aDone) { p1aDone = true; return jsonRes(200, { places: Array.from({ length: 20 }, (_, i) => searchPlace(1001 + i)), nextPageToken: 'tok1' }); }
          p2a++;
          if (p2a === 1) return jsonRes(400, { error: { status: 'INVALID_ARGUMENT', message: 'token not ready' } });
          return jsonRes(200, { places: Array.from({ length: 20 }, (_, i) => searchPlace(1021 + i)) });
        }
        if (url.includes('/v1/places/')) { const pid = decodeURIComponent(url.split('/v1/places/')[1]); return jsonRes(200, detailsFor(pid)); }
        throw new Error('unexpected url ' + url);
      }),
    });
  ok(r8a.found === 40 && r8a.truncated === false, 'M2：token 未就绪重试后成功，40 条全取');
  ok(r8a.calls.search === 3, 'M2：重试多发 1 次搜索调用（第 1 页 + 第 2 页两次尝试）');
  ok(r8a.inserted === 40, 'M2：重试成功后 40 条全部入库');
  // [8b] 第 2 页一直 400：保留已拿到的 20 条继续入库，不整批丢弃。
  let p1bDone = false;
  const r8b = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 40 },
    {
      fetchImpl: makeMock((url) => {
        if (url.includes(':searchText')) {
          if (!p1bDone) { p1bDone = true; return jsonRes(200, { places: Array.from({ length: 20 }, (_, i) => searchPlace(2001 + i)), nextPageToken: 'tok1' }); }
          return jsonRes(400, { error: { status: 'INVALID_ARGUMENT', message: 'token not ready' } });
        }
        if (url.includes('/v1/places/')) { const pid = decodeURIComponent(url.split('/v1/places/')[1]); return jsonRes(200, detailsFor(pid)); }
        throw new Error('unexpected url ' + url);
      }),
    });
  ok(r8b.found === 20 && r8b.truncated === true, 'M2：翻页一直失败时保留已拿到的 20 条，不整批丢弃');
  ok(r8b.inserted === 20, 'M2：保留的 20 条正常入库');
  ok(r8b.calls.search === 4, 'M2：翻页重试 2 次后放弃（第 1 页 + 第 2 页 3 次尝试）');
  // [8c] 单家详情失败：只跳过该家，详情调用按请求发出计数（失败的也算）。
  const r8c = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 20 },
    {
      fetchImpl: makeMock((url) => {
        if (url.includes(':searchText')) return jsonRes(200, { places: [searchPlace(3001), searchPlace(3002), searchPlace(3003)] });
        if (url.includes('/v1/places/')) {
          const pid = decodeURIComponent(url.split('/v1/places/')[1]);
          if (pid === 'ChIJTEST3002') return jsonRes(500, { error: { status: 'INTERNAL', message: 'boom' } });
          return jsonRes(200, detailsFor(pid));
        }
        throw new Error('unexpected url ' + url);
      }),
    });
  ok(r8c.found === 3 && r8c.inserted === 2 && r8c.skipped === 1, 'M2：单家详情失败只跳过该家，不中断整批');
  ok(r8c.calls.details === 3 && r8c.calls.total === 4, 'M2：详情调用按请求发出计数（失败的也算）');
  ok(r8c.results.find(x => x.name.includes('3002')).status === 'failed', 'M2：详情失败的结果标 failed');

  console.log('\n[9] web.js：超大 body 返回 413，500 不吐堆栈');
  const { createApp, Router } = require('../src/web');
  const http = require('node:http');
  const r9 = new Router();
  r9.post('/api/echo', ctx => ctx.res.json(200, { ok: true, got: ctx.body }));
  const { server: srv9 } = createApp(r9, {});
  await new Promise(res => srv9.listen(0, '127.0.0.1', res));
  const port9 = srv9.address().port;
  function postRaw(pathname, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: port9, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const big = JSON.stringify({ x: 'A'.repeat(2100000) });
  const rBig = await postRaw('/api/echo', big);
  ok(rBig.status === 413 && /超过 2MB/.test(rBig.body), 'L7：超过 2MB 的 body 返回 413');
  const rSmall = await postRaw('/api/echo', JSON.stringify({ x: 'hi' }));
  ok(rSmall.status === 200, 'L7：正常 body 不受影响');
  r9.get('/api/boom', () => { throw new Error('secret-boom-marker'); });
  const boom = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port9, path: '/api/boom' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  ok(boom.status === 500 && !/secret-boom-marker/.test(boom.body) && /服务器内部错误/.test(boom.body), 'L7：500 只给通用文案，不吐堆栈');
  await new Promise(res => srv9.close(res));

  console.log('\n[10] places：collectLeads onProgress 实时进度回调');
  const progress = [];
  const r10 = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 20 },
    {
      fetchImpl: makeMock((url) => {
        if (url.includes(':searchText')) return jsonRes(200, { places: [searchPlace(4001), searchPlace(4002), searchPlace(4003)] });
        if (url.includes('/v1/places/')) { const pid = decodeURIComponent(url.split('/v1/places/')[1]); return jsonRes(200, detailsFor('places/' + pid)); }
        throw new Error('unexpected url ' + url);
      }),
      onProgress: (p) => progress.push({ ...p }),
    });
  ok(r10.found === 3, 'onProgress 场景：3 家商家正常采集');
  ok(progress.length === 3, 'onProgress：每查完一家详情调一次，共 3 次');
  ok(progress.map(p => p.detailed).join(',') === '1,2,3', 'onProgress：detailed 依次为 1、2、3');
  ok(progress.every(p => p.total === 3), 'onProgress：total 为本次搜索到的商家数 3');
  ok(progress.map(p => p.name).join('|') === 'Test Shop 4001|Test Shop 4002|Test Shop 4003', 'onProgress：name 为刚查完的那家商家名，按顺序');
  // 不传 onProgress 时不影响采集（向后兼容）。
  const r10b = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 20 },
    {
      fetchImpl: makeMock((url) => {
        if (url.includes(':searchText')) return jsonRes(200, { places: [searchPlace(4011)] });
        if (url.includes('/v1/places/')) { const pid = decodeURIComponent(url.split('/v1/places/')[1]); return jsonRes(200, detailsFor('places/' + pid)); }
        throw new Error('unexpected url ' + url);
      }),
    });
  ok(r10b.found === 1 && r10b.inserted === 1, '不传 onProgress 时采集不受影响');

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
