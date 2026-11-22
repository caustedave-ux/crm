'use strict';
// ============ 客户分层工作台：A/B/C/D、周期动作与 C 类群发 ============
const { esc } = require('../util');
const { page } = require('./layout');
const { card, pageHead, badge, emptyRow } = require('./ui');
const { all } = require('../db');
const customerTiers = require('../customerTiers');

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function customerTiersPage(ctx) {
  let classified = [];
  let calcError = '';
  let actionRun = { created: 0, cancelled: 0 };
  try {
    customerTiers.refreshTiers(ctx.user.id);
    actionRun = customerTiers.ensureTierActions(ctx.user.id);
    classified = customerTiers.calculateForUser(ctx.user.id, new Date());
  } catch (e) { calcError = e.message; }

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of classified) if (counts[row.tier] !== undefined) counts[row.tier]++;
  const q = String(ctx.query.search || '').trim();
  const tier = ['A', 'B', 'C', 'D'].includes(String(ctx.query.tier || '').toUpperCase())
    ? String(ctx.query.tier).toUpperCase() : '';
  const pageNo = Math.max(1, parseInt(ctx.query.page, 10) || 1);
  const pageSize = 20;
  const keyword = q.toLowerCase();
  const tierRank = { A: 0, B: 1, C: 2, D: 3 };
  const filtered = classified.filter(({ customer: c, tier: currentTier }) => {
    if (tier && currentTier !== tier) return false;
    if (!keyword) return true;
    return [c.company_name, c.name_en, c.country, c.contact_person, c.phone, c.email, c.industry]
      .some(v => String(v || '').toLowerCase().includes(keyword));
  }).sort((a, b) => {
    const byTier = (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9);
    return byTier || (Number(b.score) || 0) - (Number(a.score) || 0);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(pageNo, pageCount);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const campaignHistory = all('SELECT * FROM tier_campaigns WHERE user_id=? ORDER BY id DESC LIMIT 5', ctx.user.id);
  const actionMap = {};
  try {
    for (const row of all(`SELECT ta.*, a.next_follow_date, a.archived FROM tier_actions ta
        LEFT JOIN activities a ON a.id=ta.activity_id WHERE ta.user_id=? ORDER BY ta.id DESC`, ctx.user.id)) {
      if (!actionMap[row.customer_id]) actionMap[row.customer_id] = row;
    }
  } catch (e) {}

  const tierMeta = customerTiers.TIER_META;
  const chip = (value, label, count) => {
    const on = tier === value;
    const href = '/customer-tiers?tier=' + encodeURIComponent(value) + (q ? '&search=' + encodeURIComponent(q) : '');
    return `<a class="btn btn-sm ${on ? 'btn-dark' : 'btn-outline-secondary'}" href="${href}">${label} <span class="badge text-bg-light border ms-1">${count}</span></a>`;
  };
  const pageHref = (n) => '/customer-tiers?' + [
    'tier=' + encodeURIComponent(tier),
    q ? 'search=' + encodeURIComponent(q) : '',
    'page=' + n,
  ].filter(Boolean).join('&');

  const rowsHtml = pageRows.map(({ customer: c, metrics, score, tier: currentTier, source, reason }) => {
    const actionStatus = actionMap[c.id] && actionMap[c.id].status;
    const actionLabel = currentTier === 'A'
      ? (actionStatus === 'pending' ? '本周待沟通' : '每周固定沟通')
      : currentTier === 'B'
        ? (actionStatus === 'pending' ? '本月待发简报' : '每月定制简报')
        : currentTier === 'C' ? '进入群发名单' : '停止主动联系';
    const scoreNum = Math.max(0, Math.min(100, Number(score) || 0));
    const overrideOptions = [
      { v: '', l: '自动' }, { v: 'A', l: 'A类' }, { v: 'B', l: 'B类' }, { v: 'C', l: 'C类' }, { v: 'D', l: 'D类' },
    ].map(opt => `<option value="${opt.v}" ${String(c.tier_override || '') === opt.v ? 'selected' : ''}>${opt.l}</option>`).join('');
    return `<tr>
      <td>${tier === 'C' ? `<input type="checkbox" class="tier-campaign-check me-2" value="${c.id}" aria-label="选择 ${esc(c.company_name)}">` : ''}
        <a class="fw-semibold text-decoration-none" href="/customers/${c.id}">${esc(c.company_name)}</a>
        ${c.do_not_contact ? '<span class="badge text-bg-dark ms-1">禁联</span>' : ''}
        <div class="small text-muted">${esc(c.name_en || '')}${c.name_en ? ' · ' : ''}${esc(c.country || '未填国家')}</div></td>
      <td>${badge(currentTier)}<div class="small text-muted mt-1">${source === 'manual' ? '人工覆盖' : '自动计算'}</div></td>
      <td style="min-width:150px"><div class="d-flex justify-content-between small"><span class="fw-semibold">${scoreNum.toFixed(1)}</span><span class="text-muted">/ 100</span></div><div class="progress mt-1" style="height:6px"><div class="progress-bar ${currentTier === 'A' ? 'bg-danger' : currentTier === 'B' ? 'bg-warning' : currentTier === 'C' ? 'bg-info' : 'bg-dark'}" style="width:${scoreNum}%"></div></div></td>
      <td class="text-end text-nowrap"><div class="fw-semibold">¥${fmtMoney(metrics.paidCny)}</div><div class="small text-muted">${metrics.paidOrders} 笔订单</div></td>
      <td class="small">${metrics.lastTouch ? esc(String(metrics.lastTouch).slice(0, 16)) + `<div class="text-muted">${metrics.lastTouchDays} 天前</div>` : '<span class="text-muted">无记录</span>'}</td>
      <td><span class="badge text-bg-light border">${actionLabel}</span></td>
      <td style="min-width:180px"><div class="small text-muted">${esc(reason)}</div></td>
      <td class="text-end" style="min-width:245px">
        <form method="post" action="/customer-tiers/${c.id}/override" class="d-flex justify-content-end align-items-center gap-1 flex-wrap">
          <select class="form-select form-select-sm" name="tier_override" style="width:78px">${overrideOptions}</select>
          <label class="form-check mb-0 small" title="禁止主动联系"><input class="form-check-input" type="checkbox" name="do_not_contact" value="1" ${Number(c.do_not_contact) === 1 ? 'checked' : ''}><span class="form-check-label">禁联</span></label>
          <button class="btn btn-sm btn-outline-primary">保存</button>
        </form>
      </td>
    </tr>`;
  }).join('') || emptyRow(8, calcError || '当前筛选下没有客户');
  const campaignCard = tier === 'C' ? card({
    title: `C类系统群发 <span class="badge text-bg-info ms-1">当前页 ${pageRows.length} 家</span>`,
    body: `<form method="post" action="/customer-tiers/campaign" id="tierCampaignForm">
      <input type="hidden" name="ids" id="tierCampaignIds">
      <div class="mb-2"><textarea class="form-control" name="message" rows="5" maxlength="4096" placeholder="示例：Hi {{name}}, this is ... We have updated our catalog for {{country}}. Please let me know if you would like the latest price list."></textarea></div>
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div class="small text-muted">支持 {{name}} / {{country}} 占位符；只发给当前页勾选的 C 类客户，每批最多 20 家；发送后自动写入对应客户的跟进记录。</div>
        <div class="d-flex align-items-center gap-2"><label class="form-check mb-0"><input type="checkbox" class="form-check-input" id="tierCampaignAll"><span class="form-check-label small">全选本页</span></label><span class="small text-muted" id="tierCampaignCount">已选 0 家</span><button class="btn btn-primary btn-sm" id="tierCampaignSend" disabled><i class="bi bi-whatsapp"></i> 发送给所选客户</button></div>
      </div>
    </form>
    <div class="alert alert-warning small mt-3 mb-0"><i class="bi bi-shield-exclamation me-1"></i>系统逐条限速发送，发送期间请保持页面打开。D 类和“禁止主动联系”的客户不会进入群发。</div>`
  }) : '';

  const historyHtml = tier === 'C' && campaignHistory.length ? card({
    title: '最近群发记录',
    body: `<div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead><tr><th>时间</th><th>人数</th><th>成功</th><th>失败</th><th>消息</th></tr></thead><tbody>${campaignHistory.map(x => `<tr><td class="small">${esc(String(x.created_at || '').slice(0, 16))}</td><td>${x.total}</td><td class="text-success">${x.sent}</td><td class="text-danger">${x.failed}</td><td class="small text-truncate" style="max-width:320px">${esc(x.message)}</td></tr>`).join('')}</tbody></table></div>`
  }) : '';

  const content = `
    ${pageHead('客户分层', '按贡献值自动划分 A/B/C/D，并用固定节奏把经营动作落到跟进中心', `<form method="post" action="/customer-tiers/recalculate" class="d-inline"><button class="btn btn-outline-primary"><i class="bi bi-arrow-repeat"></i> 立即重算</button></form> <a class="btn btn-outline-success" href="/briefings"><i class="bi bi-newspaper"></i> 行业简报</a> <a class="btn btn-outline-secondary" href="/customers">客户列表</a>`)}
    ${calcError ? `<div class="alert alert-danger">分层计算失败：${esc(calcError)}</div>` : ''}
    ${actionRun.created || actionRun.cancelled ? `<div class="alert alert-info py-2 small">本次已生成 ${actionRun.created} 条周期跟进，自动关闭 ${actionRun.cancelled} 条因分层变化失效的系统任务。人工创建的记录不会被删除。</div>` : ''}
    <div class="row g-3 mb-4">
      ${['A','B','C','D'].map(t => `<div class="col-6 col-xl-3"><a class="card border-0 shadow-sm h-100 text-decoration-none text-body" href="/customer-tiers?tier=${t}"><div class="card-body"><div class="d-flex justify-content-between"><span class="badge text-bg-${t === 'A' ? 'danger' : t === 'B' ? 'warning' : t === 'C' ? 'info' : 'dark'}">${t}类</span><span class="text-muted small">${tierMeta[t].action}</span></div><div class="display-6 fw-bold mt-2">${counts[t]}</div><div class="text-muted small">${tierMeta[t].note}</div></div></a></div>`).join('')}
    </div>
    <div class="row g-3 mb-4"><div class="col-12">${card({ title: '分层规则', body: `<div class="row g-3 small"><div class="col-lg-8"><div class="fw-semibold mb-1">贡献值口径</div><div class="text-muted">近12个月实际已收款折合人民币为主（未付款 PI 不计入），叠加已回款订单次数、最近回款时间和近90天报价/询盘/有效单据信号。A类门槛：近12个月回款达到 ¥${customerTiers.RULES.aRevenueCny.toLocaleString('zh-CN')}，或有 ${customerTiers.RULES.aPaidOrders} 笔已回款订单，或综合分达到 80；B类为已有回款或有明确近期商业信号；超过 ${customerTiers.RULES.inactiveDays} 天无有效触点且无贡献的客户进入 D 类。</div></div><div class="col-lg-4"><div class="fw-semibold mb-1">执行规则</div><ul class="mb-0 text-muted"><li>A类：每周固定沟通，即使只打招呼。</li><li>B类：每月发送定制化行业简报。</li><li>C类：进入系统群发名单。</li><li>D类：停止主动联系，但保留全部历史订单、聊天和跟进。</li></ul></div></div>` })}</div></div>
    ${campaignCard}
    ${historyHtml}
    <div class="row g-3 mb-4"><div class="col-12">${card({ body: `
      <div class="d-flex gap-1 flex-wrap align-items-center mb-3">
        ${chip('', '全部分层', classified.length)} ${chip('A', 'A类大客户', counts.A)} ${chip('B', 'B类潜力客户', counts.B)} ${chip('C', 'C类普通客户', counts.C)} ${chip('D', 'D类放弃客户', counts.D)}
      </div>
      <form class="row g-2 mb-3" method="get">
        ${tier ? `<input type="hidden" name="tier" value="${esc(tier)}">` : ''}
        <div class="col-md-4"><input class="form-control" name="search" value="${esc(q)}" placeholder="搜索客户 / 国家 / 联系人 / 行业"></div>
        <div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/customer-tiers${tier ? '?tier=' + encodeURIComponent(tier) : ''}">重置</a></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>客户</th><th>分层</th><th>贡献值</th><th class="text-end">近12月回款</th><th>最近触点</th><th>系统动作</th><th>计算依据</th><th class="text-end">人工调整</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mt-3">
        <span class="text-muted small">共 ${filtered.length} 家 · 第 ${safePage} / ${pageCount} 页</span>
        <div class="btn-group"><a class="btn btn-sm btn-outline-secondary ${safePage <= 1 ? 'disabled' : ''}" href="${pageHref(Math.max(1, safePage - 1))}">上一页</a><a class="btn btn-sm btn-outline-secondary ${safePage >= pageCount ? 'disabled' : ''}" href="${pageHref(Math.min(pageCount, safePage + 1))}">下一页</a></div>
      </div>` })}</div>
    <script>
      (function () {
        var checks = Array.prototype.slice.call(document.querySelectorAll('.tier-campaign-check'));
        var all = document.getElementById('tierCampaignAll');
        var form = document.getElementById('tierCampaignForm');
        var ids = document.getElementById('tierCampaignIds');
        var count = document.getElementById('tierCampaignCount');
        var send = document.getElementById('tierCampaignSend');
        function sync() {
          var selected = checks.filter(function (x) { return x.checked; }).map(function (x) { return x.value; }).slice(0, 20);
          if (ids) ids.value = selected.join(',');
          if (count) count.textContent = '已选 ' + selected.length + ' 家';
          if (send) send.disabled = selected.length === 0;
        }
        if (all) all.addEventListener('change', function () { checks.forEach(function (x) { x.checked = all.checked; }); sync(); });
        checks.forEach(function (x) { x.addEventListener('change', sync); });
        if (form) form.addEventListener('submit', function (e) {
          if (!ids.value) { e.preventDefault(); alert('请先勾选 C 类客户'); return; }
          if (!confirm('确认向已选的 ' + ids.value.split(',').length + ' 家 C 类客户发送 WhatsApp？')) { e.preventDefault(); return; }
          if (send) { send.disabled = true; send.textContent = '发送中，请勿关闭页面…'; }
        });
      })();
    </script>`;
  return page({ title: '客户分层', active: 'customer-tiers', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { customerTiersPage };

