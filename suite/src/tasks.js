'use strict';
/**
 * 采集任务引擎（获客工作台 · 任务流）
 *
 * 任务状态流转：queued（排队中）→ running（采集中）→ organizing（整理中）→ done（已完成）
 * 任何一步抛错 → failed（失败），error 写中文友好信息（places.js 已保证错误信息不含 Key，
 * 这里只做透传，不把原始错误对象打进日志或错误字段）。
 *
 * 整理逻辑是确定性规则（规则版整理；如需 DeepSeek 深度画像，后续在 organizeStep 里接）：
 * 不调任何 LLM，不需要新 Key。规则见下方的 TYPE_INDUSTRY / KEYWORD_INDUSTRY 与
 * buildProfile——按 Places types 映射中文行业，提炼一句话画像写进 leads.notes。
 *
 * 注意（与 suite/src/places.js 的约定）：
 * - collectLeads 的 results 元素含 types 与 lat/lng（详情 types 优先、缺失时用搜索
 *   结果的坐标回退），行业映射优先用 result.types，没有 types 时用任务 keyword
 *   做关键词回退映射，仍映射不到写“综合五金”；任务完成后结果原文存 tasks.results_json，
 *   供地图打点（GET /api/tasks/:id 返回 task.results）。
 * - collectLeads(input, opts)：fetchImpl 在第二个参数 opts 里（与 lead-gen 同款签名）；
 *   runTask(id, opts) 收到 fetchImpl 时会同时放进 input 与 opts，两种读取方式都兼容。
 * - estimateCalls 直接 re-export places.js 的同名函数，不自己重算；其实测签名是
 *   estimateCalls({ maxResults, radiusKm, location })（对象参数）。
 * - 任务状态统一用 organizing（AI 整理中）；enriching 只作为旧数据的别名保留在
 *   各处徽章映射里，不再新写。
 *
 * 幂等 / 并发假设（供 server.js 接线参考）：
 * - runTask 只接受 status='queued' 的任务，running/done 的任务再次调用会抛中文错；
 *   因此 runTask 本身不是幂等的——不要对同一个任务重复调用，失败重试请走 retryTask。
 * - organizeStep 写画像时有去重保护：同一条画像已在 leads.notes 里时不再重复追加，
 *   industry_hint 的覆盖写本身也是幂等的。
 * - startRunner 同一时间只跑一个任务（500ms 轮询 + busy 锁，取 created_at 最早的
 *   queued 任务）；重复调用 startRunner 不会起第二个定时器，返回同一个 stop 函数。
 * - 进程崩溃时卡在 running 的任务，startRunner() 启动时会认领回 queued 重跑
 *   （reclaimStaleTasks），不用人工改库。
 */
const { run, get, all } = require('./db');
const places = require('./places');

const MAX_RESULTS = 60;
const MAX_RADIUS_KM = 50;
const RUNNER_INTERVAL_MS = 500;

const STATUS_LABEL = {
  queued: '排队中',
  running: '采集中',
  organizing: '整理中',
  enriching: '整理中', // 旧别名，只读不写
  done: '已完成',
  failed: '失败',
};

function now() { return new Date().toISOString(); }

/** Places types → 中文行业（按优先级匹配；值为 null 的是通用类型，跳过继续找）。 */
const TYPE_INDUSTRY = [
  ['locksmith', '门窗与安防五金'],
  ['hardware_store', '五金零售'],
  ['home_goods_store', '家居五金'],
  ['furniture_store', '家具五金'],
  ['home_improvement_store', '建材五金'],
  ['building_materials_store', '建材五金'],
  ['general_contractor', '工程五金'],
  ['construction_company', '工程五金'],
  ['door_supplier', '门窗与安防五金'],
  ['security_system_supplier', '门窗与安防五金'],
  // 通用类型：不单独定行业，继续匹配后面的 types
  ['store', null],
  ['point_of_interest', null],
  ['establishment', null],
  ['premise', null],
];
const TYPE_INDUSTRY_MAP = new Map(TYPE_INDUSTRY);

/** 关键词回退映射（results 里没有 types 时用任务 keyword 匹配）。 */
const KEYWORD_INDUSTRY = [
  [/locksmith|lock|door|门锁|安防/i, '门窗与安防五金'],
  [/furniture|家具/i, '家具五金'],
  [/home|家居/i, '家居五金'],
  [/build|construct|建材|工程/i, '建材五金'],
  [/hardware|五金/i, '五金零售'],
];

/**
 * 按 Places types 映射中文行业；types 为空或映射不到时用 keyword 回退；
 * 仍映射不到写“综合五金”。
 */
function mapIndustry(types, keyword) {
  const list = Array.isArray(types) ? types : [];
  for (const t of list) {
    const key = String(t || '').trim().toLowerCase();
    if (!key) continue;
    if (TYPE_INDUSTRY_MAP.has(key)) {
      const v = TYPE_INDUSTRY_MAP.get(key);
      if (v) return v;
    }
  }
  const kw = String(keyword || '').trim();
  if (kw) {
    for (const [re, industry] of KEYWORD_INDUSTRY) {
      if (re.test(kw)) return industry;
    }
  }
  return '综合五金';
}

/** 一句话画像。rating 为空时写“评分 未公开”，phone 为空时写“未公开”。 */
function buildProfile({ name, industry, country, rating, userRatingCount, phone }) {
  const ratingPart = rating == null
    ? '评分 未公开'
    : '评分 ' + rating + (userRatingCount != null ? '（' + userRatingCount + ' 条评价）' : '');
  // 有评分时按任务书格式直接接“）· 电话”；无评分时用“ · 电话”分隔，避免“未公开·”连读
  const phoneSep = rating == null ? ' · 电话 ' : '· 电话 ';
  return (name || '') + ' · ' + (industry || '综合五金') + ' · ' + (country || '未公开')
    + ' · ' + ratingPart + phoneSep + (phone || '未公开');
}

/** 把错误翻译成中文友好信息（不含 Key：places.js 的错误信息本身已不含 Key）。 */
function toFriendlyMessage(e) {
  const m = e && e.message ? String(e.message).trim() : '';
  return m || '采集失败，请稍后重试。';
}

function normalizeRadius(radiusKm) {
  if (radiusKm === '' || radiusKm == null) return null;
  const n = Number(radiusKm);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_RADIUS_KM) {
    throw new Error('半径请填 1-' + MAX_RADIUS_KM + ' 公里。');
  }
  return n;
}

function normalizeMaxResults(maxResults) {
  if (maxResults === '' || maxResults == null) return 20;
  const n = Math.floor(Number(maxResults));
  if (!Number.isFinite(n)) return 20;
  return Math.min(MAX_RESULTS, Math.max(1, n));
}

/** 新建采集任务：插入一行 status='queued' 并返回任务行。 */
function createTask({ keyword, location, radiusKm, maxResults }) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('请填写关键词，例如 locksmith。');
  const loc = String(location || '').trim();
  const radius = normalizeRadius(radiusKm);
  const max = normalizeMaxResults(maxResults);
  const r = run(
    'INSERT INTO tasks(keyword,location,radius_km,max_results,status,total,done,created_at) VALUES(?,?,?,?,?,?,?,?)',
    kw, loc, radius, max, 'queued', 0, 0, now()
  );
  return getTask(Number(r.lastInsertRowid));
}

function getTask(id) {
  const row = get('SELECT * FROM tasks WHERE id=?', Number(id));
  return row || null;
}

function listTasks(limit = 20) {
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  // 列表不带 results_json（结果原文只在单个任务详情里返回，避免列表响应过大）
  return all('SELECT id, keyword, location, radius_km, max_results, status, total, done, batch_id, error, center_lat, center_lng, created_at, started_at, finished_at FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?', n);
}

/**
 * 整理步（规则版）：对 results 里每个有 lead_id 的结果做整理——
 * 按 types/keyword 映射行业写回 leads.industry_hint，提炼一句话画像追加进
 * leads.notes（已有 notes 时追加不覆盖；同一画像已存在时不再重复追加）。
 * 每整理完一家，tasks.done + 1。返回已整理条数。
 */
function organizeStep(task, results) {
  let organized = 0;
  for (const r of results || []) {
    const leadId = r && r.lead_id != null ? Number(r.lead_id) : null;
    if (!leadId) continue; // 详情失败 / 未入库的结果没有 lead_id，跳过不计数
    const lead = get('SELECT * FROM leads WHERE id=?', leadId);
    if (!lead) continue;
    const industry = mapIndustry(r.types, task.keyword);
    const profile = buildProfile({
      name: r.name || lead.company_name,
      industry,
      country: lead.country || task.location || '',
      rating: r.rating,
      userRatingCount: r.user_rating_count,
      phone: r.phone || '',
    });
    const oldNotes = lead.notes ? String(lead.notes) : '';
    const notes = oldNotes.includes(profile)
      ? oldNotes
      : (oldNotes ? oldNotes + '\n' + profile : profile);
    run('UPDATE leads SET industry_hint=?, notes=?, updated_at=? WHERE id=?',
      industry, notes, now(), leadId);
    organized++;
    run('UPDATE tasks SET done=? WHERE id=?', organized, task.id);
  }
  return organized;
}

/**
 * 执行一个任务：queued → running →（collectLeads 采集入库）→ organizing（逐家整理）
 * → done；任何一步抛错 → failed（error 写中文友好信息，finished_at 照记）。
 * opts.fetchImpl 仅供自测注入 mock fetch，生产调用不要传。
 */
async function runTask(id, opts = {}) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在。');
  if (task.status !== 'queued') {
    throw new Error('任务当前状态为「' + (STATUS_LABEL[task.status] || task.status) + '」，只有排队中的任务可以执行。');
  }
  run("UPDATE tasks SET status='running', started_at=?, error=NULL WHERE id=?", now(), task.id);
  try {
    const input = {
      keyword: task.keyword,
      location: task.location || '',
      radiusKm: task.radius_km,
      maxResults: task.max_results,
    };
    const callOpts = {};
    if (opts.fetchImpl) {
      input.fetchImpl = opts.fetchImpl; // 兼容 input 内读取 fetchImpl 的实现
      callOpts.fetchImpl = opts.fetchImpl; // places.js 的标准签名是 (input, opts)
    }
    const res = await places.collectLeads(input, callOpts);
    const batchId = res && res.batch_id != null ? Number(res.batch_id) : null;
    const found = res && typeof res.found === 'number'
      ? res.found
      : (Array.isArray(res && res.results) ? res.results.length : 0);
    // 服务端定位到的城市中心坐标存下来，供地图页直接用（L3，不再让浏览器重算）。
    const centerLat = res && res.center && typeof res.center.lat === 'number' ? res.center.lat : null;
    const centerLng = res && res.center && typeof res.center.lng === 'number' ? res.center.lng : null;
    run("UPDATE tasks SET batch_id=?, total=?, results_json=?, status='organizing', center_lat=?, center_lng=? WHERE id=?", batchId, found, JSON.stringify(res.results || []), centerLat, centerLng, task.id);
    const organized = organizeStep(task, res.results || []);
    run("UPDATE tasks SET status='done', done=?, finished_at=? WHERE id=?", organized, now(), task.id);
    return getTask(id);
  } catch (e) {
    const msg = toFriendlyMessage(e);
    run("UPDATE tasks SET status='failed', error=?, finished_at=? WHERE id=?", msg, now(), task.id);
    const err = new Error(msg);
    if (e && e.code) err.code = e.code;
    throw err;
  }
}

/** 仅当 status 为 failed 时可重试：状态重置为 queued，done/total/error 清空，返回更新后的行。 */
function retryTask(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在。');
  if (task.status !== 'failed') {
    throw new Error('只有失败的任务可以重试，当前状态为「' + (STATUS_LABEL[task.status] || task.status) + '」。');
  }
  run("UPDATE tasks SET status='queued', done=0, total=0, error=NULL, batch_id=NULL, results_json=NULL, started_at=NULL, finished_at=NULL WHERE id=?", task.id);
  return getTask(id);
}

let runnerTimer = null;
let runnerBusy = false;

async function tickRunner() {
  if (runnerBusy) return;
  const next = get("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC, id ASC LIMIT 1");
  if (!next) return;
  runnerBusy = true;
  try {
    await runTask(next.id);
  } catch (e) {
    // runTask 已把失败写进任务行（failed + 中文 error），这里只吞掉异常不让定时器崩掉
  } finally {
    runnerBusy = false;
  }
}

/**
 * 认领崩溃遗留的任务：进程崩溃时卡在 running 的任务不会自己恢复，
 * 下次启动时把它放回 queued（started_at 清空），runner 会重新跑它。
 * 返回被认领的条数。startRunner() 启动时调一次。
 */
function reclaimStaleTasks() {
  const r = run("UPDATE tasks SET status='queued', started_at=NULL WHERE status='running'");
  if (r.changes > 0) console.log(`[获客工作台] 已认领 ${r.changes} 个崩溃遗留的采集中任务，放回排队。`);
  return r.changes;
}

/**
 * 启动后台循环：每 500ms 检查一次，同一时间只跑一个任务，按 created_at 顺序取
 * queued 的跑；已在跑就跳过。重复调用不会起第二个定时器。返回 stop 函数。
 * 建议 server.js 启动时调一次 startRunner()。
 */
function startRunner() {
  if (runnerTimer) return stopRunner;
  reclaimStaleTasks();
  runnerTimer = setInterval(() => { tickRunner(); }, RUNNER_INTERVAL_MS);
  if (typeof runnerTimer.unref === 'function') runnerTimer.unref();
  setImmediate(() => { tickRunner(); });
  return stopRunner;
}

function stopRunner() {
  if (runnerTimer) {
    clearInterval(runnerTimer);
    runnerTimer = null;
  }
}

module.exports = {
  createTask,
  getTask,
  listTasks,
  startRunner,
  stopRunner,
  reclaimStaleTasks,
  runTask,
  retryTask,
  // 直接 re-export places.js 的同名函数（不要自己重算）；
  // 实测签名：estimateCalls({ maxResults, radiusKm, location })
  estimateCalls: places.estimateCalls,
  // 整理规则（供自测 / 后续 DeepSeek 画像接入时复用）
  mapIndustry,
  buildProfile,
  organizeStep,
  STATUS_LABEL,
};
