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
const { Router, createApp } = require('./src/web');
const views = require('./src/views');
const importer = require('./src/importer');
const places = require('./src/places');
const tasks = require('./src/tasks');
const letters = require('./src/letters');
const { get, run, now, setSetting, log } = require('./src/db');
const crmAuth = require('./src/crmAuth');

const PORT = parseInt(process.env.LEADGEN_PORT || '5101', 10);
const HOST = process.env.LEADGEN_HOST || '0.0.0.0';
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
  run('UPDATE leads SET status=?,updated_at=? WHERE id=?', ctx.body.status || 'review', now(), ctx.params.id);
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
  for (const [k, v] of Object.entries(ctx.body)) if (typeof v === 'string') setSetting(k, v);
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
});
