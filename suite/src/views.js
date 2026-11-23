'use strict';
/** 获客工作台服务端渲染视图层（复用 lead-gen 的墨绿设计语言） */
const { all, get, stats, getSetting } = require('./db');
const { getRequestContext } = require('./web');
const { proxyStatus } = require('./net');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NAV = [
  { href: '/', key: 'dashboard', icon: 'bi-grid-1x2-fill', label: '概览' },
  { href: '/maps', key: 'maps', icon: 'bi-geo-alt', label: '地图采集' },
  { href: '/tasks', key: 'tasks', icon: 'bi-diagram-3', label: 'AI 任务流' },
  { href: '/leads', key: 'leads', icon: 'bi-buildings', label: '线索库' },
  { href: '/letters', key: 'letters', icon: 'bi-envelope', label: '开发信' },
  { href: '/settings', key: 'settings', icon: 'bi-gear', label: '数据源设置' },
];

function layout({ title, active, content, flash, scripts }) {
  const st = stats();
  const reqCtx = getRequestContext() || {};
  const loginUser = reqCtx.user || null;
  const userChip = loginUser
    ? `<span class="top-chip" title="当前登录用户"><i class="bi bi-person-circle"></i> ${esc(loginUser.display_name || loginUser.username || '已登录')}${loginUser.role === 'admin' ? ' · 管理员' : ''}</span>`
    : '';
  // 与主系统同主机、端口取主系统端口（默认 5000），模式沿用 lead-gen 的 mainCrmUrl。
  const mainHost = (() => {
    const req = reqCtx.req;
    const host = String((req && req.headers && req.headers.host) || '127.0.0.1:5101');
    const ipv6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
    const hostname = ipv6 ? '[' + ipv6[1] + ']' : (host.split(':')[0] || '127.0.0.1');
    return 'http://' + hostname + ':' + (process.env.CRM_PORT || '5000');
  })();
  const mainCrmUrl = mainHost + '/dashboard';
  const whatsappUrl = mainHost + '/whatsapp/session';
  const nav = NAV.map(n => `<a class="nav-link ${active === n.key ? 'active' : ''}" href="${n.href}"><i class="bi ${n.icon}"></i><span>${n.label}</span>${n.key === 'leads' && st.leads ? `<span class="nav-badge">${st.leads}</span>` : ''}</a>`).join('');
  const flashHtml = (flash || []).map((f, i) => `<div class="alert alert-${f.type || 'info'} alert-dismissible fade show" role="alert">${esc(f.msg)}<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 获客工作台</title>
<link rel="stylesheet" href="/vendor/bootstrap/css/bootstrap.min.css">
<link rel="stylesheet" href="/vendor/bootstrap-icons/bootstrap-icons.min.css">
<link rel="stylesheet" href="/static/app.css">
</head><body>
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><span class="brand-mark"><i class="bi bi-funnel-fill"></i></span><span class="brand-name">获客工作台</span><span class="brand-sub">Lead Suite</span></div>
    <div class="topbar-right">
      ${userChip}
      <span class="top-chip"><i class="bi bi-database"></i> 独立线索库</span>
      <span class="top-chip"><i class="bi bi-stars"></i> AI 任务流</span>
      <a class="btn btn-sm btn-outline-secondary" href="${mainCrmUrl}" title="返回主系统 CRM"><i class="bi bi-arrow-left"></i> 主系统</a>
    </div>
  </header>
  <aside class="sidebar"><div class="sidebar-section-label">获客工作台</div>${nav}
    <a class="nav-link" href="${whatsappUrl}" target="_blank" rel="noopener"><i class="bi bi-whatsapp"></i><span>WhatsApp 咨询</span><i class="bi bi-box-arrow-up-right small ms-auto"></i></a>
    <span class="nav-link disabled" title="第二阶段"><i class="bi bi-share"></i><span>社媒获客专区</span><span class="nav-badge">第二阶段</span></span>
    <div class="sidebar-foot"><div class="sidebar-stat"><b>${st.leads}</b><span>线索</span></div><div class="sidebar-stat"><b>${st.pending}</b><span>待跟进</span></div><div class="sidebar-stat"><b>${st.evidence}</b><span>证据</span></div></div>
  </aside>
  <main class="main-content">
    <div class="page-wrap">${flashHtml}${content}</div>
  </main>
</div>
<script src="/vendor/bootstrap/js/bootstrap.bundle.min.js"></script>
${(scripts || []).map(s => (s.startsWith('http') || s === '/maps-js') ? `<script async src="${s}"></script>` : `<script src="${s}"></script>`).join('')}
</body></html>`;
}

function pageHead(title, subtitle, actions = '') {
  return `<div class="page-head"><div><h1 class="page-title">${esc(title)}</h1>${subtitle ? `<div class="page-subtitle">${esc(subtitle)}</div>` : ''}</div><div class="page-actions">${actions}</div></div>`;
}

function scoreBadge(score, level) {
  if (!score) return '<span class="badge bg-secondary">未核验</span>';
  const color = score >= 75 ? 'success' : score >= 45 ? 'warning' : 'danger';
  return `<span class="badge bg-${color} score-badge">${score} <small>${level || ''}</small></span>`;
}
function statusBadge(status) {
  const map = { new: ['secondary', '待跟进'], queued: ['info', '排队中'], verifying: ['info', '核验中'], verified: ['success', '已验证'], review: ['warning', '待复核'], failed: ['danger', '失败'] };
  const [c, t] = map[status] || ['secondary', status];
  return `<span class="badge bg-${c}">${t}</span>`;
}
function stageBadge(stage) {
  const map = { candidate: ['secondary', '候选池'], approved: ['success', '已审批·可联系'], rejected: ['danger', '已驳回'] };
  const [c, t] = map[stage || 'candidate'] || ['secondary', stage];
  return `<span class="badge bg-${c}">${t}</span>`;
}
function taskStatusBadge(status) {
  const map = { queued: ['secondary', '排队'], running: ['info', '采集中'], organizing: ['warning', 'AI 整理中'], enriching: ['warning', 'AI 整理中'], done: ['success', '完成'], failed: ['danger', '失败'] };
  const [c, t] = map[status] || ['secondary', status];
  return `<span class="badge bg-${c}">${t}</span>`;
}
// enriching 是 organizing 的旧别名（只读不写），徽章映射里两者同义。
function fmtTime(ts) {
  return ts ? String(ts).slice(0, 19).replace('T', ' ') : '—';
}
function elapsed(started, finished) {
  if (!started) return '—';
  const end = finished ? new Date(finished) : new Date();
  const s = Math.max(0, Math.round((end - new Date(started)) / 1000));
  if (s < 60) return s + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}

// ── WhatsApp 号码归一化（L9）──
// 线索电话常是本地格式（如尼日利亚 0803…），直接拼 wa.me 打不通。
// 规则：已有国际区号（+ 开头，或已是该国区号开头）不动；以 0 开头的本地
// 号码，去掉 0、按线索国家补默认区号；国家未知时不动（也不编造区号）。
const COUNTRY_DIAL_CODES = [
  ['nigeria', '234'], ['saudi', '966'], ['france', '33'], ['germany', '49'],
  ['sweden', '46'], ['united states', '1'], ['usa', '1'], ['america', '1'],
  ['united kingdom', '44'], ['uk', '44'], ['england', '44'],
  ['kenya', '254'], ['ghana', '233'], ['india', '91'], ['china', '86'],
  ['united arab emirates', '971'], ['uae', '971'], ['egypt', '20'],
  ['south africa', '27'], ['morocco', '212'], ['algeria', '213'],
  ['turkey', '90'], ['turkiye', '90'], ['spain', '34'], ['italy', '39'],
  ['netherlands', '31'], ['belgium', '32'], ['poland', '48'],
  ['canada', '1'], ['mexico', '52'], ['brazil', '55'], ['australia', '61'],
];
function countryDialCode(country) {
  const c = String(country || '').trim().toLowerCase();
  if (!c) return '';
  for (const [name, code] of COUNTRY_DIAL_CODES) {
    if (c.includes(name)) return code;
  }
  return '';
}
/** 返回 { digits, prefixed }：digits 为 wa.me 用的纯数字，prefixed 表示是否补过区号。 */
function normalizeWaNumber(phone, country) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { digits: '', prefixed: false };
  if (digits.startsWith('0')) {
    const code = countryDialCode(country);
    if (code) return { digits: code + digits.slice(1), prefixed: true };
  }
  return { digits, prefixed: false };
}

// ── 概览 ──
function dashboardPage() {
  const st = stats();
  const recent = all('SELECT * FROM leads ORDER BY id DESC LIMIT 8');
  let inds = all(`SELECT value,COUNT(*) c FROM field_results WHERE field='industry' AND value<>'' GROUP BY value ORDER BY c DESC LIMIT 6`);
  if (!inds.length) {
    inds = all(`SELECT industry_hint value,COUNT(*) c FROM leads WHERE industry_hint<>'' GROUP BY industry_hint ORDER BY c DESC LIMIT 6`);
  }
  const content = `
  ${pageHead('获客工作台概览', '地图采集 → AI 任务流整理 → 开发信跟进', `<a class="btn btn-primary" href="/maps"><i class="bi bi-geo-alt"></i> 地图采集</a><a class="btn btn-outline-primary" href="/import"><i class="bi bi-plus-lg"></i> 导入线索</a>`)}
  <div class="row g-3 mb-4">
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-primary-subtle text-primary"><i class="bi bi-collection"></i></div><div><div class="stat-num">${st.leads}</div><div class="stat-label">线索总数</div></div></div></div>
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-warning-subtle text-warning"><i class="bi bi-exclamation-diamond"></i></div><div><div class="stat-num">${st.pending}</div><div class="stat-label">待跟进</div></div></div></div>
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-success-subtle text-success"><i class="bi bi-list-check"></i></div><div><div class="stat-num">${st.evidence}</div><div class="stat-label">证据条数</div></div></div></div>
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-info-subtle text-info"><i class="bi bi-diagram-3"></i></div><div><div class="stat-num">${st.tasksActive}</div><div class="stat-label">进行中任务</div></div></div></div>
  </div>
  <div class="row g-3">
    <div class="col-lg-8"><div class="card panel"><div class="card-header panel-header"><span><i class="bi bi-clock-history"></i> 最近线索</span><a href="/leads" class="small">查看全部 →</a></div><div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th>公司</th><th>国家</th><th>行业</th><th>状态</th></tr></thead><tbody>
      ${recent.length ? recent.map(l => `<tr><td><a href="/lead/${l.id}" class="fw-semibold">${esc(l.company_name)}</a></td><td>${esc(l.country || '—')}</td><td>${esc(l.industry_hint || '—')}</td><td>${statusBadge(l.status)}</td></tr>`).join('') : '<tr><td colspan="4" class="text-center text-muted py-4">暂无线索，<a href="/maps">去地图采集</a>或<a href="/import">导入</a></td></tr>'}
    </tbody></table></div></div></div>
    <div class="col-lg-4"><div class="card panel"><div class="card-header panel-header"><span><i class="bi bi-diagram-3"></i> 行业分布</span></div><div class="card-body">
      ${inds.length ? inds.map(x => `<div class="dist-row"><span class="dist-name">${esc(x.value)}</span><div class="dist-bar"><div style="width:${Math.min(100, x.c * 20)}%"></div></div><span class="dist-c">${x.c}</span></div>`).join('') : '<div class="text-muted small">暂无行业数据，采集或导入线索后显示</div>'}
      <hr><div class="small text-muted"><i class="bi bi-info-circle"></i> 每条线索都记录来源与证据，可随时回溯核对。</div>
    </div></div></div>
  </div>`;
  return layout({ title: '概览', active: 'dashboard', content });
}

// ── 地图采集（单屏重做：顶部表单 + 中间大地图/右侧 AI 执行流 + 底部关键词时间线）──
// DOM 约定（与 static/maps.js 对齐）：
// 容器 #mapsSingle（data-latest-batch-id：最近批次 id，后端 getLatestMapBatch 提供；
//   未提供时为空，前端再试 GET /api/batches/latest）。
// 表单 #mapsForm[data-has-key]：#mapsKeywords（多行文本框，一行一个关键词，最多 5 个）、
//   #mapsKwCount（已填 n / 5 个）、.preset-kw / .preset-loc、#mapsLocation、#mapsRadius、
//   #mapsMax、#mapsProxyText、#mapsEstimate、#mapsRefreshBtn、#mapsRunBtn、#mapsError。
// 地图 #mapsMap（高约 560px）、#mapsPlaceSearch（地点搜索框）、#mapsMapList（叠加商家列表）、
//   #mapsMapFallback、#mapsMapNote、#mapsActions。
// 右侧 AI 执行流 #aiFlowPanel：#aiTaskList、#aiCurrentCard、#aiLeadsList、#aiCallsLog。
// 底部时间线 #mapsTimelineBar：#tlCounter、#tlNodes、#tlParsed、#tlContext。
// 后端契约：POST /api/maps/search {keywords:[...]} → {ok, batch_id, task_ids}；
//   GET /api/batches/latest、GET /api/batches/:id → {ok, batch, tasks, leads_count}。
// 分类 chips 不做（本次范围外：截图顶部的分类 chips 是另一套筛选体系，
//   与现有按关键词采集的后端没有对应字段，做出来是摆设，等后端有分类字段再补）。
function mapsPage() {
  const key = String(getSetting('google_places_key', '') || '').trim();
  const hasKey = !!key;
  const kwPresets = ['locksmith', 'door hardware', 'hardware store', 'lock distributor'];
  const locPresets = ['Lagos, Nigeria', 'Riyadh, Saudi Arabia', 'Paris, France'];
  // S2(2)：地图 JS 不再直接拼 Key 去 Google 取，改走服务端代理端点 /maps-js，
  // Key 不出现在页面源码里（Key 仍嵌在代理返回的 JS 里，见 server.js 说明）。
  const scripts = ['/static/maps.js'];
  if (hasKey) scripts.push('/maps-js');
  // M3：代理缺失时页面上明确警告，不要等采集失败了才发现。
  const proxy = proxyStatus();
  const proxyWarn = proxy.warning;
  const proxyText = proxy.proxyUrl ? ('代理：' + proxy.proxyUrl + (proxy.willUseProxy ? '（采集中走代理）' : '（代理未生效，直连）')) : '代理：未配置（直连 Google）';
  // 最近一个批次：后端提供 getLatestMapBatch（tasks.js）时取其 id；未提供时输出空，
  // 前端加载后再试 GET /api/batches/latest。取不到也不报错，页面显示空态。
  let latestBatchId = '';
  try {
    const tasksMod = require('./tasks');
    if (tasksMod && typeof tasksMod.getLatestMapBatch === 'function') {
      const b = tasksMod.getLatestMapBatch();
      if (b && b.id != null) latestBatchId = String(b.id);
    }
  } catch (e) { /* 后端批次接口未就绪：留空，前端走空态 */ }
  const content = `
  ${pageHead('地图采集', '用 Google Places API 按关键词 + 城市批量找海外商家，采回即进线索库',
    `<a class="btn btn-outline-secondary btn-sm" href="/leads"><i class="bi bi-collection"></i> 查看线索</a>`)}
  ${hasKey ? '' : `<div class="alert alert-warning"><i class="bi bi-exclamation-triangle"></i> <b>未配置 Google Places API Key，地图采集暂不可用。</b>请先到<a href="/settings">数据源设置</a>填写 Google Places API Key（Key 只保存在本机设置里，不会写进代码或日志）。</div>`}
  ${proxyWarn ? `<div class="alert alert-warning"><i class="bi bi-exclamation-triangle"></i> <b>代理提示：</b>${esc(proxyWarn)}</div>` : ''}
  <div id="mapsSingle" data-latest-batch-id="${esc(latestBatchId)}">
    <div class="card panel maps-form-card"><div class="card-header panel-header"><span><i class="bi bi-geo-alt"></i> 采集条件</span><span class="small text-muted">一行一个关键词，最多 5 个</span></div><div class="card-body">
      <form id="mapsForm" data-has-key="${hasKey ? '1' : '0'}">
        <div class="maps-form-grid">
          <div>
            <label class="form-label fw-semibold" for="mapsKeywords">关键词 <span class="small text-muted fw-normal" id="mapsKwCount">已填 0 / 5 个</span></label>
            <textarea class="form-control font-monospace" name="keywords" id="mapsKeywords" rows="3" placeholder="locksmith&#10;door hardware&#10;hardware store">locksmith</textarea>
            <div class="mt-2">${kwPresets.map(k => `<button type="button" class="btn btn-sm btn-outline-secondary preset-kw" data-kw="${k}">${k}</button>`).join(' ')}</div>
          </div>
          <div>
            <label class="form-label fw-semibold" for="mapsLocation">城市 / 地区</label>
            <input class="form-control" name="location" id="mapsLocation" placeholder="例如 Lagos, Nigeria">
            <div class="mt-2">${locPresets.map(l => `<button type="button" class="btn btn-sm btn-outline-secondary preset-loc" data-loc="${esc(l)}">${esc(l)}</button>`).join(' ')}</div>
            <div class="form-text">城市用于拼搜索词（“关键词 in 城市”）；填了半径时还会先定位，再按半径圈定范围。半径需配合城市使用，只填半径不填城市时半径会被忽略。</div>
          </div>
          <div>
            <div class="row g-2">
              <div class="col-6"><label class="form-label small">半径（公里，可选）</label><input class="form-control" type="number" min="1" max="50" name="radiusKm" id="mapsRadius" placeholder="留空不限半径"></div>
              <div class="col-6"><label class="form-label small">最多条数 / 词</label><input class="form-control" type="number" min="1" max="60" name="maxResults" id="mapsMax" value="20"></div>
            </div>
            <div class="small text-muted mt-2" id="mapsProxyText">${esc(proxyText)}</div>
            <div class="alert alert-info small mt-2 mb-0" id="mapsEstimate">预估调用：1 个关键词 × 每词约 21 次 = 合计约 21 次（未填半径，不定位）。</div>
          </div>
        </div>
        <div class="d-flex gap-2 mt-3 flex-wrap">
          <button type="button" class="btn btn-outline-secondary" id="mapsRefreshBtn"><i class="bi bi-arrow-clockwise"></i> 刷新地图</button>
          <button type="submit" class="btn btn-primary" id="mapsRunBtn" ${hasKey ? '' : 'disabled'}><i class="bi bi-search"></i> 开始采集商家</button>
          ${hasKey ? '' : '<span class="form-text align-self-center">配好 Key 后即可使用。</span>'}
        </div>
        <div id="mapsError" class="mt-2"></div>
        <div class="small text-muted mt-2">费用说明：走官方 Places API (New)，不是爬虫。Text Search Pro 每月免费 5,000 次，超出后 $32 / 1,000 次；Place Details Pro 每月免费 5,000 次，超出后 $17 / 1,000 次；Geocoding 每月免费 10,000 次。按“搜一次 20 家、每家查 1 次详情”算，免费额度够每月采约 5,000 家，超出才收费，建议在 Google Cloud 控制台设预算上限。</div>
      </form>
    </div></div>
    <div class="maps-mid">
      <div class="card panel maps-map-card"><div class="card-header panel-header"><span><i class="bi bi-map"></i> 地图</span><span class="small text-muted" id="mapsMapNote">${hasKey ? '采回商家后打点显示' : '配好 Key 后加载地图'}</span></div><div class="card-body p-2">
        <div class="maps-map-wrap">
          <div id="mapsMap"><div class="text-muted small p-3">${hasKey ? '地图加载中…' : '未配置 Key，地图不加载；采集功能不受影响，仍可只看列表。'}</div></div>
          <input id="mapsPlaceSearch" class="form-control maps-place-search" type="text" placeholder="搜索地点，定位并移动半径圈…" autocomplete="off">
          <div id="mapsMapList" class="maps-map-list" style="display:none"><div class="maps-map-list-head">已采商家 <span id="mapsMapListCount"></span></div><div id="mapsMapListItems"></div></div>
        </div>
        <div id="mapsMapFallback" class="small text-muted mt-2 px-1" style="display:none">地图脚本加载失败（网络或 Key 权限问题），已降级为只显示列表，不影响采集。</div>
        <div id="mapsActions" class="mt-2 px-1" style="display:none">
          <a class="btn btn-outline-secondary btn-sm" href="/leads">查看线索</a>
          <a class="btn btn-outline-secondary btn-sm" href="/tasks">查看任务流</a>
        </div>
      </div></div>
      <aside class="ai-flow" id="aiFlowPanel" aria-label="AI 执行流">
        <div class="ai-flow-title"><i class="bi bi-stars"></i> AI 执行流 <span class="ai-flow-sub" id="aiFlowBatch"></span></div>
        <div class="ai-flow-section"><div class="ai-flow-label">任务列表</div><div id="aiTaskList"><div class="ai-flow-empty">尚未发起采集。</div></div></div>
        <div class="ai-flow-section"><div class="ai-flow-label">当前任务</div><div id="aiCurrentCard"><div class="ai-flow-empty">暂无进行中的任务。</div></div></div>
        <div class="ai-flow-section ai-flow-grow"><div class="ai-flow-label">已采商家 <span id="aiLeadsCount"></span></div><div id="aiLeadsList"><div class="ai-flow-empty">暂无已采商家。</div></div></div>
        <div class="ai-flow-section"><div class="ai-flow-label">API 调用日志</div><div id="aiCallsLog"><div class="ai-flow-empty">暂无调用记录。</div></div></div>
      </aside>
    </div>
    <div class="maps-timeline" id="mapsTimelineBar">
      <div class="maps-tl-counter" id="tlCounter">— / —</div>
      <div class="maps-tl-nodes" id="tlNodes"><div class="maps-tl-empty">尚未发起采集</div></div>
      <div class="maps-tl-right">
        <div class="maps-tl-parsed" id="tlParsed">已解析 — / — 条 · 用时 --:--</div>
        <div class="maps-tl-context" id="tlContext">—</div>
      </div>
    </div>
  </div>`;
  return layout({ title: '地图采集', active: 'maps', content, scripts });
}

// ── AI 任务流 ──
// DOM 约定与 B 的 static/tasks.js 对齐：#taskList（任务卡片容器，JS 每 2 秒轮询重渲染）、
// #taskTimeline（底部时间线容器）、#taskForm / #taskKeyword / #taskLocation / #taskRadius /
// #taskMax / #taskEstimate / #taskFormError（新建任务表单，走 POST /api/tasks）。
// 服务端先渲染一份初始内容（无 JS 时也能看），JS 加载后接管轮询。
function tasksPage() {
  // 数据与动作来自 B 交付的 suite/src/tasks.js（createTask/getTask/listTasks/startRunner/runTask/retryTask/estimateCalls）。
  const tasks = require('./tasks');
  const hasKey = !!String(getSetting('google_places_key', '') || '').trim();
  const list = tasks.listTasks();
  // L2：搜索阶段 total 还是 0，“已解析 0 / 0 条”像卡死，改显示阶段文案。
  const progressText = t => (t.total
    ? `已解析 ${Number(t.done || 0)} / ${Number(t.total || 0)} 条`
    : ({ queued: '排队中…', running: '采集中…正在搜索商家', organizing: 'AI 整理中…' }[t.status] || '—'));
  const cards = list.length ? list.map(t => `
    <div class="col-md-6 col-lg-4"><div class="card panel task-card h-100"><div class="card-body">
      <div class="d-flex justify-content-between align-items-start mb-2"><span class="fw-bold">T-${t.id} · ${esc(t.keyword || '')}</span>${taskStatusBadge(t.status)}</div>
      <div class="small text-muted mb-1">${esc(t.location || '不限地区')}${t.radius_km ? ` · 半径 ${esc(t.radius_km)} 公里` : ''} · 最多 ${esc(t.max_results || '')} 条</div>
      <div class="d-flex justify-content-between small mb-1"><span>${progressText(t)}</span><span>${esc(elapsed(t.started_at, t.finished_at))}</span></div>
      <div class="progress mb-2" style="height:6px"><div class="progress-bar" style="width:${t.total ? Math.min(100, Math.round(100 * (t.done || 0) / t.total)) : 0}%"></div></div>
      ${t.error ? `<div class="small text-danger mb-2">失败原因：${esc(t.error)}</div>` : ''}
      <div class="small text-muted mb-2">创建 ${fmtTime(t.created_at)}${t.batch_id ? ` · 批次 #${t.batch_id}` : ''}</div>
      <div class="d-flex gap-2">
        ${t.status === 'failed' ? `<button class="btn btn-sm btn-outline-primary" data-retry-id="${t.id}"><i class="bi bi-arrow-repeat"></i> 重试</button>` : ''}
        ${t.batch_id ? `<a class="btn btn-sm btn-outline-secondary" href="/leads">查看线索</a>` : ''}
      </div>
    </div></div></div>`).join('') : '<div class="col-12"><div class="text-muted py-4 text-center">暂无任务，去<a href="/maps">地图采集</a>发起一次采集，或在下方新建任务。</div></div>';
  // 底部进度时间线：任务节点按创建时间顺序（从早到晚）横向排列，与前端轮询渲染一致。
  // listTasks() 返回的是倒序（新的在前），这里反转一份再渲染时间线。
  const timelineList = list.slice().reverse();
  const timeline = timelineList.length ? `
    <div class="task-timeline">
      ${timelineList.map((t, i) => `<div class="tl-node tl-${esc(t.status || 'queued')}"><div class="tl-dot">${i + 1}</div><div class="tl-label">T-${t.id}</div><div class="tl-sub">${esc(t.keyword || '')}</div><div class="tl-sub">${taskStatusBadge(t.status)}</div></div>${i < timelineList.length - 1 ? '<div class="tl-line"></div>' : ''}`).join('')}
    </div>` : '<div class="text-muted small">暂无任务时间线。</div>';
  const content = `
  ${pageHead('AI 任务流', '地图采集创建任务 → 后台搜索入库 → AI 整理画像', `<a class="btn btn-primary" href="/maps"><i class="bi bi-plus-lg"></i> 新建采集任务</a>`)}
  ${hasKey ? '' : `<div class="alert alert-warning"><i class="bi bi-exclamation-triangle"></i> <b>未配置 Google Places API Key，无法新建采集任务。</b>请先到<a href="/settings">数据源设置</a>填写 Google Places API Key。</div>`}
  <div class="card panel mb-3"><div class="card-header panel-header"><span><i class="bi bi-plus-lg"></i> 新建任务</span></div><div class="card-body">
    <form id="taskForm" class="row g-2 align-items-end" data-has-key="${hasKey ? '1' : '0'}">
      <div class="col-md-3"><label class="form-label small">关键词</label><input class="form-control form-control-sm" id="taskKeyword" placeholder="例如 locksmith" required></div>
      <div class="col-md-3"><label class="form-label small">城市 / 地区</label><input class="form-control form-control-sm" id="taskLocation" placeholder="例如 Lagos, Nigeria"></div>
      <div class="col-md-2"><label class="form-label small">半径（公里）</label><input class="form-control form-control-sm" type="number" min="1" max="50" id="taskRadius" placeholder="留空不限"></div>
      <div class="col-md-2"><label class="form-label small">最多条数</label><input class="form-control form-control-sm" type="number" min="1" max="60" id="taskMax" value="20"></div>
      <div class="col-md-2"><button type="submit" class="btn btn-primary btn-sm w-100" ${hasKey ? '' : 'disabled'}>创建任务</button></div>
      <div class="col-12"><div class="small text-muted" id="taskEstimate"></div><div id="taskFormError"></div></div>
    </form>
  </div></div>
  <div id="taskList"><div class="row g-3">${cards}</div></div>
  <div class="card panel mt-4"><div class="card-header panel-header"><span><i class="bi bi-clock-history"></i> 任务进度时间线</span><span class="small text-muted">按创建时间顺序</span></div><div class="card-body"><div id="taskTimeline">${timeline}</div></div></div>`;
  return layout({ title: 'AI 任务流', active: 'tasks', content, scripts: ['/static/tasks.js'] });
}

// ── 线索库 ──
function leadsPage(query) {
  const { status = '', q = '', sort = 'id' } = query;
  const st = stats();
  let sql = 'SELECT * FROM leads WHERE 1=1', params = [];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (q) { sql += ' AND (company_name LIKE ? OR website LIKE ? OR country LIKE ?)'; const k = `%${q}%`; params.push(k, k, k); }
  // “按可信分”排序已删：overall_score 没有任何代码会写（恒 0），按它排等于按 id 排。
  const order = 'id DESC';
  const leads = all(sql + ' ORDER BY ' + order, ...params);
  const filtered = status || q;
  const content = `
  ${pageHead('线索库', `共 ${st.leads} 条线索${filtered ? ` · 筛选出 ${leads.length} 条` : ''} · 待跟进 ${st.pending} 条`,
    `<a class="btn btn-primary btn-sm" href="/maps"><i class="bi bi-geo-alt"></i> 地图采集</a><a class="btn btn-primary btn-sm" href="/import"><i class="bi bi-plus-lg"></i> 导入</a>`)}
  <div class="card panel"><div class="card-body">
    <form class="row g-2 filter-bar" method="get" action="/leads">
      <div class="col-md-5"><input class="form-control form-control-sm" name="q" placeholder="搜索公司 / 网址 / 国家" value="${esc(q)}"></div>
      <div class="col-md-3"><select class="form-select form-select-sm" name="status"><option value="">全部状态</option>${[['new','待跟进'],['verified','已验证'],['review','待复核'],['verifying','核验中'],['failed','失败']].map(([v,t])=>`<option value="${v}" ${status===v?'selected':''}>${t}</option>`).join('')}</select></div>
      <div class="col-md-4"><button class="btn btn-sm btn-primary w-100"><i class="bi bi-search"></i> 筛选</button></div>
    </form>
    <div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr>
      <th>公司</th><th>国家</th><th>行业</th><th>规模</th><th>状态</th><th>操作</th>
    </tr></thead><tbody>
      ${leads.length ? leads.map(l => `<tr>
          <td><a href="/lead/${l.id}" class="fw-semibold">${esc(l.company_name)}</a>${l.website?`<div class="small text-muted">${esc(l.website)}</div>`:''}</td>
          <td>${esc(l.country||'—')}</td>
          <td>${esc(l.industry_hint||'—')}</td>
          <td>${esc(l.size_hint||'—')}</td>
          <td>${statusBadge(l.status)}</td>
          <td class="text-nowrap"><a class="btn btn-sm btn-outline-primary" href="/lead/${l.id}">查看</a></td>
        </tr>`).join('') : `<tr><td colspan="6" class="text-center text-muted py-5">暂无线索。<a href="/maps">地图采集</a>或<a href="/import">导入线索</a>开始。</td></tr>`}
    </tbody></table></div>
  </div></div>`;
  return layout({ title: '线索库', active: 'leads', content, scripts: ['/static/leads.js'] });
}

// ── 线索详情 ──
function leadDetailPage(id) {
  const lead = get('SELECT * FROM leads WHERE id=?', id);
  if (!lead) return layout({ title: '未找到', active: 'leads', content: pageHead('未找到线索') + '<div class="alert alert-warning">线索不存在。</div>' });
  const evidence = all('SELECT * FROM evidence WHERE lead_id=? ORDER BY field,id', id);
  const phoneEv = evidence.find(e => e.field === 'phone' && (e.value || e.raw_value));
  const phone = phoneEv ? String(phoneEv.value || phoneEv.raw_value) : '';
  // L9：本地格式电话（如 0803…）直接拼 wa.me 打不通，按线索国家补默认区号。
  const wa = normalizeWaNumber(phone, lead.country || '');
  const emails = evidence.filter(e => e.field === 'email').map(e => e.value || e.raw_value).filter(Boolean);
  const phones = evidence.filter(e => e.field === 'phone').map(e => e.value || e.raw_value).filter(Boolean);
  const FIELD_CN = { industry: '行业', size: '规模', country: '国家', website: '官网', social: '社媒', founded: '成立年份', followers: '粉丝数', email: '邮箱', phone: '电话', description: '描述', address: '地址' };
  const SOURCE_CN = { website: '官网', bing: 'Bing', linkedin_search: 'LinkedIn搜索', facebook_search: 'Facebook搜索', instagram_search: 'Instagram搜索', google_cse: 'Google', serpapi: 'SerpAPI', manual: '手工', google_places: 'Google 地图' };
  // 开发信区数据来自 B 交付的 suite/src/letters.js；DOM 与 static/letters.js 对齐。
  const letters = require('./letters');
  const templates = letters.ensureDefaults();
  const sends = letters.listSendRecords(lead.id);
  const content = `
  ${pageHead(esc(lead.company_name), `${lead.country||'国家未知'} · ${lead.website||'无官网'}`,
    `<a class="btn btn-sm btn-secondary" href="/leads">返回</a>`)}
  <div class="row g-3">
    <div class="col-lg-4">
      <div class="card panel mb-3"><div class="card-body text-center">
        <div class="mt-1">${statusBadge(lead.status)} ${stageBadge(lead.stage)}</div>
        <div class="small text-muted mt-2">来源 ${esc(lead.source || '—')} · 录入 ${fmtTime(lead.created_at)}</div>
        ${lead.notes ? `<div class="small text-muted mt-1">${esc(lead.notes)}</div>` : ''}
      </div></div>
      <div class="card panel mb-3"><div class="card-header panel-header">联系方式</div><div class="card-body">
        <table class="table table-sm mb-0 summary-table">
          <tr><th>官网</th><td>${lead.website?`<a href="${esc(lead.website)}" target="_blank">${esc(lead.website)}</a>`:'—'}</td></tr>
          <tr><th>邮箱</th><td>${emails.length ? esc(emails.join('、')) : '—'}</td></tr>
          <tr><th>电话</th><td>${phones.length ? esc(phones.join('、')) : '—'}</td></tr>
          <tr><th>行业</th><td>${esc(lead.industry_hint||'—')}</td></tr>
          <tr><th>规模</th><td>${esc(lead.size_hint||lead.employee_hint||'—')}</td></tr>
        </table>
        <div class="mt-3 d-grid">
          ${wa.digits
            ? `<a class="btn btn-success" href="https://wa.me/${wa.digits}" target="_blank" rel="noopener"><i class="bi bi-whatsapp"></i> WhatsApp 联系</a>`
            : `<button class="btn btn-success" disabled title="该线索暂无电话"><i class="bi bi-whatsapp"></i> WhatsApp 联系（暂无电话）</button>`}
          ${wa.prefixed ? `<div class="form-text mt-1">电话为本地格式，已按国家（${esc(lead.country || '')}）补区号；若号码不对请核对原始电话。</div>` : ''}
        </div>
      </div></div>
      <div class="card panel"><div class="card-header panel-header">画像</div><div class="card-body p-0"><table class="table table-sm mb-0 summary-table">
        <tr><th>公司</th><td>${esc(lead.company_name)}</td></tr>
        <tr><th>国家</th><td>${esc(lead.country||'—')}</td></tr>
        <tr><th>行业</th><td>${esc(lead.industry_hint||'—')}</td></tr>
        <tr><th>规模</th><td>${esc(lead.size_hint||'—')}</td></tr>
        <tr><th>员工</th><td>${esc(lead.employee_hint||'—')}</td></tr>
        <tr><th>状态</th><td>${esc(lead.status||'')}</td></tr>
      </table></div></div>
    </div>
    <div class="col-lg-8">
      <div class="card panel mb-3"><div class="card-header panel-header"><span><i class="bi bi-envelope"></i> 开发信</span><span class="small text-muted">单发：选模板 → 渲染预览 → 复制 / 打开 mailto → 标记已手动发送</span></div><div class="card-body">
        <div class="alert alert-info small py-2">V1 暂不支持自动发信：系统不会替你发出邮件，请复制全文后在自己的邮箱手动发送，回来点「标记已手动发送」。</div>
        <div id="letterError"></div>
        <div class="row g-2 mb-3">
          <div class="col-md-6"><label class="form-label small">选择模板</label>
            <select class="form-select form-select-sm" id="templateSelect">
              <option value="">请选择模板…</option>
              ${templates.map(t => `<option value="${t.id}">${esc(t.name)}（${esc(t.lang || 'en')}）</option>`).join('')}
            </select>
          </div>
          <div class="col-md-6"><label class="form-label small">线索</label>
            <select class="form-select form-select-sm" id="leadSelect">
              <option value="${lead.id}">${esc(lead.company_name)}</option>
            </select>
          </div>
        </div>
        <div class="mb-2"><label class="form-label small">主题</label><div class="fw-semibold" id="letterPreviewSubject">—</div></div>
        <div class="mb-2"><label class="form-label small">正文预览</label><pre class="border rounded p-2 small mb-0" id="letterPreviewBody" style="white-space:pre-wrap">选模板后，这里显示渲染后的开发信。</pre></div>
        <div class="small text-muted mb-3" id="letterContact"></div>
        <div class="d-flex gap-2 align-items-center flex-wrap">
          <button class="btn btn-sm btn-primary" id="btnCopy">复制全文</button>
          <button class="btn btn-sm btn-outline-secondary" id="btnMailto" disabled>打开 mailto</button>
          <select class="form-select form-select-sm w-auto" id="channelSelect"><option value="email">email</option><option value="whatsapp">whatsapp</option></select>
          <button class="btn btn-sm btn-success" id="btnMarkSent">标记已手动发送</button>
        </div>
        <hr>
        <div class="small text-muted mb-1">发送记录（手动发送的标记）</div>
        <div id="sendHistory">
          ${sends.length ? sends.map(s => `<div class="small border-bottom py-1"><span class="badge bg-secondary">${esc(s.channel || '')}</span> ${esc(s.subject || '')} · ${esc(s.status || '')} <span class="text-muted">${fmtTime(s.created_at)}</span></div>`).join('') : '<div class="text-muted small">暂无发送记录。</div>'}
        </div>
        <div class="form-text mt-2">没有合适的模板？去<a href="/letters">开发信</a>页新建。</div>
      </div></div>
      <div class="card panel"><div class="card-header panel-header"><span><i class="bi bi-list-check"></i> 证据（可审计）</span><span class="small text-muted">${evidence.length} 条原始证据</span></div><div class="card-body">
        ${evidence.length ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>来源</th><th>字段</th><th>内容</th><th>链接</th></tr></thead><tbody>
        ${evidence.map(e => `<tr><td>${SOURCE_CN[e.source]||e.source}</td><td>${FIELD_CN[e.field]||e.field}</td><td class="small">${esc(String(e.snippet||e.raw_value||e.value||'').slice(0,120))}</td><td>${e.url?`<a href="${esc(e.url)}" target="_blank"><i class="bi bi-box-arrow-up-right"></i></a>`:''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="text-muted">暂无证据。</div>'}
      </div></div>
    </div>
  </div>`;
  return layout({ title: lead.company_name, active: 'leads', content, scripts: ['/static/leads.js', '/static/letters.js'] });
}

// ── 导入 ──
function importPage() {
  const content = `
  ${pageHead('导入线索', '支持 CSV / Excel 复制粘贴，自动识别中英文列名、自动去重')}
  <div class="row g-3"><div class="col-lg-7">
    <div class="card panel"><div class="card-body">
      <form id="importForm">
        <div class="mb-3"><label class="form-label fw-semibold">粘贴线索数据</label>
          <textarea class="form-control font-monospace" name="raw" id="rawInput" rows="12" placeholder="公司名称,网址,国家,行业,来源&#10;Demo Hardware,https://www.demo-hardware.com,Germany,door hardware,展会&#10;Sample Access Ltd.,www.sample-access.com,Sweden,access control,Google">公司名称,网址,国家,行业,来源
</textarea>
          <div class="form-text">第一行是列名（可中英文），每行一条；也支持从 Excel 直接复制（Tab 分隔）。列名识别：公司名称/company、网址/website、国家/country、行业/industry 等。</div>
        </div>
        <div class="row g-2">
          <div class="col-md-4"><label class="form-label small">来源标记</label><input class="form-control form-control-sm" name="source" value="手动导入"></div>
          <div class="col-md-4"><label class="form-label small">批次备注</label><input class="form-control form-control-sm" name="note" placeholder="如：2026广交会名片"></div>
          <div class="col-md-4"><label class="form-label small">或上传 CSV</label><input class="form-control form-control-sm" type="file" id="csvFile" accept=".csv,.txt"></div>
        </div>
        <div class="mt-3"><button type="submit" class="btn btn-primary"><i class="bi bi-upload"></i> 导入线索库</button>
        <button type="button" class="btn btn-outline-secondary" id="btnPreview"><i class="bi bi-eye"></i> 预览解析</button></div>
      </form>
      <div id="importResult" class="mt-3"></div>
    </div></div>
  </div><div class="col-lg-5">
    <div class="card panel"><div class="card-header panel-header">获客流程说明</div><div class="card-body">
      <ol class="step-list">
        <li><b>地图采集 / 导入线索</b><span>按域名/公司名自动去重，重复项跳过</span></li>
        <li><b>AI 任务流整理</b><span>采集任务后台跑：搜索入库，再按行业映射、提炼电话/网址、写一句话画像</span></li>
        <li><b>开发信跟进</b><span>选模板渲染成英文/法文开发信，单发给客户并记发送记录</span></li>
        <li><b>WhatsApp 咨询</b><span>有电话的线索可一键跳 WhatsApp 继续聊</span></li>
      </ol>
      <div class="alert alert-info small mt-2 mb-0"><i class="bi bi-shield-check"></i> 系统不编造数据：找不到的字段留空，所有结论均可追溯到来源。</div>
    </div></div>
  </div></div>`;
  return layout({ title: '导入线索', active: 'import', content, scripts: ['/static/import.js'] });
}

// ── 开发信 ──
// DOM 约定与 B 的 static/letters.js 对齐：#templateList、#templateForm / #tplId / #tplName /
// #tplLang / #tplSubject / #tplBody / #tplSave / #tplNew / #tplFormError、#leadSelect、
// #templateSelect、#letterPreviewSubject / #letterPreviewBody / #letterContact、
// #btnCopy / #btnMailto / #channelSelect / #btnMarkSent / #sendHistory / #letterError。
// 服务端先渲染一份初始内容，JS 加载后接管（模板列表刷新、渲染预览、标记已手动发送）。
function lettersPage() {
  // 模板与发送记录来自 B 交付的 suite/src/letters.js；ensureDefaults 首次写入两条默认模板。
  const letters = require('./letters');
  const templates = letters.ensureDefaults();
  const sends = letters.listSendRecords();
  const leads = all('SELECT id, company_name FROM leads ORDER BY id DESC LIMIT 100');
  const content = `
  ${pageHead('开发信', '模板渲染 + 单发跟进', `<a class="btn btn-outline-secondary btn-sm" href="/leads">去线索库挑客户</a>`)}
  <div class="alert alert-info"><i class="bi bi-info-circle"></i> <b>批量发送（第二阶段）：</b>批量群发需配 SMTP、发信间隔与每日上限，防进垃圾箱，本期只做单发。V1 暂不支持自动发信：选模板 + 选线索 → 渲染预览 → 复制 / 打开 mailto → 在自己的邮箱手动发送 → 点「标记已手动发送」记一条记录。</div>
  <div id="letterError"></div>
  <div class="row g-3"><div class="col-lg-7">
    <div class="card panel"><div class="card-header panel-header"><span><i class="bi bi-envelope"></i> 模板列表</span><span class="small text-muted">${templates.length} 个模板</span></div><div class="card-body"><div id="templateList">
      ${templates.length ? templates.map(t => `<div class="d-flex justify-content-between align-items-start gap-2 border rounded p-2 mb-2"><div><div class="fw-bold">${esc(t.name)} <span class="badge bg-secondary">${esc(t.lang || 'en')}</span></div><div class="text-muted small">${esc(t.subject || '')}</div></div><div class="text-nowrap"><button class="btn btn-sm btn-outline-primary me-1" data-tpl-edit="${t.id}">编辑</button><button class="btn btn-sm btn-outline-danger" data-tpl-del="${t.id}">删除</button></div></div>`).join('') : '<div class="text-muted small">暂无模板，在右侧新建一个。</div>'}
    </div></div></div>
    <div class="card panel mt-3"><div class="card-header panel-header"><span><i class="bi bi-send"></i> 写信 / 预览</span><span class="small text-muted">选模板 + 选线索 → 渲染预览</span></div><div class="card-body">
      <div class="row g-2 mb-3">
        <div class="col-md-6"><label class="form-label small">选择模板</label>
          <select class="form-select form-select-sm" id="templateSelect">
            <option value="">请选择模板…</option>
            ${templates.map(t => `<option value="${t.id}">${esc(t.name)}（${esc(t.lang || 'en')}）</option>`).join('')}
          </select>
        </div>
        <div class="col-md-6"><label class="form-label small">选择线索</label>
          <select class="form-select form-select-sm" id="leadSelect">
            <option value="">请选择线索…</option>
            ${leads.map(l => `<option value="${l.id}">${esc(l.company_name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="mb-2"><label class="form-label small">主题</label><div class="fw-semibold" id="letterPreviewSubject">—</div></div>
      <div class="mb-2"><label class="form-label small">正文预览</label><pre class="border rounded p-2 small mb-0" id="letterPreviewBody" style="white-space:pre-wrap">选模板和线索后，这里显示渲染后的开发信。</pre></div>
      <div class="small text-muted mb-3" id="letterContact"></div>
      <div class="d-flex gap-2 align-items-center flex-wrap">
        <button class="btn btn-sm btn-primary" id="btnCopy">复制全文</button>
        <button class="btn btn-sm btn-outline-secondary" id="btnMailto" disabled>打开 mailto</button>
        <select class="form-select form-select-sm w-auto" id="channelSelect"><option value="email">email</option><option value="whatsapp">whatsapp</option></select>
        <button class="btn btn-sm btn-success" id="btnMarkSent">标记已手动发送</button>
      </div>
      <div class="form-text mt-2">收件人取线索的邮箱证据；没有邮箱时 mailto 不可用，只能复制后手动发送。系统不会自动发出邮件，「标记已手动发送」只记一条记录。</div>
    </div></div>
    <div class="card panel mt-3"><div class="card-header panel-header"><span><i class="bi bi-clock-history"></i> 发送记录</span><span class="small text-muted">选线索后显示该线索的记录</span></div><div class="card-body"><div id="sendHistory">
      ${sends.length ? sends.slice(0, 20).map(s => `<div class="small border-bottom py-1"><span class="badge bg-secondary">${esc(s.channel || '')}</span> ${esc(s.subject || '')} · ${esc(s.status || 'sent')} <span class="text-muted">${fmtTime(s.created_at)}</span></div>`).join('') : '<div class="text-muted small">暂无发送记录。</div>'}
    </div></div></div>
  </div><div class="col-lg-5">
    <div class="card panel"><div class="card-header panel-header">新建 / 编辑模板</div><div class="card-body">
      <form id="templateForm">
        <input type="hidden" id="tplId">
        <div class="mb-3"><label class="form-label small fw-semibold">模板名称</label><input class="form-control form-control-sm" id="tplName" required placeholder="例如：锁具初次接洽 EN"></div>
        <div class="mb-3"><label class="form-label small fw-semibold">语言</label><select class="form-select form-select-sm" id="tplLang"><option value="en">en（英文）</option><option value="fr">fr（法文）</option></select></div>
        <div class="mb-3"><label class="form-label small fw-semibold">主题</label><input class="form-control form-control-sm" id="tplSubject" placeholder="支持 {{公司名}} 等占位符"></div>
        <div class="mb-3"><label class="form-label small fw-semibold">正文</label><textarea class="form-control" id="tplBody" rows="10" placeholder="支持占位符：{{公司名}} {{国家}} {{产品}} {{联系人}} {{电话}} {{网址}}"></textarea>
        <div class="form-text">占位符：{{公司名}} {{国家}} {{产品}} {{联系人}} {{电话}} {{网址}}，渲染时替换成对应线索的信息。</div></div>
        <div id="tplFormError"></div>
        <button type="submit" class="btn btn-primary" id="tplSave"><i class="bi bi-check2"></i> 保存模板</button>
        <button type="button" class="btn btn-outline-secondary" id="tplNew">新建</button>
      </form>
    </div></div>
  </div></div>`;
  return layout({ title: '开发信', active: 'letters', content, scripts: ['/static/letters.js'] });
}

// ── 设置 ──
function settingsPage() {
  const s = {
    google_places_key: getSetting('google_places_key'),
    request_delay_ms: getSetting('request_delay_ms'),
    request_timeout_ms: getSetting('request_timeout_ms'),
    proxy_url: getSetting('proxy_url'),
    enabled_sources: getSetting('enabled_sources', ''),
  };
  const mapsEnabled = String(s.enabled_sources).split(',').map(x => x.trim()).includes('google_places');
  const proxyWarn = proxyStatus().warning;
  const content = `
  ${pageHead('数据源设置', 'Key 只保存在本机设置里，不会写进代码或日志')}
  <div class="row g-3"><div class="col-lg-7">
    <form id="settingsForm"><div class="card panel"><div class="card-header panel-header">API Key 与网络</div><div class="card-body">
      <div class="mb-3"><label class="form-label small fw-semibold">网络代理地址（社媒/搜索需走代理时填写）</label><input class="form-control form-control-sm" name="proxy_url" value="${esc(s.proxy_url)}" placeholder="例：http://127.0.0.1:7897，留空则直连"><div class="form-text">本机实测 7897 端口可用；留空则不走代理。修改后立即生效。</div>
      ${proxyWarn ? `<div class="alert alert-warning small mt-2 mb-0"><i class="bi bi-exclamation-triangle"></i> ${esc(proxyWarn)}</div>` : ''}</div>
      <hr>
      <div class="mb-3"><label class="form-label small fw-semibold">地图采集通道</label>
        <input type="hidden" name="enabled_sources" id="enabledSources" value="${esc(s.enabled_sources)}">
        <div class="form-check"><input class="form-check-input source-toggle" type="checkbox" data-source="google_places" id="srcGooglePlaces" ${mapsEnabled ? 'checked' : ''}><label class="form-check-label small" for="srcGooglePlaces">Google 地图采集</label></div>
        <div class="form-text">取消勾选后，地图采集与任务创建都会被拒绝（服务端守门）；勾选后才能发起采集。</div>
      </div>
      <hr>
      <div class="mb-3"><label class="form-label small fw-semibold">Google Places API Key（地图采集）</label>
        <div class="input-group input-group-sm">
          <input class="form-control form-control-sm" type="password" name="google_places_key" id="placesKeyInput" value="${esc(s.google_places_key)}" placeholder="留空则不启用地图采集" autocomplete="off">
          <button class="btn btn-outline-secondary" type="button" id="togglePlacesKey">显示</button>
        </div>
        <div class="form-text">配好 Key 后即可在「地图采集」页使用；Key 只保存在本机设置里，不会写进代码或日志。地图展示由本服务代为加载 Google 地图脚本，Key 不出现在地图页面源码中。</div>
        <div class="alert alert-warning small mt-2 mb-0"><i class="bi bi-exclamation-triangle"></i> <b>Key 限制注意：</b>此 Key 会出现在地图页面加载的脚本中（浏览器能看到），请在 Google Cloud 里只限制 API 范围（Places API (New) + Geocoding API），<b>不要加 HTTP referrer（网站）限制</b>，否则服务端调用会断，地图也加载不出来。</div>
      </div>
      <hr>
      <div class="row g-2">
        <div class="col-md-6"><label class="form-label small">请求间隔(ms)</label><input class="form-control form-control-sm" name="request_delay_ms" value="${esc(s.request_delay_ms)}"></div>
        <div class="col-md-6"><label class="form-label small">超时(ms)</label><input class="form-control form-control-sm" name="request_timeout_ms" value="${esc(s.request_timeout_ms)}"></div>
      </div>
      <button type="submit" class="btn btn-primary mt-3"><i class="bi bi-check2"></i> 保存设置</button>
    </div></div></form>
  </div><div class="col-lg-5">
    <div class="card panel"><div class="card-header panel-header">说明</div><div class="card-body small">
      <p>地图采集走官方 Places API (New)，不是爬虫；地图展示由本服务代为加载，Key 不出现在页面源码中。</p>
      <p>出网默认走代理 <b>127.0.0.1:7897</b>（设置里可改）；代理没开时 Google 请求会失败，请先确认代理在运行。</p>
      <p class="text-muted mb-0">所有 Key 只存 settings 表，不进代码、不进日志。</p>
    </div></div>
  </div></div>`;
  return layout({ title: '数据源设置', active: 'settings', content, scripts: ['/static/settings.js'] });
}

module.exports = { layout, pageHead, dashboardPage, mapsPage, tasksPage, leadsPage, leadDetailPage, importPage, lettersPage, settingsPage, scoreBadge, statusBadge, taskStatusBadge, esc, normalizeWaNumber, countryDialCode };
