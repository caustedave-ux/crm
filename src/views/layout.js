'use strict';
// ============ 页面布局（HQ CRM UI：顶部栏 + 侧栏） ============
const { esc } = require('../util');
const { get } = require('../db');
const APP_VERSION = require('../../package.json').version;

// 2.0 导航：按图片架构（外贸AI客服工作台 2.0）。原有路由仍可直接访问，
// 只是不再全部列在侧栏；库存/供应商/物流/货款/单据模板等入口保留在
// 工作台、订单管理与系统设置页内的快捷入口中。产品信息已放回侧栏。
const NAV = [
  { href: '/dashboard', key: 'dashboard', icon: 'bi-house', label: '工作台', section: '工作台' },
  { href: '/whatsapp/session', key: 'wa', icon: 'bi-whatsapp', label: 'WhatsApp' },
  { href: '/leadgen', key: 'leadgen', icon: 'bi-funnel', label: '获客工作台', target: '_blank' },
  { href: '/products', key: 'products', icon: 'bi-box-seam', label: '产品信息', section: '产品' },
  { href: '/customers', key: 'customers', icon: 'bi-person', label: '客户管理', section: '客户与沟通' },
  { href: '/inquiries', key: 'inquiries', icon: 'bi-inbox', label: '询盘管理' },
  { href: '/quotes', key: 'quotes', icon: 'bi-tag', label: '报价管理', section: '报价与履约' },
  { href: '/documents', key: 'documents', icon: 'bi-file-earmark-text', label: '订单管理' },
  { href: '/followups', key: 'followups', icon: 'bi-check2-square', label: '跟进任务' },
  { href: '/knowledge', key: 'knowledge', icon: 'bi-journal-richtext', label: '知识库与 AI 助手', section: 'AI 与分析' },
  { href: '/stats', key: 'stats', icon: 'bi-bar-chart', label: '数据统计' },
  { href: '/settings', key: 'settings', icon: 'bi-gear', label: '系统设置', section: '系统' },
];

function alertHtml(m) {
  const map = { success: 'success', danger: 'danger', error: 'danger', info: 'info', warning: 'warning' };
  const cls = map[m.category] || 'info';
  return `<div class="alert alert-${cls} alert-dismissible fade show" role="alert">${esc(m.msg)}
  <button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>`;
}

function page(opts) {
  const { title, active, user, content, flash, scripts } = opts;
  let lowStock = 0;
  try {
    lowStock = (get('SELECT COUNT(*) c FROM products WHERE stock <= stock_alert').c || 0) + (get("SELECT COUNT(*) c FROM stock_reminders WHERE status='待处理'").c || 0);
  } catch (e) {}
  let warnFollow = 0, poolCount = 0, inquiryCount = 0, followDue = 0, lgsDue = 0, waUnread = 0;
  const todayStr = (() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  })();
  try {
    const { staleCustomers } = require('../reminders');
    warnFollow = staleCustomers(user ? user.id : null).warn.length;
    poolCount = (get('SELECT COUNT(*) c FROM customers WHERE COALESCE(in_pool,0)=1').c) || 0;
    inquiryCount = (get(`SELECT COUNT(*) c FROM website_inquiries i JOIN customers c ON c.id=i.customer_id
      WHERE COALESCE(c.in_pool,0)=1`).c) || 0;
    followDue = (get("SELECT COUNT(*) c FROM activities WHERE user_id=? AND archived=0 AND next_follow_date IS NOT NULL AND next_follow_date<>'' AND next_follow_date<=?", user ? user.id : 0, todayStr).c) || 0;
    lgsDue = (get("SELECT COUNT(*) c FROM logistics_shipments WHERE user_id=? AND status NOT IN ('已签收','已取消') AND next_check_at IS NOT NULL AND next_check_at<>'' AND substr(next_check_at,1,10)<=?", user ? user.id : 0, todayStr).c) || 0;
    waUnread = (get(`SELECT COALESCE(SUM(c.unread),0) c FROM wa_chats c WHERE
      c.account_id IN (SELECT id FROM wa_accounts WHERE user_id=?)
      OR c.customer_id IN (SELECT id FROM customers WHERE user_id=?)`, user ? user.id : 0, user ? user.id : 0).c) || 0;
  } catch (e) {}
  const followBadge = followDue > 0 ? followDue : warnFollow;

  const fmtBadge = (n) => n > 99 ? '99+' : String(n);
  let lastSection = '';
  const navHtml = NAV.map(n => {
    const activeCls = (active === n.key) ? 'active' : '';
    let badgeHtml = '';
    let badgeClass = '';
    if (n.key === 'stock' && lowStock > 0) { badgeHtml = fmtBadge(lowStock); badgeClass = 'nav-badge-danger'; }
    if (n.key === 'followups' && followBadge > 0) { badgeHtml = fmtBadge(followBadge); badgeClass = 'nav-badge-danger'; }
    if (n.key === 'inquiries' && inquiryCount > 0) { badgeHtml = fmtBadge(inquiryCount); badgeClass = 'nav-badge-warning'; }
    if (n.key === 'wa' && waUnread > 0) { badgeHtml = fmtBadge(waUnread); badgeClass = 'nav-badge-danger'; }
    if (n.key === 'pool' && poolCount > 0) { badgeHtml = fmtBadge(poolCount); badgeClass = 'nav-badge-warning'; }
    if (n.key === 'logistics' && lgsDue > 0) { badgeHtml = fmtBadge(lgsDue); badgeClass = 'nav-badge-danger'; }
    const section = n.section && n.section !== lastSection ? `<div class="sidebar-section-label">${esc(n.section)}</div>` : '';
    if (n.section) lastSection = n.section;
    const targetAttr = n.target ? ` target="${esc(n.target)}" rel="noopener"` : '';
    return `${section}<a class="nav-link ${activeCls}" href="${n.href}"${targetAttr}><span class="nav-main"><i class="bi ${n.icon} nav-icon"></i><span class="nav-label">${n.label}</span></span>${badgeHtml ? `<span class="nav-badge ${badgeClass}">${badgeHtml}</span>` : ''}</a>`;
  }).join('\n');

  const flashHtml = (flash || []).map(alertHtml).join('\n');
  const scriptHtml = (scripts || []).map(s => `<script src="${s}"></script>`).join('\n');
  const roleText = user && user.role === 'admin' ? '系统管理员' : '业务员';
  const userName = user && user.display_name ? user.display_name : '用户';
  const userInitial = String(userName).trim().slice(0, 1).toUpperCase() || 'U';
  // 强弹窗通知未读数：客户给出具体需求转人工（notifications 表）
  let notifUnread = 0, notifLatestLink = '/whatsapp/session';
  try {
    notifUnread = (get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0', user ? user.id : 0).c) || 0;
    if (notifUnread > 0) {
      const latest = get('SELECT link FROM notifications WHERE user_id=? AND is_read=0 ORDER BY id DESC LIMIT 1', user ? user.id : 0);
      if (latest && latest.link) notifLatestLink = latest.link;
    }
  } catch (e) {}
  const notifyCount = lowStock + warnFollow + poolCount + inquiryCount + followDue + waUnread + notifUnread;
  const notifyItems = [
    { href: notifLatestLink, icon: 'bi-bell-fill', label: '客户给出具体需求', count: notifUnread },
    { href: '/followups', icon: 'bi-calendar2-check', label: '今日 / 逾期跟进', count: followDue },
    { href: '/inquiries', icon: 'bi-globe2', label: '独立站询盘（待领取）', count: inquiryCount },
    { href: '/whatsapp/session?filter=unread', icon: 'bi-whatsapp', label: 'WhatsApp 未读', count: waUnread },
    { href: '/customers?status=', icon: 'bi-exclamation-triangle', label: '客户超期预警', count: warnFollow },
    { href: '/pool', icon: 'bi-people-fill', label: '公共客户池', count: poolCount },
    { href: '/stock', icon: 'bi-boxes', label: '库存提醒', count: lowStock },
  ].filter(x => x.count > 0);
  const notifyHtml = notifyItems.length
    ? notifyItems.map(x => `<li><a class="dropdown-item" href="${x.href}"><i class="bi ${x.icon}"></i><span class="dropdown-alert-row"><strong>${x.label}</strong><span>${x.count}</span></span></a></li>`).join('')
    : '<li><div class="dropdown-item text-muted"><i class="bi bi-check2-circle text-success"></i>当前没有待处理提醒</div></li>';

  const bodyClass = 'workbench-2' + (active ? ' page-' + String(active).replace(/[^a-z0-9_-]/gi, '') : '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - 外贸AI客服工作台 2.0</title>
<link rel="stylesheet" href="/static/vendor/bootstrap/css/bootstrap.min.css">
<link rel="stylesheet" href="/static/vendor/bootstrap-icons/bootstrap-icons.min.css">
<link rel="stylesheet" href="/static/css/style.css">
</head>
<body class="${bodyClass}">
<div class="app-shell">
  <header class="topbar">
    <a class="topbar-brand" href="/dashboard" title="外贸AI客服工作台 2.0">
      <img class="topbar-logo" src="/static/img/logo-mark.svg" alt="外贸AI客服工作台 2.0">
      <span class="topbar-brand-copy">
        <span class="topbar-product">外贸AI客服工作台 2.0 <span class="pro-pill">V${esc(APP_VERSION)}</span></span>
        <span class="topbar-context">WhatsApp · AI客服 · CRM · 报价 · 订单 · 知识库</span>
      </span>
    </a>
    <form class="global-search" method="get" action="/customers" role="search">
      <i class="bi bi-search"></i>
      <input type="search" name="search" placeholder="搜索客户、订单、报价、产品…" aria-label="搜索客户、订单、报价、产品">
    </form>
    <div class="topbar-actions">
      <a class="topbar-new" href="/documents/new"><i class="bi bi-plus-lg"></i><span>新建单据</span></a>
      <div class="dropdown">
        <button class="topbar-icon-btn" type="button" data-bs-toggle="dropdown" aria-label="提醒中心">
          <i class="bi bi-bell"></i>${notifyCount > 0 ? `<span class="topbar-count">${notifyCount > 99 ? '99+' : notifyCount}</span>` : ''}
        </button>
        <ul class="dropdown-menu dropdown-menu-end neo-dropdown">
          <li><div class="dropdown-item-text px-2 pb-1 pt-1 small fw-bold text-muted">提醒中心</div></li>
          ${notifyHtml}
        </ul>
      </div>
      <div class="dropdown">
        <button class="user-trigger" type="button" data-bs-toggle="dropdown">
          <span class="user-copy"><span class="user-name">${esc(userName)}</span><span class="user-role">${roleText}</span></span>
          <span class="user-avatar">${esc(userInitial)}</span>
        </button>
        <ul class="dropdown-menu dropdown-menu-end neo-dropdown">
          <li><div class="dropdown-item-text px-2 pb-2 pt-1"><div class="fw-bold">${esc(userName)}</div><div class="small text-muted">${roleText}</div></div></li>
          <li><hr class="dropdown-divider"></li>
          <li><a class="dropdown-item" href="/settings"><i class="bi bi-person-gear"></i>账号与密码</a></li>
          <li><form method="post" action="/logout"><button class="dropdown-item" type="submit"><i class="bi bi-box-arrow-right"></i>退出登录</button></form></li>
        </ul>
      </div>
    </div>
  </header>

  <aside class="sidebar">
    <nav class="nav flex-column sidebar-nav">${navHtml}</nav>
    <div class="sidebar-foot"><span class="sidebar-status"><span class="sidebar-status-dot"></span>局域网在线</span><span>V${esc(APP_VERSION)}</span></div>
  </aside>

  <main class="content">
    ${flashHtml}
    ${content}
  </main>
</div>
<div class="lightbox-mask" id="lightboxMask">
  <div class="lightbox-close" id="lightboxClose">&times;</div>
  <img id="lightboxImg" alt="">
  <div class="lightbox-cap" id="lightboxCap"></div>
</div>
<script src="/static/vendor/bootstrap/js/bootstrap.bundle.min.js"></script>
<script src="/static/js/app.js"></script>
<div class="notify-toast-stack" id="notifyToastStack" aria-live="polite"></div>
<script>
(function () {
  var stack = document.getElementById('notifyToastStack');
  if (!stack) return;
  var shown = {};
  var soundOn = true;
  try { soundOn = localStorage.getItem('crm_wa_sound') !== '0'; } catch (e) {}
  var audioCtx = null;
  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
    } catch (e) {}
  }
  function beep() {
    if (!soundOn) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      var ctx = audioCtx;
      var play = function () {
        try {
          var now = ctx.currentTime;
          [0, 0.14].forEach(function (offset, index) {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(index === 0 ? 880 : 1174.66, now + offset);
            gain.gain.setValueAtTime(0.0001, now + offset);
            gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.12);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + offset);
            osc.stop(now + offset + 0.13);
          });
        } catch (e) {}
      };
      if (ctx.state === 'suspended') { try { ctx.resume().then(play).catch(function () {}); } catch (e) {} }
      else play();
    } catch (e) {}
  }
  function markRead(id) {
    try {
      fetch('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    } catch (e) {}
  }
  function buildCard(n) {
    var card = document.createElement('div');
    card.className = 'notify-toast';
    card.setAttribute('role', 'alert');
    var head = document.createElement('div');
    head.className = 'notify-toast-head';
    var bell = document.createElement('i');
    bell.className = 'bi bi-bell-fill';
    var headText = document.createElement('span');
    headText.textContent = '客户给出具体需求';
    var time = document.createElement('span');
    time.className = 'notify-toast-time';
    time.textContent = String(n.created_at || '').slice(0, 16);
    head.appendChild(bell);
    head.appendChild(headText);
    head.appendChild(time);
    var title = document.createElement('div');
    title.className = 'notify-toast-title';
    title.textContent = n.title || '';
    var body = document.createElement('div');
    body.className = 'notify-toast-body';
    body.textContent = n.body || '';
    var actions = document.createElement('div');
    actions.className = 'notify-toast-actions';
    var go = document.createElement('a');
    go.className = 'btn btn-sm notify-toast-go';
    go.href = n.link || '/whatsapp/session';
    go.textContent = '去跟进';
    // 点“去跟进”也标已读（L2），否则下个页面又弹出来
    go.addEventListener('click', function () { markRead(n.id); });
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-sm btn-outline-light notify-toast-ok';
    ok.textContent = '知道了';
    ok.addEventListener('click', function () {
      markRead(n.id);
      if (card.parentNode) card.parentNode.removeChild(card);
    });
    actions.appendChild(go);
    actions.appendChild(ok);
    card.appendChild(head);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(actions);
    return card;
  }
  function poll() {
    fetch('/api/notifications?unread=1', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok || !Array.isArray(d.notifications)) return;
        var fresh = false;
        d.notifications.forEach(function (n) {
          if (!n || shown[n.id]) return;
          shown[n.id] = true;
          fresh = true;
          stack.appendChild(buildCard(n));
        });
        if (fresh) beep();
      })
      .catch(function () {});
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio);
  poll();
  setInterval(poll, 25000);
})();
</script>
${scriptHtml}
</body>
</html>`;
}

// 登录页（Stitch 风格）
function loginPage(opts) {
  const { flash, next } = opts;
  const flashHtml = (flash || []).map(alertHtml).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 - HQ CRM</title>
<link rel="stylesheet" href="/static/vendor/bootstrap/css/bootstrap.min.css">
<link rel="stylesheet" href="/static/vendor/bootstrap-icons/bootstrap-icons.min.css">
<link rel="stylesheet" href="/static/css/style.css">
</head>
<body class="login-body">
<div class="login-wrap">
  <div class="login-card">
    <div class="p-4 p-md-5">
      <div class="text-center mb-4">
        <div class="login-logo"><img src="/static/img/logo-mark.svg" alt="HQ CRM"></div>
        <div class="login-title mt-3">外贸AI客服工作台 2.0</div>
        <div class="login-sub">WhatsApp · AI客服 · CRM · 报价 · 订单 · 知识库 · 局域网共享版 V${esc(APP_VERSION)}</div>
      </div>
      ${flashHtml}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${esc(next || '/dashboard')}">
        <div class="mb-3">
          <label class="form-label">用户名</label>
          <div class="input-group"><span class="input-group-text"><i class="bi bi-person"></i></span>
            <input type="text" class="form-control" name="username" autocomplete="username" required autofocus>
          </div>
        </div>
        <div class="mb-4">
          <label class="form-label">密码</label>
          <div class="input-group"><span class="input-group-text"><i class="bi bi-lock"></i></span>
            <input type="password" class="form-control" name="password" autocomplete="current-password" required>
          </div>
        </div>
        <button class="btn btn-primary w-100 py-2"><i class="bi bi-box-arrow-in-right me-1"></i>登 录</button>
      </form>
      <div class="text-center text-muted small mt-3">请使用已创建的业务账号登录，首次登录后请及时修改密码</div>
    </div>
  </div>
</div>
<script src="/static/vendor/bootstrap/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
}

module.exports = { page, loginPage, NAV, APP_VERSION };
















