'use strict';
/** 地图采集自测：用临时库 + mock fetch，不联网、不碰 lead-gen/data/leads.db */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmp = path.join(os.tmpdir(), `leadgen-maps-${process.pid}.db`);
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.LEADGEN_DB = tmp;

const { db, run, get, all, setSetting, now } = require('../src/db');
const places = require('../src/places');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

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
  // pages: 每页返回的 place 数组；每页都带 nextPageToken（除非已到末尾）
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
  console.log('\n[1] 无 Key 不发起任何请求');
  setSetting('google_places_key', '');
  calls.length = 0;
  let err1 = null;
  try { await places.collectLeads({ keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 20 }, { fetchImpl: makeMock(() => jsonRes(200, {})) }); }
  catch (e) { err1 = e; }
  ok(err1 && err1.code === 'NO_API_KEY', '无 Key 抛 NO_API_KEY');
  ok(err1 && /未配置 Google Places API Key/.test(err1.message), '无 Key 错误文案友好并指引去设置');
  ok(calls.length === 0, '无 Key 时零请求');
  setSetting('google_places_key', 'FAKE-KEY-123');

  console.log('\n[2] 搜索翻页 + 上限 60 截断');
  calls.length = 0;
  const pages = [0, 1, 2, 3].map(p => Array.from({ length: 20 }, (_, i) => searchPlace(p * 20 + i + 1)));
  const r2 = await places.collectLeads(
    { keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 60 },
    { fetchImpl: makeMock(searchHandler(pages)) });
  const searchCalls = calls.filter(c => c.url.includes(':searchText'));
  const detailCalls = calls.filter(c => c.url.includes('/v1/places/'));
  ok(r2.found === 60 && r2.results.length === 60, '最多取 60 条');
  ok(searchCalls.length === 3, '60 条只翻 3 页搜索（第 3 页后即使有 token 也不再翻）');
  ok(detailCalls.length === 60, '每家查 1 次详情');
  ok(r2.inserted === 60 && r2.duplicates === 0, '60 条全部新增入库');
  ok(r2.calls.search === 3 && r2.calls.details === 60 && r2.calls.total === 63, '调用次数明细正确');
  ok(r2.batch_id && get('SELECT source FROM batches WHERE id=?', r2.batch_id).source === 'google_places', '批次来源为 google_places');
  ok(get("SELECT COUNT(*) c FROM leads WHERE source='google_places'").c === 60, '库里 60 条新线索');

  console.log('\n[3] 去重：同域名、同公司名各跳过一次');
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
  ok(r3.results.find(x => x.name === 'Brand New Shop').status === 'new', '新店判定新增');
  ok(get("SELECT COUNT(*) c FROM leads WHERE domain='dup-example.com'").c === 1, '重复域名未重复入库');
  const newLead = get("SELECT * FROM leads WHERE domain='brand-new.example.com'");
  ok(!!newLead && newLead.source === 'google_places' && newLead.industry_hint === 'locksmith' && /places\/ChIJTEST903/.test(newLead.notes || ''), '新线索写对来源/关键词/Places ID');
  const evs = all("SELECT field FROM evidence WHERE lead_id=? AND source='google_places'", newLead.id).map(r => r.field);
  ok(evs.includes('website') && evs.includes('phone') && evs.includes('address'), '新线索写了 website/phone/address 三条证据');

  console.log('\n[4] fieldMask 只含 Pro 字段');
  const searchCall = calls.find(c => c.url.includes(':searchText'));
  const detailCall = calls.find(c => c.url.includes('/v1/places/'));
  ok(searchCall.headers['X-Goog-FieldMask'] === places.SEARCH_FIELD_MASK, '搜索 fieldMask 为约定值');
  ok(detailCall.headers['X-Goog-FieldMask'] === places.DETAILS_FIELD_MASK, '详情 fieldMask 为约定值');
  ok(/internationalPhoneNumber/.test(places.DETAILS_FIELD_MASK) && /websiteUri/.test(places.DETAILS_FIELD_MASK), '详情拿了电话与网址');
  ok(!/reviews|photos|priceLevel|priceRange/.test(places.DETAILS_FIELD_MASK), '详情不含 Enterprise 档字段');
  ok(detailCall.method === 'GET' && /\/v1\/places\/ChIJTEST901$/.test(detailCall.url), '详情用 GET 且 ID 去掉了 places/ 前缀');
  ok(calls.every(c => !c.url.includes('FAKE-KEY-123') && !(c.body || '').includes('FAKE-KEY-123')), 'Key 不出现在 URL 或请求体里（只走请求头）');

  console.log('\n[5] API 报错转中文');
  async function expectApiError(status, gStatus, re) {
    let err = null;
    try {
      await places.collectLeads({ keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 5 }, {
        fetchImpl: makeMock((url) => {
          if (url.includes(':searchText')) return jsonRes(status, { error: { code: status, status: gStatus, message: 'upstream says no' } });
          throw new Error('unexpected url ' + url);
        }),
      });
    } catch (e) { err = e; }
    return err && re.test(err.message) && !err.message.includes('FAKE-KEY-123');
  }
  ok(await expectApiError(403, 'PERMISSION_DENIED', /Places API/), '403 转中文并提示启用 Places API');
  ok(await expectApiError(429, 'RESOURCE_EXHAUSTED', /限流/), '429 转中文限流提示');
  ok(await expectApiError(400, 'INVALID_ARGUMENT', /请求参数无效/), '400 转中文参数提示');

  console.log('\n[6] 定位与半径');
  calls.length = 0;
  const geoMock = makeMock((url, opts) => {
    if (url.includes('geocode')) return jsonRes(200, { status: 'OK', results: [{ geometry: { location: { lat: 6.5244, lng: 3.3792 } } }] });
    if (url.includes(':searchText')) return jsonRes(200, { places: [searchPlace(951)] });
    if (url.includes('/v1/places/')) return jsonRes(200, detailsFor('places/ChIJTEST951'));
    throw new Error('unexpected url ' + url);
  });
  await places.collectLeads({ keyword: 'locksmith', location: 'Lagos, Nigeria', radiusKm: 5, maxResults: 5 }, { fetchImpl: geoMock });
  ok(calls.filter(c => c.url.includes('geocode')).length === 1, '填了半径时定位调 1 次');
  const sc = calls.find(c => c.url.includes(':searchText'));
  const scBody = JSON.parse(sc.body);
  ok(scBody.locationBias && scBody.locationBias.circle && scBody.locationBias.circle.radius === 5000, '半径 5 公里转成 5000 米 circle');
  ok(Math.abs(scBody.locationBias.circle.center.latitude - 6.5244) < 1e-9, '定位坐标带进搜索');
  calls.length = 0;
  await places.collectLeads({ keyword: 'locksmith', location: 'Lagos, Nigeria', maxResults: 5 }, { fetchImpl: geoMock });
  ok(calls.filter(c => c.url.includes('geocode')).length === 0, '不填半径时不定位');
  ok(!JSON.parse(calls.find(c => c.url.includes(':searchText')).body).locationBias, '不填半径时不加 locationBias');

  console.log('\n[7] 预估调用量');
  const est = places.estimateCalls({ maxResults: 20, radiusKm: 5, location: 'Lagos, Nigeria' });
  ok(est.geocode === 1 && est.search === 1 && est.details === 20 && est.total === 22, '20 条+半径预估 22 次');
  const est2 = places.estimateCalls({ maxResults: 60, radiusKm: null, location: '' });
  ok(est2.geocode === 0 && est2.search === 3 && est2.details === 60 && est2.total === 63, '60 条无半径预估 63 次');

  db.close();
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('自测异常：', e);
  try { db.close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exit(1);
});
