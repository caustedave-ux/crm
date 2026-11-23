'use strict';
/**
 * Google Places API (New) 客户端 + 地图采集编排（MVP）
 *
 * 只用 Node 内置 global fetch，不新增任何 npm 依赖。
 * 数据走官方 Places API (New)，不是爬虫：每次调用都按 Google 定价计费，
 * 但每月有免费额度（Text Search Pro 5000 次、Place Details Pro 5000 次、
 * Geocoding 10000 次），超了才收费。
 *
 * 费用口径说明：Places API (New) 按请求的字段分档计费。本模块只拿
 * Pro 档及以下字段（电话、网址、地址、评分等），不碰 Enterprise 档
 * （reviews / photos / priceLevel 等），见下面的 FIELD_MASK。
 * Key 只从 settings 表读（google_places_key），绝不写进代码、日志或错误信息。
 */
const { getSetting, run, get, now } = require('./db');
const norm = require('./normalize');
const importer = require('./importer');
const { sleep, dispatcherFor } = require('./net');

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// 搜索只拿这 4 个字段：id / 名称 / 地址 / 坐标（Essentials 档）。
const SEARCH_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location';
// 详情只拿 Pro 档及以下字段：电话、网址、地址、评分、营业状态、类型、坐标。
// 不含 Enterprise 档字段（reviews / photos / priceLevel / priceRange 等）。
const DETAILS_FIELD_MASK = 'id,displayName,formattedAddress,internationalPhoneNumber,websiteUri,rating,userRatingCount,businessStatus,types,location';

const MAX_PAGE_SIZE = 20;
const MAX_RESULTS = 60;
const MAX_RADIUS_KM = 50;

function getApiKey() {
  return String(getSetting('google_places_key', '') || '').trim();
}
function hasApiKey() {
  return !!getApiKey();
}
function getTimeoutMs() {
  const n = parseInt(getSetting('request_timeout_ms', '15000'), 10);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}
function getDelayMs() {
  const n = parseInt(getSetting('request_delay_ms', '1200'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
}

/** 带 code 的业务错误（message 永远不含 Key）。 */
function placesError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 把 Google / 网络报错翻译成中文友好信息（绝不把 Key 打进去）。 */
function friendlyError(status, payload, fallback) {
  const gStatus = payload && payload.error && payload.error.status;
  const detail = payload && payload.error && payload.error.message ? String(payload.error.message) : '';
  if (status === 401 || gStatus === 'UNAUTHENTICATED') {
    return placesError('PLACES_API', 'Google API Key 无效或未启用 Places API：请检查数据源设置里的 Key 是否填对，并在 Google Cloud 控制台确认已启用 Places API (New)。');
  }
  if (status === 403 || gStatus === 'PERMISSION_DENIED') {
    return placesError('PLACES_API', 'Google 拒绝了这次调用（403）：请在 Google Cloud 控制台启用 Places API (New)，并确认 Key 的 API 限制里放行了 Places API。');
  }
  if (status === 429 || gStatus === 'RESOURCE_EXHAUSTED') {
    return placesError('PLACES_API', '已触发 Google 限流（429）：请稍后再试；如果经常出现，请检查本月免费额度（Text Search / Place Details 各 5000 次）是否用完。');
  }
  if (status === 400 || gStatus === 'INVALID_ARGUMENT') {
    return placesError('PLACES_API', '请求参数无效（400）' + (detail ? '：' + detail : '：请检查关键词、城市或半径是否合法，半径最大 50 公里。'));
  }
  if (status === 404 || gStatus === 'NOT_FOUND') {
    return placesError('PLACES_API', '找不到该地点（404）：可能该商家已被 Google 下架，请跳过。');
  }
  return placesError('PLACES_API', fallback || ('Google 返回错误（HTTP ' + status + '）' + (detail ? '：' + detail : '，请稍后再试。')));
}

/**
 * 发一次 Google 请求。fetchImpl 可注入（自测用 mock），默认用全局 fetch。
 * 出网走系统代理设置（proxy_url），与本服务其他数据源一致。
 */
async function googleFetch(url, opts, fetchImpl) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const timeout = getTimeoutMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const init = {
    method: opts.method || 'GET',
    signal: ctrl.signal,
    headers: { ...(opts.headers || {}) },
  };
  if (opts.body !== undefined) init.body = opts.body;
  // 只有真实 fetch 才挂代理 dispatcher；mock 不需要也不识别该字段。
  if (!fetchImpl) {
    const d = dispatcherFor(url);
    if (d) init.dispatcher = d;
  }
  try {
    const res = await fetchFn(url, init);
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      throw placesError('PLACES_API', '请求 Google 超时（' + Math.round(timeout / 1000) + ' 秒无响应）：请检查网络或数据源设置里的代理地址，稍后再试。');
    }
    throw placesError('PLACES_API', '连接 Google 失败：' + (e && e.message ? String(e.message) : '网络错误') + '。请检查网络或代理设置（数据源设置里的代理地址），稍后再试。');
  }
}

async function readJsonSafe(res) {
  try { return await res.json(); } catch { return null; }
}

/** 把城市/地区文字转经纬度（只在用户填了半径时调用）。 */
async function geocodeLocation(text, opts = {}) {
  const key = getApiKey();
  const url = GEOCODE_URL + '?address=' + encodeURIComponent(text) + '&key=' + encodeURIComponent(key);
  const res = await googleFetch(url, { method: 'GET' }, opts.fetchImpl);
  const data = await readJsonSafe(res);
  if (!res.ok) throw friendlyError(res.status, data, '定位失败');
  if (!data || data.status === 'ZERO_RESULTS' || !Array.isArray(data.results) || !data.results.length) {
    throw placesError('GEOCODE_FAILED', '找不到「' + text + '」的坐标：请换个写法，例如 Lagos, Nigeria；或留空半径直接搜。');
  }
  if (data.status !== 'OK') {
    throw placesError('GEOCODE_FAILED', '定位失败（' + data.status + '）：请检查城市写法，或留空半径直接搜。');
  }
  const loc = data.results[0].geometry && data.results[0].geometry.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
    throw placesError('GEOCODE_FAILED', '定位返回异常：请换个城市写法，或留空半径直接搜。');
  }
  return { lat: loc.lat, lng: loc.lng };
}

/**
 * Text Search 翻页搜索。
 * 返回 { places: [...], calls: n }，places 每项为搜索原始对象。
 */
async function textSearch({ keyword, locationText, center, radiusKm, maxResults }, opts = {}) {
  const textQuery = locationText ? keyword + ' in ' + locationText : keyword;
  const places = [];
  let pageToken = null;
  let calls = 0;
  do {
    const body = { textQuery, pageSize: MAX_PAGE_SIZE, languageCode: 'en' };
    if (pageToken) body.pageToken = pageToken;
    if (center && radiusKm) {
      body.locationBias = { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.round(radiusKm * 1000) } };
    }
    const res = await googleFetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getApiKey(),
        'X-Goog-FieldMask': SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
    }, opts.fetchImpl);
    calls++;
    const data = await readJsonSafe(res);
    if (!res.ok) throw friendlyError(res.status, data, '搜索失败');
    const page = Array.isArray(data && data.places) ? data.places : [];
    places.push(...page);
    pageToken = data && data.nextPageToken ? data.nextPageToken : null;
    // 翻页之间留间隔，避免触发限流
    if (pageToken && places.length < maxResults) await sleep(getDelayMs());
  } while (pageToken && places.length < maxResults);
  return { places: places.slice(0, maxResults), calls };
}

/** 取一家商家的详情（电话、网址、地址、评分等 Pro 档字段）。 */
async function placeDetails(placeId, opts = {}) {
  const id = String(placeId || '').replace(/^places\//, '');
  if (!id) throw placesError('PLACES_API', '商家 ID 为空，跳过。');
  const res = await googleFetch(DETAILS_URL + encodeURIComponent(id), {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': getApiKey(),
      'X-Goog-FieldMask': DETAILS_FIELD_MASK,
    },
  }, opts.fetchImpl);
  const data = await readJsonSafe(res);
  if (!res.ok) throw friendlyError(res.status, data, '查询商家详情失败');
  return data || {};
}

/** 预估调用量（不发请求，供页面展示）。 */
function estimateCalls({ maxResults, radiusKm, location }) {
  const search = Math.max(1, Math.ceil(maxResults / MAX_PAGE_SIZE));
  const details = maxResults;
  const geocode = radiusKm && location ? 1 : 0;
  return { geocode, search, details, total: geocode + search + details };
}

/**
 * 采集编排：定位（如需）→ 翻页搜索 → 逐家查详情 → 按 importer 去重规则入库。
 * 返回汇总 { batch_id, found, inserted, duplicates, skipped, calls, results }。
 * results 每项：{ place_id, name, address, phone, website, rating, user_rating_count, status, lead_id, types, lat, lng, error? }（types/lat/lng 供行业归类与地图打点；详情无坐标时用搜索结果的坐标回退）
 * status: new（新增入库）/ duplicate（重复跳过）/ failed（详情失败未入库）。
 */
async function collectLeads(input, opts = {}) {
  const fetchImpl = opts.fetchImpl;
  const keyword = String(input.keyword || '').trim();
  const location = String(input.location || '').trim();
  const radiusKm = input.radiusKm === '' || input.radiusKm == null ? null : Number(input.radiusKm);
  let maxResults = Math.floor(Number(input.maxResults) || 20);
  maxResults = Math.min(MAX_RESULTS, Math.max(1, maxResults));
  if (!keyword) throw placesError('BAD_INPUT', '请填写关键词，例如 locksmith。');
  if (radiusKm != null && !(radiusKm > 0 && radiusKm <= MAX_RADIUS_KM)) {
    throw placesError('BAD_INPUT', '半径请填 1-' + MAX_RADIUS_KM + ' 公里。');
  }
  // 无 Key 直接报错，不发起任何请求。
  if (!hasApiKey()) {
    throw placesError('NO_API_KEY', '未配置 Google Places API Key，去数据源设置里填写');
  }

  const calls = { geocode: 0, search: 0, details: 0 };
  let center = null;
  if (radiusKm && location) {
    center = await geocodeLocation(location, { fetchImpl });
    calls.geocode++;
  }

  const { places, calls: searchCalls } = await textSearch({ keyword, locationText: location, center, radiusKm, maxResults }, { fetchImpl });
  calls.search += searchCalls;

  // 逐家查详情（间隔 request_delay_ms），失败的单家跳过不中断整批。
  const detailed = [];
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const placeId = p && p.id ? String(p.id) : '';
    const name0 = p && p.displayName && p.displayName.text ? String(p.displayName.text) : '';
    const addr0 = p && p.formattedAddress ? String(p.formattedAddress) : '';
    if (i > 0) await sleep(getDelayMs());
    try {
      const d = await placeDetails(placeId, { fetchImpl });
      calls.details++;
      detailed.push({
        place_id: placeId,
        name: (d.displayName && d.displayName.text) || name0,
        address: d.formattedAddress || addr0,
        phone: d.internationalPhoneNumber || '',
        website: d.websiteUri || '',
        rating: typeof d.rating === 'number' ? d.rating : null,
        user_rating_count: typeof d.userRatingCount === 'number' ? d.userRatingCount : null,
        types: Array.isArray(d.types) ? d.types.slice() : [],
        location: (d.location && typeof d.location.latitude === 'number')
          ? { latitude: d.location.latitude, longitude: d.location.longitude }
          : (p.location && typeof p.location.latitude === 'number'
            ? { latitude: p.location.latitude, longitude: p.location.longitude }
            : null),
        status: 'pending',
      });
    } catch (e) {
      detailed.push({
        place_id: placeId, name: name0, address: addr0, phone: '', website: '',
        rating: null, user_rating_count: null, types: [],
        location: (p.location && typeof p.location.latitude === 'number'
          ? { latitude: p.location.latitude, longitude: p.location.longitude }
          : null),
        status: 'failed', error: e && e.message ? String(e.message) : '详情查询失败',
      });
    }
  }

  // 按 importer 去重规则预判每家是新增还是重复（域名优先，无域名用规范化公司名），
  // 再一次性调 importLeads 建一个 batch 入库（它内部用同一规则去重）。
  const rows = [];
  const seen = new Set();
  const meta = [];
  let skipped = 0;
  for (const d of detailed) {
    if (d.status === 'failed' || !d.name) { skipped++; meta.push({ ...d, status: d.status === 'failed' ? 'failed' : 'skipped' }); continue; }
    const domain = norm.normalizeDomain(d.website || '');
    const dedupKey = domain ? 'd:' + domain : 'n:' + norm.normalizeCompanyName(d.name);
    const existing = get('SELECT id FROM leads WHERE dedup_key=?', dedupKey);
    const isDup = seen.has(dedupKey) || !!existing;
    seen.add(dedupKey);
    const rowIndex = rows.length;
    rows.push({
      company_name: d.name,
      website: d.website,
      country: location,
      industry_hint: keyword,
      notes: 'Google Places: ' + d.place_id,
    });
    meta.push({ ...d, dedupKey, rowIndex, status: isDup ? 'duplicate' : 'new', existing_id: existing ? Number(existing.id) : null });
  }

  let batchId = null;
  let inserted = 0;
  let duplicates = 0;
  let ids = [];
  if (rows.length) {
    const r = importer.importLeads(rows, {
      batch_name: 'Google 地图：' + keyword + (location ? ' @ ' + location : ''),
      source: 'google_places',
      note: 'Places place id 见各线索备注',
    });
    batchId = r.batch_id;
    inserted = r.inserted;
    duplicates = r.duplicates;
    ids = r.ids || [];
    // 给新增线索写证据（website / phone / address，带原始值）。
    const t = now();
    for (const m of meta) {
      if (m.status !== 'new' || m.rowIndex == null) continue;
      const leadId = ids[m.rowIndex];
      if (!leadId) continue;
      const ev = [];
      if (m.website) ev.push(['website', m.website]);
      if (m.phone) ev.push(['phone', m.phone]);
      if (m.address) ev.push(['address', m.address]);
      for (const [field, value] of ev) {
        run('INSERT INTO evidence(lead_id,source,field,raw_value,value,url,snippet,confidence,captured_at) VALUES(?,?,?,?,?,?,?,?,?)',
          leadId, 'google_places', field, value, value, m.website || '', '', 0.9, t);
      }
    }
  }

  const results = meta.map((m) => ({
    place_id: m.place_id,
    name: m.name,
    address: m.address,
    phone: m.phone,
    website: m.website,
    rating: m.rating,
    user_rating_count: m.user_rating_count,
    status: m.status === 'pending' ? 'new' : m.status,
    lead_id: m.rowIndex != null ? (ids[m.rowIndex] || m.existing_id || null) : null,
    types: Array.isArray(m.types) ? m.types : [],
    lat: m.location && typeof m.location.latitude === 'number' ? m.location.latitude : null,
    lng: m.location && typeof m.location.longitude === 'number' ? m.location.longitude : null,
    ...(m.error ? { error: m.error } : {}),
  }));

  return {
    batch_id: batchId,
    found: places.length,
    inserted,
    duplicates,
    skipped,
    calls: { ...calls, total: calls.geocode + calls.search + calls.details },
    results,
  };
}

module.exports = {
  SEARCH_FIELD_MASK, DETAILS_FIELD_MASK, MAX_RESULTS, MAX_RADIUS_KM,
  hasApiKey, getApiKey, estimateCalls,
  geocodeLocation, textSearch, placeDetails, collectLeads,
};
