'use strict';
/** 服务端渲染视图层（复用主系统 Neo B2B 墨绿设计语言） */
const { all, get, stats, getSetting } = require('./db');
const { getRequestContext } = require('./web');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NAV = [
  { href: '/', key: 'dashboard', icon: 'bi-grid-1x2-fill', label: '概览' },
  { href: '/leads', key: 'leads', icon: 'bi-buildings', label: '线索库' },
  { href: '/verify', key: 'verify', icon: 'bi-check2-circle', label: '核验任务' },
  { href: '/import', key: 'import', icon: 'bi-upload', label: '导入线索' },
  { href: '/settings', key: 'settings', icon: 'bi-gear', label: '数据源设置' },
];

function layout({ title, active, content, flash, scripts }) {
  const st = stats();
  const reqCtx = getRequestContext() || {};
  const loginUser = reqCtx.user || null;
  const userChip = loginUser
    ? `<span class="top-chip" title="当前登录用户"><i class="bi bi-person-circle"></i> ${esc(loginUser.display_name || loginUser.username || '已登录')}${loginUser.role === 'admin' ? ' · 管理员' : ''}</span>`
    : '';
  const mainCrmUrl = (() => {
    const req = reqCtx.req;
    const host = String((req && req.headers && req.headers.host) || '127.0.0.1:5101');
    const ipv6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
    const hostname = ipv6 ? '[' + ipv6[1] + ']' : (host.split(':')[0] || '127.0.0.1');
    return 'http://' + hostname + ':' + (process.env.CRM_PORT || '5000') + '/dashboard';
  })();
  const nav = NAV.map(n => `<a class="nav-link ${active === n.key ? 'active' : ''}" href="${n.href}"><i class="bi ${n.icon}"></i><span>${n.label}</span>${n.key === 'leads' && st.leads ? `<span class="nav-badge">${st.leads}</span>` : ''}</a>`).join('');
  const flashHtml = (flash || []).map((f, i) => `<div class="alert alert-${f.type || 'info'} alert-dismissible fade show" role="alert">${esc(f.msg)}<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 获客核验系统</title>
<link rel="stylesheet" href="/vendor/bootstrap/css/bootstrap.min.css">
<link rel="stylesheet" href="/vendor/bootstrap-icons/bootstrap-icons.min.css">
<link rel="stylesheet" href="/lg-static/app.css">
</head><body>
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><span class="brand-mark"><i class="bi bi-funnel-fill"></i></span><span class="brand-name">获客核验</span><span class="brand-sub">Lead Verifier</span></div>
    <div class="topbar-right">
      ${userChip}
      <span class="top-chip"><i class="bi bi-database"></i> 独立线索库</span>
      <span class="top-chip"><i class="bi bi-shield-check"></i> 多源交叉验证</span>
      <a class="btn btn-sm btn-outline-secondary" href="${mainCrmUrl}" title="返回主系统 CRM"><i class="bi bi-arrow-left"></i> 主系统</a>
    </div>
  </header>
  <aside class="sidebar"><div class="sidebar-section-label">获客工作台</div>${nav}
    <div class="sidebar-foot"><div class="sidebar-stat"><b>${st.leads}</b><span>线索</span></div><div class="sidebar-stat"><b>${st.verified}</b><span>已核验</span></div><div class="sidebar-stat"><b>${st.evidence}</b><span>证据</span></div></div>
  </aside>
  <main class="main-content">
    <div class="page-wrap">${flashHtml}${content}</div>
  </main>
</div>
<script src="/vendor/bootstrap/js/bootstrap.bundle.min.js"></script>
${(scripts || []).map(s => `<script src="${s}"></script>`).join('')}
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
  const map = { new: ['secondary', '待核验'], queued: ['info', '排队中'], verifying: ['info', '核验中'], verified: ['success', '已验证'], review: ['warning', '待复核'], failed: ['danger', '失败'] };
  const [c, t] = map[status] || ['secondary', status];
  return `<span class="badge bg-${c}">${t}</span>`;
}
function stageBadge(stage) {
  const map = { candidate: ['secondary', '候选池'], approved: ['success', '已审批·可联系'], rejected: ['danger', '已驳回'] };
  const [c, t] = map[stage || 'candidate'] || ['secondary', stage];
  return `<span class="badge bg-${c}">${t}</span>`;
}

// ── 概览 ──
function dashboardPage() {
  const st = stats();
  const recent = all(`SELECT l.*, v.overall_score, v.created_at vat FROM leads l LEFT JOIN verifications v ON v.id=(SELECT MAX(id) FROM verifications WHERE lead_id=l.id) ORDER BY l.id DESC LIMIT 8`);
  const inds = all(`SELECT value,COUNT(*) c FROM field_results WHERE field='industry' AND value<>'' GROUP BY value ORDER BY c DESC LIMIT 6`);
  const top = recent.filter(r => r.overall_score).slice(0, 5);
  const content = `
  ${pageHead('获客核验概览', '导入线索 → 多源交叉验证 → 生成可审计画像', `<a class="btn btn-primary" href="/import"><i class="bi bi-plus-lg"></i> 导入线索</a>`)}
  <div class="row g-3 mb-4">
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-primary-subtle text-primary"><i class="bi bi-collection"></i></div><div><div class="stat-num">${st.leads}</div><div class="stat-label">线索总数</div></div></div></div>
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-success-subtle text-success"><i class="bi bi-check2-circle"></i></div><div><div class="stat-num">${st.verified}</div><div class="stat-label">已核验</div></div></div></div>
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-warning-subtle text-warning"><i class="bi bi-exclamation-diamond"></i></div><div><div class="stat-num">${st.review}</div><div class="stat-label">待复核</div></div></div></div>
    <div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon bg-info-subtle text-info"><i class="bi bi-person-check"></i></div><div><div class="stat-num">${st.approved}</div><div class="stat-label">已审批可联系</div></div></div></div>
  </div>
  <div class="row g-3">
    <div class="col-lg-8"><div class="card panel"><div class="card-header panel-header"><span><i class="bi bi-clock-history"></i> 最近线索</span><a href="/leads" class="small">查看全部 →</a></div><div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th>公司</th><th>国家</th><th>行业</th><th>可信分</th><th>状态</th><th>审批</th></tr></thead><tbody>
      ${recent.length ? recent.map(l => {
        const v = l.overall_score ? get('SELECT result_json FROM verifications WHERE lead_id=? ORDER BY id DESC LIMIT 1', l.id) : null;
        let ind = ''; try { ind = v ? (JSON.parse(v.result_json).summary || {}).industry_sub || '' : ''; } catch {}
        return `<tr><td><a href="/lead/${l.id}" class="fw-semibold">${esc(l.company_name)}</a></td><td>${esc(l.country || '—')}</td><td>${esc(ind || '—')}</td><td>${scoreBadge(l.overall_score, (()=>{try{return JSON.parse(v.result_json).level}catch{return ''}})())}</td><td>${statusBadge(l.status)}</td><td>${stageBadge(l.stage)}</td></tr>`;
      }).join('') : '<tr><td colspan="6" class="text-center text-muted py-4">暂无线索，<a href="/import">去导入</a></td></tr>'}
    </tbody></table></div></div></div>
    <div class="col-lg-4"><div class="card panel"><div class="card-header panel-header"><span><i class="bi bi-diagram-3"></i> 行业分布</span></div><div class="card-body">
      ${inds.length ? inds.map(x => `<div class="dist-row"><span class="dist-name">${esc(x.value)}</span><div class="dist-bar"><div style="width:${Math.min(100, x.c * 20)}%"></div></div><span class="dist-c">${x.c}</span></div>`).join('') : '<div class="text-muted small">核验后显示行业分布</div>'}
      <hr><div class="small text-muted"><i class="bi bi-info-circle"></i> 每个字段都会记录来源、原文片段和 URL，可随时回溯核对。</div>
    </div></div></div>
  </div>`;
  return layout({ title: '概览', active: 'dashboard', content });
}

// ── 线索库 ──
function leadsPage(query) {
  const { status = '', stage = '', q = '', sort = 'score' } = query;
  const st = stats();
  let sql = 'SELECT * FROM leads WHERE 1=1', params = [];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (stage) { sql += " AND COALESCE(stage,'candidate')=?"; params.push(stage); }
  if (q) { sql += ' AND (company_name LIKE ? OR website LIKE ? OR country LIKE ?)'; const k = `%${q}%`; params.push(k, k, k); }
  const order = sort === 'id' ? 'id DESC' : 'COALESCE(recommend_score,0) DESC, overall_score DESC, id DESC';
  const leads = all(sql + ' ORDER BY ' + order, ...params);
  const stageOpts = [['', '全部审批状态'], ['candidate', '候选池'], ['approved', '已审批可联系'], ['rejected', '已驳回']];
  const content = `
  ${pageHead('线索库', `共 ${leads.length} 条 · 候选 ${st.candidate} / 已审批 ${st.approved} / 已驳回 ${st.rejected}`,
    `<a class="btn btn-outline-success btn-sm" href="/api/export?stage=approved"><i class="bi bi-download"></i> 导出已审批</a><button class="btn btn-outline-primary btn-sm" id="btnExport"><i class="bi bi-download"></i> 导出报告</button><a class="btn btn-primary btn-sm" href="/import"><i class="bi bi-plus-lg"></i> 导入</a>`)}
  <div class="card panel"><div class="card-body">
    <form class="row g-2 filter-bar" method="get" action="/leads">
      <div class="col-md-4"><input class="form-control form-control-sm" name="q" placeholder="搜索公司 / 网址 / 国家" value="${esc(q)}"></div>
      <div class="col-md-2"><select class="form-select form-select-sm" name="status"><option value="">全部核验状态</option>${[['new','待核验'],['verified','已验证'],['review','待复核'],['verifying','核验中'],['failed','失败']].map(([v,t])=>`<option value="${v}" ${status===v?'selected':''}>${t}</option>`).join('')}</select></div>
      <div class="col-md-2"><select class="form-select form-select-sm" name="stage">${stageOpts.map(([v,t])=>`<option value="${v}" ${stage===v?'selected':''}>${t}</option>`).join('')}</select></div>
      <div class="col-md-2"><select class="form-select form-select-sm" name="sort"><option value="score">按推荐分</option><option value="id" ${sort==='id'?'selected':''}>按导入时间</option></select></div>
      <div class="col-md-2"><button class="btn btn-sm btn-primary w-100"><i class="bi bi-search"></i> 筛选</button></div>
    </form>
    <div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr>
      <th><input type="checkbox" id="checkAll"></th><th>公司</th><th>国家</th><th>行业</th><th>规模</th><th>社媒</th><th>可信分</th><th>推荐分</th><th>状态</th><th>审批</th><th>操作</th>
    </tr></thead><tbody id="leadRows">
      ${leads.length ? leads.map(l => {
        const v = get('SELECT result_json FROM verifications WHERE lead_id=? ORDER BY id DESC LIMIT 1', l.id);
        let s = {}, lvl = '', recLevel = ''; try { const pj = v ? JSON.parse(v.result_json) : {}; s = pj.summary || {}; lvl = pj.level || ''; recLevel = (pj.recommendation || {}).level || ''; } catch {}
        const curStage = l.stage || 'candidate';
        return `<tr>
          <td><input type="checkbox" class="lead-check" value="${l.id}"></td>
          <td><a href="/lead/${l.id}" class="fw-semibold">${esc(l.company_name)}</a>${l.website?`<div class="small text-muted">${esc(l.website)}</div>`:''}</td>
          <td>${esc(l.country||'—')}</td>
          <td>${esc(s.industry_sub||'—')}</td>
          <td>${esc(s.size_bucket||'—')}</td>
          <td>${(s.social_platforms||[]).length ? `<span class="badge bg-light text-dark border">${(s.social_platforms||[]).slice(0,3).join('/')}</span>` : '—'}</td>
          <td>${scoreBadge(l.overall_score, lvl)}</td>
          <td>${l.recommend_score ? `<span class="badge bg-light text-dark border" title="${esc(recLevel)}">${l.recommend_score}</span>` : '—'}</td>
          <td>${statusBadge(l.status)}</td>
          <td>${stageBadge(curStage)}</td>
          <td class="text-nowrap"><button class="btn btn-sm btn-outline-primary verify-one" data-id="${l.id}"><i class="bi bi-arrow-repeat"></i></button>
            ${curStage !== 'approved' ? `<button class="btn btn-sm btn-outline-success stage-one" data-id="${l.id}" data-stage="approved" title="审批通过（可联系）"><i class="bi bi-check-lg"></i></button>` : ''}
            ${curStage !== 'rejected' ? `<button class="btn btn-sm btn-outline-danger stage-one" data-id="${l.id}" data-stage="rejected" title="驳回"><i class="bi bi-x-lg"></i></button>` : ''}
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="11" class="text-center text-muted py-5">暂无线索。<a href="/import">导入线索</a>开始核验。</td></tr>`}
    </tbody></table></div>
    ${leads.length ? `<div class="bulk-bar"><button class="btn btn-sm btn-primary" id="btnVerifySelected"><i class="bi bi-arrow-repeat"></i> 核验选中 (<span id="selCount">0</span>)</button><button class="btn btn-sm btn-outline-success" id="btnApproveSelected">审批通过选中</button><button class="btn btn-sm btn-outline-danger" id="btnRejectSelected">驳回选中</button><button class="btn btn-sm btn-outline-secondary" id="btnApproveRecommended">一键勾选推荐分达标</button><button class="btn btn-sm btn-outline-secondary" id="btnExportSel">导出选中</button></div>` : ''}
  </div></div>`;
  return layout({ title: '线索库', active: 'leads', content, scripts: ['/lg-static/leads.js'] });
}

// ── 线索详情 ──
function leadDetailPage(id) {
  const lead = get('SELECT * FROM leads WHERE id=?', id);
  if (!lead) return layout({ title: '未找到', active: 'leads', content: pageHead('未找到线索') + '<div class="alert alert-warning">线索不存在。</div>' });
  const ver = get('SELECT * FROM verifications WHERE lead_id=? ORDER BY id DESC LIMIT 1', id);
  const evidence = all('SELECT * FROM evidence WHERE lead_id=? ORDER BY field,id', id);
  let r = {}; try { r = ver ? JSON.parse(ver.result_json) : {}; } catch {}
  const summary = r.summary || {};
  const FIELD_CN = { industry: '行业', size: '规模', country: '国家', website: '官网', social: '社媒', founded: '成立年份', followers: '粉丝数', email: '邮箱', phone: '电话', description: '描述' };
  const STATUS_CN = { confirmed: ['已确认','success'], weak: ['证据弱','warning'], conflict: ['冲突','danger'], missing: ['缺失','secondary'] };
  const SOURCE_CN = { website: '官网', bing: 'Bing', linkedin_search: 'LinkedIn搜索', facebook_search: 'Facebook搜索', instagram_search: 'Instagram搜索', linkedin_page: 'LinkedIn主页', facebook_page: 'Facebook主页', instagram_page: 'Instagram主页', google_cse: 'Google', serpapi: 'SerpAPI', manual: '手工' };

  const fieldCards = (r.fields || []).filter(f => f.field !== 'description').map(f => {
    const [st, sc] = STATUS_CN[f.status] || [f.status, 'secondary'];
    return `<div class="field-card"><div class="field-head"><span class="field-name">${FIELD_CN[f.field]||f.field}</span><span class="badge bg-${sc}">${st}</span></div>
      <div class="field-value">${esc(f.value || '—')}</div>
      <div class="field-meta"><span>置信度 <b>${Math.round((f.confidence||0)*100)}%</b></span><span>${f.evidence_count} 条证据</span></div></div>`;
  }).join('');

  const detailRows = (r.fields || []).filter(f => f.detail && f.detail.length).map(f => {
    const groups = f.detail.slice(0, 3).map(d => {
      const srcs = (d.sources||[]).slice(0,3).map(s => `<div class="ev-src"><span class="badge bg-light text-dark border">${SOURCE_CN[s.source]||s.source}</span> <span class="text-muted small">${Math.round((s.confidence||0)*100)}%</span>${s.url?` <a href="${esc(s.url)}" target="_blank" class="small"><i class="bi bi-box-arrow-up-right"></i></a>`:''}${s.snippet?`<div class="ev-snippet">${esc(String(s.snippet).slice(0,160))}</div>`:''}</div>`).join('');
      return `<div class="cand"><b>${esc(d.value||'—')}</b> <span class="text-muted small">(${d.sources.length} 来源)</span>${srcs}</div>`;
    }).join('');
    return `<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#fd-${f.field}"><b>${FIELD_CN[f.field]||f.field}</b> <span class="text-muted small ms-2">${f.detail.length} 个候选值</span></button></h2><div id="fd-${f.field}" class="accordion-collapse collapse"><div class="accordion-body">${groups}</div></div></div>`;
  }).join('');

  const content = `
  ${pageHead(esc(lead.company_name), `${lead.country||'国家未知'} · ${lead.website||'无官网'}`,
    `<button class="btn btn-sm btn-outline-primary" data-verify-id="${lead.id}"><i class="bi bi-arrow-repeat"></i> 重新核验</button>
     ${(lead.stage || 'candidate') !== 'approved' ? `<button class="btn btn-sm btn-outline-success stage-one" data-id="${lead.id}" data-stage="approved"><i class="bi bi-check-lg"></i> 审批通过</button>` : ''}
     ${(lead.stage || 'candidate') !== 'rejected' ? `<button class="btn btn-sm btn-outline-danger stage-one" data-id="${lead.id}" data-stage="rejected"><i class="bi bi-x-lg"></i> 驳回</button>` : ''}
     ${(lead.stage || 'candidate') !== 'candidate' ? `<button class="btn btn-sm btn-outline-secondary stage-one" data-id="${lead.id}" data-stage="candidate">退回候选</button>` : ''}
     <a class="btn btn-sm btn-outline-secondary" href="/lead/${lead.id}/report"><i class="bi bi-file-earmark-excel"></i> 报告</a><a class="btn btn-sm btn-secondary" href="/leads">返回</a>`)}
  <div class="row g-3">
    <div class="col-lg-4">
      <div class="card panel mb-3"><div class="card-body text-center">
        <div class="score-ring" style="--score:${(r.overall_score||0)*3.6}deg"><div class="score-inner"><div class="score-num">${r.overall_score||0}</div><div class="score-cap">可信分 / ${r.level||'—'}</div></div></div>
        <div class="mt-3">${statusBadge(lead.status)} ${stageBadge(lead.stage)}</div>
        <div class="small text-muted mt-2">核验时间 ${esc((r.verified_at||lead.updated_at||'').slice(0,19).replace('T',' '))}</div>
        ${lead.review_note ? `<div class="small text-muted mt-1">审批备注：${esc(lead.review_note)}</div>` : ''}
      </div></div>
      ${r.recommendation ? `<div class="card panel mb-3"><div class="card-header panel-header"><span><i class="bi bi-stars"></i> 联系推荐分</span><span class="badge bg-light text-dark border">${r.recommendation.level || ''}</span></div><div class="card-body">
        <div class="d-flex align-items-baseline gap-2 mb-2"><div class="fs-3 fw-bold">${r.recommendation.score || 0}</div><div class="small text-muted">/ 100 · 达标线 ${r.recommendation.min_score || 70}</div></div>
        <div class="small">${(r.recommendation.reasons || []).map(x => `<div>${esc(x)}</div>`).join('') || '<span class="text-muted">暂无评分明细</span>'}</div>
        <div class="small text-muted mt-2"><i class="bi bi-info-circle"></i> 推荐分只作建议，是否可联系仍由人工审批决定。</div>
      </div></div>` : ''}
      <div class="card panel"><div class="card-header panel-header">核验结论</div><div class="card-body p-0"><table class="table table-sm mb-0 summary-table">
        <tr><th>一级行业</th><td>${esc(summary.industry_sector||'—')}</td></tr>
        <tr><th>细分行业</th><td>${esc(summary.industry_sub||'—')}</td></tr>
        <tr><th>规模档</th><td>${esc(summary.size||'—')}</td></tr>
        <tr><th>员工估算</th><td>${summary.employees_est||'—'}</td></tr>
        <tr><th>社媒粉丝</th><td>${summary.followers ? Number(summary.followers).toLocaleString() : '—'}</td></tr>
        <tr><th>国家</th><td>${esc(summary.country||'—')}</td></tr>
        <tr><th>官网</th><td>${summary.website?`<a href="https://${esc(summary.website)}" target="_blank">${esc(summary.website)}</a>`:'—'}</td></tr>
        <tr><th>成立年份</th><td>${esc(summary.founded||'—')}</td></tr>
        <tr><th>社媒</th><td>${(summary.social_platforms||[]).join('、')||'—'}</td></tr>
        <tr><th>邮箱</th><td>${esc((summary.emails||[]).join('、')||'—')}</td></tr>
        <tr><th>电话</th><td>${esc((summary.phones||[]).join('、')||'—')}</td></tr>
      </table></div></div>
    </div>
    <div class="col-lg-8">
      <div class="card panel mb-3"><div class="card-header panel-header"><span><i class="bi bi-grid"></i> 字段级验证</span><span class="small text-muted">多源一致才确认，冲突会显式标记</span></div><div class="card-body"><div class="field-grid">${fieldCards||'<div class="text-muted">尚未核验</div>'}</div></div></div>
      <div class="card panel"><div class="card-header panel-header"><span><i class="bi bi-list-check"></i> 证据链（可审计）</span><span class="small text-muted">${evidence.length} 条原始证据</span></div><div class="card-body">
        ${detailRows ? `<div class="accordion accordion-flush" id="detailAcc">${detailRows}</div>` : '<div class="text-muted">暂无证据链</div>'}
        <details class="mt-3"><summary class="small text-muted">查看全部原始证据 (${evidence.length})</summary><div class="table-responsive mt-2"><table class="table table-sm"><thead><tr><th>来源</th><th>字段</th><th>内容</th><th>链接</th></tr></thead><tbody>
        ${evidence.map(e => `<tr><td>${SOURCE_CN[e.source]||e.source}</td><td>${FIELD_CN[e.field]||e.field}</td><td class="small">${esc(String(e.snippet||e.raw_value||'').slice(0,120))}</td><td>${e.url?`<a href="${esc(e.url)}" target="_blank"><i class="bi bi-box-arrow-up-right"></i></a>`:''}</td></tr>`).join('')}
        </tbody></table></div></details>
      </div></div>
    </div>
  </div>`;
  return layout({ title: lead.company_name, active: 'leads', content, scripts: ['/lg-static/leads.js'] });
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
    <div class="card panel"><div class="card-header panel-header">核验流程说明</div><div class="card-body">
      <ol class="step-list">
        <li><b>导入线索</b><span>按域名/公司名自动去重，重复项跳过</span></li>
        <li><b>多源采集</b><span>官网元数据（JSON-LD / OpenGraph）+ 搜索引擎索引 + 社媒公开页链接</span></li>
        <li><b>交叉验证</b><span>每个字段多来源投票，一致才确认，冲突显式标记</span></li>
        <li><b>生成画像</b><span>行业、规模、成立年份、社媒、联系方式 + 可信分/推荐分</span></li>
        <li><b>人工审批</b><span>推荐分达标且无冲突的候选可一键勾选，最终由人工确认可联系</span></li>
        <li><b>导出报告</b><span>Excel 含线索总览、字段验证明细、完整证据链</span></li>
      </ol>
      <div class="alert alert-info small mt-2 mb-0"><i class="bi bi-shield-check"></i> 系统不编造数据：找不到的字段留空并标记「缺失」，所有结论均可追溯到来源 URL。</div>
    </div></div>
  </div></div>`;
  return layout({ title: '导入线索', active: 'import', content, scripts: ['/lg-static/import.js'] });
}

// ── 核验任务 ──
function verifyPage() {
  const jobs = all('SELECT * FROM jobs ORDER BY id DESC LIMIT 20');
  const content = `
  ${pageHead('核验任务', '批量核验进度与历史', `<button class="btn btn-sm btn-primary" id="btnVerifyAll"><i class="bi bi-arrow-repeat"></i> 核验全部待办线索</button>`)}
  <div class="card panel"><div class="card-body">
    <div id="verifyProgress" class="mb-3" style="display:none"><div class="d-flex justify-content-between small mb-1"><span id="vpLabel">核验中…</span><span id="vpPct">0%</span></div><div class="progress"><div id="vpBar" class="progress-bar progress-bar-striped progress-bar-animated" style="width:0%"></div></div></div>
    <div class="table-responsive"><table class="table align-middle"><thead><tr><th>任务ID</th><th>类型</th><th>进度</th><th>状态</th><th>创建时间</th><th>错误信息</th></tr></thead><tbody>
      ${jobs.length ? jobs.map(j => `<tr><td>#${j.id}</td><td>${esc(j.kind)}</td><td>${j.total?`${j.progress}/${j.total}`:'—'}</td><td>${statusBadge(j.status==='done'?'verified':j.status==='running'?'verifying':j.status==='queued'?'queued':'failed')}</td><td class="small text-muted">${esc((j.created_at||'').slice(0,19).replace('T',' '))}</td><td class="small text-danger">${esc(j.error||'')}</td></tr>`).join('') : '<tr><td colspan="6" class="text-center text-muted py-4">暂无任务</td></tr>'}
    </tbody></table></div>
  </div></div>`;
  return layout({ title: '核验任务', active: 'verify', content, scripts: ['/lg-static/verify.js'] });
}

// ── 设置 ──
function settingsPage() {
  const s = { google_cse_key: getSetting('google_cse_key'), google_cse_cx: getSetting('google_cse_cx'), serpapi_key: getSetting('serpapi_key'), request_delay_ms: getSetting('request_delay_ms'), request_timeout_ms: getSetting('request_timeout_ms'), max_results_per_query: getSetting('max_results_per_query'), proxy_url: getSetting('proxy_url'), jina_reader: getSetting('jina_reader'), jina_base: getSetting('jina_base'), enabled_sources: getSetting('enabled_sources', 'website,bing,linkedin_search,facebook_search,instagram_search,google_cse,serpapi'), approval_min_score: getSetting('approval_min_score', '70') };
  const enabled = new Set(String(s.enabled_sources).split(',').map(x => x.trim()).filter(Boolean));
  const providers = [['website','官网元数据'],['bing','Bing 搜索'],['linkedin_search','LinkedIn 搜索'],['facebook_search','Facebook 搜索'],['instagram_search','Instagram 搜索'],['google_cse','Google CSE（需 Key）'],['serpapi','SerpAPI（需 Key）']];
  const content = `
  ${pageHead('数据源设置', '免密通道开箱即用；配置 API Key 可显著提升搜索覆盖与规模识别')}
  <div class="row g-3"><div class="col-lg-7">
    <form id="settingsForm"><div class="card panel"><div class="card-header panel-header">可选增强数据源（API Key）</div><div class="card-body">
      <div class="alert alert-success small"><i class="bi bi-check-circle"></i> 已启用社媒直读：通过文本阅读器读取 LinkedIn / Facebook 公开主页，可拿到<b>公司规模（员工数）、行业、粉丝数、联系方式</b>等硬指标。</div>
      <div class="mb-3"><label class="form-label small fw-semibold">网络代理地址（社媒/搜索需走代理时填写）</label><input class="form-control form-control-sm" name="proxy_url" value="${esc(s.proxy_url)}" placeholder="例：http://127.0.0.1:7897，留空则直连"><div class="form-text">本机实测 7897 端口可用；留空则不走代理。修改后立即生效。</div></div>
      <div class="row g-2 mb-3"><div class="col-md-8"><label class="form-label small fw-semibold">文本阅读器地址（读社媒主页）</label><input class="form-control form-control-sm" name="jina_base" value="${esc(s.jina_base)}"></div><div class="col-md-4"><label class="form-label small fw-semibold">启用社媒直读</label><select class="form-select form-select-sm" name="jina_reader"><option value="1" ${s.jina_reader==='1'?'selected':''}>启用</option><option value="0" ${s.jina_reader==='0'?'selected':''}>关闭</option></select></div></div>
      <hr>
      <div class="mb-3"><label class="form-label small fw-semibold">启用的采集通道（借鉴 GoodJob 的 Provider 开关）</label>
        <input type="hidden" name="enabled_sources" id="enabledSources" value="${esc(s.enabled_sources)}">
        <div>${providers.map(([v,t]) => `<div class="form-check form-check-inline"><input class="form-check-input source-toggle" type="checkbox" data-source="${v}" ${enabled.has(v)?'checked':''}><label class="form-check-label small">${t}</label></div>`).join('')}</div>
        <div class="form-text">未勾选的通道不会发起请求；未配置 Key 的增强源会自动跳过，不阻塞核验。</div>
      </div>
      <div class="mb-3"><label class="form-label small fw-semibold">人工审批建议阈值（推荐分）</label><input class="form-control form-control-sm" type="number" min="0" max="100" name="approval_min_score" value="${esc(s.approval_min_score)}"><div class="form-text">仅影响「建议通过」提示；一键勾选和人工审批仍由人确认。</div></div>
      <hr>
      <div class="mb-3"><label class="form-label small fw-semibold">Google Custom Search API Key</label><input class="form-control form-control-sm" name="google_cse_key" value="${esc(s.google_cse_key)}" placeholder="留空则不启用"></div>
      <div class="mb-3"><label class="form-label small fw-semibold">Google CSE CX (搜索引擎 ID)</label><input class="form-control form-control-sm" name="google_cse_cx" value="${esc(s.google_cse_cx)}"></div>
      <div class="mb-3"><label class="form-label small fw-semibold">SerpAPI Key</label><input class="form-control form-control-sm" name="serpapi_key" value="${esc(s.serpapi_key)}"></div>
      <hr>
      <div class="row g-2">
        <div class="col-md-4"><label class="form-label small">请求间隔(ms)</label><input class="form-control form-control-sm" name="request_delay_ms" value="${esc(s.request_delay_ms)}"></div>
        <div class="col-md-4"><label class="form-label small">超时(ms)</label><input class="form-control form-control-sm" name="request_timeout_ms" value="${esc(s.request_timeout_ms)}"></div>
        <div class="col-md-4"><label class="form-label small">每次结果数</label><input class="form-control form-control-sm" name="max_results_per_query" value="${esc(s.max_results_per_query)}"></div>
      </div>
      <button type="submit" class="btn btn-primary mt-3"><i class="bi bi-check2"></i> 保存设置</button>
    </div></div></form>
  </div><div class="col-lg-5">
    <div class="card panel"><div class="card-header panel-header">当前网络环境说明</div><div class="card-body small">
      <p><b class="text-success">已打通社媒直读</b>：走 7897 代理 + r.jina.ai 文本阅读器，可读取 LinkedIn / Facebook 公开主页，拿到<b>员工规模、行业、粉丝数、地址、邮箱</b>等硬指标。</p>
      <p>实测各通道：<span class="text-success">官网直连 ✓</span>、<span class="text-success">LinkedIn 主页（经阅读器）✓</span>、<span class="text-success">Facebook 主页（经阅读器）✓</span>、<span class="text-warning">Instagram 落登录墙</span>、<span class="text-warning">Google 搜索需 API Key</span>。</p>
      <p>系统先用官网抓元数据，再用公司名定位社媒主页直读硬指标，多源交叉验证后生成画像。</p>
      <p class="text-muted mb-0">所有结论带来源 URL 与原文片段，可审计；找不到就留空，不编造。</p>
    </div></div>
  </div></div>`;
  return layout({ title: '数据源设置', active: 'settings', content, scripts: ['/lg-static/settings.js'] });
}

module.exports = { layout, pageHead, dashboardPage, leadsPage, leadDetailPage, importPage, verifyPage, settingsPage, scoreBadge, statusBadge, esc };
