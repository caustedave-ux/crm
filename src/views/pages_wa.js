'use strict';
// ============ 页面渲染：WhatsApp 实时会话 ============
const { esc, guessCountry, todayStr, addDays } = require('../util');
const { page } = require('./layout');
const { card, pageHead, badge } = require('./ui');
const { all, get, getSetting, run, DOC_TYPE_MAP } = require('../db');
const wa = require('../wa');
const autoReplyControl = require('../autoReplyControl');
const knowledgeBase = require('../knowledgeBase');

const WA_CATEGORY = Object.freeze({
  new: { key: 'new', label: '新询盘', className: 'wa-category-new' },
  following: { key: 'following', label: '跟进中', className: 'wa-category-following' },
  won: { key: 'won', label: '已成交', className: 'wa-category-won' },
  lost: { key: 'lost', label: '已流失', className: 'wa-category-lost' },
  none: { key: 'none', label: '未分类', className: 'wa-category-none' },
});
const WA_CATEGORY_ORDER = ['new', 'following', 'won', 'lost', 'none'];
const WA_CATEGORY_FILTERS = new Set(WA_CATEGORY_ORDER);

function compareInboxChats(a, b) {
  const unreadRank = row => Number(row && row.unread) > 0 ? 1 : 0;
  return (unreadRank(b) - unreadRank(a)) ||
    String((b && b.last_msg_at) || '').localeCompare(String((a && a.last_msg_at) || '')) ||
    ((Number(b && b.id) || 0) - (Number(a && a.id) || 0));
}

function dayOf(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
  return s.slice(0, 10);
}

/**
 * WhatsApp 客户分类：
 * - 新询盘为手动标记，手动标记会保留到用户主动清除；这样不会被自动同步的聊天跟进冲掉。
 * - 已流失优先识别客户状态/跟进结果，其次按最后一次成交距今满 180 天判断。
 * - 从未成交的客户即使创建很久，也不会仅因时间久被判为流失。
 */
function classifyWaChat(row, today) {
  if (!row) return 'none';
  if (String(row.manual_category || '').trim() === WA_CATEGORY.new.label) return 'new';

  const customerStatus = String(row.customer_status || '').trim();
  const wonActivityCount = Number(row.won_activity_count || 0);
  const wonDocumentCount = Number(row.won_doc_count || 0);
  const lastWon = [dayOf(row.last_deal_date), dayOf(row.last_won_activity_date)]
    .filter(Boolean)
    .sort()
    .pop() || '';
  const lastLost = dayOf(row.last_lost_activity_date);
  const hasLostFollowup = Number(row.lost_activity_count || 0) > 0;
  const lostFollowupIsLatest = hasLostFollowup && (!lastWon || !lastLost || lastLost > lastWon);
  if (customerStatus.includes('流失') || lostFollowupIsLatest) return 'lost';

  if (wonActivityCount > 0 || wonDocumentCount > 0) {
    const cutoff = addDays(String(today || todayStr()).slice(0, 10), -180);
    if (lastWon && lastWon < cutoff) return 'lost';
    return 'won';
  }

  if (Number(row.activity_count || 0) > 0 || Number(row.doc_count || 0) > 0) return 'following';
  return 'none';
}

function categoryOf(row, today) {
  return WA_CATEGORY[classifyWaChat(row, today)] || WA_CATEGORY.none;
}

function chatInsightsSql(whereSql, limit) {
  const safeLimit = Math.max(1, Math.min(5000, parseInt(limit, 10) || 300));
  return `SELECT c.*, cu.company_name AS customer_name, cu.image AS customer_image,
      cu.status AS customer_status,
      COALESCE(a.activity_count,0) AS activity_count,
      COALESCE(a.won_activity_count,0) AS won_activity_count,
      COALESCE(a.lost_activity_count,0) AS lost_activity_count,
      a.last_activity_date, a.last_won_activity_date, a.last_lost_activity_date,
      COALESCE(d.doc_count,0) AS doc_count,
      COALESCE(d.won_doc_count,0) AS won_doc_count,
      d.last_deal_date
    FROM wa_chats c
    LEFT JOIN customers cu ON cu.id=c.customer_id
    LEFT JOIN (
      SELECT customer_id,
        COUNT(*) AS activity_count,
        MAX(activity_date) AS last_activity_date,
        SUM(CASE WHEN outcome='已成交' THEN 1 ELSE 0 END) AS won_activity_count,
        SUM(CASE WHEN outcome LIKE '%流失%' THEN 1 ELSE 0 END) AS lost_activity_count,
        MAX(CASE WHEN outcome='已成交'
          THEN COALESCE(NULLIF(activity_date,''), SUBSTR(created_at,1,10)) END) AS last_won_activity_date,
        MAX(CASE WHEN outcome LIKE '%流失%'
          THEN COALESCE(NULLIF(activity_date,''), SUBSTR(created_at,1,10)) END) AS last_lost_activity_date
      FROM activities WHERE user_id=? GROUP BY customer_id
    ) a ON a.customer_id=c.customer_id
    LEFT JOIN (
      SELECT customer_id,
        COUNT(*) AS doc_count,
        SUM(CASE WHEN status IN ('已确认','已完成') THEN 1 ELSE 0 END) AS won_doc_count,
        MAX(CASE WHEN status IN ('已确认','已完成')
          THEN COALESCE(NULLIF(issue_date,''), SUBSTR(created_at,1,10)) END) AS last_deal_date
      FROM documents
      WHERE user_id=? AND doc_type IN ('pi','so','ci') AND status NOT IN ('已取消','作废')
      GROUP BY customer_id
    ) d ON d.customer_id=c.customer_id
    WHERE ${whereSql}
    ORDER BY (CASE WHEN COALESCE(c.pinned_at,'')<>'' THEN 0 ELSE 1 END),
      COALESCE(c.pinned_at,'') DESC,
      (CASE WHEN COALESCE(c.unread,0)>0 THEN 0 ELSE 1 END),
      COALESCE(c.last_msg_at,'') DESC, c.id DESC LIMIT ${safeLimit}`;
}

function loadChatInsights(userId, whereSql, whereArgs, limit) {
  return all(chatInsightsSql(whereSql, limit), userId, userId, ...(whereArgs || []));
}

/* ---------------- 会话页 ---------------- */

// back: 表单提交后跳回的页面（'/whatsapp/session' 或 '/settings'），由调用方指定
function accountCard(ctx, back) {
  const backUrl = back === '/settings' ? '/settings' : '/whatsapp/session';
  const backField = `<input type="hidden" name="back" value="${backUrl}">`;
  const v = wa.accountView(ctx.user.id);
  const acc = v.account;
  const lastInbound = acc ? get('SELECT MAX(last_inbound_at) AS at FROM wa_chats WHERE account_id=?', acc.id) : null;
  const statusMap = { offline: ['secondary', '未连接'], qr: ['warning', '等待扫码'], pairing: ['info', '等待输入配对码'], connecting: ['info', '连接中'], online: ['success', '已连接'], paused: ['secondary', '已暂停'], logged_out: ['danger', '已退出'], error: ['danger', '异常'] };
  const receiveBroken = v.status === 'online' && Number(v.decryptFailures || 0) > 0 && Number(v.messagesStored || 0) === 0;
  const mapped = statusMap[v.status] || ['secondary', v.status];
  const cls = receiveBroken ? 'danger' : mapped[0];
  const text = receiveBroken ? '在线但接收异常' : mapped[1];
  let body = `<div class="d-flex align-items-center gap-3 flex-wrap">
      <span class="badge text-bg-${cls}">${text}</span>
      ${acc && acc.phone ? `<span class="small">${esc(acc.phone)}</span>` : ''}
      ${v.error ? `<span class="small text-danger">${esc(v.error)}</span>` : ''}
      <span class="small text-muted">最后客户来信：${esc((lastInbound && lastInbound.at) || '本次尚未收到')}</span>
      <div class="ms-auto d-flex gap-2">
        ${v.status === 'offline' || v.status === 'error' || v.status === 'logged_out' || v.status === 'paused' ? `<form method="post" action="/whatsapp/connect">${backField}<button class="btn btn-sm btn-primary"><i class="bi bi-qr-code"></i> 扫码连接</button></form>` : ''}
        ${(v.failStreak || 0) >= 3 ? `<form method="post" action="/whatsapp/unlock">${backField}<button class="btn btn-sm btn-outline-warning" onclick="return confirm('确认账号本身可以关联设备（例如网页版能登）后再解锁，否则会继续消耗尝试次数。')">解除锁定</button></form>` : ''}
        ${v.status === 'qr' ? `<form method="post" action="/whatsapp/connect">${backField}<input type="hidden" name="force" value="1"><button class="btn btn-sm btn-outline-secondary"><i class="bi bi-arrow-clockwise"></i> 刷新二维码</button></form>` : ''}
        ${v.status === 'online' ? `<form method="post" action="/whatsapp/stop" class="d-inline">${backField}<button class="btn btn-sm btn-outline-warning">暂停</button></form><form method="post" action="/whatsapp/disconnect" class="d-inline" onsubmit="return confirm('确认退出登录？退出后需要重新扫码。聊天和 CRM 数据不会删除。')">${backField}<button class="btn btn-sm btn-outline-danger">退出登录并修复</button></form>` : ''}
      </div>
    </div>`;
  if (v.pairCode) {
    const age = v.pairCodeAt ? Math.floor((Date.now() - v.pairCodeAt) / 1000) : 0;
    const left = Math.max(0, 60 - age);
    body += `<div class="mt-3 p-3 rounded-3" style="background:#f6f9ff;border:1px solid #dbe7ff">
      <div class="text-center">
        <div class="small text-muted mb-1">在手机 WhatsApp 里输入这串配对码（有效期约 60 秒）</div>
        <div class="fw-bold" style="font-size:34px;letter-spacing:4px">${esc(v.pairCode)}</div>
        <div class="small ${left > 10 ? 'text-muted' : 'text-danger'} mt-1">${left > 0 ? '剩余约 ' + left + ' 秒' : '可能已过期，重新点一次「生成配对码」'}</div>
        <div class="small text-muted mt-2">手机：WhatsApp → 设置 → 已关联的设备 → 关联设备 → <b>改用手机号码连接</b> → 输入上面这串码</div>
        <div class="small text-muted mt-1">注意：手机号要填<b>带国家码、不要 +、不要前导 0</b>（例如 86 138 6896 5673 要填 <code>8613800138000</code>）</div>
      </div>
    </div>
    <script>setTimeout(function(){ location.reload(); }, 12000);</script>`;
  } else if (v.status === 'qr' && v.qr) {
    body += `<div class="mt-3 text-center"><img src="${v.qr}" alt="WhatsApp 二维码" style="width:260px;height:260px;image-rendering:pixelated;background:#fff;padding:8px;border-radius:12px;border:1px solid #e3e9f0">
      <div class="small text-muted mt-2">手机 WhatsApp → 设置 → 已关联的设备 → 关联设备 → 扫码<br>二维码约 20 秒轮换一次，本页 4 秒自动刷新（扫到过期码会提示"无法关联设备"）</div></div>
      <script>setTimeout(function(){ location.reload(); }, 4000);</script>`;
  } else if (v.status === 'qr' || v.status === 'connecting' || v.status === 'pairing') {
    body += `<div class="mt-3 text-center text-muted small"><div class="spinner-border spinner-border-sm me-2"></div>正在和 WhatsApp 建立连接…（超过 20 秒还停在这里，说明代理没通或服务器在限流）</div>
      <script>setTimeout(function(){ location.reload(); }, 4000);</script>`;
  }
  if (receiveBroken) {
    body += `<div class="alert alert-danger py-2 mt-3 mb-0 small"><i class="bi bi-shield-exclamation me-1"></i>
      检测到 <b>${Number(v.decryptFailures || 0)}</b> 条实时客户消息无法解密${v.lastDecryptError ? '（' + esc(v.lastDecryptError) + '）' : ''}，
      且当前连接尚未成功接收到任何客户消息。请点“退出登录并修复”，然后用手机重新扫码关联一次；CRM 客户、跟进和聊天记录不会删除。
    </div>`;
  } else if (v.status === 'online' && Number(v.decryptFailures || 0) > 0) {
    body += `<div class="alert alert-light border py-2 mt-3 mb-0 small"><i class="bi bi-check-circle me-1 text-success"></i>
      当前连接已成功接收 <b>${Number(v.messagesStored || 0)}</b> 条客户消息。期间有 <b>${Number(v.decryptFailures || 0)}</b> 条实时消息解密失败，通常为客户重发或单条密钥异常，无需重新扫码。
    </div>`;
  }
  if (v.error) {
    body += `<div class="alert alert-warning py-2 mt-3 mb-0 small"><i class="bi bi-exclamation-triangle me-1"></i>${esc(v.error)}</div>`;
  }
  // 尝试次数与限流状态（透明化：他要知道什么时候能再试）
  const lim = Number(v.attemptsHour || 0) + Number(v.attemptsDay || 0) + Number(v.lockHoursLeft || 0);
  body += `<div class="d-flex align-items-center gap-2 flex-wrap mt-2 small text-muted">
      <span>本小时已试 <b>${Number(v.attemptsHour || 0)}</b> 次 · 24 小时 <b>${Number(v.attemptsDay || 0)}</b> 次${v.lockHoursLeft ? ' · 锁定剩余 <b class="text-danger">' + v.lockHoursLeft + ' 小时</b>' : ''}</span>
      ${lim > 0 ? `<form method="post" action="/whatsapp/unlock" class="d-inline">
        ${backField}<button class="btn btn-sm btn-link p-0" onclick="return confirm('清除后即可立刻再次尝试登录。确认清除所有限流与锁定记录？')">清除限制</button>
      </form>` : ''}
    </div>`;
  if (v.status === 'offline' && acc && acc.phone) {
    body += `<div class="small text-muted mt-2">上次登录号码 ${esc(acc.phone)}；重新连接后会自动恢复会话。</div>`;
  }
  // 配对码登录：扫码一直失败时的稳妥路线
  body += `<form method="post" action="/whatsapp/pair" class="row g-2 align-items-center mt-3 pt-3 border-top">
    ${backField}
    <div class="col-12 col-md-3"><span class="small text-muted">改用配对码登录</span></div>
    <div class="col-12 col-md-5"><input class="form-control form-control-sm" name="phone" placeholder="手机号含国家码，如 8613800138000"></div>
    <div class="col-auto"><button class="btn btn-sm btn-outline-primary">生成配对码</button></div>
    <div class="col-12"><div class="form-text mb-0">扫码老提示"网络连接不上"时用这个：手机端可以不扫码，直接输 8 位码。</div></div>
  </form>`;
  const savedProxy = getSetting('wa_proxy') || '';
  const effectiveProxy = wa.proxyUrl();
  body += `<form method="post" action="/whatsapp/proxy" class="row g-2 align-items-center mt-3 pt-3 border-top">
    ${backField}
    <div class="col-12 col-md-3"><span class="small text-muted">出网代理</span></div>
    <div class="col-12 col-md-5"><input class="form-control form-control-sm" name="proxy" value="${esc(savedProxy)}" placeholder="留空 = 自动用系统代理"></div>
    <div class="col-auto"><button class="btn btn-sm btn-outline-secondary">保存</button></div>
    <div class="col-auto"><button class="btn btn-sm btn-outline-primary" formaction="/whatsapp/proxy-test">测试连通</button></div>
    <div class="col-12"><div class="form-text mb-0">当前使用：<b>${esc(effectiveProxy || '直连')}</b>　WhatsApp 服务器国内一般连不上，建议保留 Clash / V2Ray 的系统代理。</div></div>
  </form>`;
  return card({ title: '我的 WhatsApp', body });
}

// 自动回复总开关（可在 WhatsApp 页或系统设置页渲染）
function autoReplyBar(ctx, back) {
  const backUrl = back === '/settings' ? '/settings' : '/whatsapp/session';
  const autoReply = autoReplyControl.status();
  const autoReplyOn = !!(autoReply.enabled && autoReply.running);
  const autoReplyLabel = autoReplyOn ? '自动回复：开' : (autoReply.enabled ? '配置已开 · Worker 未运行' : '自动回复：关');
  const autoReplyBadge = autoReplyOn ? 'success' : (autoReply.enabled ? 'warning' : 'secondary');
  const autoReplyButton = autoReplyOn ? '关闭自动回复' : (autoReply.enabled ? '重新启动 Worker' : '开启自动回复');
  const autoReplyNext = autoReplyOn ? '0' : '1';
  const autoReplyStockNote = autoReply.stockPreferPdf && autoReply.stockPdfs > 0
    ? `现货 PDF ${autoReply.stockPdfs} 个，默认全部发送`
    : `现货图 ${autoReply.stockImages} 张，默认 ${autoReply.stockSendAll ? '全部发送' : '限量发送'}`;
  let autoReplyActionHtml = '<span class="small text-muted">仅管理员可操作</span>';
  if (ctx.user.role === 'admin') {
    const confirmAttr = autoReplyNext === '1' ? ' onsubmit="return confirm(\'开启后系统会按资格判定自动给客户发消息和素材。确认开启？\')"' : '';
    autoReplyActionHtml = `<form method="post" action="/whatsapp/auto-reply/toggle" class="wa-auto-reply-action"${confirmAttr}>
      <input type="hidden" name="back" value="${backUrl}">
      <input type="hidden" name="enabled" value="${autoReplyNext}">
      <button class="btn btn-sm ${autoReplyOn ? 'btn-outline-danger' : 'btn-success'}"><i class="bi bi-power me-1"></i>${autoReplyButton}</button>
    </form>`;
  }
  return `<div class="wa-auto-reply-bar">
    <div class="wa-auto-reply-main">
      <div class="wa-auto-reply-title"><i class="bi bi-robot"></i><b>自动回复总开关</b><span class="badge text-bg-${autoReplyBadge}">${autoReplyLabel}</span></div>
      <div class="wa-auto-reply-note">已置顶客户永不自动回复；发送前还会再次检查置顶和人工回复。${autoReplyStockNote}。</div>
    </div>
    ${autoReplyActionHtml}
  </div>`;
}

// 系统设置页用的 WhatsApp 卡片：连接与代理、自动回复总开关、声音提醒。
// 连接卡直接复用 accountCard（自带“我的 WhatsApp”标题）；自动回复条自带标题行，外面只套一层卡壳。
// 声音提醒开关原来在 WhatsApp 页右上角，现搬到这里：Bootstrap 开关，拨一下就写 localStorage 的 crm_wa_sound（'0' 为关，默认开），不用提交；WhatsApp 页只读同一个 key。
function waSettingsCards(ctx) {
  return [
    accountCard(ctx, '/settings'),
    card({ body: autoReplyBar(ctx, '/settings') }),
    card({ title: '声音提醒', body: `<div class="d-flex align-items-center gap-3 flex-wrap">
      <div class="form-check form-switch">
        <input class="form-check-input" type="checkbox" role="switch" id="waSoundSetting">
        <label class="form-check-label fw-semibold" for="waSoundSetting">新消息声音提醒</label>
      </div>
      <span class="text-muted small">来新客户消息时播放提示音；只保存在这台浏览器里，换电脑或清除浏览器数据后要重新开。</span>
    </div>
    <script>
      (function () {
        var sw = document.getElementById('waSoundSetting');
        if (!sw) return;
        try { sw.checked = localStorage.getItem('crm_wa_sound') !== '0'; } catch (e) { sw.checked = true; }
        sw.addEventListener('change', function () {
          try { localStorage.setItem('crm_wa_sound', sw.checked ? '1' : '0'); } catch (e) {}
        });
      })();
    </script>` }),
  ];
}

function chatLabel(c) {
  if (c.name) return c.name;
  if (c.phone) return '+' + c.phone;
  if (String(c.jid || '').endsWith('@lid')) return '未命名联系人';
  return c.jid || '未知会话';
}

function timeLabel(ts) {
  const s = String(ts || '');
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s.slice(5, 16);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay) return s.slice(11, 16);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return s.slice(5, 10);
}

function initialsOf(name, phone) {
  const s = String(name || phone || 'WA').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function linkifyMessage(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function messageMediaUrl(m) {
  return '/api/wa/media/' + Number(m.id);
}

function chatAvatarHtml(chat, eager) {
  const initials = esc(initialsOf(chatLabel(chat), chat.phone));
  const fallback = esc(chat.customer_image || '');
  const loading = eager ? '' : ' loading="lazy"';
  return `<span class="wa-avatar-initials">${initials}</span><img src="/api/wa/avatar/${Number(chat.id)}" alt="${esc(chatLabel(chat))}"${loading} data-fallback="${fallback}" onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.removeAttribute('data-fallback');}else{this.remove();}">`;
}

function chatListHtml(chats, activeId, hrefFor, backUrl) {
  if (!chats.length) return `<div class="text-muted small py-3">
    没有符合条件的会话。<br>
    <span style="font-size:13px">清空搜索或切换筛选试试，或等待客户发来新消息。</span>
  </div>`;
  const back = String(backUrl || '/whatsapp/session');
  const isPinned = c => String(c.pinned_at || '').trim() !== '';
  const renderChat = c => {
    const pinned = isPinned(c);
    const unreadCount = Number(c.unread) || 0;
    const unreadBounce = unreadCount > 0;
    const remark = String(c.remark || '').replace(/\s+/g, ' ').trim();
    const remarkPreview = remark.length > 24 ? remark.slice(0, 24) + '…' : remark;
    const href = hrefFor ? hrefFor(c.id) : '/whatsapp/session?chat=' + c.id;
    return `<div class="wa-chat-swipe" data-chat-id="${Number(c.id)}">
  <form class="wa-swipe-delete" method="post" action="/whatsapp/chat/${Number(c.id)}/delete" data-chat-name="${esc(chatLabel(c))}">
    <input type="hidden" name="back" value="${esc(back)}">
    <button type="submit" class="wa-swipe-delete-btn" aria-label="删除与 ${esc(chatLabel(c))} 的会话"><i class="bi bi-trash3"></i><span>删除</span></button>
  </form>
  <div class="wa-chat-item${pinned ? ' is-pinned' : ''}${unreadBounce ? ' has-unread' : ''}" data-chat-id="${Number(c.id)}" data-pinned="${pinned ? '1' : '0'}">
  <a class="list-item wa-chat-row ${String(activeId) === String(c.id) ? 'active' : ''}${unreadBounce ? ' unread-bounce' : ''}" href="${esc(href)}" draggable="false" style="text-decoration:none">
    <span class="wa-avatar ${unreadBounce ? 'wa-avatar-unread' : ''}">${chatAvatarHtml(c, false)}</span>
    <div class="flex-grow-1 min-w-0">
      <div class="d-flex align-items-center gap-1">
        <div class="fw-semibold text-truncate flex-grow-1">${esc(chatLabel(c))}</div>
        <span class="wa-chat-time">${esc(timeLabel(c.last_msg_at))}</span>
      </div>
      <div class="d-flex align-items-center gap-2 mt-1">
        <div class="text-muted small text-truncate flex-grow-1">${esc(c.last_msg_text || '暂无消息')}</div>
        ${unreadBounce ? `<span class="wa-unread wa-unread-pulse">${unreadCount > 99 ? '99+' : unreadCount}</span>` : ''}
      </div>
      <div class="d-flex gap-1 mt-1 flex-wrap">${pinned ? '<span class="wa-pin-badge"><i class="bi bi-pin-angle-fill"></i>置顶</span>' : ''}${remark ? `<span class="wa-note-tag" title="会话备注：${esc(remark)}"><i class="bi bi-journal-text"></i>${esc(remarkPreview)}</span>` : ''}${c.is_group ? '<span class="wa-mini-tag">群聊</span>' : ''}${c.customer_name ? `<span class="wa-mini-tag wa-mini-tag-green">${esc(c.customer_name)}</span>` : '<span class="wa-mini-tag wa-mini-tag-muted">待绑定</span>'}</div>
    </div>
  </a>
  <form class="wa-pin-form" method="post" action="/whatsapp/chat/${Number(c.id)}/pin">
    <input type="hidden" name="pin" value="${pinned ? '0' : '1'}">
    <input type="hidden" name="back" value="${esc(back)}">
    <button type="submit" class="wa-pin-btn" title="${pinned ? '取消置顶' : '置顶，稍后处理'}" aria-label="${pinned ? '取消置顶' : '置顶，稍后处理'}" aria-pressed="${pinned ? 'true' : 'false'}"><i class="bi bi-pin-angle${pinned ? '-fill' : ''}"></i></button>
  </form>
  </div>
</div>`;
  };
  const pinnedChats = chats.filter(isPinned)
    .slice()
    .sort((a, b) => String(b.pinned_at || '').localeCompare(String(a.pinned_at || '')));
  const regularChats = chats.filter(c => !isPinned(c)).slice().sort(compareInboxChats);
  const pinnedHtml = pinnedChats.length
    ? `<div class="wa-pin-group-label"><i class="bi bi-pin-angle-fill"></i><span>置顶会话</span><b>${pinnedChats.length}</b></div>${pinnedChats.map(renderChat).join('')}`
    : '';
  return pinnedHtml + regularChats.map(renderChat).join('');
}

function parseQuotedPreview(value) {
  try {
    const p = JSON.parse(String(value || ''));
    return p && typeof p === 'object' ? p : null;
  } catch (e) { return null; }
}

const QUOTE_KIND_LABEL = { image: '[图片]', video: '[视频]', audio: '[语音]', document: '[文件]', sticker: '[贴纸]', location: '[位置]', contact: '[名片]' };
const QUOTE_KIND_ICON = { image: 'bi-image', video: 'bi-camera-video', audio: 'bi-mic', document: 'bi-file-earmark-text', sticker: 'bi-sticky' };

function quotedInfo(m, byWaId) {
  const local = m.quoted_msg_id && byWaId ? byWaId.get(String(m.quoted_msg_id)) : null;
  if (local) {
    return {
      kind: local.kind || 'text',
      text: local.text || QUOTE_KIND_LABEL[local.kind] || '',
      mediaName: local.media_name || '',
      mediaPath: local.kind === 'audio' ? messageMediaUrl(local) : (local.media_path || ''),
      sender: Number(local.from_me) === 1 ? '你' : (local.sender_name || '客户'),
      targetId: Number(local.id) || 0,
      targetWaId: String(m.quoted_msg_id || ''),
    };
  }
  const p = parseQuotedPreview(m.quoted_preview);
  if (!p) return null;
  return {
    kind: p.kind || 'text',
    text: p.text || QUOTE_KIND_LABEL[p.kind] || '',
    mediaName: p.mediaName || '',
    mediaPath: '',
    sender: '引用的消息',
    targetId: 0,
    targetWaId: String(m.quoted_msg_id || ''),
  };
}

function quotedCardHtml(m, byWaId) {
  const q = quotedInfo(m, byWaId);
  if (!q) return '';
  const body = q.mediaName || q.text || QUOTE_KIND_LABEL[q.kind] || '[消息]';
  const thumb = q.mediaPath && (q.kind === 'image' || q.kind === 'sticker')
    ? `<img src="${esc(q.mediaPath)}" alt="被引用的图片" class="wa-quote-thumb" loading="lazy">` : `<i class="bi ${QUOTE_KIND_ICON[q.kind] || 'bi-chat-left-text'}"></i>`;
  const card = `<div class="wa-quote-card"><div class="wa-quote-card-title">${esc(q.sender)}</div><div class="d-flex align-items-start gap-2">${thumb}<div class="wa-quote-card-text">${esc(body)}</div></div></div>`;
  if (!q.targetId && !q.targetWaId) return card;
  const targetAttrs = q.targetId
    ? `data-quote-target-id="${Number(q.targetId)}"`
    : `data-quote-target-wa-id="${esc(q.targetWaId)}"`;
  const jump = `<button type="button" class="wa-quote-jump" ${targetAttrs} title="跳到被引用的原消息" aria-label="跳到被引用的原消息">${card}</button>`;
  const openable = q.mediaPath && ['image', 'sticker', 'video', 'audio', 'document'].includes(q.kind);
  if (!openable) return `<div class="wa-quote-wrap">${jump}</div>`;
  const label = q.kind === 'image' || q.kind === 'sticker' ? '打开原图' : '打开附件';
  return `<div class="wa-quote-wrap">${jump}<a class="wa-quote-media-open" href="${esc(q.mediaPath)}" target="_blank" rel="noopener" title="${label}" aria-label="${label}"><i class="bi bi-box-arrow-up-right"></i>${label}</a></div>`;
}

/** 我方发出的消息显示客户回执；收到的消息不显示。 */
function messageReceiptHtml(m) {
  if (Number(m.from_me) !== 1) return '';
  const status = Number(m.receipt_status) || 0;
  const readAt = String(m.read_at || '').trim();
  const deliveredAt = String(m.delivered_at || '').trim();
  if (status >= 4) {
    const time = readAt ? readAt.slice(5, 16) : '';
    const readHint = readAt ? `客户已于 ${esc(readAt)} 读取` : '客户已读取（WhatsApp 未提供读取时间）';
    return `<span class="wa-msg-receipt is-read" data-receipt-status="${status}" title="${readHint}"><i class="bi bi-check2-all"></i>${time ? '客户已读 ' + esc(time) : '客户已读'}</span>`;
  }
  const delivered = status >= 3;
  const deliveredHint = delivered && deliveredAt ? `已于 ${esc(deliveredAt)} 送达，客户尚未读取` : (delivered ? '已送达，客户尚未读取' : '已发送，等待客户读取');
  return `<span class="wa-msg-receipt is-unread" data-receipt-status="${status}" title="${deliveredHint}"><i class="bi ${delivered ? 'bi-check2-all' : 'bi-check2'}"></i>${delivered ? '已送达 · 未读' : '未读'}</span>`;
}

function msgHtml(m, chat, byWaId) {
  const mine = Number(m.from_me) === 1;
  const audioTs = m.ts ? new Date(String(m.ts).replace(' ', 'T')).getTime() : 0;
  const audioDownloadStale = m.kind === 'audio' && !m.media_path && audioTs > 0 && (Date.now() - audioTs > 10 * 60 * 1000);
  let media = '';
  if (m.media_path && (m.kind === 'image' || m.kind === 'sticker')) {
    media = `<a href="${esc(m.media_path)}" target="_blank" rel="noopener" class="d-block mb-2"><img class="wa-media-img" src="${esc(m.media_path)}" alt="客户图片" loading="lazy"></a>`;
  } else if (m.media_path && m.kind === 'video') {
    media = `<video class="wa-media-video mb-2" controls preload="metadata" src="${esc(m.media_path)}"></video>`;
  } else if (m.media_path && m.kind === 'audio') {
    const audioUrl = messageMediaUrl(m);
    media = `<div class="wa-voice-card">
      <div class="wa-voice-head"><span><i class="bi bi-mic-fill me-1"></i>语音消息</span><span>可播放 / 下载</span></div>
      <audio class="wa-voice-audio" controls preload="metadata" src="${esc(audioUrl)}">您的浏览器不支持语音播放。</audio>
      <div class="wa-voice-foot"><a href="${esc(audioUrl)}" target="_blank" rel="noopener"><i class="bi bi-download me-1"></i>下载语音</a></div>
    </div>`;
  } else if (m.media_path && m.kind === 'document') {
    media = `<a class="wa-file-card mb-2" href="${esc(m.media_path)}" target="_blank" rel="noopener"><i class="bi bi-file-earmark-arrow-down"></i><span>${esc(m.media_name || m.text || '下载文件')}</span></a>`;
  } else if (!m.media_path && (m.kind === 'image' || m.kind === 'sticker')) {
    media = '<div class="wa-media-missing mb-2" role="status"><i class="bi bi-arrow-repeat"></i><span>图片正在保存，完成后会自动显示</span></div>';
  } else if (!m.media_path && m.kind === 'audio') {
    media = audioDownloadStale
      ? '<div class="wa-voice-card wa-voice-missing mb-2" role="status"><div class="wa-voice-head"><span><i class="bi bi-mic-mute-fill me-1"></i>语音消息</span><span>文件未保存</span></div><div class="wa-voice-wait wa-voice-stale"><i class="bi bi-exclamation-circle me-1"></i>这条旧语音当时未下载成功，请让客户重新发送</div></div>'
      : '<div class="wa-voice-card wa-voice-missing mb-2" role="status"><div class="wa-voice-head"><span><i class="bi bi-mic-mute-fill me-1"></i>语音消息</span><span>等待保存</span></div><div class="wa-voice-wait"><i class="bi bi-arrow-repeat me-1"></i>语音正在下载，完成后会自动显示播放器</div></div>';
  } else if (!m.media_path && (m.kind === 'video' || m.kind === 'document')) {
    media = '<div class="wa-media-missing mb-2" role="status"><i class="bi bi-arrow-repeat"></i><span>附件正在保存，完成后会自动显示</span></div>';
  }
  const text = m.kind === 'document' && m.media_path ? '' : linkifyMessage(m.text);
  const quoteText = m.media_name || m.text || QUOTE_KIND_LABEL[m.kind] || '[消息]';
  const quoteSender = mine ? '你' : (m.sender_name || '客户');
  return `<div id="wa-msg-${Number(m.id)}" data-wa-msg-id="${esc(m.msg_id)}" tabindex="-1" class="wa-message-row d-flex ${mine ? 'justify-content-end' : 'justify-content-start'} mb-2">
    <div class="wa-message ${mine ? 'wa-message-mine' : 'wa-message-theirs'}">
      ${chat && chat.is_group && !mine && m.sender_name ? `<div class="wa-message-sender">${esc(m.sender_name)}</div>` : ''}
      ${quotedCardHtml(m, byWaId)}
      ${media}
      ${text ? `<div class="wa-message-text">${text}</div>` : ''}
      ${m.translated ? `<div class="small mt-1 ${mine ? 'text-white-50' : 'text-muted'}"><i class="bi bi-translate me-1"></i>${esc(m.translated)}</div>` : ''}
      <div class="small ${mine ? 'text-white-50' : 'text-muted'} mt-1 d-flex gap-2 align-items-center flex-wrap">
        <span>${esc(String(m.ts || '').slice(5, 16))}</span>
        ${messageReceiptHtml(m)}
        <button type="button" class="btn btn-link btn-sm p-0 wa-quote-btn" data-quote-id="${Number(m.id)}" data-quote-kind="${esc(m.kind || 'text')}" data-quote-sender="${esc(quoteSender)}" data-quote-text="${esc(quoteText)}">引用</button>
        ${!mine && !m.translated && m.kind === 'text' && m.text ? `<form method="post" action="/whatsapp/translate/${m.id}" class="d-inline wa-translate-form" data-chat-id="${Number(chat.id)}">
          <input type="hidden" name="chat_id" value="${Number(chat.id)}">
          <button class="btn btn-link btn-sm p-0">翻译</button></form>` : ''}
      </div>
    </div>
  </div>`;
}

function sessionPage(ctx) {
  const q = String(ctx.query.q || '').trim();
  const requestedFilter = String(ctx.query.filter || '');
  const filter = ['all', 'unread', 'unbound', 'bound', 'pinned'].includes(requestedFilter) ? requestedFilter : 'all';
  const baseWhere = `(${wa.visibleChatsSql()})`;
  const stats = get(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN COALESCE(c.unread,0)>0 THEN c.unread ELSE 0 END),0) unread_msgs,
      COALESCE(SUM(CASE WHEN c.customer_id IS NULL THEN 1 ELSE 0 END),0) unbound,
      COALESCE(SUM(CASE WHEN COALESCE(c.pinned_at,'')<>'' THEN 1 ELSE 0 END),0) pinned
    FROM wa_chats c WHERE ${baseWhere}`, ctx.user.id, ctx.user.id);
  const todayMessages = get(`SELECT COUNT(*) AS count FROM wa_messages m
    JOIN wa_chats c ON c.account_id=m.account_id AND c.jid=m.chat_jid
    WHERE ${wa.visibleChatsSql()} AND m.from_me=0 AND substr(m.ts,1,10)=?`, ctx.user.id, ctx.user.id, todayStr()).count;
  const activeConversations = get(`SELECT COUNT(*) AS count FROM wa_chats c
    WHERE ${wa.visibleChatsSql()} AND COALESCE(c.last_inbound_at,'')>=?`, ctx.user.id, ctx.user.id, todayStr() + ' 00:00').count;
  const dueFollowups = get("SELECT COUNT(*) AS count FROM activities WHERE user_id=? AND archived=0 AND COALESCE(next_follow_date,'')<>'' AND next_follow_date<=?", ctx.user.id, todayStr()).count;
  const weekQuotes = get("SELECT COUNT(*) AS count FROM quote_history WHERE user_id=? AND quote_date>=?", ctx.user.id, addDays(todayStr(), -6)).count;
  const clauses = [baseWhere];
  const args = [ctx.user.id, ctx.user.id];
  if (q) {
    clauses.push(`(COALESCE(c.name,'') LIKE ? OR COALESCE(c.phone,'') LIKE ? OR
      COALESCE(c.last_msg_text,'') LIKE ? OR COALESCE(cu.company_name,'') LIKE ? OR COALESCE(c.remark,'') LIKE ?)`);
    const like = '%' + q + '%';
    args.push(like, like, like, like, like);
  }
  const allChats = loadChatInsights(ctx.user.id, clauses.join(' AND '), args, 5000);
  let chats = allChats;
  const isPinned = row => String(row.pinned_at || '').trim() !== '';
  if (filter === 'all') {
    chats = chats.filter(row => !isPinned(row));
  } else if (filter === 'pinned') {
    chats = chats.filter(isPinned);
  } else {
    if (filter === 'unread') chats = chats.filter(row => Number(row.unread) > 0 && !isPinned(row));
    else if (filter === 'unbound') chats = chats.filter(row => !row.customer_id);
    else if (filter === 'bound') chats = chats.filter(row => !!row.customer_id);
    // “全部”只显示普通会话；其他业务筛选仍保留置顶会话，避免漏掉待办。
    if (!q && filter !== 'all' && filter !== 'unread') {
      const pinnedRows = allChats.filter(isPinned);
      if (pinnedRows.length) {
        const rest = chats.filter(row => !isPinned(row));
        chats = pinnedRows.concat(rest);
      }
    }
  }
  // 先完成筛选，再限制渲染数量；避免置顶/已读会话占满 300 条后挤掉未读会话。
  chats = chats.slice(0, 300);
  const activeId = ctx.query.chat || '';
  let active = activeId
    ? (loadChatInsights(ctx.user.id, `c.id=? AND ${wa.visibleChatsSql()}`, [activeId, ctx.user.id, ctx.user.id], 1)[0] || null)
    : null;
  const customers = all('SELECT id, company_name, whatsapp, phone, country, status, email, contact_person, image FROM customers WHERE user_id=? ORDER BY company_name', ctx.user.id);
  const v = wa.accountView(ctx.user.id);
  const autoReply = autoReplyControl.status();
  if (active) {
    if (!active.customer_id && active.phone && !active.is_group) {
      try { wa.autoBindChat(active); } catch (e) {}
      active = loadChatInsights(ctx.user.id, `c.id=? AND ${wa.visibleChatsSql()}`, [active.id, ctx.user.id, ctx.user.id], 1)[0] || null;
    }
    if (active) {
      const unreadBefore = Number(active.unread) || 0;
      wa.markChatRead(active.id);
      active.unread = 0;
      if (unreadBefore > 0) {
        stats.unread_msgs = Math.max(0, Number(stats.unread_msgs || 0) - unreadBefore);
        const listRow = chats.find(row => Number(row.id) === Number(active.id));
        if (listRow) listRow.unread = 0;
      }
    }
  }
  const activeCustomer = active && active.customer_id ? customers.find(c => Number(c.id) === Number(active.customer_id)) : null;
  const pinnedActive = !!active && String(active.pinned_at || '').trim() !== '';
  const backParams = [];
  if (active) backParams.push('chat=' + active.id);
  if (filter !== 'all') backParams.push('filter=' + encodeURIComponent(filter));
  if (q) backParams.push('q=' + encodeURIComponent(q));
  const backUrl = '/whatsapp/session' + (backParams.length ? '?' + backParams.join('&') : '');
  const quickReplies = all('SELECT * FROM wa_quick_replies WHERE user_id=? ORDER BY usage_count DESC, id DESC LIMIT 30', ctx.user.id);
  const inboxLast = get(`SELECT MAX(m.id) AS id
    FROM wa_messages m
    JOIN wa_chats c ON c.account_id=m.account_id AND c.jid=m.chat_jid
    WHERE ${wa.visibleChatsSql()}`, ctx.user.id, ctx.user.id);
  const inboxLastId = inboxLast && inboxLast.id ? Number(inboxLast.id) : 0;

  let activeAdConfig = null;
  let convHtml = '<div class="text-muted small py-5 text-center">左侧选一个会话开始查看</div>';
  let lastId = 0;
  let mediaSaved = 0;
  let receiptState = 0;
  let activeMessages = [];
  if (active) {
    const msgs = all(`SELECT * FROM (
        SELECT * FROM wa_messages WHERE account_id=? AND chat_jid=? ORDER BY ts DESC, id DESC LIMIT 500
      ) ORDER BY ts ASC, id ASC`, active.account_id, active.jid);
    activeMessages = msgs;
    const msgIds = new Set(msgs.map(m => Number(m.id)));
    // 引用目标可能早于当前 500 条消息；补入一条目标消息，点击引用时才能滚动到原消息。
    const quotedIds = [...new Set(msgs.map(m => String(m.quoted_msg_id || '')).filter(Boolean))];
    if (quotedIds.length) {
      const marks = quotedIds.map(() => '?').join(',');
      const quotedRows = all(`SELECT * FROM wa_messages WHERE account_id=? AND chat_jid=? AND msg_id IN (${marks})`,
        active.account_id, active.jid, ...quotedIds);
      for (const row of quotedRows) {
        if (!msgIds.has(Number(row.id))) {
          msgs.push(row);
          msgIds.add(Number(row.id));
        }
      }
      msgs.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || Number(a.id) - Number(b.id));
    }
    const msgByWaId = new Map(msgs.map(m => [String(m.msg_id), m]));
    lastId = msgs.length ? msgs[msgs.length - 1].id : 0;
    mediaSaved = msgs.filter(m => !!m.media_path && ['image', 'video', 'audio', 'document', 'sticker'].includes(m.kind)).length;
    const receiptStateRow = get(`SELECT COALESCE(SUM(CASE WHEN from_me=1 THEN COALESCE(receipt_status,0) ELSE 0 END),0) AS n
      FROM wa_messages WHERE account_id=? AND chat_jid=?`, active.account_id, active.jid);
    receiptState = Number(receiptStateRow && receiptStateRow.n) || 0;
    const currentSearch = activeCustomer ? `#${activeCustomer.id} · ${activeCustomer.company_name}` : '';
    const activeRemark = String(active.remark || '').trim();
    if (active.ad_source_id || active.ad_ctwa_clid || active.ad_ref) {
      const mapping = active.ad_source_id ? get('SELECT * FROM wa_ad_sources WHERE user_id=? AND source_id=?', ctx.user.id, active.ad_source_id) : null;
      const sourceHref = /^https?:\/\//i.test(String(active.ad_source_url || '')) ? String(active.ad_source_url) : '';
      activeAdConfig = {
        sourceId: String(active.ad_source_id || ''), title: String(active.ad_title || ''), body: String(active.ad_body || ''),
        sourceUrl: sourceHref, ctwaClid: String(active.ad_ctwa_clid || ''), ref: String(active.ad_ref || ''),
        displayName: String((mapping && mapping.display_name) || active.ad_title || active.ad_source_id || '未命名广告'),
        campaignName: String((mapping && mapping.campaign_name) || ''), adSetName: String((mapping && mapping.ad_set_name) || ''),
        notes: String((mapping && mapping.notes) || ''), firstSeenAt: String(active.ad_first_seen_at || '').slice(0, 16),
      };
    }
    // 广告条默认只占一行（标题 + ID + 两个按钮），详情收到折叠里，省出消息区高度。
    const adAttributionHtml = !activeAdConfig ? '' : `
      <div class="wa-ad-strip">
        <div class="wa-ad-icon"><i class="bi bi-megaphone-fill"></i></div>
        <div class="wa-ad-main">
          <div class="wa-ad-title"><span class="badge text-bg-primary">广告</span><b>${esc(activeAdConfig.displayName)}</b>${activeAdConfig.sourceId ? '<code class="wa-ad-id">' + esc(activeAdConfig.sourceId) + '</code>' : ''}</div>
        </div>
        <div class="wa-ad-actions">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-toggle="collapse" data-bs-target="#waAdDetails" aria-expanded="false" aria-controls="waAdDetails"><i class="bi bi-chevron-down me-1"></i>详情</button>
          <button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="collapse" data-bs-target="#waAdEditor" aria-expanded="false" aria-controls="waAdEditor"><i class="bi bi-pencil"></i> 标记广告</button>
        </div>
      </div>
      <div class="collapse" id="waAdDetails">
        <div class="wa-ad-details">
          <div class="wa-ad-meta">
            ${activeAdConfig.sourceId ? '<span>广告 ID <code>' + esc(activeAdConfig.sourceId) + '</code></span>' : ''}
            ${activeAdConfig.campaignName ? '<span>广告系列：' + esc(activeAdConfig.campaignName) + '</span>' : ''}
            ${activeAdConfig.adSetName ? '<span>广告组：' + esc(activeAdConfig.adSetName) + '</span>' : ''}
            ${activeAdConfig.ref ? '<span>ref：' + esc(activeAdConfig.ref) + '</span>' : ''}
            ${activeAdConfig.firstSeenAt ? '<span>首次进入：' + esc(activeAdConfig.firstSeenAt) + '</span>' : ''}
          </div>
          ${activeAdConfig.body ? '<div class="wa-ad-copy">' + esc(activeAdConfig.body) + '</div>' : ''}
          <div class="wa-ad-detail-actions">
            ${activeAdConfig.sourceUrl ? '<a class="btn btn-sm btn-outline-secondary" href="' + esc(activeAdConfig.sourceUrl) + '" target="_blank" rel="noopener noreferrer"><i class="bi bi-box-arrow-up-right"></i> 落地页</a>' : ''}
            ${activeAdConfig.sourceId ? '<button type="button" class="btn btn-sm btn-outline-secondary wa-ad-copy-id" data-copy="' + esc(activeAdConfig.sourceId) + '"><i class="bi bi-copy"></i> 复制 ID</button>' : ''}
          </div>
        </div>
      </div>
      <div class="collapse" id="waAdEditor">
        <form method="post" action="/whatsapp/chat/${Number(active.id)}/ad-label" class="wa-ad-editor">
          <input type="hidden" name="back" value="${esc(backUrl)}">
          <div class="row g-2">
            <div class="col-md-4"><label class="form-label small mb-1">业务易读名称</label><input class="form-control form-control-sm" name="display_name" maxlength="200" value="${esc(activeAdConfig.displayName)}" placeholder="例如：尼日利亚门锁询盘-黑色款"></div>
            <div class="col-md-4"><label class="form-label small mb-1">广告系列</label><input class="form-control form-control-sm" name="campaign_name" maxlength="200" value="${esc(activeAdConfig.campaignName)}" placeholder="Meta 广告系列名称"></div>
            <div class="col-md-4"><label class="form-label small mb-1">广告组</label><input class="form-control form-control-sm" name="ad_set_name" maxlength="200" value="${esc(activeAdConfig.adSetName)}" placeholder="国家/兴趣/受众"></div>
            <div class="col-12"><label class="form-label small mb-1">备注</label><input class="form-control form-control-sm" name="notes" maxlength="1000" value="${esc(activeAdConfig.notes)}" placeholder="投放素材、优惠、目标市场等"></div>
            <div class="col-12 d-flex justify-content-between align-items-center gap-2"><span class="form-text m-0">保存后，同一广告 ID 进入的所有客户都会显示这个名称。广告 ID 仍会原样保留。</span><button class="btn btn-sm btn-primary"><i class="bi bi-check2"></i> 保存广告名称</button></div>
          </div>
        </form>
      </div>`;

    const customerList = customers.map(c => `<option value="#${c.id} · ${esc(c.company_name)}"></option>`).join('');
    convHtml = `
      <div class="wa-conversation-head">
        <span class="wa-avatar wa-avatar-lg">${chatAvatarHtml(active, true)}</span>
        <div class="min-w-0">
          <div class="fw-semibold text-truncate">${esc(chatLabel(active))}</div>
          <div class="text-muted small">${active.is_group ? '群聊' : (active.phone ? '+' + esc(active.phone) : 'WhatsApp 内部联系人 ID')}</div>
        </div>
        <div class="ms-auto d-flex gap-2 align-items-center flex-wrap">
          <button type="button" class="btn btn-sm ${activeRemark ? 'btn-outline-primary' : 'btn-outline-secondary'}" data-bs-toggle="collapse" data-bs-target="#waNoteEditor" aria-expanded="false" aria-controls="waNoteEditor">
            <i class="bi bi-journal-text me-1"></i>${activeRemark ? '备注' : '添加备注'}
          </button>
          <form method="post" action="/whatsapp/chat/${Number(active.id)}/pin" class="d-inline-flex">
            <input type="hidden" name="pin" value="${pinnedActive ? '0' : '1'}">
            <input type="hidden" name="back" value="${esc(backUrl)}">
            <button type="submit" class="btn btn-sm ${pinnedActive ? 'btn-dark' : 'btn-outline-secondary'}" title="${pinnedActive ? '取消置顶' : '置顶，稍后处理'}">
              <i class="bi bi-pin-angle${pinnedActive ? '-fill' : ''} me-1"></i>${pinnedActive ? '已置顶' : '置顶'}
            </button>
          </form>
          ${active.customer_name ? `<a href="/customers/${active.customer_id}" class="badge text-bg-success text-decoration-none"><i class="bi bi-buildings me-1"></i>${esc(active.customer_name)}</a>` : '<span class="badge text-bg-warning">未绑定客户</span>'}
        </div>
      </div>
      <div class="wa-note-strip ${activeRemark ? 'has-note' : ''}">
        <div class="wa-note-content">
          <i class="bi bi-journal-text"></i>
          <div class="min-w-0">
            <div class="wa-note-label">会话备注</div>
            <div class="wa-note-text">${activeRemark ? esc(activeRemark).replace(/\n/g, '<br>') : '暂无备注，可记录客户偏好、付款约定或待确认事项。'}</div>
          </div>
        </div>
        <button type="button" class="btn btn-link btn-sm p-0 wa-note-edit" data-bs-toggle="collapse" data-bs-target="#waNoteEditor" aria-expanded="false" aria-controls="waNoteEditor">${activeRemark ? '编辑' : '添加'}</button>
      </div>
      <div class="collapse" id="waNoteEditor">
        <form method="post" action="/whatsapp/chat/${Number(active.id)}/remark" class="wa-note-editor">
          <input type="hidden" name="back" value="${esc(backUrl)}">
          <label class="form-label small mb-1" for="waRemark">会话备注（仅当前 WhatsApp 会话显示）</label>
          <textarea class="form-control form-control-sm" id="waRemark" name="remark" rows="3" maxlength="2000" placeholder="例如：客户只接受 T/T；下次联系需发送门锁报价；已承诺周五前回复。">${esc(activeRemark)}</textarea>
          <div class="d-flex align-items-center justify-content-between gap-2 mt-2">
            <span class="form-text m-0">最多 2000 个字符，清空内容后保存即可删除备注。</span>
            <button class="btn btn-sm btn-primary text-nowrap"><i class="bi bi-check2 me-1"></i>保存备注</button>
          </div>
        </form>
      </div>
      ${adAttributionHtml}
      <div class="wa-bindbar">
        <form method="post" action="/whatsapp/bind" class="d-flex gap-1 align-items-center flex-grow-1" id="waBindForm">
            <input type="hidden" name="chat_id" value="${active.id}">
            <input type="hidden" name="customer_id" id="waCustomerId" value="${active.customer_id || ''}">
            <input class="form-control form-control-sm" id="waCustomerSearch" list="waCustomerList" value="${esc(currentSearch)}" placeholder="搜索客户名称后选择">
            <datalist id="waCustomerList">${customerList}</datalist>
            <button class="btn btn-sm btn-outline-secondary text-nowrap">保存绑定</button>
        </form>
        <form method="post" action="/whatsapp/import-chat">
            <input type="hidden" name="chat_id" value="${active.id}">
            <button class="btn btn-sm btn-outline-primary text-nowrap" ${active.customer_id ? '' : 'disabled title="先绑定客户"'}>立即同步跟进</button>
        </form>
      </div>
      <div id="waMsgs" class="wa-messages">${msgs.map(m => msgHtml(m, active, msgByWaId)).join('') || '<div class="text-muted small py-4 text-center">暂无消息</div>'}</div>
      ${'' /* 翻译/快捷短语面板放在输入框前面（2026-11-23）：从右侧 AI 面板搬过来，默认收起，点附件边的按钮展开；放在输入框下面会被 sticky 置底的输入框盖住、点不到。面板在 #waSendForm 外面，里面的管理表单才不会嵌套进发送表单。 */}
      <div id="waComposeTranslatePanel" class="wa-compose-panel d-none" aria-label="翻译工具">
        <div class="wa-ai-section-title"><i class="bi bi-translate"></i><span>翻译输入框内容</span></div>
        <div class="d-flex gap-2 align-items-center flex-wrap">
          <label class="wa-ai-field-label mb-0" for="waTranslateLang">目标语言</label>
          <select class="form-select form-select-sm w-auto" id="waTranslateLang" title="谷歌免费机翻，无需 API Key"><option value="en">英语</option><option value="fr">法语</option><option value="ar">阿拉伯语</option><option value="es">西班牙语</option><option value="ru">俄语</option></select>
          <button class="btn btn-sm btn-outline-primary" type="button" id="waAiTranslate"><i class="bi bi-translate me-1"></i>翻译草稿</button>
        </div>
        <p class="wa-ai-hint mb-0">先在聊天输入框写入或粘贴内容，翻译结果会替换输入框文本，可编辑后再发送。</p>
      </div>
      <div id="waComposePhrasesPanel" class="wa-compose-panel d-none" aria-label="快捷短语">
        <div class="wa-ai-section-title"><i class="bi bi-lightning"></i><span>快捷短语</span></div>
        <label class="wa-ai-field-label" for="waQuickReply">选择并填入聊天输入框</label>
        <select class="form-select form-select-sm" id="waQuickReply"><option value="">选择快捷回复…</option>${quickReplies.map(reply => `<option value="${esc(reply.content)}">${esc(reply.title)}</option>`).join('')}</select>
        <div class="wa-compose-phrases-manage">
          <div class="small text-muted mt-2 mb-1">管理快捷回复</div>
          <div class="d-flex flex-wrap gap-2 mt-2">
            ${quickReplies.map(r => `<form method="post" action="/whatsapp/quick-replies/${r.id}/delete" class="d-inline"><input type="hidden" name="chat_id" value="${active.id}"><button class="btn btn-sm btn-light border">${esc(r.title)} ×</button></form>`).join('') || '<span class="small text-muted">还没有快捷回复</span>'}
          </div>
          <div class="input-group input-group-sm mt-2">
            <input class="form-control" name="title" form="waSaveReply" placeholder="名称，如：询问型号和数量" required>
            <button class="btn btn-outline-secondary" form="waSaveReply">保存当前输入内容</button>
          </div>
          <form method="post" action="/whatsapp/quick-replies" id="waSaveReply">
            <input type="hidden" name="chat_id" value="${active.id}">
            <input type="hidden" name="content" id="waQuickContent">
          </form>
        </div>
      </div>
      <form method="post" action="/whatsapp/send" class="wa-compose" id="waSendForm" enctype="multipart/form-data">
        <input type="hidden" name="chat_id" value="${active.id}">
        <input type="hidden" name="quote_id" id="waQuoteId" value="">
        <div id="waQuoteBar" class="wa-compose-quote d-none">
          <i class="bi bi-reply-fill" id="waQuoteIcon"></i>
          <div class="min-w-0 flex-grow-1"><div class="wa-compose-quote-sender" id="waQuoteSender"></div><div class="wa-compose-quote-text" id="waQuoteText"></div></div>
          <button type="button" class="btn-close btn-sm" id="waQuoteCancel" aria-label="取消引用"></button>
        </div>
        <div class="wa-compose-tools">
          <label class="btn btn-sm btn-outline-secondary mb-0" for="waAttachment" title="可多选文件，也可以直接在输入框按 Ctrl+V 粘贴图片"><i class="bi bi-paperclip me-1"></i>附件</label>
          <input class="visually-hidden" type="file" name="attachment" id="waAttachment" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip" multiple>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="waComposeTranslateBtn" aria-expanded="false" aria-controls="waComposeTranslatePanel" title="翻译输入框内容"><i class="bi bi-translate me-1"></i>翻译</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="waComposePhrasesBtn" aria-expanded="false" aria-controls="waComposePhrasesPanel" title="选择快捷短语填入输入框"><i class="bi bi-lightning me-1"></i>快捷短语</button>
          <span class="small text-muted" id="waSendState" aria-live="polite"></span>
        </div>
        <div id="waAttachmentPreview" class="wa-attachment-preview d-none" aria-live="polite">
          <div class="wa-attachment-head">
            <span><i class="bi bi-paperclip me-1"></i><b id="waAttachmentSummary"></b></span>
            <button type="button" class="btn btn-link btn-sm p-0 wa-attachment-clear-all" id="waAttachmentClear">全部移除</button>
          </div>
          <div id="waAttachmentItems" class="wa-attachment-items"></div>
        </div>
        <div class="d-flex gap-2 align-items-end mt-2">
          <textarea class="form-control" name="text" rows="3" placeholder="输入消息，可粘贴图片，Ctrl+Enter 发送" id="waText"></textarea>
          <button class="btn btn-primary" ${v.status === 'online' ? '' : 'disabled'}><i class="bi bi-send me-1"></i>发送</button>
        </div>
        ${v.status === 'online' ? '' : '<div class="form-text text-danger">当前未连接，无法发送。</div>'}
      </form>
`;
  }


  const filterUrl = (f) => '/whatsapp/session?filter=' + f + (q ? '&q=' + encodeURIComponent(q) : '');
  const chatUrl = (id) => '/whatsapp/session?chat=' + id
    + (filter !== 'all' ? '&filter=' + encodeURIComponent(filter) : '')
    + (q ? '&q=' + encodeURIComponent(q) : '');
  let sideHtml = '<div class="text-muted small py-5 text-center">选择会话后查看客户档案和跟进状态</div>';
  if (active) {
    const lastAct = activeCustomer ? get("SELECT * FROM activities WHERE customer_id=? AND user_id=? ORDER BY activity_date DESC, id DESC LIMIT 1", activeCustomer.id, ctx.user.id) : null;
    const nextAct = activeCustomer ? get("SELECT * FROM activities WHERE customer_id=? AND user_id=? AND archived=0 AND next_follow_date IS NOT NULL AND next_follow_date<>'' ORDER BY CASE WHEN next_follow_date>? THEN 0 ELSE 1 END, next_follow_date ASC, id DESC LIMIT 1", activeCustomer.id, ctx.user.id, todayStr()) : null;
    const customerDocs = activeCustomer ? all(`SELECT id, doc_no, doc_type, title, issue_date, currency, total_amount, status
      FROM documents WHERE customer_id=? AND user_id=?
      ORDER BY COALESCE(NULLIF(issue_date,''),created_at) DESC, id DESC LIMIT 8`, activeCustomer.id, ctx.user.id) : [];
    const customerDocsHtml = customerDocs.length
      ? `<div class="wa-side-documents"><div class="wa-side-documents-title"><span>客户单据</span><a href="/documents?search=${encodeURIComponent(activeCustomer.company_name || '')}">全部</a></div>${customerDocs.map(doc => `<a class="wa-side-document" href="/documents/${Number(doc.id)}"><span class="wa-side-document-main"><b>${esc(doc.doc_no || '-')}</b><small>${esc(DOC_TYPE_MAP[doc.doc_type] ? DOC_TYPE_MAP[doc.doc_type].name : doc.doc_type)}${doc.issue_date ? ' · ' + esc(doc.issue_date) : ''}</small></span><span class="wa-side-document-meta"><b>${esc(doc.status || '-')}</b><small>${esc(doc.currency || 'USD')} ${Number(doc.total_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</small></span></a>`).join('')}</div>`
      : '<div class="wa-side-documents"><div class="wa-side-documents-title"><span>客户单据</span></div><div class="wa-side-documents-empty">暂无客户单据</div></div>';
    const syncOn = Number(active.sync_followup) === 1;
    sideHtml = activeCustomer ? `
      <div class="wa-side-head">
        <span class="wa-avatar wa-avatar-lg">${chatAvatarHtml(active, true)}</span>
        <div class="min-w-0"><a class="fw-semibold text-decoration-none text-reset d-block text-truncate" href="/customers/${activeCustomer.id}">${esc(activeCustomer.company_name)}</a><div class="small text-muted">${esc(activeCustomer.country || '未填写国家')}</div></div>
      </div>
      <div class="wa-side-list">
        <div><span>客户状态</span><b>${esc(activeCustomer.status || '-')}</b></div>
        <div><span>联系人</span><b>${esc(activeCustomer.contact_person || chatLabel(active))}</b></div>
        <div><span>WhatsApp</span><b>${esc(activeCustomer.whatsapp || active.phone || '-')}</b></div>
        <div><span>邮箱</span><b>${esc(activeCustomer.email || '-')}</b></div>
        ${activeAdConfig ? '<div><span>广告来源</span><b title="' + esc(activeAdConfig.sourceId) + '">' + esc(activeAdConfig.displayName) + '</b></div>' : ''}
        <div><span>最近跟进</span><b>${esc(lastAct ? String(lastAct.activity_date || '').slice(0, 10) : '暂无')}</b></div>
        <div><span>下次跟进</span><b class="${nextAct && nextAct.next_follow_date <= new Date().toISOString().slice(0, 10) ? 'text-danger' : ''}">${esc(nextAct ? nextAct.next_follow_date : '未安排')}</b></div>
      </div>
      <div class="d-grid gap-2 mt-3">
        <a class="btn btn-sm btn-primary" href="/customers/${activeCustomer.id}/activities/new"><i class="bi bi-calendar-plus me-1"></i>新增跟进</a>
        <a class="btn btn-sm btn-outline-secondary" href="/customers/${activeCustomer.id}">查看完整客户档案</a>
        <form method="post" action="/whatsapp/followup-sync">
          <input type="hidden" name="chat_id" value="${active.id}">
          <button class="btn btn-sm ${syncOn ? 'btn-success' : 'btn-outline-secondary'} w-100"><i class="bi bi-arrow-repeat me-1"></i>自动同步跟进：${syncOn ? '开' : '关'}</button>
        </form>
      </div>
      ${customerDocsHtml}`
      : `
      <div class="wa-side-head"><span class="wa-avatar wa-avatar-lg">${chatAvatarHtml(active, true)}</span><div><div class="fw-semibold">${esc(chatLabel(active))}</div><div class="small text-muted">${active.phone ? '+' + esc(active.phone) : '缺少手机号'}</div></div></div>
      <div class="alert alert-warning small py-2 mt-3">这个会话还没有绑定 CRM 客户。绑定后可看跟进、订单和完整档案。</div>
      ${active.is_group ? '<div class="small text-muted">群聊请先绑定到对应客户再同步跟进。</div>' : `<form method="post" action="/whatsapp/create-customer" class="vstack gap-2">
        <input type="hidden" name="chat_id" value="${active.id}">
        <div><label class="form-label small mb-1">客户名称</label><input class="form-control form-control-sm" name="company_name" value="${esc(chatLabel(active))}" required></div>
        <div><label class="form-label small mb-1">联系人</label><input class="form-control form-control-sm" name="contact_person" value="${esc(active.name || '')}" placeholder="联系人姓名"></div>
        <div><label class="form-label small mb-1">国家/地区</label><input class="form-control form-control-sm" name="country" value="${esc(guessCountry(active.phone) || '')}" placeholder="按国际区号自动识别"></div>
        <button class="btn btn-sm btn-primary"><i class="bi bi-person-plus me-1"></i>新建客户并绑定</button>
        <div class="form-text">绑定后自动安排首次跟进，日期为创建当天加 3 天。</div>
      </form>`}`;
  }
  const latestInbound = activeMessages.slice().reverse().find(message => !Number(message.from_me) && String(message.text || '').trim());
  const latestInboundText = String(latestInbound && latestInbound.text || '').trim();
  const matchedKnowledge = latestInboundText ? knowledgeBase.relevantArticles(latestInboundText, 5) : [];
  const relatedActivities = activeCustomer ? all(`SELECT type,subject,content,outcome,activity_date,next_follow_date,archived
    FROM activities WHERE customer_id=? AND user_id=? ORDER BY activity_date DESC,id DESC LIMIT 16`, activeCustomer.id, ctx.user.id) : [];
  const followupTabHtml = relatedActivities.length ? relatedActivities.map(row => `<div class="wa-workbench-record">
    <div class="wa-workbench-record-meta"><span class="badge text-bg-light">${esc(row.type || '其他')}</span><span>${esc(String(row.activity_date || '').slice(0, 16))}</span>${row.archived ? '<span class="badge text-bg-success">已完成</span>' : ''}</div>
    <div class="wa-workbench-record-title">${esc(row.subject || row.content || '跟进记录')}</div>
    ${row.content && row.subject ? `<div class="wa-workbench-record-copy">${esc(String(row.content).slice(0, 500))}</div>` : ''}
    ${row.outcome ? `<div class="wa-workbench-record-copy">结果：${esc(row.outcome)}</div>` : ''}
    ${row.next_follow_date ? `<div class="wa-workbench-record-next">下次跟进：${esc(row.next_follow_date)}</div>` : ''}
  </div>`).join('') : '<div class="wa-panel-empty">绑定 CRM 客户后，这里会显示已有跟进记录。</div>';
  const fileMessages = activeMessages.filter(message => message.media_path && ['image', 'video', 'audio', 'document', 'sticker'].includes(message.kind)).slice().reverse();
  const filesTabHtml = fileMessages.length ? `<div class="wa-files-grid">${fileMessages.map(message => {
    const url = messageMediaUrl(message);
    const label = message.media_name || ({ image: '图片', video: '视频', audio: '语音', sticker: '贴纸' }[message.kind] || '附件');
    const isImage = message.kind === 'image';
    return `<a class="wa-file-tile" href="${esc(url)}" target="_blank" rel="noopener"><span class="wa-file-thumb">${isImage ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<i class="bi ${message.kind === 'audio' ? 'bi-file-music' : message.kind === 'video' ? 'bi-file-play' : 'bi-file-earmark'}"></i>`}</span><span><b>${esc(label)}</b><small>${esc(String(message.ts || '').slice(0, 16))}</small></span></a>`;
  }).join('')}</div>` : '<div class="wa-panel-empty">当前会话还没有已保存的图片或文件。</div>';
  const customerQuotes = activeCustomer ? all(`SELECT id,quote_no,quote_date,product_name,model,currency,amount,status
    FROM quote_history WHERE user_id=? AND customer_id=? ORDER BY quote_date DESC,id DESC LIMIT 12`, ctx.user.id, activeCustomer.id) : [];
  const orderRows = activeCustomer ? all(`SELECT id,doc_no,doc_type,issue_date,currency,total_amount,status
    FROM documents WHERE user_id=? AND customer_id=? ORDER BY COALESCE(NULLIF(issue_date,''),created_at) DESC,id DESC LIMIT 12`, ctx.user.id, activeCustomer.id) : [];
  const orderQuoteRowsHtml = [
    ...customerQuotes.map(row => `<a class="wa-order-row" href="/quotes/${Number(row.id)}/edit"><span><b>${esc(row.quote_no || '历史报价')}</b><small>${esc(row.product_name || '')}${row.model ? ' · ' + esc(row.model) : ''} · ${esc(row.quote_date || '')}</small></span><span><b>${esc(row.currency || 'USD')} ${Number(row.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b><small>${esc(row.status || '')}</small></span></a>`),
    ...orderRows.map(row => `<a class="wa-order-row" href="/documents/${Number(row.id)}"><span><b>${esc(row.doc_no || '单据')}</b><small>${esc(DOC_TYPE_MAP[row.doc_type] ? DOC_TYPE_MAP[row.doc_type].name : row.doc_type)} · ${esc(row.issue_date || '')}</small></span><span><b>${esc(row.currency || 'USD')} ${Number(row.total_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b><small>${esc(row.status || '')}</small></span></a>`),
  ].join('') || '<div class="wa-panel-empty">绑定 CRM 客户后，这里会显示真实报价和订单。</div>';
  const activeProfile = activeCustomer ? `<div class="wa-profile-summary">
    <span class="wa-avatar wa-avatar-lg">${chatAvatarHtml(active, true)}</span><div class="min-w-0"><a href="/customers/${activeCustomer.id}" class="wa-profile-name">${esc(activeCustomer.company_name)}</a><div class="wa-profile-meta">${esc(activeCustomer.country || '国家/地区未填写')}${activeCustomer.status ? ' · ' + esc(activeCustomer.status) : ''}</div></div>
    <a href="/customers/${activeCustomer.id}" class="btn btn-sm btn-outline-secondary ms-auto">客户档案</a>
  </div>` : '<div class="wa-unbound-notice"><i class="bi bi-person-exclamation"></i><span>当前会话尚未绑定客户。可在“客户信息”页完成绑定或新建客户。</span></div>';
  const aiKnowledgeHtml = matchedKnowledge.length ? matchedKnowledge.map(article => `<a class="wa-ai-knowledge-row" href="/knowledge?article=${Number(article.id)}"><span class="badge text-bg-light">${esc(article.category)}</span><b>${esc(article.title)}</b><i class="bi bi-arrow-up-right"></i></a>`).join('') : '<div class="wa-panel-empty">最近入站消息没有匹配到知识库内容。可先补充消息，或直接搜索知识库。</div>';
  const aiPanelHtml = `<aside class="wa-ai-pane" aria-label="AI 智能助手">
    <div class="wa-ai-pane-head"><span class="wa-ai-mark"><i class="bi bi-stars"></i></span><div><b>AI 智能助手</b><small>只生成草稿，不自动发送</small></div></div>
    <div class="wa-ai-tabs" role="tablist" aria-label="AI 工具">
      <button type="button" role="tab" aria-selected="true" class="active" data-wa-ai-tab="reply">智能回复</button><button type="button" role="tab" aria-selected="false" data-wa-ai-tab="knowledge">知识检索</button>
    </div>
    <section class="wa-ai-tab-panel active" role="tabpanel" data-wa-ai-panel="reply">
      <div class="wa-ai-section-title"><i class="bi bi-person-lines-fill"></i><span>客户与会话</span></div>
      ${activeProfile}
      <div class="wa-ai-context-label">最近入站消息</div>
      <div class="wa-ai-context-copy">${latestInboundText ? esc(latestInboundText.slice(0, 650)) : '暂无可用于起草的客户文字消息。'}</div>
      <button class="btn btn-sm btn-primary w-100 mt-3" type="button" id="waAiDraft"><i class="bi bi-stars me-1"></i>根据当前对话起草</button>
      <div class="wa-ai-state" id="waAiState" aria-live="polite"></div>
      <div class="wa-ai-safety-note"><i class="bi bi-shield-check"></i><span>草稿只填入聊天输入框，确认后由你手动发送。</span></div>
      <div class="wa-ai-inline-knowledge">
        <div class="wa-ai-section-title"><i class="bi bi-journal-richtext"></i><span>引用知识</span><a href="/knowledge${latestInboundText ? '?search=' + encodeURIComponent(latestInboundText.split(/\\s+/).slice(0, 4).join(' ')) : ''}">知识库</a></div>
        <div class="wa-ai-knowledge-list">${aiKnowledgeHtml}</div>
      </div>
    </section>
    <section class="wa-ai-tab-panel" role="tabpanel" data-wa-ai-panel="knowledge" hidden>
      <div class="wa-ai-section-title"><i class="bi bi-journal-richtext"></i><span>相关知识</span></div>
      ${latestInboundText ? `<div class="wa-ai-context-copy mb-2">按最近入站消息检索：${esc(latestInboundText.slice(0, 180))}</div>` : ''}
      <div class="wa-ai-knowledge-list">${aiKnowledgeHtml}</div>
      <a class="btn btn-sm btn-outline-secondary w-100 mt-3" href="/knowledge${latestInboundText ? '?search=' + encodeURIComponent(latestInboundText.split(/\\s+/).slice(0, 4).join(' ')) : ''}"><i class="bi bi-search me-1"></i>打开知识库</a>
    </section>
  </aside>`;
  const content = `
    ${pageHead('WhatsApp', '客户会话 · CRM 档案 · AI 销售助手', `<div class="d-flex gap-2 flex-wrap align-items-center"><span class="badge text-bg-light">${stats.total || 0} 个会话</span><span class="badge text-bg-danger">${stats.unread_msgs || 0} 条未读</span><span class="badge text-bg-warning">${stats.unbound || 0} 个待绑定</span></div>`)}
    <div class="wa-workbench-metrics">
      <div><i class="bi bi-chat-dots"></i><span><b>${Number(todayMessages) || 0}</b><small>今日客户消息</small></span></div>
      <div><i class="bi bi-people"></i><span><b>${Number(activeConversations) || 0}</b><small>今日活跃会话</small></span></div>
      <div><i class="bi bi-calendar2-check"></i><span><b>${Number(dueFollowups) || 0}</b><small>待处理跟进</small></span></div>
      <div><i class="bi bi-send"></i><span><b>${Number(weekQuotes) || 0}</b><small>近 7 天报价</small></span></div>
    </div>
    <div class="row g-3 wa-inbox wa-3col workbench-2" id="waInbox" data-inbox-last-id="${inboxLastId}">
      <div class="wa-left-column">${card({
        title: '会话',
        actions: `<a class="btn btn-sm btn-outline-primary" href="#newChat" data-bs-toggle="collapse">新对话</a>`,
        body: `<div id="newChat" class="collapse mb-3">
          <form method="post" action="/whatsapp/new-chat">
            <input class="form-control form-control-sm mb-1" name="phone" placeholder="手机号含国家码，如 8613800138000" required>
            <textarea class="form-control form-control-sm mb-1" name="text" rows="2" placeholder="第一条消息" required></textarea>
            <button class="btn btn-sm btn-primary w-100">发送并建会话</button>
          </form>
        </div>
        <div class="wa-filter-tabs">
          <a class="${filter === 'all' ? 'active' : ''}" href="${filterUrl('all')}">全部 ${Number(stats.total) || 0}</a>
          <a class="${filter === 'unread' ? 'active' : ''}${Number(stats.unread_msgs) > 0 ? ' unread-bounce' : ''}" href="${filterUrl('unread')}">未读 ${Number(stats.unread_msgs) || 0}</a>
          <a class="wa-filter-pinned ${filter === 'pinned' ? 'active' : ''}" href="${filterUrl('pinned')}">置顶 ${Number(stats.pinned) || 0}</a>
          <a class="${filter === 'unbound' ? 'active' : ''}" href="${filterUrl('unbound')}">待绑定</a>
          <a class="${filter === 'bound' ? 'active' : ''}" href="${filterUrl('bound')}">已绑定</a>
        </div>
        <form method="get" action="/whatsapp/session" class="wa-search mb-2">
          <input type="hidden" name="filter" value="${filter}">
          <div class="input-group input-group-sm"><span class="input-group-text"><i class="bi bi-search"></i></span><input class="form-control" name="q" value="${esc(q)}" placeholder="搜索姓名、手机号、客户或消息"><button class="btn btn-outline-secondary">搜索</button></div>
        </form>
        <div class="wa-chat-list">${chatListHtml(chats, active ? active.id : '', chatUrl, backUrl)}</div>`
      })}</div>
      <div class="wa-center-column" id="waChatPanel" data-chat-id="${active ? active.id : ''}" data-last-id="${Number(lastId)}" data-media-saved="${mediaSaved}" data-receipt-state="${Number(receiptState)}">${card({
        title: '',
        body: `<div class="wa-main-tabs" role="tablist" aria-label="会话内容">
          <button type="button" class="active" data-wa-main-tab="chat"><i class="bi bi-chat-left-text"></i><span>聊天对话</span></button>
          <button type="button" data-wa-main-tab="customer"><i class="bi bi-person-vcard"></i><span>客户信息</span></button>
          <button type="button" data-wa-main-tab="followups"><i class="bi bi-clock-history"></i><span>跟进记录</span></button>
          <button type="button" data-wa-main-tab="files"><i class="bi bi-images"></i><span>文件资料</span><b>${fileMessages.length}</b></button>
          <button type="button" data-wa-main-tab="orders"><i class="bi bi-receipt"></i><span>订单报价</span><b>${customerQuotes.length + orderRows.length}</b></button>
        </div>
        <section class="wa-main-tab-panel active" data-wa-main-panel="chat">${convHtml}</section>
        <section class="wa-main-tab-panel" data-wa-main-panel="customer">${sideHtml}</section>
        <section class="wa-main-tab-panel wa-records-panel" data-wa-main-panel="followups">${followupTabHtml}</section>
        <section class="wa-main-tab-panel wa-records-panel" data-wa-main-panel="files">${filesTabHtml}</section>
        <section class="wa-main-tab-panel wa-records-panel" data-wa-main-panel="orders">${orderQuoteRowsHtml}</section>`,
        bodyClass: 'wa-main-card-body'
      })}</div>
      <div class="wa-right-column">${aiPanelHtml}</div>
    </div>
    <script>
      (function () {
        var inbox = document.getElementById('waInbox');
        if (!inbox) return;
        var pollTimer = null;
        var pollNow = null;
        // 输入区展开的面板（translate/phrases，2026-11-23）：轮询刷新会重渲染收件箱，
        // 展开状态记在这里，initConversation 每次绑定完再恢复。
        var openComposePanel = '';
        var requestSeq = 0;
        var loading = false;
        var deferredPollRefresh = false;
        // 声音提醒开关已移到系统设置（localStorage 的 crm_wa_sound，'0' 为关，默认开），这里只读不渲染按钮。
        var soundEnabled = true;
        var waAudioContext = null;
        var lastNotifiedIncomingId = Number(inbox.dataset.inboxLastId || 0);
        try { soundEnabled = localStorage.getItem('crm_wa_sound') !== '0'; } catch (e) {}

        function ensureWaAudioContext() {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return null;
          if (!waAudioContext) waAudioContext = new Ctx();
          return waAudioContext;
        }

        function unlockWaAudio() {
          var ctx = ensureWaAudioContext();
          if (ctx && ctx.state === 'suspended') {
            try { ctx.resume().catch(function () {}); } catch (e) {}
          }
        }

        function playWaNotification() {
          if (!soundEnabled) return;
          var ctx = ensureWaAudioContext();
          if (!ctx) return;
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
          if (ctx.state === 'suspended') {
            try { ctx.resume().then(play).catch(function () {}); } catch (e) {}
          } else play();
        }

        function maybeNotifyIncoming(data) {
          if (!data || !data.inbox_incoming_changed) return;
          var incomingId = Number(data.inboxLatestIncomingId) || 0;
          if (incomingId <= lastNotifiedIncomingId) return;
          lastNotifiedIncomingId = incomingId;
          playWaNotification();
        }

        document.addEventListener('pointerdown', unlockWaAudio, { passive: true });
        document.addEventListener('keydown', unlockWaAudio);

        function activePanel() { return document.getElementById('waChatPanel'); }

        function clearQuote() {
          var quoteId = document.getElementById('waQuoteId');
          var bar = document.getElementById('waQuoteBar');
          var sender = document.getElementById('waQuoteSender');
          var text = document.getElementById('waQuoteText');
          if (quoteId) quoteId.value = '';
          if (sender) sender.textContent = '';
          if (text) text.textContent = '';
          if (bar) bar.classList.add('d-none');
        }

        function applyQuote(button) {
          if (!button) return;
          var quoteId = document.getElementById('waQuoteId');
          var bar = document.getElementById('waQuoteBar');
          var sender = document.getElementById('waQuoteSender');
          var text = document.getElementById('waQuoteText');
          var icon = document.getElementById('waQuoteIcon');
          var id = String(button.dataset.quoteId || '');
          if (!id || !quoteId || !bar) return;
          var kind = String(button.dataset.quoteKind || 'text');
          var icons = { image: 'bi-image', video: 'bi-camera-video', audio: 'bi-mic', document: 'bi-file-earmark-text', sticker: 'bi-sticky', location: 'bi-geo-alt', contact: 'bi-person-vcard' };
          quoteId.value = id;
          if (sender) sender.textContent = button.dataset.quoteSender || '引用的消息';
          if (text) text.textContent = button.dataset.quoteText || '[消息]';
          if (icon) icon.className = 'bi ' + (icons[kind] || 'bi-reply-fill');
          bar.classList.remove('d-none');
          var ta = document.getElementById('waText');
          if (ta) ta.focus();
        }

        function jumpToQuotedMessage(button) {
          if (!button) return;
          var targetId = String(button.dataset.quoteTargetId || '');
          var targetWaId = String(button.dataset.quoteTargetWaId || '');
          function findTarget() {
            var current = targetId ? document.getElementById('wa-msg-' + targetId) : null;
            if (current || !targetWaId) return current;
            var allRows = document.querySelectorAll('#waMsgs .wa-message-row[data-wa-msg-id]');
            for (var i = 0; i < allRows.length; i++) {
              if (String(allRows[i].dataset.waMsgId || '') === targetWaId) return allRows[i];
            }
            return null;
          }
          function centerTarget(behavior) {
            var box = document.getElementById('waMsgs');
            var target = findTarget();
            if (!box || !target) return false;
            var boxRect = box.getBoundingClientRect();
            var targetRect = target.getBoundingClientRect();
            var top = box.scrollTop + (targetRect.top - boxRect.top) - Math.max(12, (box.clientHeight - targetRect.height) / 2);
            try {
              box.scrollTo({ top: Math.max(0, top), behavior: behavior || 'auto' });
            } catch (e) {
              box.scrollTop = Math.max(0, top);
            }
            target.classList.remove('wa-message-jump-flash');
            void target.offsetWidth;
            target.classList.add('wa-message-jump-flash');
            try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (err) {} }
            window.setTimeout(function () { target.classList.remove('wa-message-jump-flash'); }, 1800);
            return true;
          }
          if (!centerTarget('smooth')) {
            var wrap = button.closest ? button.closest('.wa-quote-wrap') : null;
            if (wrap && !wrap.querySelector('.wa-quote-jump-error')) {
              var notice = document.createElement('span');
              notice.className = 'wa-quote-jump-error';
              notice.textContent = '原消息不在本地记录中';
              wrap.appendChild(notice);
              window.setTimeout(function () { if (notice.isConnected) notice.remove(); }, 2600);
            }
            return;
          }
          // 图片和附件加载会改变消息高度，分几次校准，确保被引用的消息仍在可视区域。
          [220, 650, 1300].forEach(function (delay) {
            window.setTimeout(function () { centerTarget('auto'); }, delay);
          });
        }

        function saveDraft() {
          var panel = activePanel();
          var ta = document.getElementById('waText');
          if (!panel || !ta || !panel.dataset.chatId) return;
          try { sessionStorage.setItem('waDraft:' + panel.dataset.chatId, ta.value); } catch (e) {}
        }

        function initConversation() {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          var panel = activePanel();
          if (!panel) return;
          var chatId = Number(panel.dataset.chatId || 0);
          var lastId = Number(panel.dataset.lastId || 0);
          var box = document.getElementById('waMsgs');
          if (box) box.scrollTop = box.scrollHeight;
          var ta = document.getElementById('waText');
          var form = document.getElementById('waSendForm');
          // 输入框自动长高（2026-11-22）：rows=3 起步，多打几行时跟着长，最高 160px 后框内滚动，
          // 避免原来 rows=2、打的字被截看不到。程序填入草稿后也要调一次（见下面各 ta.value 赋值处）。
          function autoGrowWaText() {
            if (!ta) return;
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
            // 输入框长高时跟随滚动（2026-11-22）：页面已滚到底看消息时，打字把框撑高会把发送按钮
            // 顶出视口底边，这里把超出部分滚回来，发送按钮始终可见。刚打开页面（scrollY=0）不触发，
            // 落地滚动由下面首次打开的 scrollTo 负责，避免两者打架。
            try {
              if ((window.scrollY || 0) > 0 && form) {
                var _fb = form.getBoundingClientRect().bottom;
                if (_fb > window.innerHeight - 4) window.scrollBy(0, _fb - window.innerHeight + 8);
              }
            } catch (e) {}
          }
          if (ta && form) ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (form.requestSubmit) form.requestSubmit();
            }
          });
          if (ta) {
            ta.addEventListener('input', autoGrowWaText);
            autoGrowWaText();
          }

          var attachmentFiles = [];
          var attachmentObjectUrls = [];
          var attachmentPasteSeq = 0;
          var MAX_ATTACHMENTS = 10;
          var MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
          var MAX_BATCH_BYTES = 45 * 1024 * 1024;
          var IMAGE_OPTIMIZE_BYTES = 1.2 * 1024 * 1024;
          var IMAGE_MAX_EDGE = 2048;
          var IMAGE_JPEG_QUALITY = 0.86;

          function formatFileSize(bytes) {
            var n = Number(bytes || 0);
            if (n < 1024) return n + ' B';
            if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
            return (n / 1024 / 1024).toFixed(1) + ' MB';
          }

          function attachmentKey(file) {
            return [file.name || '', Number(file.size || 0), Number(file.lastModified || 0), file.type || ''].join('|');
          }

          function syncAttachmentInput() {
            var input = document.getElementById('waAttachment');
            if (!input) return;
            if (!attachmentFiles.length) {
              input.value = '';
              return;
            }
            if (typeof DataTransfer !== 'function') return;
            try {
              var transfer = new DataTransfer();
              for (var i = 0; i < attachmentFiles.length; i++) transfer.items.add(attachmentFiles[i]);
              input.files = transfer.files;
            } catch (e) {}
          }

          function renderAttachments() {
            var preview = document.getElementById('waAttachmentPreview');
            var items = document.getElementById('waAttachmentItems');
            var summary = document.getElementById('waAttachmentSummary');
            if (!preview || !items || !summary) return;
            for (var u = 0; u < attachmentObjectUrls.length; u++) {
              try { URL.revokeObjectURL(attachmentObjectUrls[u]); } catch (e) {}
            }
            attachmentObjectUrls = [];
            items.innerHTML = '';
            if (!attachmentFiles.length) {
              preview.classList.add('d-none');
              summary.textContent = '';
              return;
            }
            var total = attachmentFiles.reduce(function (sum, file) { return sum + Number(file.size || 0); }, 0);
            summary.textContent = '已选 ' + attachmentFiles.length + ' 个附件 · ' + formatFileSize(total);
            attachmentFiles.forEach(function (file, index) {
              var item = document.createElement('div');
              item.className = 'wa-attachment-item';
              var thumb = document.createElement('div');
              thumb.className = 'wa-attachment-thumb';
              var isImage = String(file.type || '').toLowerCase().startsWith('image/');
              if (isImage && typeof URL.createObjectURL === 'function') {
                try {
                  var url = URL.createObjectURL(file);
                  attachmentObjectUrls.push(url);
                  var img = document.createElement('img');
                  img.src = url;
                  img.alt = file.name || '待发送图片';
                  thumb.appendChild(img);
                } catch (e) {}
              }
              if (!thumb.firstChild) {
                var icon = document.createElement('i');
                icon.className = 'bi ' + (isImage ? 'bi-image' : 'bi-file-earmark-arrow-up');
                thumb.appendChild(icon);
              }
              var detail = document.createElement('div');
              detail.className = 'min-w-0 flex-grow-1';
              var name = document.createElement('div');
              name.className = 'wa-attachment-name text-truncate';
              name.textContent = file.name || (isImage ? '粘贴的图片' : '粘贴的附件');
              var meta = document.createElement('div');
              meta.className = 'wa-attachment-meta';
              meta.textContent = (isImage ? '图片' : '附件') + ' · ' + formatFileSize(file.size);
              detail.appendChild(name);
              detail.appendChild(meta);
              var remove = document.createElement('button');
              remove.type = 'button';
              remove.className = 'btn btn-link wa-attachment-remove p-0';
              remove.dataset.attachmentRemove = String(index);
              remove.title = '移除附件';
              remove.setAttribute('aria-label', '移除附件 ' + (file.name || ''));
              remove.innerHTML = '<i class="bi bi-x-lg"></i>';
              item.appendChild(thumb);
              item.appendChild(detail);
              item.appendChild(remove);
              items.appendChild(item);
            });
            preview.classList.remove('d-none');
          }

          function clearAttachment() {
            attachmentFiles = [];
            syncAttachmentInput();
            renderAttachments();
          }

          function normalizeAttachment(file) {
            if (!file) return null;
            if (String(file.name || '').trim()) return file;
            attachmentPasteSeq++;
            var type = String(file.type || '').toLowerCase();
            var ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : type.startsWith('image/') ? '.jpg' : '.bin';
            try {
              return new File([file], 'pasted-' + Date.now() + '-' + attachmentPasteSeq + ext, { type: file.type || 'application/octet-stream' });
            } catch (e) { return file; }
          }

          function isOptimizableImage(file) {
            var type = String(file && file.type || '').toLowerCase();
            return type.startsWith('image/') && ['image/gif','image/svg+xml','image/heic','image/heif'].indexOf(type) < 0;
          }

          function loadImageForOptimization(file) {
            return new Promise(function (resolve, reject) {
              var url = URL.createObjectURL(file);
              var img = new Image();
              var settled = false;
              img.onload = function () {
                if (settled) return;
                settled = true;
                resolve({ img: img, url: url });
              };
              img.onerror = function () {
                if (settled) return;
                settled = true;
                try { URL.revokeObjectURL(url); } catch (e) {}
                reject(new Error('图片读取失败'));
              };
              img.src = url;
            });
          }

          // 仅在浏览器内压缩过大的图片，文档保持原文件不变。
          // 手机照片通常会从 5-15MB 降到几百 KB，WhatsApp 上传耗时会明显下降。
          function optimizeImageForWhatsApp(file) {
            if (!file || !isOptimizableImage(file)) return Promise.resolve(file);
            return loadImageForOptimization(file).then(function (loaded) {
              var img = loaded.img;
              var url = loaded.url;
              var width = Number(img.naturalWidth || img.width || 0);
              var height = Number(img.naturalHeight || img.height || 0);
              var maxEdge = Math.max(width, height);
              var finish = function (result) {
                try { URL.revokeObjectURL(url); } catch (e) {}
                return result;
              };
              if (!width || !height) return finish(file);
              if (Number(file.size || 0) <= IMAGE_OPTIMIZE_BYTES && maxEdge <= IMAGE_MAX_EDGE) return finish(file);
              var scale = Math.min(1, IMAGE_MAX_EDGE / maxEdge);
              var canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(width * scale));
              canvas.height = Math.max(1, Math.round(height * scale));
              var context = canvas.getContext('2d');
              if (!context || typeof canvas.toBlob !== 'function') return finish(file);
              context.fillStyle = '#fff';
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(img, 0, 0, canvas.width, canvas.height);
              return new Promise(function (resolve) {
                canvas.toBlob(function (blob) {
                  if (!blob || blob.size >= Number(file.size || 0) * 0.92) return resolve(finish(file));
                  var originalName = String(file.name || 'image');
                  var dot = originalName.lastIndexOf('.');
                  var baseName = dot > 0 ? originalName.slice(0, dot) : originalName;
                  try {
                    resolve(finish(new File([blob], baseName + '.jpg', {
                      type: 'image/jpeg',
                      lastModified: Date.now()
                    })));
                  } catch (e) {
                    resolve(finish(file));
                  }
                }, 'image/jpeg', IMAGE_JPEG_QUALITY);
              });
            }).catch(function () { return file; });
          }

          function prepareAttachmentsForSend(files, onProgress) {
            var output = new Array(files.length);
            var next = 0;
            var completed = 0;
            function worker() {
              var index = next++;
              if (index >= files.length) return Promise.resolve();
              return optimizeImageForWhatsApp(files[index]).then(function (prepared) {
                output[index] = prepared;
                completed++;
                if (onProgress) onProgress(completed, files.length);
                return worker();
              });
            }
            if (!files.length) return Promise.resolve(output);
            var workers = [];
            for (var i = 0; i < Math.min(2, files.length); i++) workers.push(worker());
            return Promise.all(workers).then(function () { return output; });
          }

          function makeAttachmentBatches(units) {
            var batches = [];
            var current = [];
            var currentBytes = 0;
            units.forEach(function (unit) {
              var size = Number(unit.file && unit.file.size || 0);
              if (current.length && currentBytes + size > MAX_BATCH_BYTES) {
                batches.push(current);
                current = [];
                currentBytes = 0;
              }
              current.push(unit);
              currentBytes += size;
            });
            if (current.length) batches.push(current);
            return batches;
          }

          function addAttachments(list, source) {
            var incoming = Array.from(list || []);
            var state = document.getElementById('waSendState');
            var added = 0;
            var skipped = 0;
            var oversized = 0;
            var existing = new Set(attachmentFiles.map(attachmentKey));
            for (var i = 0; i < incoming.length; i++) {
              var file = normalizeAttachment(incoming[i]);
              if (!file) continue;
              if (Number(file.size || 0) > MAX_ATTACHMENT_BYTES) { oversized++; continue; }
              var key = attachmentKey(file);
              if (existing.has(key)) { skipped++; continue; }
              if (attachmentFiles.length >= MAX_ATTACHMENTS) { skipped++; continue; }
              attachmentFiles.push(file);
              existing.add(key);
              added++;
            }
            syncAttachmentInput();
            renderAttachments();
            if (state) {
              if (added) state.textContent = source + '已添加 ' + added + ' 个附件，共 ' + attachmentFiles.length + ' 个';
              else if (oversized) state.textContent = '单个附件不能超过 20MB';
              else if (skipped) state.textContent = '附件重复或已达到 ' + MAX_ATTACHMENTS + ' 个上限';
            }
            return added;
          }

          function clipboardFiles(event) {
            var data = event && event.clipboardData;
            if (!data) return [];
            var files = data.files ? Array.from(data.files) : [];
            if (files.length) return files;
            var found = [];
            var items = data.items || [];
            for (var i = 0; i < items.length; i++) {
              if (items[i].kind === 'file') {
                var file = items[i].getAsFile();
                if (file) found.push(file);
              }
            }
            return found;
          }

          if (form) {
            var sendState = document.getElementById('waSendState');
            var sendButton = form.querySelector('button[type="submit"], button:not([type])');
            var setSending = function (on) {
              form.dataset.sending = on ? '1' : '';
              if (!sendButton || !sendButton.isConnected) return;
              sendButton.disabled = !!on;
              if (on) {
                sendButton.dataset.originalHtml = sendButton.innerHTML;
                sendButton.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>发送中';
              } else if (sendButton.dataset.originalHtml) {
                sendButton.innerHTML = sendButton.dataset.originalHtml;
                delete sendButton.dataset.originalHtml;
              }
            };
            var postMessage = function (payload, url) {
              return fetch(url || form.action, {
                method: 'POST',
                body: payload,
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
              }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (d) {
                  if (!res.ok || !d.ok) throw new Error(d.error || '发送失败');
                  return d;
                });
              });
            };
            form.addEventListener('submit', function (e) {
              e.preventDefault();
              if (form.dataset.sending === '1') return;
              var files = attachmentFiles.slice();
              var text = ta ? ta.value.trim() : '';
              var quoteEl = document.getElementById('waQuoteId');
              var quoteId = quoteEl ? quoteEl.value : '';
              if (!text && !files.length) {
                if (sendState) sendState.textContent = '请输入消息或选择附件';
                if (ta) ta.focus();
                return;
              }
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              setSending(true);
              if (sendState) sendState.textContent = files.length > 1 ? '准备发送 ' + files.length + ' 个附件…' : '正在发送…';
              var sentCount = 0;
              var remainingFiles = files.slice();
              var firstItemSent = !text && !quoteId;
              var chain = Promise.resolve();
              if (!files.length) {
                chain = chain.then(function () {
                  var payload = new FormData();
                  payload.set('chat_id', String(chatId));
                  payload.set('text', text);
                  if (quoteId) payload.set('quote_id', quoteId);
                  return postMessage(payload);
                });
              } else {
                chain = chain.then(function () {
                  if (sendState) sendState.textContent = '正在优化图片并准备附件…';
                  return prepareAttachmentsForSend(files, function (done, total) {
                    if (sendState) sendState.textContent = '正在准备附件 ' + done + ' / ' + total + '…';
                  });
                }).then(function (preparedFiles) {
                  var units = preparedFiles.map(function (file, index) {
                    return { file: file, index: index };
                  });
                  var batches = makeAttachmentBatches(units);
                  var sentIndexes = new Set();
                  var batchChain = Promise.resolve();
                  batches.forEach(function (batch, batchIndex) {
                    batchChain = batchChain.then(function () {
                      var payload = new FormData();
                      payload.set('chat_id', String(chatId));
                      if (batchIndex === 0) {
                        if (text) payload.set('text', text);
                        if (quoteId) payload.set('quote_id', quoteId);
                      }
                      batch.forEach(function (unit) {
                        payload.append('attachment', unit.file, unit.file.name || 'attachment');
                      });
                      if (sendState) sendState.textContent = '正在发送附件 ' + (sentCount + 1) + ' / ' + files.length + '…';
                      return postMessage(payload, '/whatsapp/send-batch').then(function (data) {
                        var results = Array.isArray(data.results) ? data.results : [];
                        results.forEach(function (result, resultIndex) {
                          var unit = batch[resultIndex];
                          if (!unit) return;
                          if (result && result.ok) {
                            sentIndexes.add(unit.index);
                            if (unit.index === 0) firstItemSent = true;
                          }
                        });
                        sentCount = sentIndexes.size;
                        remainingFiles = files.filter(function (_file, index) { return !sentIndexes.has(index); });
                        if (sendState) sendState.textContent = '已发送 ' + sentCount + ' / ' + files.length + ' 个附件…';
                      });
                    });
                  });
                  return batchChain;
                });
              }
              chain.then(function () {
                if (remainingFiles.length) {
                  attachmentFiles = remainingFiles.slice();
                  syncAttachmentInput();
                  renderAttachments();
                  if (firstItemSent) {
                    if (ta) ta.value = '';
                    autoGrowWaText();
                    try { sessionStorage.removeItem('waDraft:' + chatId); } catch (err) {}
                    clearQuote();
                  }
                  if (sendState) sendState.textContent = '成功发送 ' + sentCount + ' 个，剩余 ' + remainingFiles.length + ' 个附件，请重试';
                  setSending(false);
                  return;
                }
                if (!files.length) {
                  try { sessionStorage.removeItem('waDraft:' + chatId); } catch (err) {}
                  if (ta) ta.value = '';
                  autoGrowWaText();
                  clearQuote();
                } else {
                  clearAttachment();
                }
                if (sendState) sendState.textContent = '已发送，正在更新会话…';
                // 保留当前筛选条件（例如“未读”）和搜索词，回复后不要跳回“全部”。
                return loadChat(window.location.href, { push: false, saveDraft: false }).catch(function () {
                  if (sendState) sendState.textContent = '消息已发送，但会话刷新失败，请稍后刷新页面';
                });
              }).then(function () {
                setSending(false);
              }).catch(function (err) {
                attachmentFiles = remainingFiles.slice();
                syncAttachmentInput();
                renderAttachments();
                if (sentCount > 0) {
                  if (sendState) sendState.textContent = '已发送 ' + sentCount + ' 个，剩余 ' + remainingFiles.length + ' 个附件；' + (err.message || '请重试');
                } else if (sendState) {
                  sendState.textContent = err.message || '发送失败，请重试';
                }
                setSending(false);
              });
            });
          }
          var qr = document.getElementById('waQuickReply');
          if (qr && ta) qr.addEventListener('change', function () {
            if (qr.value) { ta.value = qr.value; ta.focus(); autoGrowWaText(); }
          });
          var ai = document.getElementById('waAiDraft');
          var aiState = document.getElementById('waAiState');
          if (ai && ta) ai.addEventListener('click', function () {
            ai.disabled = true;
            if (aiState) aiState.textContent = '正在读取对话并起草…';
            fetch('/api/wa/draft?chat_id=' + chatId, { headers: { 'Accept': 'application/json' } })
              .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'AI 起草失败'); return d; }); })
              .then(function (d) { ta.value = d.text || ''; ta.focus(); autoGrowWaText(); if (aiState) aiState.textContent = '草稿已填入，请核对后发送'; })
              .catch(function (e) { if (aiState) aiState.textContent = e.message || 'AI 起草失败'; })
              .finally(function () { ai.disabled = false; });
          });
          var transLang = document.getElementById('waTranslateLang');
          var transBtn = document.getElementById('waAiTranslate');
          // 翻译状态同时写到输入区状态行（2026-11-23）：翻译按钮已搬到附件边上，
          // 右侧 AI 面板不一定停在“智能回复”页签，状态只写 waAiState 用户可能看不到。
          var setTranslateState = function (msg) {
            if (aiState) aiState.textContent = msg;
            if (sendState) sendState.textContent = msg;
          };
          if (transBtn && transLang && ta) transBtn.addEventListener('click', function () {
            var text = ta.value.trim();
            if (!text) {
              setTranslateState('请先在输入框填写要翻译的内容');
              ta.focus();
              return;
            }
            transBtn.disabled = true;
            transBtn.dataset.originalHtml = transBtn.innerHTML;
            transBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>翻译中';
            setTranslateState('正在翻译…');
            fetch('/api/wa/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ text: text, target: transLang.value })
            }).then(function (r) {
              return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok || !d.ok) throw new Error(d.error || '翻译失败');
                return d;
              });
            }).then(function (d) {
              ta.value = d.text || '';
              ta.focus();
              autoGrowWaText();
              try { sessionStorage.setItem('waDraft:' + chatId, ta.value); } catch (e) {}
              setTranslateState('翻译完成，请核对后发送');
            }).catch(function (e) {
              setTranslateState(e.message || '翻译失败，请重试');
            }).finally(function () {
              transBtn.disabled = false;
              if (transBtn.dataset.originalHtml) {
                transBtn.innerHTML = transBtn.dataset.originalHtml;
                delete transBtn.dataset.originalHtml;
              }
            });
          });
          // 输入区附件边的翻译/快捷短语展开收起（2026-11-23）：两个面板互斥，点已展开的再收起；
          // 展开状态记在 openComposePanel，轮询重渲染后由 initConversation 末尾恢复。
          var composeTranslateBtn = document.getElementById('waComposeTranslateBtn');
          var composeTranslatePanel = document.getElementById('waComposeTranslatePanel');
          var composePhrasesBtn = document.getElementById('waComposePhrasesBtn');
          var composePhrasesPanel = document.getElementById('waComposePhrasesPanel');
          var toggleComposePanel = function (which, skipFocus) {
            var pairs = [
              { btn: composeTranslateBtn, panel: composeTranslatePanel, name: 'translate' },
              { btn: composePhrasesBtn, panel: composePhrasesPanel, name: 'phrases' }
            ];
            var opened = '';
            pairs.forEach(function (pair) {
              if (!pair.btn || !pair.panel) return;
              var open = pair.name === which && pair.panel.classList.contains('d-none');
              if (open) opened = pair.name;
              pair.panel.classList.toggle('d-none', !open);
              pair.btn.classList.toggle('active', open);
              pair.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
            openComposePanel = opened;
            if (!skipFocus) {
              if (opened === 'translate' && transLang) transLang.focus();
              if (opened === 'phrases' && qr) qr.focus();
            }
          };
          if (composeTranslateBtn) composeTranslateBtn.addEventListener('click', function () { toggleComposePanel('translate'); });
          if (composePhrasesBtn) composePhrasesBtn.addEventListener('click', function () { toggleComposePanel('phrases'); });
          var attach = document.getElementById('waAttachment');
          if (attach) {
            attach.addEventListener('change', function () {
              if (form && form.dataset.sending === '1') return;
              addAttachments(Array.from(attach.files || []), '已选择');
            });
          }
          var attachmentItems = document.getElementById('waAttachmentItems');
          if (attachmentItems) attachmentItems.addEventListener('click', function (e) {
            if (form && form.dataset.sending === '1') return;
            var button = e.target && e.target.closest ? e.target.closest('[data-attachment-remove]') : null;
            if (!button) return;
            var index = Number(button.dataset.attachmentRemove);
            if (!Number.isInteger(index) || index < 0 || index >= attachmentFiles.length) return;
            attachmentFiles.splice(index, 1);
            syncAttachmentInput();
            renderAttachments();
            var state = document.getElementById('waSendState');
            if (state) state.textContent = attachmentFiles.length ? '已移除 1 个附件，还剩 ' + attachmentFiles.length + ' 个' : '附件已全部移除';
          });
          var attachmentClear = document.getElementById('waAttachmentClear');
          if (attachmentClear) attachmentClear.addEventListener('click', function () {
            if (form && form.dataset.sending === '1') return;
            clearAttachment();
            var state = document.getElementById('waSendState');
            if (state) state.textContent = '附件已移除';
          });
          if (ta) ta.addEventListener('paste', function (e) {
            if (form && form.dataset.sending === '1') return;
            var files = clipboardFiles(e);
            if (!files.length) return;
            e.preventDefault();
            addAttachments(files, '已粘贴');
          });
          var saveReply = document.getElementById('waSaveReply');
          var quickContent = document.getElementById('waQuickContent');
          if (saveReply && quickContent && ta) saveReply.addEventListener('submit', function (e) {
            if (!ta.value.trim()) { e.preventDefault(); alert('请先在输入框写好要保存的回复内容'); return; }
            quickContent.value = ta.value.trim();
          });
          var search = document.getElementById('waCustomerSearch');
          var customerId = document.getElementById('waCustomerId');
          if (search && customerId) {
            var syncCustomer = function () {
              var m = search.value.match(/^#(\d+)/);
              customerId.value = m ? m[1] : '';
            };
            search.addEventListener('input', syncCustomer);
            syncCustomer();
          }
          try {
            var draft = sessionStorage.getItem('waDraft:' + chatId);
            if (draft && ta && !ta.value) { ta.value = draft; autoGrowWaText(); }
          } catch (e) {}
          if (chatId) {
            pollNow = function () {
              if (document.hidden || loading) return;
              var inboxAfter = Number(inbox.dataset.inboxLastId || 0);
              var panel = document.getElementById('waChatPanel');
              var mediaSaved = panel ? Number(panel.dataset.mediaSaved || 0) : 0;
              var receiptState = panel ? Number(panel.dataset.receiptState || 0) : 0;
              var url = '/api/wa/poll?chat_id=' + chatId + '&after=' + lastId + '&inbox_after=' + inboxAfter + '&media_saved=' + mediaSaved + '&receipt_state=' + receiptState;
              fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' })
                .then(function (r) {
                  if (!r.ok) throw new Error('轮询失败');
                  return r.json();
                })
                .then(function (d) {
                  maybeNotifyIncoming(d);
                  if (d && (d.inbox_changed || d.changed || d.media_changed || d.receipt_changed)) refreshInboxFromPoll();
                })
                .catch(function () {});
            };
            pollTimer = setInterval(pollNow, 3000);
            setTimeout(pollNow, 800);
          } else {
            pollNow = function () {
              if (document.hidden || loading) return;
              var inboxAfter = Number(inbox.dataset.inboxLastId || 0);
              fetch('/api/wa/poll?inbox_after=' + inboxAfter, { headers: { 'Accept': 'application/json' }, cache: 'no-store' })
                .then(function (r) {
                  if (!r.ok) throw new Error('轮询失败');
                  return r.json();
                })
                .then(function (d) {
                  maybeNotifyIncoming(d);
                  if (d && d.inbox_changed) refreshInboxFromPoll();
                })
                .catch(function () {});
            };
            pollTimer = setInterval(pollNow, 3000);
          }
          // 轮询刷新会重渲染整个收件箱，恢复之前展开的翻译/快捷短语面板（2026-11-23），恢复时不抢焦点。
          if (openComposePanel) toggleComposePanel(openComposePanel, true);
        }

        function setLoading(on) {
          loading = on;
          inbox.classList.toggle('wa-inbox-loading', on);
          inbox.setAttribute('aria-busy', on ? 'true' : 'false');
        }

        function keepActiveChatVisible(list) {
          if (!list) return;
          var active = list.querySelector('.wa-chat-row.active');
          if (!active) return;
          var listRect = list.getBoundingClientRect();
          var activeRect = active.getBoundingClientRect();
          if (activeRect.top < listRect.top) {
            list.scrollTop -= listRect.top - activeRect.top;
          } else if (activeRect.bottom > listRect.bottom) {
            list.scrollTop += activeRect.bottom - listRect.bottom;
          }
        }

        function captureChatScroll(current) {
          var list = current.querySelector('.wa-chat-list');
          var messages = current.querySelector('#waMsgs');
          var panel = current.querySelector('#waChatPanel');
          var activeMainTab = current.querySelector('[data-wa-main-tab].active');
          var activeAiTab = current.querySelector('[data-wa-ai-tab].active');
          return {
            windowX: window.scrollX || window.pageXOffset || 0,
            windowY: window.scrollY || window.pageYOffset || 0,
            listTop: list ? list.scrollTop : 0,
            messagesTop: messages ? messages.scrollTop : 0,
            messagesAtBottom: messages ? (messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 24) : true,
            chatId: panel ? String(panel.dataset.chatId || '') : '',
            mainTab: activeMainTab ? activeMainTab.dataset.waMainTab : '',
            aiTab: activeAiTab ? activeAiTab.dataset.waAiTab : ''
          };
        }

        function activateWorkbenchTab(root, kind, value) {
          if (!root || !value) return;
          var buttonAttr = kind === 'main' ? 'data-wa-main-tab' : 'data-wa-ai-tab';
          var panelAttr = kind === 'main' ? 'data-wa-main-panel' : 'data-wa-ai-panel';
          // 兜底（2026-11-23）：翻译/快捷短语已搬出 AI 面板，轮询恢复时若记住的还是旧标签，
          // 没有按钮能对上就回落到第一个标签，避免全部标签失活、面板全藏。
          var knownValues = Array.prototype.map.call(root.querySelectorAll('[' + buttonAttr + ']'), function (button) { return button.getAttribute(buttonAttr); });
          if (knownValues.indexOf(value) === -1) value = knownValues[0] || '';
          if (!value) return;
          root.querySelectorAll('[' + buttonAttr + ']').forEach(function (button) {
            var selected = button.getAttribute(buttonAttr) === value;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
          });
          root.querySelectorAll('[' + panelAttr + ']').forEach(function (panel) {
            var selected = panel.getAttribute(panelAttr) === value;
            panel.classList.toggle('active', selected);
            panel.hidden = !selected;
          });
        }

        function restoreChatScroll(state, next, preserveMessages, keepActive) {
          var apply = function () {
            var list = next.querySelector('.wa-chat-list');
            if (list) {
              list.scrollTop = state.listTop;
              if (keepActive) keepActiveChatVisible(list);
            }
            if (preserveMessages && !state.messagesAtBottom) {
              var messages = next.querySelector('#waMsgs');
              if (messages) messages.scrollTop = state.messagesTop;
            }
            activateWorkbenchTab(next, 'main', state.mainTab);
            activateWorkbenchTab(next, 'ai', state.aiTab);
            try {
              window.scrollTo({ left: state.windowX, top: state.windowY, behavior: 'auto' });
            } catch (e) {
              window.scrollTo(state.windowX, state.windowY);
            }
          };
          apply();
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(apply);
        }

        function composerOrFormBusy() {
          var active = document.activeElement;
          if (active && inbox.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
          var fileInput = document.getElementById('waAttachment');
          if (fileInput && fileInput.files && fileInput.files.length) return true;
          var preview = document.getElementById('waAttachmentPreview');
          return !!(preview && !preview.classList.contains('d-none'));
        }

        function refreshInboxFromPoll() {
          if (composerOrFormBusy()) {
            deferredPollRefresh = true;
            return;
          }
          deferredPollRefresh = false;
          loadChat(window.location.href, { push: false, silent: true });
        }

        function loadChat(url, options) {
          options = options || {};
          if (options.saveDraft !== false) saveDraft();
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          var seq = ++requestSeq;
          if (!options.silent) setLoading(true);
          return fetch(url, {
            headers: { 'Accept': 'text/html', 'X-Requested-With': 'XMLHttpRequest' },
            cache: 'no-store'
          }).then(function (res) {
            if (res.redirected) { window.location.href = res.url; throw new Error('登录状态已失效'); }
            if (!res.ok) throw new Error('会话加载失败：HTTP ' + res.status);
            return res.text();
          }).then(function (html) {
            if (seq !== requestSeq) return;
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var next = doc.getElementById('waInbox');
            if (!next) throw new Error('会话内容解析失败');
            var current = document.getElementById('waInbox');
            if (!current) throw new Error('收件箱容器不存在');
            var scrollState = captureChatScroll(current);
            var nextPanel = next.querySelector('#waChatPanel');
            var preserveMessages = !!scrollState.chatId && !!nextPanel && String(nextPanel.dataset.chatId || '') === scrollState.chatId;
            current.replaceWith(next);
            inbox = next;
            if (options.push !== false) {
              try { history.pushState({ waChat: true }, '', url); } catch (e) {}
            }
            if (doc.title) document.title = doc.title;
            if (!options.silent) setLoading(false);
            initConversation();
            restoreChatScroll(scrollState, next, preserveMessages, options.silent !== true);
            document.dispatchEvent(new CustomEvent('wa:chat-loaded'));
          }).catch(function (e) {
            if (seq !== requestSeq) return;
            if (!options.silent) console.warn(e.message || e);
            if (!options.silent) setLoading(false);
            initConversation();
          });
        }

        var swipeState = null;
        var swipeSuppressClickUntil = 0;
        var SWIPE_DELETE_WIDTH = 78;

        function closeWaSwipe(except) {
          var root = document.getElementById('waInbox');
          if (!root) return;
          var opened = root.querySelectorAll('.wa-chat-swipe.swipe-open');
          for (var i = 0; i < opened.length; i++) {
            if (opened[i] !== except) opened[i].classList.remove('swipe-open');
          }
        }

        function setWaSwipeOffset(wrapper, offset) {
          var content = wrapper ? wrapper.querySelector('.wa-chat-item') : null;
          if (content) content.style.transform = offset ? 'translateX(' + offset + 'px)' : '';
        }

        document.addEventListener('pointerdown', function (e) {
          if (e.pointerType === 'touch') return;
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          var wrapper = e.target.closest ? e.target.closest('.wa-chat-swipe') : null;
          var root = document.getElementById('waInbox');
          if (!wrapper || !root || !root.contains(wrapper)) return;
          if (e.target.closest('.wa-swipe-delete, .wa-pin-form')) return;
          closeWaSwipe(wrapper);
          var content = wrapper.querySelector('.wa-chat-item');
          swipeState = {
            wrapper: wrapper,
            content: content,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startOffset: wrapper.classList.contains('swipe-open') ? -SWIPE_DELETE_WIDTH : 0,
            moved: false,
            touch: false
          };
          wrapper.classList.add('is-swiping');
        }, { passive: true });

        document.addEventListener('pointermove', function (e) {
          var state = swipeState;
          if (!state || state.touch || e.pointerId !== state.pointerId) return;
          var dx = e.clientX - state.startX;
          var dy = e.clientY - state.startY;
          if (!state.moved) {
            if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
            if (Math.abs(dy) > Math.abs(dx) * 1.15) {
              state.wrapper.classList.remove('is-swiping');
              setWaSwipeOffset(state.wrapper, state.startOffset);
              swipeState = null;
              return;
            }
            state.moved = true;
          }
          var offset = Math.max(-96, Math.min(0, state.startOffset + dx));
          setWaSwipeOffset(state.wrapper, offset);
          if (Math.abs(dx) > 8) e.preventDefault();
        }, { passive: false });

        function endWaSwipe(e) {
          var state = swipeState;
          if (!state || state.touch || (e && e.pointerId !== state.pointerId)) return;
          var dx = e ? e.clientX - state.startX : 0;
          if (state.moved) {
            var offset = Math.max(-96, Math.min(0, state.startOffset + dx));
            var open = offset <= -36;
            setWaSwipeOffset(state.wrapper, 0);
            state.wrapper.classList.toggle('swipe-open', open);
            swipeSuppressClickUntil = Date.now() + 380;
          }
          state.wrapper.classList.remove('is-swiping');
          swipeState = null;
        }

        document.addEventListener('pointerup', endWaSwipe);
        document.addEventListener('pointercancel', function (e) {
          var state = swipeState;
          if (!state || state.touch || (e && e.pointerId !== state.pointerId)) return;
          setWaSwipeOffset(state.wrapper, 0);
          state.wrapper.classList.remove('is-swiping', 'swipe-open');
          swipeState = null;
        });

        document.addEventListener('touchstart', function (e) {
          if (!e.touches || e.touches.length !== 1) return;
          var touch = e.touches[0];
          var wrapper = e.target.closest ? e.target.closest('.wa-chat-swipe') : null;
          var root = document.getElementById('waInbox');
          if (!wrapper || !root || !root.contains(wrapper)) return;
          if (e.target.closest('.wa-swipe-delete, .wa-pin-form')) return;
          closeWaSwipe(wrapper);
          swipeState = {
            wrapper: wrapper,
            content: wrapper.querySelector('.wa-chat-item'),
            pointerId: null,
            startX: touch.clientX,
            startY: touch.clientY,
            startOffset: wrapper.classList.contains('swipe-open') ? -SWIPE_DELETE_WIDTH : 0,
            moved: false,
            touch: true
          };
          wrapper.classList.add('is-swiping');
        }, { passive: true });

        document.addEventListener('touchmove', function (e) {
          var state = swipeState;
          if (!state || !state.touch || !e.touches || e.touches.length !== 1) return;
          var touch = e.touches[0];
          var dx = touch.clientX - state.startX;
          var dy = touch.clientY - state.startY;
          if (!state.moved) {
            if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
            if (Math.abs(dy) > Math.abs(dx) * 1.15) {
              state.wrapper.classList.remove('is-swiping');
              setWaSwipeOffset(state.wrapper, state.startOffset);
              swipeState = null;
              return;
            }
            state.moved = true;
          }
          if (e.cancelable) e.preventDefault();
          var offset = Math.max(-96, Math.min(0, state.startOffset + dx));
          setWaSwipeOffset(state.wrapper, offset);
        }, { passive: false });

        document.addEventListener('touchend', function (e) {
          var state = swipeState;
          if (!state || !state.touch) return;
          var touch = e.changedTouches && e.changedTouches[0];
          var dx = touch ? touch.clientX - state.startX : 0;
          if (state.moved) {
            var offset = Math.max(-96, Math.min(0, state.startOffset + dx));
            var open = offset <= -36;
            setWaSwipeOffset(state.wrapper, 0);
            state.wrapper.classList.toggle('swipe-open', open);
            swipeSuppressClickUntil = Date.now() + 380;
          }
          state.wrapper.classList.remove('is-swiping');
          swipeState = null;
        }, { passive: true });

        document.addEventListener('touchcancel', function () {
          var state = swipeState;
          if (!state || !state.touch) return;
          setWaSwipeOffset(state.wrapper, 0);
          state.wrapper.classList.remove('is-swiping', 'swipe-open');
          swipeState = null;
        }, { passive: true });

        document.addEventListener('click', function (e) {
          var deleteButton = e.target.closest ? e.target.closest('.wa-swipe-delete-btn') : null;
          if (Date.now() < swipeSuppressClickUntil && !deleteButton) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          var wrapper = e.target.closest ? e.target.closest('.wa-chat-swipe') : null;
          if (wrapper && wrapper.classList.contains('swipe-open') && !deleteButton) {
            e.preventDefault();
            e.stopPropagation();
            wrapper.classList.remove('swipe-open');
            return;
          }
          closeWaSwipe(wrapper);
        }, true);

        document.addEventListener('submit', function (e) {
          var deleteForm = e.target && e.target.closest ? e.target.closest('form.wa-swipe-delete') : null;
          if (deleteForm && inbox.contains(deleteForm)) {
            var name = String(deleteForm.dataset.chatName || '该');
            if (!window.confirm('确认从 CRM 收件箱删除与「' + name + '」的会话？\\n\\n手机 WhatsApp、客户档案、跟进记录和单据不会被删除。')) {
              e.preventDefault();
              closeWaSwipe();
              return;
            }
            var deleteButton = deleteForm.querySelector('button[type="submit"]');
            if (deleteButton) deleteButton.disabled = true;
            return;
          }
          var form = e.target && e.target.closest ? e.target.closest('form.wa-translate-form') : null;
          if (!form || !inbox.contains(form)) return;
          e.preventDefault();
          var button = form.querySelector('button');
          var chatId = Number(form.dataset.chatId || 0);
          if (button) { button.disabled = true; button.textContent = '翻译中…'; }
          fetch(form.action, {
            method: 'POST',
            body: new FormData(form),
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
          }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
              if (!r.ok || !d.ok) throw new Error(d.error || '翻译失败');
              return d;
            });
          }).then(function () {
            return loadChat('/whatsapp/session?chat=' + chatId, { push: false });
          }).catch(function (err) {
            if (button && button.isConnected) { button.disabled = false; button.textContent = '翻译'; }
            console.warn(err.message || err);
          });
        });

        document.addEventListener('click', function (e) {
          var mainTab = e.target.closest ? e.target.closest('[data-wa-main-tab]') : null;
          if (mainTab && inbox.contains(mainTab)) {
            activateWorkbenchTab(inbox, 'main', mainTab.dataset.waMainTab);
            return;
          }
          var aiTab = e.target.closest ? e.target.closest('[data-wa-ai-tab]') : null;
          if (aiTab && inbox.contains(aiTab)) {
            activateWorkbenchTab(inbox, 'ai', aiTab.dataset.waAiTab);
            return;
          }
          var adCopy = e.target.closest ? e.target.closest('.wa-ad-copy-id') : null;
          if (adCopy && inbox.contains(adCopy)) {
            e.preventDefault();
            var adCopyText = String(adCopy.getAttribute('data-copy') || '');
            var done = function () { var old = adCopy.innerHTML; adCopy.innerHTML = '<i class="bi bi-check2"></i> 已复制'; setTimeout(function () { adCopy.innerHTML = old; }, 1200); };
            if (navigator.clipboard && adCopyText) navigator.clipboard.writeText(adCopyText).then(done).catch(function () { window.prompt('复制广告 ID', adCopyText); });
            else if (adCopyText) window.prompt('复制广告 ID', adCopyText);
            return;
          }
          var quoteJump = e.target.closest ? e.target.closest('.wa-quote-jump') : null;
          if (quoteJump && inbox.contains(quoteJump)) {
            e.preventDefault();
            jumpToQuotedMessage(quoteJump);
            return;
          }
          var quoteButton = e.target.closest ? e.target.closest('.wa-quote-btn') : null;
          if (quoteButton && inbox.contains(quoteButton)) {
            e.preventDefault();
            applyQuote(quoteButton);
            return;
          }
          var quoteCancel = e.target.closest ? e.target.closest('#waQuoteCancel') : null;
          if (quoteCancel && inbox.contains(quoteCancel)) {
            e.preventDefault();
            clearQuote();
            var quoteTextarea = document.getElementById('waText');
            if (quoteTextarea) quoteTextarea.focus();
            return;
          }
          var link = e.target.closest ? e.target.closest('a.wa-chat-row') : null;
          if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          loadChat(link.href, { push: true });
        });
        window.addEventListener('popstate', function () {
          loadChat(window.location.href, { push: false });
        });
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden && pollNow) pollNow();
        });
        document.addEventListener('focusout', function () {
          if (!deferredPollRefresh || !pollNow) return;
          window.setTimeout(function () {
            if (deferredPollRefresh && pollNow) pollNow();
          }, 250);
        });
        initConversation();
        // 首次打开会话时把页面滚到底（2026-11-22）：消息区在页签/客户头/广告条下面，
        // 不滚的话首屏只能看到一两行。滚到底后最新消息和完整输入框一次可见，
        // 页签和客户头是 sticky 的，不会滚丢。只往下滚、不往上滚；
        // 轮询刷新走 loadChat + restoreChatScroll，不经过这里，不会反复跳动。
        try {
          var _doc = document.documentElement;
          var _max = Math.max(_doc.scrollHeight, document.body ? document.body.scrollHeight : 0) - (window.innerHeight || 0);
          if (_max > (window.scrollY || 0) + 40) window.scrollTo(0, _max);
        } catch (e) {}
      })();
    </script>`;
  return page({ title: 'WhatsApp 会话', active: 'wa', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { sessionPage, accountCard, autoReplyBar, waSettingsCards, classifyWaChat, categoryOf, compareInboxChats, WA_CATEGORY };
