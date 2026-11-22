'use strict';
/**
 * 获客核验系统 - 独立服务入口
 * 独立端口（默认 5101），独立数据库，不改动主 CRM 任何代码。
 */
const path = require('node:path');
const { Router, createApp } = require('./src/web');
const views = require('./src/views');
const importer = require('./src/importer');
const { exportReport } = require('./src/exporter');
const { verifyOne } = require('./tools/pipeline-demo');
const { setStage, approveRecommended } = require('./src/workflow');
const { run, get, all, now, setSetting, getSetting, allSettings, log } = require('./src/db');
const crmAuth = require('./src/crmAuth');

const PORT = parseInt(process.env.LEADGEN_PORT || '5101', 10);
const HOST = process.env.LEADGEN_HOST || '0.0.0.0';
const router = new Router();

let verifying = false;
let verifyQueue = [];

async function processQueue() {
  if (verifying || !verifyQueue.length) return;
  verifying = true;
  const jobId = verifyQueue.shift();
  const job = get('SELECT * FROM jobs WHERE id=?', jobId);
  if (job && job.status === 'queued') {
    run("UPDATE jobs SET status='running',updated_at=? WHERE id=?", now(), jobId);
    try {
      let ids;
      if (job.kind === 'verify_all') {
        ids = all("SELECT id FROM leads WHERE status IN ('new','failed')").map(r => r.id);
      } else {
        const payload = JSON.parse(job.payload || '{}');
        ids = payload.ids || [];
      }
      run('UPDATE jobs SET total=?,progress=0 WHERE id=?', ids.length, jobId);
      for (let i = 0; i < ids.length; i++) {
        try { await verifyOne(ids[i]); }
        catch (e) { log('error', `核验失败 lead=${ids[i]}: ${e.message}`, ids[i]); }
        run('UPDATE jobs SET progress=?,updated_at=? WHERE id=?', i + 1, now(), jobId);
      }
      run("UPDATE jobs SET status='done',updated_at=? WHERE id=?", now(), jobId);
    } catch (e) {
      run("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?", e.message, now(), jobId);
    }
  }
  verifying = false;
  if (verifyQueue.length) setImmediate(processQueue);
}

function enqueue(kind, payload) {
  const r = run("INSERT INTO jobs(kind,payload,status,created_at,updated_at) VALUES(?,?,'queued',?,?)", kind, JSON.stringify(payload || {}), now(), now());
  const id = Number(r.lastInsertRowid);
  verifyQueue.push(id);
  setImmediate(processQueue);
  return id;
}

// ── 页面路由 ──
router.get('/', ctx => ctx.res.send(views.dashboardPage()));
router.get('/leads', ctx => ctx.res.send(views.leadsPage(ctx.query)));
router.get('/lead/:id', ctx => ctx.res.send(views.leadDetailPage(ctx.params.id)));
router.get('/import', ctx => ctx.res.send(views.importPage()));
router.get('/verify', ctx => ctx.res.send(views.verifyPage()));
router.get('/settings', ctx => ctx.res.send(views.settingsPage()));

// ── API 路由 ──
router.get('/api/stats', ctx => {
  const { stats } = require('./src/db');
  ctx.res.json(200, { ok: true, ...stats(), verifying, queued: verifyQueue.length });
});

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

router.post('/api/verify', ctx => {
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : (ctx.body.id ? [Number(ctx.body.id)] : []);
  if (!ids.length) return ctx.res.json(400, { ok: false, error: '未指定线索' });
  const jobId = enqueue('verify_one', { ids });
  ctx.res.json(200, { ok: true, job_id: jobId, queued: ids.length });
});

router.post('/api/verify-all', ctx => {
  const jobId = enqueue('verify_all', {});
  ctx.res.json(200, { ok: true, job_id: jobId });
});

router.get('/api/lead/:id', ctx => {
  const lead = get('SELECT * FROM leads WHERE id=?', ctx.params.id);
  if (!lead) return ctx.res.json(404, { ok: false, error: 'not found' });
  const ver = get('SELECT result_json FROM verifications WHERE lead_id=? ORDER BY id DESC LIMIT 1', ctx.params.id);
  let result = null; try { result = ver ? JSON.parse(ver.result_json) : null; } catch {}
  ctx.res.json(200, { ok: true, lead, result });
});

router.post('/api/settings', ctx => {
  for (const [k, v] of Object.entries(ctx.body)) if (typeof v === 'string') setSetting(k, v);
  log('info', '更新数据源设置');
  ctx.res.json(200, { ok: true });
});

router.get('/api/export', async ctx => {
  try {
    const ids = ctx.query.ids ? String(ctx.query.ids).split(',').map(Number) : null;
    const outPath = await exportReport({ ids, stage: ctx.query.stage || '' });
    const filename = path.basename(outPath);
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
    require('node:fs').createReadStream(outPath).pipe(ctx.res);
  } catch (e) {
    ctx.res.json(500, { ok: false, error: e.message });
  }
});

router.get('/lead/:id/report', async ctx => {
  try {
    const outPath = await exportReport({ ids: [Number(ctx.params.id)] });
    const filename = path.basename(outPath);
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
    require('node:fs').createReadStream(outPath).pipe(ctx.res);
  } catch (e) { ctx.res.send('<h1>导出失败</h1><pre>' + e.message + '</pre>', 500); }
});

router.post('/api/lead/:id/status', ctx => {
  run('UPDATE leads SET status=?,updated_at=? WHERE id=?', ctx.body.status || 'review', now(), ctx.params.id);
  ctx.res.json(200, { ok: true });
});

// GoodJob 式人工审批：候选池 → 审批通过（可联系）/ 已驳回
router.post('/api/lead/:id/stage', ctx => {
  const r = setStage([ctx.params.id], ctx.body.stage, ctx.body.note || '');
  ctx.res.json(r.ok ? 200 : 400, r);
});

router.post('/api/leads/stage', ctx => {
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : [];
  const r = setStage(ids, ctx.body.stage, ctx.body.note || '');
  ctx.res.json(r.ok ? 200 : 400, r);
});

router.post('/api/leads/approve-recommended', ctx => {
  const r = approveRecommended(ctx.body.min_score || Number(getSetting('approval_min_score', '70')) || 70);
  ctx.res.json(r.ok ? 200 : 400, r);
});

router.post('/api/lead/:id/delete', ctx => {
  const id = ctx.params.id;
  run('DELETE FROM evidence WHERE lead_id=?', id);
  run('DELETE FROM field_results WHERE lead_id=?', id);
  run('DELETE FROM verifications WHERE lead_id=?', id);
  run('DELETE FROM leads WHERE id=?', id);
  ctx.res.json(200, { ok: true });
});

const { server } = createApp(router, {
  before(ctx) {
    // 静态资源放行（登录跳转后的页面样式、JS 依赖它们）。web.js 已在 before 前处理，
    // 这里只兜底：/lg-static/ 与 /vendor/ 不鉴权。
    const p = ctx.path || '';
    if (p.startsWith('/lg-static/') || p.startsWith('/vendor/') || p === '/favicon.ico') return true;
    const user = crmAuth.currentUser(ctx.req);
    if (user) { ctx.user = user; return true; }
    if (ctx.req.method === 'GET') { ctx.res.redirect(crmAuth.loginUrl(ctx.req)); return false; }
    ctx.res.json(401, { ok: false, error: '未登录或登录已过期，请通过主 CRM 进入获客系统' });
    return false;
  },
});
server.listen(PORT, HOST, () => {
  console.log(`[获客核验系统] 已启动: http://localhost:${PORT}`);
  console.log(`[获客核验系统] 独立数据库: ${require('./src/db').DB_PATH}`);
});
