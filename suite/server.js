'use strict';
/**
 * 获客工作台 - 独立服务入口（替代旧 lead-gen/ 服务）
 * 独立端口（默认 5101，环境变量名保持 LEADGEN_PORT 不变），独立数据库 suite/data/，
 * 不改动主 CRM 任何代码，不改动 lead-gen/data/ 下的任何文件。
 *
 * 与 B 的集成约定（B 已交付，不要改它们）：
 *   suite/src/tasks.js   导出 createTask/getTask/listTasks/startRunner/runTask/retryTask/estimateCalls
 *   suite/src/letters.js 导出 listTemplates/getTemplate/saveTemplate/deleteTemplate/renderTemplate/recordSend/listSendRecords
 *   suite/static/tasks.js / suite/static/letters.js（前端）
 * 本文件直接调它们的导出函数，不 try/catch 吞掉缺失——缺失就是错误。
 * 注意：B 的文件在 src/ 下，所以这里是 require('./src/tasks') / require('./src/letters')。
 * 已确认的签名（与 B 的实现逐项对过）：
 *   tasks.createTask({ keyword, location, radiusKm, maxResults }) -> 任务行（含 id）
 *   tasks.getTask(id) -> 行或 null；tasks.listTasks(limit?)；tasks.retryTask(id) 仅 failed 可重试
 *   tasks.runTask(id, opts?)；tasks.startRunner() 返回 stop 函数
 *   tasks 任务状态：queued / running / organizing / done / failed（organizing 为 AI 整理中）
 *   letters.renderTemplate(template, lead) -> { subject, body }（可传对象或 id）
 *   letters.recordSend({ leadId, templateId, channel, subject, body, status? }) 驼峰参数
 *   letters.getLeadContact(leadId) -> { phone, website, email }
 *   letters.ensureDefaults() 首次写入两条默认模板（en/fr）
 *   前端 POST /api/send-records 发 snake_case（lead_id/template_id），本文件转驼峰后再调 recordSend。
 */
const path = require('node:path');

// ── S1(a)：启动前先确认端口空闲，再加载数据库层 ──
// db.js 在 require 时就会跑旧库迁移；若旧服务还占着端口，新服务先复制旧库、
// 再因 EADDRINUSE 崩溃退出，复制文件会残留，下次启动因“库已存在”跳过迁移。
// 端口被占就直接报错退出，什么都不复制、不碰旧库。
// 端口探测是异步操作，这里用一次性的子进程同步探测（只 bind 一下就退出）。
const PORT = parseInt(process.env.LEADGEN_PORT || '5101', 10);
const HOST = process.env.LEADGEN_HOST || '0.0.0.0';
(function ensurePortFree() {
  const { execFileSync } = require('node:child_process');
  const probeJs = 'require("node:net").createServer()'
    + '.once("error",e=>{console.error(e.message);process.exit(1)})'
    + '.once("listening",function(){this.close(()=>process.exit(0))})'
    + `.listen(${JSON.stringify(PORT)},${JSON.stringify(HOST)});`;
  try {
    execFileSync(process.execPath, ['-e', probeJs], { timeout: 10000, stdio: 'pipe' });
  } catch (e) {
    const detail = e && e.stderr ? String(e.stderr).trim().split('\n').pop() : '';
    console.error(`[获客工作台] 端口 ${HOST}:${PORT} 已被占用${detail ? '（' + detail + '）' : ''}，请先停掉旧的获客服务（或旧的获客工作台）再启动。本次未复制任何数据，旧库完好。`);
    process.exit(1);
  }
})();

const { Router, createApp } = require('./src/web');
const views = require('./src/views');
const importer = require('./src/importer');
const places = require('./src/places');
const tasks = require('./src/tasks');
const letters = require('./src/letters');
const validate = require('./src/validate');
const { fetchUrl, proxyStatus } = require('./src/net');
const { get, run, now, setSetting, log } = require('./src/db');
const crmAuth = require('./src/crmAuth');

const router = new Router();

// ── 页面路由 ──
router.get('/', ctx => ctx.res.send(views.dashboardPage()));
router.get('/maps', ctx => ctx.res.send(views.mapsPage()));
router.get('/tasks', ctx => ctx.res.send(views.tasksPage()));
router.get('/leads', ctx => ctx.res.send(views.leadsPage(ctx.query)));
router.get('/lead/:id', ctx => ctx.res.send(views.leadDetailPage(ctx.params.id)));
router.get('/import', ctx => ctx.res.send(views.importPage()));
router.get('/letters', ctx => ctx.res.send(views.lettersPage()));
router.get('/settings', ctx => ctx.res.send(views.settingsPage()));

// ── 地图采集（任务制：只建任务入队，不做同步搜索）──
// S2(2)：地图 JS 由服务端代为加载，Key 不出现在页面源码里——浏览器只请求
// 同源的 /maps-js（见下），服务端拼 Key 去取 Google 的 bootstrap 再返回。
// 注意：Google 的 loader 会把 Key 嵌进返回的 JS（后续模块地址里要用），所以 Key
// 仍可从 /maps-js 的响应体里看到，只是不在页面源码中；因此 Key 仍只能限制
// API 范围（Places API (New) + Geocoding API），不要加 HTTP referrer 限制，
// 否则服务端取脚本和调 API 都会断（见设置页说明）。
router.get('/maps-js', async ctx => {
  const key = places.getApiKey();
  if (!key) {
    ctx.res.writeHead(404, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end('// 未配置 Google Places API Key');
    return;
  }
  const url = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&loading=async&callback=initMapsSuite';
  const r = await fetchUrl(url, { throttle: false, retries: 0 });
  if (!r.ok || !r.text) {
    console.error('[获客工作台] 地图脚本代理加载失败：', r.status || '', r.error || '');
    ctx.res.writeHead(502, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end('// 地图脚本加载失败，已降级为只显示列表，不影响采集。');
    return;
  }
  ctx.res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  ctx.res.end(r.text);
});

router.post('/api/maps/search', ctx => {
  const keyword = String(ctx.body.keyword || '').trim();
  const location = String(ctx.body.location || '').trim();
  const radiusKm = ctx.body.radiusKm === '' || ctx.body.radiusKm == null ? null : Number(ctx.body.radiusKm);
  let maxResults = Number(ctx.body.maxResults) || 20;
  maxResults = Math.min(places.MAX_RESULTS, Math.max(1, Math.floor(maxResults)));
  if (!keyword) return ctx.res.json(400, { ok: false, error: '请填写关键词，例如 locksmith' });
  if (radiusKm != null && !(radiusKm > 0 && radiusKm <= places.MAX_RADIUS_KM)) {
    return ctx.res.json(400, { ok: false, error: '半径请填 1-' + places.MAX_RADIUS_KM + ' 公里' });
  }
  // M4：地图采集通道开关真正守门——取消勾选时明确拒绝（不建任务、不发请求）。
  if (!places.isMapsEnabled()) {
    return ctx.res.json(400, { ok: false, error: '地图采集通道未启用，请在数据源设置里勾选「Google 地图采集」后再试', code: 'MAPS_DISABLED', settings_url: '/settings' });
  }
  // 无 Key 直接报错，不发起任何请求（也不建任务）。
  if (!places.hasApiKey()) {
    return ctx.res.json(400, { ok: false, error: '未配置 Google Places API Key，去数据源设置里填写', code: 'NO_API_KEY', settings_url: '/settings' });
  }
  let t;
  try {
    t = tasks.createTask({ keyword, location, radiusKm, maxResults });
  } catch (e) {
    return ctx.res.json(400, { ok: false, error: (e && e.message) || '新建任务失败' });
  }
  const taskId = t && (t.id || t.task_id);
  ctx.res.json(200, { ok: true, task_id: taskId });
});

// ── 任务流（经 tasks.js）──
// B 的 tasks.js 前端（static/tasks.js）用 POST /api/tasks 新建任务；
// 地图页用 POST /api/maps/search 建任务。两者都先校验 Key（无 Key 零请求）。
function noApiKeyRes(ctx) {
  return ctx.res.json(400, { ok: false, error: '未配置 Google Places API Key，去数据源设置里填写', code: 'NO_API_KEY', settings_url: '/settings' });
}

router.post('/api/tasks', ctx => {
  // M4：地图采集通道开关同样守门任务创建。
  if (!places.isMapsEnabled()) {
    return ctx.res.json(400, { ok: false, error: '地图采集通道未启用，请在数据源设置里勾选「Google 地图采集」后再试', code: 'MAPS_DISABLED', settings_url: '/settings' });
  }
  if (!places.hasApiKey()) return noApiKeyRes(ctx);
  try {
    const t = tasks.createTask({
      keyword: ctx.body.keyword,
      location: ctx.body.location,
      radiusKm: ctx.body.radiusKm,
      maxResults: ctx.body.maxResults,
    });
    ctx.res.json(200, { ok: true, task_id: t && t.id, task: t });
  } catch (e) {
    ctx.res.json(400, { ok: false, error: (e && e.message) || '新建任务失败' });
  }
});

router.get('/api/tasks', ctx => {
  ctx.res.json(200, { ok: true, tasks: tasks.listTasks() });
});

router.get('/api/tasks/:id', ctx => {
  const t = tasks.getTask(Number(ctx.params.id));
  if (!t) return ctx.res.json(404, { ok: false, error: '任务不存在' });
  let results = [];
  try { const parsed = JSON.parse(t.results_json || '[]'); if (Array.isArray(parsed)) results = parsed; } catch (e) {}
  const out = Object.assign({}, t);
  delete out.results_json;
  out.results = results;
  ctx.res.json(200, { ok: true, task: out });
});

router.post('/api/tasks/:id/retry', ctx => {
  try {
    const t = tasks.retryTask(Number(ctx.params.id));
    ctx.res.json(200, { ok: true, task: t });
  } catch (e) {
    ctx.res.json(400, { ok: false, error: (e && e.message) || '重试失败' });
  }
});

// ── 导入（复用 importer.js，照旧服务写法）──
router.post('/api/import/preview', ctx => {
  const rows = importer.parseRows(ctx.body.raw || '');
  ctx.res.json(200, { ok: true, rows: rows.slice(0, 20), total: rows.length });
});

router.post('/api/import', ctx => {
  const rows = importer.parseRows(ctx.body.raw || '');
  if (!rows.length) return ctx.res.json(400, { ok: false, error: '没有解析到有效数据' });
  const result = importer.importLeads(rows, { batch_name: ctx.body.batch_name || '', source: ctx.body.source || 'manual', note: ctx.body.note || '' });
  ctx.res.json(200, { ok: true, ...result });
});

// ── 线索 ──
router.get('/api/lead/:id', ctx => {
  const lead = get('SELECT * FROM leads WHERE id=?', ctx.params.id);
  if (!lead) return ctx.res.json(404, { ok: false, error: 'not found' });
  const evidence = require('./src/db').all('SELECT * FROM evidence WHERE lead_id=? ORDER BY field,id', ctx.params.id);
  ctx.res.json(200, { ok: true, lead, evidence });
});

router.post('/api/lead/:id/status', ctx => {
  // M5：状态加白名单，并先查线索存在（不存在 404；非法状态 400）。
  const status = ctx.body.status;
  if (!validate.isValidLeadStatus(status)) {
    return ctx.res.json(400, { ok: false, error: '无效的状态：' + String(status == null ? '' : status) + '。可选：' + validate.LEAD_STATUS_VALUES.join(' / ') });
  }
  const lead = get('SELECT id FROM leads WHERE id=?', Number(ctx.params.id));
  if (!lead) return ctx.res.json(404, { ok: false, error: '线索不存在' });
  run('UPDATE leads SET status=?,updated_at=? WHERE id=?', status, now(), ctx.params.id);
  ctx.res.json(200, { ok: true });
});

// ── 开发信（经 letters.js）──
// 已与 B 的 letters.js / static/letters.js 对齐的调用签名：
//   renderTemplate(template, lead) -> { subject, body }（template/lead 可传对象或 id）
//   recordSend({ leadId, templateId, channel, subject, body, status? }) 驼峰参数
//   getLeadContact(leadId) -> { phone, website, email }
//   listTemplates() / getTemplate(id) / saveTemplate({id?,name,lang,subject,body}) / deleteTemplate(id) -> bool
//   listSendRecords(leadId?, limit?) / ensureDefaults()
// B 的前端调 /api/letter-templates 与 /api/send-records；/api/letters/* 保留为同义别名。
// 注意：前端 POST /api/send-records 发的是 snake_case（lead_id/template_id），
// 这里转成 recordSend 要的驼峰参数再调。
function listLetterTemplates(ctx) {
  ctx.res.json(200, { ok: true, templates: letters.ensureDefaults() });
}
router.get('/api/letter-templates', listLetterTemplates);
router.get('/api/letters/templates', listLetterTemplates);

function getLetterTemplate(ctx) {
  const t = letters.getTemplate(Number(ctx.params.id));
  if (!t) return ctx.res.json(404, { ok: false, error: '模板不存在' });
  ctx.res.json(200, { ok: true, template: t });
}
router.get('/api/letter-templates/:id', getLetterTemplate);
router.get('/api/letters/templates/:id', getLetterTemplate);

function saveLetterTemplate(ctx) {
  try {
    const saved = letters.saveTemplate({
      id: ctx.body.id ? Number(ctx.body.id) : undefined,
      name: String(ctx.body.name || '').trim(),
      lang: ctx.body.lang === 'fr' ? 'fr' : 'en',
      subject: String(ctx.body.subject || ''),
      body: String(ctx.body.body || ''),
    });
    ctx.res.json(200, { ok: true, template: saved });
  } catch (e) {
    ctx.res.json(400, { ok: false, error: (e && e.message) || '保存模板失败' });
  }
}
router.post('/api/letter-templates', saveLetterTemplate);
router.post('/api/letters/templates', saveLetterTemplate);

function deleteLetterTemplate(ctx) {
  letters.deleteTemplate(Number(ctx.params.id));
  ctx.res.json(200, { ok: true });
}
router.add('DELETE', '/api/letter-templates/:id', deleteLetterTemplate);
router.post('/api/letters/templates/:id/delete', deleteLetterTemplate);
router.post('/api/letter-templates/:id/delete', deleteLetterTemplate);

function renderLetter(ctx) {
  const template = letters.getTemplate(Number(ctx.query.template_id));
  if (!template) return ctx.res.json(404, { ok: false, error: '模板不存在' });
  const lead = get('SELECT * FROM leads WHERE id=?', Number(ctx.query.lead_id));
  if (!lead) return ctx.res.json(404, { ok: false, error: '线索不存在' });
  const rendered = letters.renderTemplate(template, lead);
  const contact = letters.getLeadContact(lead.id);
  ctx.res.json(200, { ok: true, subject: rendered.subject, body: rendered.body, contact });
}
router.get('/api/letters/render', renderLetter);

function recordLetterSend(ctx, leadId, templateId) {
  const lead = get('SELECT * FROM leads WHERE id=?', Number(leadId));
  if (!lead) return ctx.res.json(404, { ok: false, error: '线索不存在' });
  const template = templateId ? letters.getTemplate(Number(templateId)) : null;
  if (templateId && !template) return ctx.res.json(400, { ok: false, error: '模板不存在' });
  const rendered = template
    ? letters.renderTemplate(template, lead)
    : { subject: String(ctx.body.subject || ''), body: String(ctx.body.body || '') };
  try {
    const rec = letters.recordSend({
      leadId: lead.id,
      templateId: template ? template.id : (templateId ? Number(templateId) : null),
      channel: ctx.body.channel || 'email',
      subject: rendered.subject,
      body: rendered.body,
    });
    ctx.res.json(200, { ok: true, record: rec });
  } catch (e) {
    ctx.res.json(400, { ok: false, error: (e && e.message) || '记录发送失败' });
  }
}
router.post('/api/send-records', ctx => recordLetterSend(ctx, ctx.body.lead_id, ctx.body.template_id));
router.post('/api/lead/:id/letter/send', ctx => recordLetterSend(ctx, ctx.params.id, ctx.body.template_id));

function listSendRecords(ctx) {
  const leadId = ctx.query.lead_id ? Number(ctx.query.lead_id) : undefined;
  ctx.res.json(200, { ok: true, sends: letters.listSendRecords(leadId), records: letters.listSendRecords(leadId) });
}
router.get('/api/send-records', listSendRecords);
router.get('/api/letters/sends', listSendRecords);

// ── 设置（照旧服务写法）──
router.post('/api/settings', ctx => {
  // M5：设置项加白名单——未知键整单拒绝，不写任何项。
  const v = validate.validateSettingsBody(ctx.body);
  if (!v.ok) return ctx.res.json(400, { ok: false, error: v.error });
  for (const [k, val] of Object.entries(v.settings)) setSetting(k, val);
  log('info', '更新数据源设置');
  ctx.res.json(200, { ok: true });
});

const { server } = createApp(router, {
  before(ctx) {
    // 静态资源放行（登录跳转后的页面样式、JS 依赖它们）。web.js 已在 before 前处理，
    // 这里只兜底：/static/ 与 /vendor/ 不鉴权。
    const p = ctx.path || '';
    if (p.startsWith('/static/') || p.startsWith('/vendor/') || p === '/favicon.ico') return true;
    const user = crmAuth.currentUser(ctx.req);
    if (user) { ctx.user = user; return true; }
    if (ctx.req.method === 'GET') { ctx.res.redirect(crmAuth.loginUrl(ctx.req)); return false; }
    ctx.res.json(401, { ok: false, error: '未登录或登录已过期，请通过主 CRM 进入获客系统' });
    return false;
  },
});

// 启动任务执行器（B 的 tasks.js 提供 startRunner）。
tasks.startRunner();

server.listen(PORT, HOST, () => {
  console.log(`[获客工作台] 已启动: http://localhost:${PORT}`);
  console.log(`[获客工作台] 独立数据库: ${require('./src/db').DB_PATH}`);
  // M3：代理缺失时不要静默直连——启动日志里明确警告。
  const ps = proxyStatus();
  if (ps.warning) console.warn('[获客工作台] 代理警告：' + ps.warning);
});
