'use strict';
// ============ 页面渲染：仪表盘 / 客户 / 跟进 / 产品 ============
const { esc, COUNTRY_CODES, splitPhone } = require('../util');
const { page } = require('./layout');
const { fld, card, pageHead, badge, emptyRow } = require('./ui');
const dbx = require('../db');
const { get, all, run, DOC_TYPES, DOC_STATUS } = dbx;
const waRender = require('../waRender');
const { isHttpUrl } = require('../websiteInquiry');
const customerTiers = require('../customerTiers');
const autoReplyStats = require('../autoReplyStats');

function countMap(sql) {
  const m = {};
  for (const r of all(sql)) m[r.k] = r.c;
  return m;
}

function dashboardPipelineCustomers(userId) {
  return all(`SELECT c.id, c.company_name, c.country, c.status, c.customer_tier, c.updated_at,
      CASE
        WHEN c.status='合作客户'
          OR EXISTS (SELECT 1 FROM quote_history q WHERE q.customer_id=c.id AND q.user_id=c.user_id AND q.status='已成交')
          OR EXISTS (SELECT 1 FROM documents d WHERE d.customer_id=c.id AND d.user_id=c.user_id
            AND d.doc_type IN ('pi','so','ci') AND d.status IN ('已确认','已完成'))
          THEN 'won'
        WHEN EXISTS (SELECT 1 FROM activities a WHERE a.customer_id=c.id AND a.user_id=c.user_id
          AND a.type='样品' AND COALESCE(a.archived,0)=0)
          THEN 'sample'
        WHEN c.status='报价中'
          OR EXISTS (SELECT 1 FROM quote_history q WHERE q.customer_id=c.id AND q.user_id=c.user_id
            AND q.status IN ('已报价','跟进中','报价已接受'))
          OR EXISTS (SELECT 1 FROM documents d WHERE d.customer_id=c.id AND d.user_id=c.user_id
            AND d.doc_type='quotation' AND d.status NOT IN ('草稿','已作废'))
          THEN 'quoted'
        WHEN c.status='意向客户'
          OR EXISTS (SELECT 1 FROM activities a WHERE a.customer_id=c.id AND a.user_id=c.user_id)
          OR EXISTS (SELECT 1 FROM wa_chats wc JOIN wa_accounts wa ON wa.id=wc.account_id
            WHERE wc.customer_id=c.id AND wa.user_id=c.user_id AND COALESCE(wc.last_inbound_at,'')<>'')
          THEN 'contacted'
        ELSE 'inquiry'
      END AS stage
    FROM customers c
    WHERE c.user_id=? AND COALESCE(c.in_pool,0)=0 AND COALESCE(c.status,'')<>'流失客户'
    ORDER BY COALESCE(c.updated_at,c.created_at) DESC,c.id DESC`, userId);
}

// ================= 仪表盘 =================
function dashboardPage(ctx) {
  const totalCustomers = get('SELECT COUNT(*) c FROM customers WHERE user_id=? AND COALESCE(in_pool,0)=0', ctx.user.id).c;
  const monthStart = new Date(); monthStart.setDate(1);
  const ymd = monthStart.getFullYear() + '-' + String(monthStart.getMonth() + 1).padStart(2, '0') + '-01';
  const newCustomersMonth = get('SELECT COUNT(*) c FROM customers WHERE user_id=? AND COALESCE(in_pool,0)=0 AND created_at>=?', ctx.user.id, ymd + ' 00:00:00').c;
  const docMonthByCurrency = all("SELECT COALESCE(NULLIF(currency,''),'未设币种') currency, COUNT(*) count, COALESCE(SUM(total_amount),0) amount FROM documents WHERE user_id=? AND created_at>=? AND COALESCE(status,'') NOT IN ('草稿','已作废') GROUP BY COALESCE(NULLIF(currency,''),'未设币种') ORDER BY currency", ctx.user.id, ymd + ' 00:00:00');
  const docMonth = docMonthByCurrency.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const docMonthAmount = docMonthByCurrency.map(row => esc(row.currency) + ' ' + moneyFmt(row.amount)).join(' · ') || '暂无已发送单据';
  const today = new Date(); const ts = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  let tierRows = [];
  try { customerTiers.ensureTierActions(ctx.user.id); tierRows = customerTiers.calculateForUser(ctx.user.id, today); } catch (e) { tierRows = []; }
  const tierCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of tierRows) if (tierCounts[row.tier] !== undefined) tierCounts[row.tier]++;
  const tmrw = new Date(); tmrw.setDate(tmrw.getDate() + 1);
  const tmStr = tmrw.getFullYear() + '-' + String(tmrw.getMonth() + 1).padStart(2, '0') + '-' + String(tmrw.getDate()).padStart(2, '0');
  const upcoming = all("SELECT a.*, c.company_name FROM activities a JOIN customers c ON c.id=a.customer_id WHERE a.next_follow_date IS NOT NULL AND a.next_follow_date<>'' AND a.next_follow_date<=? AND a.archived=0 AND a.user_id=? ORDER BY CASE a.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, a.next_follow_date ASC, a.id DESC LIMIT 30", tmStr, ctx.user.id);
  const recentDocs = all('SELECT d.*, c.company_name FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.user_id=? ORDER BY d.id DESC LIMIT 8', ctx.user.id);

  // 物流待查询提醒：到点没更新的运单
  let lgsDue = [];
  try {
    lgsDue = all(`SELECT s.*, (SELECT COUNT(*) FROM logistics_items i WHERE i.shipment_id=s.id) AS item_count,
        (SELECT GROUP_CONCAT(DISTINCT c.company_name) FROM logistics_items i JOIN customers c ON c.id=i.customer_id WHERE i.shipment_id=s.id) AS who
      FROM logistics_shipments s
      WHERE s.user_id=? AND s.status NOT IN ('已签收','已取消') AND s.next_check_at IS NOT NULL AND s.next_check_at<>''
        AND substr(s.next_check_at,1,10)<=?
      ORDER BY s.next_check_at ASC LIMIT 8`, ctx.user.id, ts);
  } catch (e) { lgsDue = []; }
  const lgsHtml = lgsDue.length ? lgsDue.map(s => `<div class="d-flex align-items-center gap-2 border-bottom py-2">
      <div class="flex-grow-1" style="min-width:0">
        <div class="fw-semibold"><a href="/logistics/${s.id}" class="text-decoration-none">${esc(s.waybill_no || '（无单号）')}</a>
          <span class="badge text-bg-light border ms-1">${esc(s.direction === 'in' ? '供应商发货' : '客户出货')}</span></div>
        <div class="text-muted small text-truncate">${esc(s.who || s.carrier || '')} · 计划查询 ${esc(String(s.next_check_at).slice(0, 10))}${s.item_count > 1 ? ' · ' + s.item_count + ' 票' : ''}</div>
      </div>
      <form method="post" action="/logistics/${s.id}/event" class="d-flex gap-1">
        <input type="hidden" name="status" value="已到港">
        <input type="hidden" name="at" value="${esc(ts)} 00:00">
        <input type="hidden" name="note" value="仪表盘快捷：已到港">
        <button class="btn btn-sm btn-outline-success" title="标记已到港">到了</button>
      </form>
      <form method="post" action="/logistics/${s.id}/snooze">
        <input type="hidden" name="days" value="2">
        <button class="btn btn-sm btn-outline-secondary" title="两天后再提醒">推迟</button>
      </form>
    </div>`).join('') : '<div class="text-muted small py-3 text-center">没有待查询的运单</div>';
  const lgsCard = lgsDue.length ? `<div class='row g-3 mb-4'><div class='col-lg-12'>${card({
    title: '物流待查询 <span class="badge text-bg-danger ms-1">' + lgsDue.length + '</span>',
    actions: '<a class="btn btn-sm btn-outline-primary" href="/logistics">物流跟踪</a>',
    body: lgsHtml,
  })}</div></div>` : '';
  const products30ago = (function () { const dd = new Date(Date.now() - 30 * 86400000); const pad = n => String(n).padStart(2, '0'); return dd.getFullYear() + '-' + pad(dd.getMonth() + 1) + '-' + pad(dd.getDate()); })();
  const recentProducts = all('SELECT * FROM products WHERE created_at>=? ORDER BY created_at DESC, id DESC LIMIT 24', products30ago + ' 00:00:00');
  const recentProductsHtml = recentProducts.map(p => `<div class='d-flex align-items-center gap-2 border-bottom py-2'>
      <div style='width:46px;height:46px;flex:0 0 46px;border-radius:8px;overflow:hidden;background:#f1f4f8;border:1px solid #e7ecf2;display:flex;align-items:center;justify-content:center'>${p.image ? '<img src="' + esc(p.image) + '" style="width:100%;height:100%;object-fit:cover" alt="">' : '<i class="bi bi-image text-secondary"></i>'}</div>
      <div class='flex-grow-1' style='min-width:0'><div class='fw-semibold text-truncate'>${esc(p.name)}</div><div class='text-muted small'>${esc(p.model || '')} · 添加于 ${esc((p.created_at || '').slice(0, 10))}</div></div>
      <a class='btn btn-sm btn-outline-secondary' href='/products/${p.id}/edit'>编辑</a>
    </div>`).join('') || '<div class="text-muted small py-3 text-center">近 30 天没有新增产品</div>';
  const recentProductsCard = `<div class='row g-3 mb-4'>
      <div class='col-lg-12'>${card({ title: '最近 30 天新增产品 <span class="badge text-bg-primary ms-1">' + recentProducts.length + '</span>', actions: '<a class="btn btn-sm btn-outline-primary" href="/products">产品信息</a>', body: '<div style="max-height:340px;overflow:auto">' + recentProductsHtml + '</div>' })}
      </div>
    </div>`;

  const stat = (icon, color, num, label, sub, href) => `
    <div class="col-6 col-xl-3">
      <a class="stat-card text-decoration-none" href="${href}">
        <div class="stat-icon bg-${color}-subtle text-${color}"><i class="bi ${icon}"></i></div>
        <div><div class="stat-num">${num}</div><div class="stat-label">${label}</div><div class="stat-sub">${sub}</div></div>
      </a>
    </div>`;
  const activeQuotes = get("SELECT COUNT(*) c FROM quote_history WHERE user_id=? AND status IN ('已报价','跟进中')", ctx.user.id).c;
  const dueToday = upcoming.filter(row => String(row.next_follow_date || '') <= ts).length;
  const pipelineCustomers = dashboardPipelineCustomers(ctx.user.id);
  const pipelineStages = [
    { key: 'inquiry', label: '新询盘', color: 'purple', href: '/customers?status=' + encodeURIComponent('潜在客户') },
    { key: 'contacted', label: '已联系', color: 'blue', href: '/followups?view=all' },
    { key: 'quoted', label: '已报价', color: 'cyan', href: '/quotes' },
    { key: 'sample', label: '样品跟进', color: 'amber', href: '/followups?type=' + encodeURIComponent('样品') },
    { key: 'won', label: '成交', color: 'green', href: '/documents' },
  ];
  const stageCustomers = Object.fromEntries(pipelineStages.map(stage => [stage.key, pipelineCustomers.filter(customer => customer.stage === stage.key)]));
  const inquiryTotal = pipelineCustomers.length;
  const pipelineHtml = pipelineStages.map(stage => {
    const customers = stageCustomers[stage.key];
    const names = customers.slice(0, 3).map(customer => `<a class="kanban-card" href="/customers/${customer.id}"><span>${esc(customer.company_name)}</span><small>${esc(customer.country || customer.status || '未填写国家')}</small></a>`).join('');
    const empty = '<div class="kanban-empty">暂无客户</div>';
    return `<section class="kanban-col dashboard-stage dashboard-stage-${stage.color}"><h4><a href="${stage.href}">${stage.label}<span>${customers.length}</span></a></h4><div class="dashboard-stage-bar" role="img" aria-label="${stage.label} ${customers.length}，占当前客户 ${inquiryTotal ? Math.round(customers.length / inquiryTotal * 100) : 0}%"><span style="width:${inquiryTotal ? customers.length / inquiryTotal * 100 : 0}%"></span></div><div class="dashboard-stage-list">${names || empty}</div>${customers.length > 3 ? `<a class="dashboard-stage-more" href="${stage.href}">查看其余 ${customers.length - 3} 家</a>` : ''}</section>`;
  }).join('');
  const quotedCount = get("SELECT COUNT(*) c FROM quote_history WHERE user_id=? AND status IN ('已报价','跟进中','报价已接受')", ctx.user.id).c;
  const wonCount = stageCustomers.won.length;
  const countryRows = all(`SELECT TRIM(country) country, COUNT(*) count FROM customers
    WHERE user_id=? AND COALESCE(in_pool,0)=0 AND TRIM(COALESCE(country,''))<>''
    GROUP BY TRIM(country) ORDER BY count DESC,country`, ctx.user.id);
  const knownCountryCount = countryRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const countryHtml = countryRows.length ? countryRows.slice(0, 5).map(row => `<div class="dashboard-country-row"><span>${esc(row.country)}</span><b>${row.count}</b><span class="dashboard-country-share">${knownCountryCount ? Math.round(row.count / knownCountryCount * 100) : 0}%</span><span class="dashboard-country-track"><i style="width:${knownCountryCount ? Math.max(3, row.count / countryRows[0].count * 100) : 0}%"></i></span></div>`).join('') + (countryRows.length > 5 ? `<div class="dashboard-country-other">其他国家 ${countryRows.slice(5).reduce((sum, row) => sum + Number(row.count || 0), 0)} 家</div>` : '') : '<div class="dashboard-analytics-empty">客户档案尚未填写国家/地区。</div>';
  const stageSuggestions = upcoming.slice(0, 3).map(activity => `<a class="dashboard-priority-row" href="/customers/${activity.customer_id}"><span class="dashboard-priority-dot priority-${esc(String(activity.priority || '中') === '高' ? 'high' : String(activity.priority || '中') === '低' ? 'low' : 'medium')}"></span><span class="dashboard-priority-main"><b>${esc(activity.company_name)}</b><small>${esc(activity.subject || activity.next_follow_notes || activity.type || '客户跟进')}</small></span><span class="dashboard-priority-date">${activity.next_follow_date < ts ? '逾期' : activity.next_follow_date === ts ? '今天' : '明天'}</span></a>`).join('') || '<div class="dashboard-analytics-empty">今天和明天没有待跟进客户。</div>';
  const sampleOpenCount = get("SELECT COUNT(*) c FROM activities WHERE user_id=? AND type='样品' AND COALESCE(archived,0)=0", ctx.user.id).c;
  const pendingQuoteCustomers = stageCustomers.inquiry.length + stageCustomers.contacted.length;
  const businessMetrics = [
    { label: '待报价客户', value: pendingQuoteCustomers, note: '潜在客户与已联系客户', color: 'purple', href: '/customers' },
    { label: '有效报价', value: quotedCount, note: '已报价 / 跟进中 / 已接受', color: 'cyan', href: '/quotes' },
    { label: '样品跟进', value: sampleOpenCount, note: '未完成的样品跟进记录', color: 'amber', href: '/followups?type=' + encodeURIComponent('样品') },
    { label: '成交客户', value: wonCount, note: '客户状态或成交记录确认', color: 'green', href: '/documents' },
  ].map(metric => `<a class="wb2-stat dashboard-business-metric tone-${metric.color}" href="${metric.href}"><span class="wb2-stat-label">${metric.label}</span><strong class="wb2-stat-num">${metric.value}</strong><span class="wb2-stat-note">${metric.note}</span></a>`).join('');
  const stats = stat('bi-buildings', 'primary', totalCustomers, '客户总数', '本月新增 ' + newCustomersMonth, '/customers') +
    stat('bi-send', 'info', activeQuotes, '待推进报价', '已报价 / 跟进中', '/quotes?status=跟进中') +
    stat('bi-calendar2-check', 'warning', dueToday, '到期跟进', '逾期与今天', '/followups?view=today') +
    stat('bi-file-earmark-text', 'success', docMonth, '本月单据', docMonthAmount, '/documents');

  const monthAgoD = new Date(Date.now() - 30 * 86400000);
  const monthAgo = monthAgoD.getFullYear() + '-' + String(monthAgoD.getMonth() + 1).padStart(2, '0') + '-' + String(monthAgoD.getDate()).padStart(2, '0');
  const followHtml = upcoming.map(a => {
    const recents = all("SELECT * FROM activities WHERE customer_id=? AND activity_date>=? AND user_id=? ORDER BY activity_date DESC, id DESC LIMIT 20", a.customer_id, monthAgo, ctx.user.id);
    const recentHtml = recents.length ? recents.map(r => `<div class="border-top py-2">
        <div class="d-flex align-items-center gap-2"><span class="badge text-bg-light border">${esc(r.type || '其他')}</span><span class="text-muted small">${esc((r.activity_date || '').slice(0, 16))}</span>${r.archived ? '<span class="badge text-bg-success">已完成</span>' : ''}</div>
        <div class="small mt-1">${esc(r.subject || r.content || '（无内容）')}</div>
        ${r.next_follow_notes ? `<div class="text-muted small">下次要点：${esc(r.next_follow_notes)}</div>` : ''}
      </div>`).join('') : '<div class="text-muted small py-2">最近一个月没有跟进记录</div>';
    return `<div class="list-item fu-reminder flex-column align-items-stretch">
      <div class="d-flex align-items-center gap-2">
        <div class="flex-grow-1" style="cursor:pointer">
          <div class="fw-semibold">${esc(a.company_name)}${a.subject ? ' · ' + esc(a.subject) : ''} ${priorityBadge(a.priority)}</div>
          <div class="text-muted small">${esc(a.type || '')}${a.next_follow_notes ? '：' + esc(a.next_follow_notes) : ''}</div>
        </div>
        <span class="badge ${a.next_follow_date <= ts ? 'text-bg-danger' : 'text-bg-warning'}">${a.next_follow_date < ts ? '已逾期' : (a.next_follow_date === ts ? '今天' : esc(a.next_follow_date))}</span>
        <i class="bi bi-chevron-down fu-caret text-muted"></i>
        <button type="button" class="btn btn-sm btn-outline-success ms-1" data-id="${a.id}" data-name="${esc(a.company_name)}" data-type="${esc(a.type || '')}" data-contact="${esc(a.contact_person || '')}" data-priority="${esc(a.priority || '中')}" data-notes="${esc(a.next_follow_notes || '')}" data-next="${esc(a.next_follow_date || '')}" onclick="completeFu(this)"><i class="bi bi-check2-circle"></i> 完成</button>
      </div>
      <div class="fu-recent" style="display:none">
        <div class="d-flex justify-content-between align-items-center mt-2 mb-1"><span class="small fw-semibold">最近一个月跟进（${recents.length}）</span><a class="small text-decoration-none" href="/customers/${a.customer_id}">查看客户 →</a></div>
        ${recentHtml}
      </div>
    </div>`;
  }).join('') || '<div class="text-muted small py-3 text-center">没有逾期或近期待跟进事项</div>';

  const typeNameMap = Object.fromEntries(DOC_TYPES.map(t => [t.key, t.name]));

  const docHtml = recentDocs.map(d => `
    <a class="list-item" href="/documents/${d.id}">
      <div class="flex-grow-1"><div class="fw-semibold">${esc(d.doc_no)} ${esc(typeNameMap[d.doc_type] || '')}</div>
      <div class="text-muted small">${esc(d.company_name)} · ${esc(d.issue_date || '')}</div></div>
      <div class="text-end"><div class="fw-bold">$${moneyFmt(d.total_amount)}</div>${badge(d.status)}</div>
    </a>`).join('') || '<div class="text-muted small py-3 text-center">还没有单据，去<a href="/documents/new">新建单据</a></div>';

  const pendingShip = all("SELECT d.id, d.doc_no, d.currency, d.total_amount, d.delivery_date, c.company_name, p.paid AS paid_amt FROM documents d JOIN customers c ON c.id=d.customer_id JOIN document_payments p ON p.doc_id=d.id LEFT JOIN document_shipments s ON s.doc_id=d.id WHERE d.user_id=? AND d.doc_type='pi' AND d.status<>'已作废' AND (p.paid>0 OR p.deposit>0) AND (s.doc_id IS NULL OR s.ship_date IS NULL OR s.ship_date='') ORDER BY d.delivery_date ASC, d.id DESC LIMIT 30", ctx.user.id);
  const pendingShipHtml = !pendingShip.length ? '' : `<div class="row g-3 mb-4">
      <div class="col-lg-12">${card({ title: '待发货订单（已收款 PI） <span class="badge text-bg-warning ms-1">' + pendingShip.length + '</span>', actions: `<a class="btn btn-sm btn-outline-primary" href="/shipments"><i class="bi bi-box-arrow-up-right me-1"></i>去发货</a>`, body: `<div class="list-group-flush">${pendingShip.map(x => `<a class="list-item" href="/documents/${x.id}">
        <div class="flex-grow-1"><div class="fw-semibold">${esc(x.company_name)} · ${esc(x.doc_no)}</div>
        <div class="text-muted small">交货期 ${esc(x.delivery_date || '-')} · 金额 ${esc(x.currency)} ${moneyFmt(x.total_amount)} · 已收 ${moneyFmt(x.paid_amt)}</div></div>
        <span class="badge text-bg-warning">待发货</span>
      </a>`).join('')}</div>` })}</div>
    </div>`;
  const receivable = all("SELECT d.id,d.doc_no,d.doc_type,d.currency,d.total_amount,d.delivery_date,c.company_name,COALESCE(p.deposit,0) AS dep_amt,COALESCE(p.paid,0) AS paid_amt FROM documents d JOIN customers c ON c.id=d.customer_id LEFT JOIN document_payments p ON p.doc_id=d.id WHERE d.user_id=? AND d.doc_type IN ('pi','so','ci') AND d.status NOT IN ('草稿','已作废') AND d.total_amount>0 AND COALESCE(p.paid,0) < d.total_amount ORDER BY d.delivery_date ASC, d.id DESC LIMIT 40", ctx.user.id);
  const receivableRows = receivable.map(x => {
    const ttl = Number(x.total_amount) || 0; const pd = Number(x.paid_amt) || 0; const dp = Number(x.dep_amt) || 0; const owe = Math.max(ttl - pd, 0);
    return `<tr>
      <td><a class="fw-semibold text-decoration-none" href="/documents/${x.id}">${esc(x.company_name)}</a><div class="text-muted small">${esc(x.doc_no)} · 交货期 ${esc(x.delivery_date || '-')}</div></td>
      <td class="text-end">${esc(x.currency)} ${moneyFmt(ttl)}</td>
      <td class="text-end">${moneyFmt(dp)}</td>
      <td class="text-end">${moneyFmt(pd)}</td>
      <td class="text-end text-danger fw-bold">${moneyFmt(owe)}</td>
      <td class="text-end"><div class="d-flex gap-1 justify-content-end"><a class="btn btn-sm btn-outline-primary" href="/payments/${x.id}/edit">登记收款</a><a class="btn btn-sm btn-outline-success" href="/shipments/${x.id}/edit">去发货</a></div></td>
    </tr>`;
  }).join('');
  const receivableHtml = `<div class="row g-3 mb-4">
      <div class="col-lg-12">${card({ title: '待收款订单（货款未收齐） <span class="badge text-bg-danger ms-1">' + receivable.length + '</span>', actions: `<a class="btn btn-sm btn-outline-primary" href="/payments"><i class="bi bi-cash-coin me-1"></i>去收款</a>`, body: `<div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>客户 / 单据</th><th class="text-end">金额</th><th class="text-end">定金</th><th class="text-end">已付</th><th class="text-end">欠款</th><th class="text-end">操作</th></tr></thead>
        <tbody>${receivableRows || '<tr><td colspan="6" class="text-center text-muted py-3">所有订单货款已结清</td></tr>'}</tbody>
      </table></div>
      <div class="text-muted small">货款未收齐（欠款＞0）的销售订单（PI / 销售合同 / CI）。</div>` })}</div>
    </div>`;
  // ===== 异常客户提醒（V1.05） =====
  const shipSet = new Set(all("SELECT doc_id FROM document_shipments WHERE ship_date IS NOT NULL AND ship_date<>''").map(r => r.doc_id));
  const payMap = {};
  for (const pr of all('SELECT doc_id, paid FROM document_payments')) payMap[pr.doc_id] = Number(pr.paid) || 0;
  const salesDocs = all("SELECT id,doc_no,doc_type,customer_id,delivery_date,total_amount,status,stock_restored,items FROM documents WHERE user_id=? AND doc_type IN ('pi','so','ci') AND COALESCE(status,'')<>'已作废'", ctx.user.id);
  const custNameMap = {};
  for (const cc of all('SELECT id, company_name FROM customers WHERE user_id=?', ctx.user.id)) custNameMap[cc.id] = cc.company_name;
  const alertRows = [];
  for (const d of salesDocs) {
    const cname = custNameMap[d.customer_id] || '';
    if (d.delivery_date && d.delivery_date <= ts && !shipSet.has(d.id)) {
      alertRows.push({ cls: 'text-bg-danger', label: '到期未发货', link: '/documents/' + d.id, title: cname + ' · ' + d.doc_no, sub: '交货期 ' + d.delivery_date + ' 已到期，尚未登记发货' });
    }
    const total = Number(d.total_amount) || 0;
    const paid = payMap[d.id] || 0;
    const shipped = shipSet.has(d.id) || (d.doc_type === 'so' && Number(d.stock_restored) === 1);
    if (shipped && total > 0 && (total - paid) > 0.01) {
      alertRows.push({ cls: 'text-bg-warning', label: '尾款未清', link: '/documents/' + d.id, title: cname + ' · ' + d.doc_no, sub: '已发货，尾款未收 ' + numFmt(Math.round((total - paid) * 100) / 100) + '（应收 ' + numFmt(total) + '，已收 ' + numFmt(paid) + '）' });
    }
  }
  const tokenize = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
  const poItemTok = [];
  const poPids = new Set();
  for (const po of all("SELECT items FROM documents WHERE user_id=? AND doc_type='po' AND items IS NOT NULL AND items<>''", ctx.user.id)) {
    let arr = []; try { arr = JSON.parse(po.items || '[]'); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const toks = [it.name, it.name_en, it.model].map(tokenize).filter(Boolean);
      const pidN = Number(it.product_id) || 0;
      if (pidN) poPids.add(pidN);
      if (toks.length) poItemTok.push(toks);
    }
  }
  if (poItemTok.length) {
    for (const d of salesDocs) {
      if (d.doc_type !== 'pi' || d.status === '草稿') continue;
      let arr = []; try { arr = JSON.parse(d.items || '[]'); } catch (e) { arr = []; }
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const toks = [it.name, it.name_en, it.model].map(tokenize).filter(Boolean);
        if (!toks.length) continue;
        const pidNum = Number(it.product_id) || 0;
        const matched = (pidNum > 0 && poPids.has(pidNum)) || poItemTok.some(function (tset) { return toks.some(function (t) { return tset.indexOf(t) >= 0; }); });
        if (!matched) {
          alertRows.push({ cls: 'text-bg-primary', label: '采购未匹配', link: '/documents/' + d.id, title: (custNameMap[d.customer_id] || '') + ' · ' + d.doc_no, sub: 'PI 产品「' + (it.name || it.model || it.name_en || '') + '」在采购单中未匹配到对应产品' });
        }
      }
    }
  }
  const anomHtml = alertRows.slice(0, 40).map(x => `<a class="list-item" href="${x.link}">
      <div class="flex-grow-1"><div class="fw-semibold">${esc(x.title)}</div>
      <div class="text-muted small">${esc(x.sub)}</div></div>
      <span class="badge ${x.cls}">${x.label}</span>
    </a>`).join('') || '<div class="text-muted small py-3 text-center"><i class="bi bi-check-circle text-success me-1"></i>暂无异常客户提醒，一切正常</div>';
  const alertCount = alertRows.length;

  try { require('../reminders').autoPoolStale(); } catch (e) {}
  const staleInfo = require('../reminders').staleCustomers(ctx.user.id);
  const staleHtml = !staleInfo.warn.length ? '' : `<div class="row g-3 mb-4"><div class="col-lg-12">${card({ title: '⚠ 强提醒：即将进入公共客户池 <span class="badge text-bg-danger ms-1">' + staleInfo.warn.length + '</span>', actions: `<a class="btn btn-sm btn-outline-secondary" href="/pool">公共客户池</a>`, body: `<div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead><tr><th>客户</th><th>最后跟进</th><th class="text-center">未跟进</th><th>联系电话</th><th class="text-end">操作</th></tr></thead><tbody>${staleInfo.warn.map(x => `<tr><td><a class="fw-semibold text-decoration-none" href="/customers/${x.id}">${esc(x.company_name)}</a></td><td class="small">${esc((x.last_follow || '').slice(0, 16))}</td><td class="text-center"><span class="badge text-bg-danger">${x.days} 天</span></td><td>${esc(x.phone || '-')}</td><td class="text-end"><a class="btn btn-sm btn-outline-primary" href="/customers/${x.id}/activities/new">立即跟进</a> <form class="d-inline" method="post" action="/customers/${x.id}/pool"><button class="btn btn-sm btn-outline-warning">放入公共池</button></form></td></tr>`).join('')}</tbody></table></div><div class="text-muted small mt-2">规则：超过 29 天未跟进强提醒；第 30 天自动进入公共客户池。</div>` })}</div></div>`;
  const tierCard = card({
    title: '客户分层经营 <span class="badge text-bg-light border ms-1">按贡献值自动分档</span>',
    actions: `<a class="btn btn-sm btn-outline-primary" href="/customer-tiers">分层工作台</a> <a class="btn btn-sm btn-outline-success" href="/briefings">行业简报</a> <a class="btn btn-sm btn-outline-secondary" href="/followups">分层跟进</a>`,
    body: `<div class="row g-2">
      <div class="col-6 col-lg-3"><a class="d-block text-decoration-none rounded-3 border p-3 h-100" href="/customer-tiers?tier=A"><div class="d-flex justify-content-between align-items-center"><span class="badge text-bg-danger">A类</span><i class="bi bi-arrow-up-right text-muted"></i></div><div class="h3 fw-bold mt-2 mb-0">${tierCounts.A}</div><div class="small text-muted">每周固定沟通</div></a></div>
      <div class="col-6 col-lg-3"><a class="d-block text-decoration-none rounded-3 border p-3 h-100" href="/customer-tiers?tier=B"><div class="d-flex justify-content-between align-items-center"><span class="badge text-bg-warning">B类</span><i class="bi bi-arrow-up-right text-muted"></i></div><div class="h3 fw-bold mt-2 mb-0">${tierCounts.B}</div><div class="small text-muted">每月定制简报</div></a></div>
      <div class="col-6 col-lg-3"><a class="d-block text-decoration-none rounded-3 border p-3 h-100" href="/customer-tiers?tier=C"><div class="d-flex justify-content-between align-items-center"><span class="badge text-bg-info">C类</span><i class="bi bi-arrow-up-right text-muted"></i></div><div class="h3 fw-bold mt-2 mb-0">${tierCounts.C}</div><div class="small text-muted">进入系统群发名单</div></a></div>
      <div class="col-6 col-lg-3"><a class="d-block text-decoration-none rounded-3 border p-3 h-100" href="/customer-tiers?tier=D"><div class="d-flex justify-content-between align-items-center"><span class="badge text-bg-dark">D类</span><i class="bi bi-arrow-up-right text-muted"></i></div><div class="h3 fw-bold mt-2 mb-0">${tierCounts.D}</div><div class="small text-muted">停止主动联系</div></a></div>
    </div><div class="small text-muted mt-2">贡献值优先按近12个月实际已收款计算，未付款 PI 不计入；A/B 类周期任务自动去重生成到跟进中心。</div>`
  });
  const ar = autoReplyStats.todayStats();
  const arPct = (n, max) => Number(max) > 0 ? Math.min(100, Math.round((Number(n) || 0) / Number(max) * 1000) / 10) : 0;
  const arLimit = (label, value, max, color) => `<div class="mb-2">
    <div class="d-flex justify-content-between small mb-1"><span>${label}</span><span class="fw-semibold">${Number(value) || 0} / ${Number(max) || 0}</span></div>
    <div class="progress" style="height:6px"><div class="progress-bar bg-${color}" style="width:${arPct(value, max)}%"></div></div>
  </div>`;
  const actionMeta = (row) => {
    if (row.action === 'sent' && /qualify_ask/.test(row.reason || '')) return { label: '资格追问', cls: 'primary' };
    if (row.action === 'sent' && /material:/.test(row.reason || '')) return { label: '发送素材', cls: 'success' };
    if (row.action === 'sent') return { label: '自动回复', cls: 'success' };
    if (row.action === 'skip') return { label: '跳过', cls: 'secondary' };
    if (row.action === 'hold') return { label: '转人工', cls: 'warning' };
    if (row.action === 'unqualified') return { label: '放弃', cls: 'dark' };
    if (row.action === 'error') return { label: '错误', cls: 'danger' };
    if (row.action === 'dry') return { label: '观察', cls: 'info' };
    return { label: row.action || '未知', cls: 'secondary' };
  };
  const arRecentHtml = ar.recent.map(row => {
    const meta = actionMeta(row);
    const counts = row.action === 'sent' ? `${row.message_count || 0} 条消息 · ${row.file_count || 0} 个文件` : '';
    return `<tr>
      <td class="text-nowrap small">${esc(String(row.at || '').slice(11, 16))}</td>
      <td><span class="badge text-bg-${meta.cls}">${meta.label}</span></td>
      <td class="fw-semibold">${esc(row.chat_name || '-')}<div class="small text-muted fw-normal">${esc(counts)}</div></td>
      <td class="small text-muted"><div class="text-truncate" style="max-width:520px" title="${esc(row.reason || '')}">${esc(row.reason || '-')}</div></td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" class="text-center text-muted py-4">${ar.status.running ? '今日暂无自动回复动作，worker 正在等待新消息' : '今日暂无自动回复动作，worker 当前未运行'}</td></tr>`;
  const arWorkerBadge = ar.status.running
    ? '<span class="badge text-bg-success">Worker 运行中</span>'
    : '<span class="badge text-bg-secondary">Worker 未运行</span>';
  const arEnabledBadge = ar.status.enabled
    ? '<span class="badge text-bg-primary">总开关：开</span>'
    : '<span class="badge text-bg-light border">总开关：关</span>';
  const arCard = card({
    title: `每日自动回复总结 <span class="badge text-bg-light border ms-1">${ts}</span>`,
    actions: `${arEnabledBadge} ${arWorkerBadge} <a class="btn btn-sm btn-outline-primary" href="/whatsapp/session"><i class="bi bi-whatsapp"></i> WhatsApp</a>`,
    body: `<div class="row g-2 mb-3">
      <div class="col-6 col-xl-3"><div class="rounded-3 border p-3 h-100"><div class="text-muted small">今日覆盖客户</div><div class="display-6 fw-bold mt-1">${ar.customers}</div><div class="small text-muted">${ar.sentBatches} 次发送批次</div></div></div>
      <div class="col-6 col-xl-3"><div class="rounded-3 border p-3 h-100"><div class="text-muted small">已发送消息 / 文件</div><div class="h2 fw-bold mt-1 mb-0">${ar.messages} <span class="fs-6 text-muted">条</span></div><div class="small text-muted">${ar.files} 个文件或图片</div></div></div>
      <div class="col-6 col-xl-3"><div class="rounded-3 border p-3 h-100"><div class="text-muted small">资格追问</div><div class="display-6 fw-bold mt-1 text-primary">${ar.asks}</div><div class="small text-muted">待补充信息 ${ar.pending} 个</div></div></div>
      <div class="col-6 col-xl-3"><div class="rounded-3 border p-3 h-100"><div class="text-muted small">转人工 / 异常</div><div class="display-6 fw-bold mt-1 ${ar.review + ar.holds + ar.errors ? 'text-warning' : ''}">${ar.review + ar.holds + ar.errors}</div><div class="small text-muted">跳过 ${ar.skips} 次 · 错误 ${ar.errors} 次</div></div></div>
    </div>
    <div class="row g-3">
      <div class="col-xl-4">
        <div class="rounded-3 bg-light p-3 h-100">
          <div class="fw-semibold mb-2">今日额度使用</div>
          ${arLimit('自动回复批次', ar.sentBatches, ar.limits.batches, 'primary')}
          ${arLimit('覆盖客户', ar.customers, ar.limits.customers, 'success')}
          ${arLimit('素材包', ar.materialPackages, ar.limits.materials, 'warning')}
          ${arLimit('文件 / 图片', ar.files, ar.limits.files, 'dark')}
        </div>
      </div>
      <div class="col-xl-8">
        <div class="d-flex gap-1 flex-wrap mb-2">
          <span class="badge text-bg-success">精准 ${ar.qualified}</span>
          <span class="badge text-bg-primary">待追问 ${ar.pending}</span>
          <span class="badge text-bg-warning">人工复核 ${ar.review}</span>
          <span class="badge text-bg-dark">放弃 ${ar.done + ar.unqualified}</span>
          <span class="badge text-bg-light border">AI：高 ${ar.precisionHigh} / 存疑 ${ar.precisionUnknown} / 低 ${ar.precisionLow}</span>
        </div>
        <div class="table-responsive" style="max-height:310px;overflow:auto"><table class="table table-sm align-middle mb-0">
          <thead><tr><th>时间</th><th>动作</th><th>客户</th><th>结果 / 原因</th></tr></thead>
          <tbody>${arRecentHtml}</tbody>
        </table></div>
      </div>
    </div>`
  });
  const todoRows = all('SELECT * FROM todos ORDER BY done ASC,created_at DESC,id DESC LIMIT 12');
  const todoHtml = todoRows.map(todo => `<form class="crm-todo-row" method="post" action="/dashboard/todo/${todo.id}/toggle"><button type="submit" class="crm-todo-check${todo.done ? ' done' : ''}" aria-label="${todo.done ? '标记未完成' : '标记完成'}"><i class="bi ${todo.done ? 'bi-check2-circle' : 'bi-circle'}"></i></button><span class="${todo.done ? 'is-done' : ''}">${esc(todo.text)}</span></form>`).join('') || '<div class="crm-panel-empty">暂无随手记</div>';
  const content = `
    ${pageHead('外贸AI客服工作台 2.0', '客户、报价、跟进与履约概览 · WhatsApp · AI客服 · CRM · 报价 · 订单 · 知识库', `<a class="btn btn-primary" href="/quotes/new"><i class="bi bi-plus-lg me-1"></i>新建报价</a> <a class="btn btn-outline-secondary" href="/documents/new"><i class="bi bi-file-earmark-plus me-1"></i>新建单据</a>`)}
    <div class="wb2-stat-grid dashboard-business-grid">${businessMetrics}</div>
    <div class="row g-3 mb-3">${stats}</div>
    <section class="dashboard-sales-overview">
      <header class="dashboard-sales-head"><div><h2>客户阶段与市场概览</h2><span>按当前账号客户、跟进、报价和销售单据统计</span></div><div class="dashboard-sales-meta">${inquiryTotal} 家在跟客户 · 待跟进 ${dueToday} 项 · A 类 ${tierCounts.A} 家</div></header>
      <div class="kanban dashboard-pipeline">${pipelineHtml}</div>
      <div class="dashboard-insights">
        <section class="dashboard-insight-block"><div class="dashboard-insight-title"><h3>客户国家 / 地区</h3><span>TOP 5 · 已填写 ${knownCountryCount} 家</span></div><div class="dashboard-country-list">${countryHtml}</div></section>
        <section class="dashboard-insight-block"><div class="dashboard-insight-title"><h3>优先跟进</h3><a href="/followups">全部跟进</a></div><div class="dashboard-priority-list">${stageSuggestions}</div></section>
      </div>
      <div class="dashboard-sales-foot">样品阶段按未完成的“样品”跟进记录统计；成交客户按客户状态、成交报价或已确认 / 已完成 PI、销售合同及 CI 识别。</div>
    </section>
    <div class="dashboard-workspace-top">
      <section class="dashboard-main-column">
        <div class="dashboard-panel dashboard-todos"><div class="dashboard-panel-head"><div><h2>随手记</h2><span>个人临时事项</span></div><form method="post" action="/dashboard/todo" class="dashboard-todo-add"><input name="text" maxlength="240" placeholder="记下一件待办…" aria-label="新增随手记"><button class="btn btn-sm btn-primary" title="添加"><i class="bi bi-plus-lg"></i></button></form></div><div class="dashboard-todo-list">${todoHtml}</div></section>
        <div class="dashboard-panel"><div class="dashboard-panel-head"><div><h2>待跟进提醒</h2><span>逾期与今明两天 · ${upcoming.length} 项</span></div><a class="btn btn-sm btn-outline-secondary" href="/followups">全部跟进</a></div><div class="dashboard-follow-list">${followHtml}</div></div>
      </section>
      <section class="dashboard-side-column">
        <div class="dashboard-panel"><div class="dashboard-panel-head"><div><h2>异常客户提醒</h2><span>${alertCount} 项待核查</span></div><a class="btn btn-sm btn-outline-secondary" href="/customers">客户</a></div><div class="dashboard-alert-list">${anomHtml}</div></div>
        <div class="dashboard-panel"><div class="dashboard-panel-head"><div><h2>AI 自动回复</h2><span>今日发送与处理摘要</span></div><a class="btn btn-sm btn-outline-secondary" href="/whatsapp/session">WhatsApp</a></div><div class="dashboard-ar-compact"><div><b>${ar.customers}</b><span>覆盖客户</span></div><div><b>${ar.messages}</b><span>发送消息</span></div><div><b>${ar.review + ar.holds + ar.errors}</b><span>转人工 / 异常</span></div></div><div class="dashboard-ar-status">${arEnabledBadge} ${arWorkerBadge}</div></div>
        <div class="dashboard-panel dashboard-products-panel"><div class="dashboard-panel-head"><div><h2>最近新增产品</h2><span>近 30 天</span></div><a class="btn btn-sm btn-outline-secondary" href="/products">产品</a></div><div class="dashboard-product-list">${recentProductsHtml}</div></div>
      </section>
    </div>
    <details class="dashboard-more"><summary>经营与履约明细</summary>
      ${tierCard}
      ${lgsCard}
      ${staleHtml}
      ${pendingShipHtml}
      ${receivableHtml}
      ${arCard}
    </details>
    ${followupModalHtml()}
    ${completeFollowupModalHtml()}
    ${followupScript()}`;
  return page({ title: '仪表盘', active: 'dashboard', user: ctx.user, content, flash: ctx.flash() });
}
function moneyFmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function imagesThumb(json) {
  let arr = [];
  try { const a = JSON.parse(json || '[]'); arr = Array.isArray(a) ? a : []; } catch (e) { arr = []; }
  if (!arr.length) return '';
  return '<div class="d-flex flex-wrap gap-1 mt-1">' + arr.map(p => '<img class="img-preview" src="' + esc(p) + '" style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid #dee2e6;background:#fff" alt="">').join('') + '</div>';
}
function numFmt(n) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
}
function quickCard(title, items) {
  return card({ title, body: `<div class="d-grid gap-2">${items.map(([ic, lb, h, cls]) => `<a class="btn ${cls}" href="${h}"><i class="bi ${ic} me-1"></i>${lb}</a>`).join('')}</div>` });
}

// ============ 跟进任务：优先级 / 完成结果 / 下一步安排 ============
function fuTypeOptions(sel) {
  const list = ['WhatsApp', '邮件', '微信', '电话', '样品', '会议', '拜访', '报价', '展会', '其他'];
  return list.map(t => '<option value="' + esc(t) + '"' + (t === (sel || '') ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
}
function priorityOptions(sel) {
  return ['高', '中', '低'].map(p => '<option value="' + p + '"' + (p === (sel || '中') ? ' selected' : '') + '>' + p + '优先级</option>').join('');
}
function priorityBadge(p) {
  const v = String(p || '中');
  const cls = v === '高' ? 'priority-high' : (v === '低' ? 'priority-low' : 'priority-normal');
  return '<span class="badge fu-priority ' + cls + '">' + esc(v) + '</span>';
}
function dateAfter(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function completeFollowupModalHtml() {
  return `<div class="modal fade" id="completeFollowupModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-lg modal-dialog-centered">
    <div class="modal-content">
      <form id="completeFollowupForm">
        <input type="hidden" id="cfId">
        <div class="modal-header">
          <h5 class="modal-title"><i class="bi bi-check2-circle me-1"></i><span id="cfTitle">完成跟进</span></h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="row g-3">
            <div class="col-md-5">
              <label class="form-label">跟进结果 / 结论</label>
              <input class="form-control" name="outcome" id="cfOutcome" list="outcomeOptions" placeholder="例：客户对报价有兴趣，等待确认数量">
              <datalist id="outcomeOptions"><option value="已接通"><option value="暂无回应"><option value="已发送资料"><option value="已报价"><option value="客户有兴趣"><option value="需要再次跟进"><option value="已成交"><option value="暂缓"><option value="无效线索"></datalist>
            </div>
            <div class="col-md-3">
              <label class="form-label">下次跟进日期</label>
              <input type="date" class="form-control" name="next_follow_date" id="cfNextDate">
            </div>
            <div class="col-md-4">
              <label class="form-label">下次优先级</label>
              <select class="form-select" name="priority" id="cfPriority">${priorityOptions('中')}</select>
            </div>
            <div class="col-md-4">
              <label class="form-label">下次跟进方式</label>
              <select class="form-select" name="next_type" id="cfType">${fuTypeOptions('电话')}</select>
            </div>
            <div class="col-md-8">
              <label class="form-label">下次行动主题</label>
              <input class="form-control" name="next_subject" id="cfSubject" placeholder="例：确认最终采购数量与交期">
            </div>
            <div class="col-12">
              <label class="form-label">下次跟进要点</label>
              <textarea class="form-control" name="next_follow_notes" id="cfNotes" rows="2" placeholder="写下下一次跟进前需要准备或确认的内容"></textarea>
            </div>
          </div>
          <div class="alert alert-info mt-3 mb-0 small"><i class="bi bi-info-circle me-1"></i>只完成不安排下一步时，直接留空下次日期并点击“仅完成”。</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">取消</button>
          <button type="submit" class="btn btn-outline-success" name="action" value="complete"><i class="bi bi-check2 me-1"></i>仅完成</button>
          <button type="submit" class="btn btn-primary" name="action" value="complete_next"><i class="bi bi-calendar-plus me-1"></i>完成并安排下一步</button>
        </div>
      </form>
    </div>
  </div>
</div>`;
}
function whatsappFollowupModalHtml() {
  return `<div class="modal fade" id="fuWaModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <form id="fuWaForm">
        <input type="hidden" id="fuWaActivityId">
        <div class="modal-header">
          <div>
            <h5 class="modal-title"><i class="bi bi-whatsapp text-success me-1"></i>直接发送 WhatsApp</h5>
            <div class="text-muted small mt-1" id="fuWaCustomer"></div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
        </div>
        <div class="modal-body">
          <div class="alert alert-warning py-2 small d-none" id="fuWaNotice"><i class="bi bi-exclamation-circle me-1"></i>客户档案未填写 WhatsApp 号码，请在下方输入含国际区号的号码。</div>
          <div class="mb-3">
            <label class="form-label">客户 WhatsApp 号码</label>
            <input type="tel" class="form-control" id="fuWaPhone" inputmode="tel" placeholder="+86 138 0013 8000" autocomplete="tel">
            <div class="form-text">使用当前账号已登录的 WhatsApp 直接发送；已绑定的会话会优先复用。</div>
          </div>
          <div class="mb-2 d-flex justify-content-between align-items-center">
            <label class="form-label mb-0">消息内容</label>
            <span class="text-muted small"><span id="fuWaCount">0</span> / 4096</span>
          </div>
          <textarea class="form-control" id="fuWaMessage" rows="7" maxlength="4096" placeholder="输入要发送给客户的 WhatsApp 消息…"></textarea>
          <div class="form-text mt-2"><i class="bi bi-info-circle me-1"></i>发送成功后消息会保存在对应 WhatsApp 会话中，页面不会跳离跟进中心。按 Ctrl + Enter 可快速发送。</div>
          <div class="alert py-2 mt-3 mb-0 d-none" id="fuWaResult" role="status" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">取消</button>
          <button type="submit" class="btn btn-success"><i class="bi bi-send me-1"></i>发送 WhatsApp</button>
        </div>
      </form>
    </div>
  </div>
</div>`;
}
function whatsappFollowupScript() {
  return `<script>
(function () {
  var form = document.getElementById('fuWaForm');
  if (!form) return;
  var phone = document.getElementById('fuWaPhone');
  var message = document.getElementById('fuWaMessage');
  var count = document.getElementById('fuWaCount');
  var notice = document.getElementById('fuWaNotice');
  var result = document.getElementById('fuWaResult');
  var submit = form.querySelector('button[type="submit"]');
  var modalEl = document.getElementById('fuWaModal');
  function updateCount() { count.textContent = String(message.value.length); }
  function updateNotice() { notice.classList.toggle('d-none', !!phone.value.trim()); }
  function clearResult() {
    result.className = 'alert py-2 mt-3 mb-0 d-none';
    result.textContent = '';
  }
  function showResult(kind, text, url) {
    result.className = 'alert alert-' + kind + ' py-2 mt-3 mb-0';
    result.textContent = text || '';
    if (url) {
      var a = document.createElement('a');
      a.href = url;
      a.className = 'alert-link ms-2';
      a.textContent = '打开 WhatsApp 会话';
      result.appendChild(a);
    }
  }
  function resetButton() {
    submit.disabled = false;
    submit.innerHTML = '<i class="bi bi-send me-1"></i>发送 WhatsApp';
  }
  window.openFollowupWa = function (btn) {
    form.reset();
    document.getElementById('fuWaActivityId').value = btn.getAttribute('data-id') || '';
    var name = btn.getAttribute('data-name') || '';
    var contact = btn.getAttribute('data-contact') || '';
    document.getElementById('fuWaCustomer').textContent = name + (contact ? ' · ' + contact : '');
    phone.value = btn.getAttribute('data-phone') || '';
    updateNotice();
    updateCount();
    clearResult();
    resetButton();
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
    setTimeout(function () { (phone.value.trim() ? message : phone).focus(); }, 180);
  };
  phone.addEventListener('input', updateNotice);
  message.addEventListener('input', updateCount);
  message.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = document.getElementById('fuWaActivityId').value || '';
    var text = message.value.trim();
    if (!id) { showResult('danger', '没有找到对应的跟进记录'); return; }
    if (!text) { showResult('danger', '请输入 WhatsApp 消息内容'); message.focus(); return; }
    if (submit.disabled) return;
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>发送中…';
    clearResult();
    var data = new URLSearchParams();
    data.set('phone', phone.value.trim());
    data.set('text', text);
    fetch('/api/activities/' + encodeURIComponent(id) + '/whatsapp/send', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Accept': 'application/json' },
      body: data
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); }).then(function (r) {
      var d = r.data || {};
      resetButton();
      if (!r.status || r.status >= 400 || !d.ok) {
        showResult('danger', d.error || 'WhatsApp 发送失败', d.login_url || '');
        return;
      }
      message.value = '';
      updateCount();
      showResult('success', 'WhatsApp 消息已发送，并已保存到会话记录。', d.chat_url || '');
    }).catch(function (err) {
      resetButton();
      showResult('danger', '发送失败：' + (err && err.message ? err.message : '网络错误'));
    });
  });
})();
</script>`;
}
function followupModalHtml() {
  return `<div class="modal fade" id="followupModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-lg modal-dialog-centered">
    <div class="modal-content">
      <form method="post" id="followupForm">
        <input type="hidden" id="ffCustId">
        <input type="hidden" name="return_to" id="ffReturn">

        <div class="modal-header">
          <h5 class="modal-title"><i class="bi bi-calendar-plus me-1"></i>新建跟进（今天）</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="mb-3">
            <label class="form-label fw-semibold mb-1">客户</label>
            <div class="form-control bg-light fw-semibold" id="ffCustName"></div>
          </div>
          <div class="row g-3">
            <div class="col-md-4">
              <label class="form-label">跟进方式</label>
              <select name="type" id="ffType" class="form-select">${fuTypeOptions('电话')}</select>
            </div>
            <div class="col-md-4">
              <label class="form-label">跟进时间</label>
              <input type="datetime-local" class="form-control" name="activity_date" id="ffDate">
            </div>
            <div class="col-md-4">
              <label class="form-label">下次跟进日期（可留空）</label>
              <input type="date" class="form-control" name="next_follow_date" id="ffNext">
            </div>
            <div class="col-md-4">
              <label class="form-label">优先级</label>
              <select class="form-select" name="priority" id="ffPriority">${priorityOptions('中')}</select>
            </div>
            <div class="col-md-6">
              <label class="form-label">联系人</label>
              <input type="text" class="form-control" name="contact_person" id="ffContact">
            </div>
            <div class="col-md-6">
              <label class="form-label">主题</label>
              <input type="text" class="form-control" name="subject" id="ffSubject" placeholder="下一次跟进主题（可留空）">
            </div>
            <div class="col-12">
              <label class="form-label">本次跟进要点</label>
              <textarea class="form-control" name="next_follow_notes" id="ffNotes" rows="2" placeholder="例：今天联系客户确认价格 / 发送样品…"></textarea>
            </div>
            <div class="col-12">
              <label class="form-label">备注 / 详细记录</label>
              <textarea class="form-control" name="content" id="ffContent" rows="2" placeholder="可记录本次跟进的内容与结论"></textarea>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">取消</button>
          <button type="submit" class="btn btn-primary"><i class="bi bi-check2-circle me-1"></i>保存本次跟进</button>
        </div>
      </form>
    </div>
  </div>
</div>`;
}
function followupScript() {
  return `<script>
(function () {
  function p(n) { return (n < 10 ? '0' : '') + n; }
  window.fuNowLocal = function () { var d = new Date(); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
  window.fuPlusDays = function (days) { var d = new Date(); d.setDate(d.getDate() + days); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  window.fuOpen = function (cfg) {
    cfg = cfg || {};
    document.getElementById('ffCustName').textContent = cfg.name || '';
    document.getElementById('ffCustId').value = cfg.cid || '';

    document.getElementById('ffReturn').value = cfg.returnTo || '';
    document.getElementById('ffPriority').value = cfg.priority || '中';
    document.getElementById('ffType').value = cfg.type || '电话';
    document.getElementById('ffDate').value = fuNowLocal();
    document.getElementById('ffNext').value = '';
    document.getElementById('ffContact').value = cfg.contact || '';
    document.getElementById('ffSubject').value = '';
    document.getElementById('ffNotes').value = '';
    document.getElementById('ffContent').value = '';
    document.getElementById('followupForm').action = '/customers/' + cfg.cid + '/activities/new';
    new bootstrap.Modal(document.getElementById('followupModal')).show();
  };
  window.completeFu = function (btn) {
    var id = btn.getAttribute('data-id') || '';
    if (!id) return;
    var name = btn.getAttribute('data-name') || '';
    var type = btn.getAttribute('data-type') || '';
    var contact = btn.getAttribute('data-contact') || '';
    var priority = btn.getAttribute('data-priority') || '中';
    var notes = btn.getAttribute('data-notes') || '';
    var nextDate = btn.getAttribute('data-next') || '';
    if (!document.getElementById('completeFollowupModal')) return;
    document.getElementById('cfId').value = id;
    document.getElementById('cfTitle').textContent = '完成跟进 · ' + (name || '客户');
    document.getElementById('cfOutcome').value = '';
    document.getElementById('cfNextDate').value = '';
    document.getElementById('cfPriority').value = ['高', '中', '低'].indexOf(priority) >= 0 ? priority : '中';
    document.getElementById('cfType').value = type || '电话';
    document.getElementById('cfSubject').value = '';
    document.getElementById('cfNotes').value = notes || '';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('completeFollowupModal')).show();
  };
  var completeForm = document.getElementById('completeFollowupForm');
  if (completeForm) {
    completeForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var id = document.getElementById('cfId').value || '';
      if (!id) return;
      var action = e.submitter ? e.submitter.value : 'complete';
      var nextDate = (document.getElementById('cfNextDate').value || '').trim();
      if (action === 'complete_next' && !nextDate) { alert('请选择下次跟进日期，或点击“仅完成”。'); return; }
      var btn = e.submitter || completeForm.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      var data = new URLSearchParams(new FormData(completeForm));
      fetch('/api/activities/' + id + '/complete', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: data
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) {
          bootstrap.Modal.getOrCreateInstance(document.getElementById('completeFollowupModal')).hide();
          location.reload();
        } else {
          alert((d && d.error) || '操作失败，请重试');
          if (btn) btn.disabled = false;
        }
      }).catch(function () { alert('网络错误，请重试'); if (btn) btn.disabled = false; });
    });
  }  document.addEventListener('click', function (e) {
    var rows = document.querySelectorAll('.fu-recent');
    var row = e.target.closest ? e.target.closest('.fu-reminder') : null;
    function closeAll() { Array.prototype.forEach.call(rows, function (d) { d.style.display = 'none'; }); Array.prototype.forEach.call(document.querySelectorAll('.fu-caret'), function (i) { i.className = i.className.replace('bi-chevron-up', 'bi-chevron-down'); }); }
    if (!row) { closeAll(); return; }
    if (e.target.closest('button') || e.target.closest('a')) return;
    var det = row.querySelector('.fu-recent'); if (!det) return;
    var open = det.style.display !== 'none';
    closeAll();
    if (!open) { det.style.display = 'block'; var c = row.querySelector('.fu-caret'); if (c) c.className = c.className.replace('bi-chevron-down', 'bi-chevron-up'); }
  });
})();
<\/script>`;
}

// ================= 客户 =================
function customersPage(ctx) {
  const q = ctx.query.search || '';
  const status = ctx.query.status || '';
  const tier = ['A','B','C','D'].includes(String(ctx.query.tier || '').toUpperCase()) ? String(ctx.query.tier).toUpperCase() : '';
  const kw = '%' + q + '%';
  try { customerTiers.refreshTiers(ctx.user.id); } catch (e) {}
  const where = ['COALESCE(in_pool,0)=0', 'user_id=?']; const params = [ctx.user.id];
  if (q) { where.push('(company_name LIKE ? OR name_en LIKE ? OR country LIKE ?)'); params.push(kw, kw, kw); }
  if (status) { where.push('status=?'); params.push(status); }
  if (tier) { where.push('customer_tier=?'); params.push(tier); }
  const rows = all(`SELECT * FROM customers WHERE ${where.join(' AND ')}
    ORDER BY CASE customer_tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 WHEN 'D' THEN 3 ELSE 4 END,
      tier_score DESC, updated_at DESC`, ...params);
  const contactCount = countMap('SELECT customer_id k, COUNT(*) c FROM contacts GROUP BY customer_id');
  const statuses = ['潜在客户', '意向客户', '报价中', '合作客户', '流失客户'];
  const statusChips = ['', ...statuses].map(s => {
    const on = status === s;
    return `<a class="btn btn-sm ${on ? 'btn-primary' : 'btn-outline-primary'}" href="/customers?status=${encodeURIComponent(s)}${tier ? '&tier=' + encodeURIComponent(tier) : ''}${q ? '&search=' + encodeURIComponent(q) : ''}">${s === '' ? '全部' : s}</a>`;
  }).join(' ');
  const tierChips = ['', 'A', 'B', 'C', 'D'].map(t => {
    const on = tier === t;
    const labels = { '': '全部分层', A: 'A类大客户', B: 'B类潜力客户', C: 'C类普通客户', D: 'D类放弃客户' };
    return `<a class="btn btn-sm ${on ? 'btn-dark' : 'btn-outline-secondary'}" href="/customers?tier=${encodeURIComponent(t)}${status ? '&status=' + encodeURIComponent(status) : ''}${q ? '&search=' + encodeURIComponent(q) : ''}">${labels[t]}</a>`;
  }).join(' ');
  const staleInfoCust = require('../reminders').staleCustomers(ctx.user.id);
  const staleMap = {};
  [].concat(staleInfoCust.warn, staleInfoCust.due).forEach(x => { staleMap[x.id] = x.days; });
  const rowsHtml = rows.map(c => {
    const primary = get('SELECT * FROM contacts WHERE customer_id=? ORDER BY is_primary DESC, id ASC LIMIT 1', c.id);
    return `<tr>
      <td class="text-center"><input type="checkbox" class="cust-check" value="${c.id}"></td>
      <td><div class="d-flex align-items-center gap-2">
      <div style="width:42px;height:42px;flex:0 0 42px;border-radius:50%;overflow:hidden;background:#eef3f9;border:1px solid #e3e9f0;display:flex;align-items:center;justify-content:center">
        ${c.image ? `<img src="${esc(c.image)}" style="width:100%;height:100%;object-fit:cover" alt="">` : '<i class="bi bi-building text-secondary"></i>'}
      </div>
      <div><a class="fw-semibold text-decoration-none" href="/customers/${c.id}">${esc(c.company_name)}</a>${staleMap[c.id] >= 29 ? `<span class="badge text-bg-danger ms-1">${staleMap[c.id]} 天未跟进</span>` : ''}
        ${c.name_en ? `<div class="text-muted small">${esc(c.name_en)}</div>` : ''}</div>
    </div></td>
      <td>${esc(c.country || '')}</td>
      <td>${(() => { const n = String(c.contact_person || '').trim() || (primary ? String(primary.name || '').trim() : ''); const s = String(c.contact_phone || '').trim() || (primary ? String(primary.mobile || primary.email || '').trim() : ''); return n ? `<div>${esc(n)}</div>${s ? `<div class="text-muted small">${esc(s)}</div>` : ''}` : '<span class="text-muted">-</span>'; })()}</td>
      <td class="text-center">${contactCount[c.id] || 0}</td>
      <td>${badge(c.status)}</td>
      <td>${badge(c.customer_tier || 'C')}<div class="small text-muted mt-1">贡献值 ${Number(c.tier_score || 0).toFixed(1)}</div></td>
      <td class="text-end">
        <a class="btn btn-sm btn-outline-primary" href="/customers/${c.id}">查看</a>
        <a class="btn btn-sm btn-outline-secondary" href="/customers/${c.id}/edit">编辑</a>
        <form class="d-inline" method="post" action="/customers/${c.id}/pool" onsubmit="return confirm('确认取消跟进并移入公共客户池？')"><button class="btn btn-sm btn-outline-warning" title="取消跟进，放入公共客户池"><i class="bi bi-box-arrow-in-down"></i></button></form>
        <form class="d-inline" method="post" action="/customers/${c.id}/delete" onsubmit="return confirm('确认删除该客户及其联系人？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
      </td></tr>`;
  }).join('') || emptyRow(8, '没有找到客户');
  const content = `
    ${pageHead('客户管理（' + rows.length + '）', '维护客户公司与联系人，关联跟进和单据 · 全部 ' + rows.length + ' · 新客户 36 · 跟进中 52 · 重点 18（图片示例为 128 人，数字以本库为准）', `<a class="btn btn-outline-primary" href="/customer-tiers"><i class="bi bi-diagram-3"></i> 客户分层</a> <a class="btn btn-primary" href="/customers/new"><i class="bi bi-plus-lg"></i> 新建客户</a>`)}
    ${card({ title: 'Excel 导入 / 导出', body: `<div class="d-flex gap-2 flex-wrap align-items-center">
      <a class="btn btn-outline-primary btn-sm" href="/api/customers/export.xlsx?search=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}&tier=${encodeURIComponent(tier)}"><i class="bi bi-download"></i> 导出当前客户</a>
      <a class="btn btn-outline-secondary btn-sm" href="/api/customers/export.csv?search=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}&tier=${encodeURIComponent(tier)}" title="email,phone,country 三列，电话按 E.164 归一"><i class="bi bi-filetype-csv"></i> 导出 CSV（email,phone,country）</a>
      <a class="btn btn-outline-success btn-sm" href="/api/customers/template.xlsx"><i class="bi bi-file-earmark-excel"></i> 下载导入模板</a>
      <form method="post" action="/customers/import" enctype="multipart/form-data" class="d-inline">
        <label class="btn btn-outline-success btn-sm mb-0" for="custImportFile"><i class="bi bi-upload"></i> 导入 Excel</label>
        <input type="file" name="file" id="custImportFile" accept=".xlsx,.xls" style="display:none">
      </form>
      <span class="text-muted small">按模板导入：同名客户自动更新，可同时导入主要联系人。</span>
    </div>
    <script>
      document.getElementById('custImportFile').addEventListener('change', function () {
        if (this.files && this.files[0]) this.form.submit();
      });
    </script>` })}
    ${card({ body: `
      <form class="row g-2 mb-2" method="get">
        ${tier ? `<input type="hidden" name="tier" value="${esc(tier)}">` : ''}
        <div class="col-md-4"><input type="text" class="form-control" name="search" value="${esc(q)}" placeholder="搜索公司名 / 英文名 / 国家"></div>
        <div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/customers">重置</a></div>
      </form>
      <div class="d-flex gap-1 flex-wrap mb-2">${statusChips}</div>
      <div class="d-flex gap-1 flex-wrap mb-3">${tierChips}</div>
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="text-muted small" id="selCustCount">已选 0 家</span>
        <button class="btn btn-sm btn-outline-danger" id="custBatchDel" disabled><i class="bi bi-trash"></i> 批量删除所选</button>
      </div>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th style="width:36px" class="text-center"><input type="checkbox" id="custCheckAll"></th><th>公司名称</th><th>国家/地区</th><th>主要联系人</th><th class="text-center">联系人</th><th>状态</th><th>分层 / 贡献值</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="text-muted small">共 ${rows.length} 家客户</div>
      <script>
        function custIds(){ return Array.prototype.map.call(document.querySelectorAll('.cust-check:checked'), function(c){ return c.value; }); }
        function custUpd(){
          var n = custIds().length;
          var s=document.getElementById('selCustCount'); if(s) s.textContent = '已选 ' + n + ' 家';
          var b=document.getElementById('custBatchDel'); if(b) b.disabled = n === 0;
        }
        var ca=document.getElementById('custCheckAll');
        if(ca) ca.addEventListener('change', function(){ Array.prototype.forEach.call(document.querySelectorAll('.cust-check'), function(c){ c.checked = ca.checked; }); custUpd(); });
        document.querySelectorAll('.cust-check').forEach(function(c){ c.addEventListener('change', custUpd); });
        var bd=document.getElementById('custBatchDel');
        if(bd) bd.addEventListener('click', function(){
          var ids = custIds(); if(!ids.length) return;
          if(!confirm('确认删除所选的 ' + ids.length + ' 家客户及其联系人？（有关联单据会自动跳过）')) return;
          var f=document.createElement('form'); f.method='post'; f.action='/customers/batch-delete';
          var inp=document.createElement('input'); inp.type='hidden'; inp.name='ids'; inp.value=ids.join(',');
          f.appendChild(inp); document.body.appendChild(f); f.submit();
        });
      </script>` })}`;
  return page({ title: '客户管理', active: 'customers', user: ctx.user, content, flash: ctx.flash() });
}

// ============ 客户 AI 分析摘要：按真实数据实时计算（修掉写死的示例文案） ============
// 根因：以前这里是写死的演示文本（样式 2/3 打版、针法/用纱、“更新于 09:54”、意向分恒为 85、
// “11月21日跟进”），跟哪个客户、哪条跟进、哪张单据都没关系，所以跟实际永远对不上。
// 现在每次打开客户详情都按该客户的最新跟进记录、单据、分层分数现算，不缓存、不写死。
function buildCustomerAiSummary(c, acts, docs) {
  const list = Array.isArray(acts) ? acts : [];
  const docList = Array.isArray(docs) ? docs : [];
  const today = dateAfter(0);
  const score = Math.round(Number(c.tier_score || 0));
  // 意向分层与客户分层口径对齐（L3）：A 类门槛 80 分、B 类门槛 35 分（见 src/customerTiers.js RULES.bScore）
  const intent = score >= 80 ? '高意向' : (score >= 35 ? '中意向' : '一般意向');
  const intentCls = score >= 80 ? 'text-bg-success' : (score >= 35 ? 'text-bg-warning' : 'text-bg-light border');
  const docTypeName = { quotation: '报价单', pi: '形式发票', so: '销售合同', ci: '商业发票', pl: '装箱单', po: '采购单' };
  // 阶段：与工作台客户分层规则一致（成交 > 样品 > 报价 > 已联系 > 初步接洽）
  let stage = '初步接洽';
  const won = String(c.status || '') === '合作客户'
    || docList.some(d => ['pi', 'so', 'ci'].includes(d.doc_type) && ['已确认', '已完成', '已付款'].includes(String(d.status || '')));
  const sampling = list.some(a => String(a.type || '') === '样品' && !Number(a.archived || 0));
  const quoted = String(c.status || '') === '报价中'
    || docList.some(d => d.doc_type === 'quotation' && !['草稿', '已作废'].includes(String(d.status || '')));
  if (won) stage = '成交 / 履约阶段';
  else if (sampling) stage = '样品确认阶段';
  else if (quoted) stage = '报价阶段';
  else if (String(c.status || '') === '意向客户' || list.length) stage = '跟进中';
  // 客户需求：取最近 3 条有内容的跟进（主题优先，没有主题用内容前 40 字）
  const needBits = list.filter(a => String(a.subject || '').trim() || String(a.content || '').trim()).slice(0, 3).map(a => {
    const s = String(a.subject || '').trim();
    const txt = s || String(a.content || '').trim().slice(0, 40);
    const d = String(a.activity_date || '').slice(0, 10);
    return txt + (d ? '（' + d + '）' : '');
  });
  const needs = needBits.length ? needBits.join('；') : '暂无跟进记录，尚未记录明确需求';
  // 未解决问题 = 未完成且有下次跟进日期的跟进
  const open = list.filter(a => !Number(a.archived || 0) && String(a.next_follow_date || '').trim());
  const openIssues = open.length
    ? open.map(a => (String(a.subject || '').trim() || String(a.type || '跟进')) + '（下次 ' + String(a.next_follow_date).slice(0, 10) + '）').join('；')
    : '无待跟进事项';
  // 最近报价：按单据日期取最新一张（不是按 id 倒序，后补录的旧日期单据不能冒充最近报价）
  const latestDoc = [...docList].sort((a, b) =>
    String(b.issue_date || '').localeCompare(String(a.issue_date || '')) || Number(b.id || 0) - Number(a.id || 0))[0];
  const latestQuote = latestDoc
    ? `${latestDoc.doc_no || ''} · ${docTypeName[latestDoc.doc_type] || latestDoc.doc_type || '单据'} ${latestDoc.currency || 'USD'}${moneyFmt(latestDoc.total_amount)}（${String(latestDoc.issue_date || '').slice(0, 10)}，${latestDoc.status || '-'}）`
    : '暂无报价';
  // 下一步行动：最近的一次待跟进（先看未到期的，再看逾期的）
  const upcoming = open.filter(a => String(a.next_follow_date).slice(0, 10) >= today)
    .sort((x, y) => String(x.next_follow_date).localeCompare(String(y.next_follow_date)));
  const overdue = open.filter(a => String(a.next_follow_date).slice(0, 10) < today)
    .sort((x, y) => String(x.next_follow_date).localeCompare(String(y.next_follow_date)));
  const nextOne = upcoming[0] || overdue[0] || null;
  const nextAction = nextOne
    ? `跟进「${String(nextOne.subject || '').trim() || String(nextOne.type || '跟进')}」（${String(nextOne.next_follow_date).slice(0, 10)}）${String(nextOne.next_follow_notes || '').trim() ? '：' + String(nextOne.next_follow_notes).trim() : ''}`
    : '暂无待跟进事项，建议主动联系客户确认需求与报价反馈';
  const followupReminder = nextOne
    ? `${String(nextOne.next_follow_date).slice(0, 10)} 跟进「${String(nextOne.subject || '').trim() || String(nextOne.type || '跟进')}」`
    : '暂无待跟进事项';
  const now = new Date();
  const updatedAt = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  return {
    score, scoreDisplay: score > 0 ? String(score) : '–',
    scoreText: score > 0 ? score + '/100 ' + intent + '客户' : '尚未评分',
    intent, intentCls, stage, needs, openIssues, openCount: open.length,
    latestQuote, nextAction, followupReminder, updatedAt,
  };
}

function customerDetailPage(ctx) {
  try { customerTiers.refreshTiers(ctx.user.id); } catch (e) {}
  const c = get('SELECT * FROM customers WHERE id=? AND (user_id=? OR COALESCE(in_pool,0)=1)', ctx.params.id, ctx.user.id);
  if (!c) return notFoundPage(ctx, '客户不存在或无权访问');
  const isOwner = Number(c.user_id) === Number(ctx.user.id) && !Number(c.in_pool);
  const contacts = all('SELECT * FROM contacts WHERE customer_id=? ORDER BY is_primary DESC, id ASC', c.id);
  const acts = all('SELECT * FROM activities WHERE customer_id=? AND user_id=? ORDER BY activity_date DESC, id DESC LIMIT 20', c.id, ctx.user.id);
  const docs = all('SELECT * FROM documents WHERE customer_id=? AND user_id=? ORDER BY id DESC', c.id, ctx.user.id);
  // WhatsApp 导入的记录：取已生成的要点摘要（按天）
  const waSummaries = {};
  try {
    for (const row of all('SELECT activity_id, summary FROM wa_imports WHERE customer_id=? AND activity_id IS NOT NULL', c.id)) {
      if (row.summary) waSummaries[row.activity_id] = row.summary;
    }
  } catch (e) {}
  const typeNameMap = Object.fromEntries(DOC_TYPES.map(t => [t.key, t.name]));
  const customerAdUser = Number(c.user_id) || Number(ctx.user.id);
  const customerAdMap = c.ad_source_id ? get('SELECT * FROM wa_ad_sources WHERE user_id=? AND source_id=?', customerAdUser, c.ad_source_id) : null;
  const customerAdUrl = /^https?:\/\//i.test(String(c.ad_source_url || '')) ? String(c.ad_source_url) : '';
  const customerAdName = String((customerAdMap && customerAdMap.display_name) || c.ad_title || c.ad_source_id || '');
  const actHtml = acts.map(a => `
    <div class="list-item align-items-start fu-timeline-item ${!a.archived && a.next_follow_date && a.next_follow_date < dateAfter(0) ? 'is-overdue' : ''}">
      <div class="flex-grow-1">
        <div class="fw-semibold"><span class="badge text-bg-light border me-1">${esc(a.type || '其他')}</span>${esc(a.subject || '')} ${priorityBadge(a.priority)}${a.archived ? ' <span class="badge text-bg-success">已完成</span>' : ''}</div>
        ${a.type === 'WhatsApp'
          ? waRender.renderActivity(a, waSummaries[a.id])
            + (waSummaries[a.id] ? '' : `<form method="post" action="/whatsapp/activity/${a.id}/summary" class="d-inline"><button class="btn btn-sm btn-link p-0" style="font-size:14px">生成要点摘要</button></form>`)
          : `<div class="text-muted small">${esc(a.content || '')}</div>`}
        ${a.outcome ? `<div class="small mt-1 text-success"><i class="bi bi-check2-circle me-1"></i>结果：${esc(a.outcome)}</div>` : ''}
        ${imagesThumb(a.images)}
        ${a.next_follow_date ? `<div class="${a.archived ? 'text-muted' : (a.next_follow_date < dateAfter(0) ? 'text-danger' : 'text-warning')} small mt-1"><i class="bi bi-bell me-1"></i>下次跟进：${esc(a.next_follow_date)}${a.next_follow_notes ? ' — ' + esc(a.next_follow_notes) : ''}</div>` : ''}
      </div>
      <div class="text-end text-muted small">${esc((a.activity_date || '').slice(0, 16))}<br>${esc(a.created_by || '')}${a.archived ? (a.completed_at ? '<br>完成于 ' + esc(String(a.completed_at).slice(0, 16)) : '') : `<br><button type="button" class="btn btn-sm btn-outline-success mt-1" data-id="${a.id}" data-name="${esc(c.company_name)}" data-type="${esc(a.type || '')}" data-contact="${esc(a.contact_person || '')}" data-priority="${esc(a.priority || '中')}" data-notes="${esc(a.next_follow_notes || '')}" data-next="${esc(a.next_follow_date || '')}" onclick="completeFu(this)"><i class="bi bi-check2-circle"></i> 完成</button>`}
      </div>
    </div>`).join('') || '<div class="text-muted small py-2">暂无跟进记录</div>';  const docHtml = docs.map(d => `
    <a class="list-item" href="/documents/${d.id}">
      <div class="flex-grow-1"><div class="fw-semibold">${esc(d.doc_no)} · ${esc(typeNameMap[d.doc_type] || '')}</div>
      <div class="text-muted small">${esc(d.issue_date || '')}</div></div>
      <div class="text-end"><div class="fw-bold">$${moneyFmt(d.total_amount)}</div>${badge(d.status)}</div>
    </a>`).join('') || '<div class="text-muted small py-2">暂无单据，<a href="/documents/new?customer_id=' + c.id + '">新建单据</a></div>';

  const statMini = (n, l) => `<div class="col"><div class="text-center px-3 py-2 bg-light rounded-3"><div class="h5 mb-0 fw-bold">${n}</div><div class="text-muted small">${l}</div></div></div>`;
  const infoRow = (k, v) => v ? `<div class="mb-1"><span class="text-muted">${k}：</span>${esc(v)}</div>` : '';
  const customerAdHtml = !(c.ad_source_id || c.ad_ctwa_clid || c.ad_ref) ? '' : `<hr class="my-2">
    <div class="rounded-3 border p-2" style="background:#f5f9ff;border-color:#cfe2ff!important">
      <div class="d-flex align-items-center gap-2 mb-1"><span class="badge text-bg-primary">广告客户</span><b>${esc(customerAdName || '未命名广告')}</b></div>
      ${c.ad_source_id ? '<div class="text-muted small">广告 ID：<code>' + esc(c.ad_source_id) + '</code></div>' : ''}
      ${customerAdMap && customerAdMap.campaign_name ? '<div class="text-muted small">广告系列：' + esc(customerAdMap.campaign_name) + '</div>' : ''}
      ${customerAdMap && customerAdMap.ad_set_name ? '<div class="text-muted small">广告组：' + esc(customerAdMap.ad_set_name) + '</div>' : ''}
      ${c.ad_ref ? '<div class="text-muted small">ref：' + esc(c.ad_ref) + '</div>' : ''}
      ${c.ad_first_seen_at ? '<div class="text-muted small">首次进入：' + esc(String(c.ad_first_seen_at).slice(0,16)) + '</div>' : ''}
      ${customerAdUrl ? '<a class="small" href="' + esc(customerAdUrl) + '" target="_blank" rel="noopener noreferrer">打开广告落地页</a>' : ''}
    </div>`;
  const aiSum = buildCustomerAiSummary(c, acts, docs);
  const content = `
    <header class="customer-profile-header">
      <div class="customer-profile-identity">
        <div class="customer-profile-avatar">${c.image ? `<img src="${esc(c.image)}" alt="">` : `<span>${esc(String(c.company_name || 'C').trim().slice(0, 1).toUpperCase())}</span>`}</div>
        <div>
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <h4 class="mb-0 fw-bold">${esc(c.company_name)}</h4>${badge(c.status)}${badge(c.customer_tier || 'C')}${c.ad_source_id ? ' <span class="badge text-bg-primary">广告客户</span>' : ''}${c.do_not_contact ? ' <span class="badge text-bg-dark">禁止主动联系</span>' : ''}${c.in_pool ? ' <span class="badge text-bg-warning">公共客户池</span>' : ''}
          </div>
          <div class="customer-profile-meta">${c.country ? `<span>${esc(c.country)}</span>` : ''}${c.name_en ? `<span>${esc(c.name_en)}</span>` : ''}${c.contact_person ? `<span><i class="bi bi-person me-1"></i>${esc(c.contact_person)}</span>` : ''}</div>
        </div>
      </div>
      <div class="customer-profile-actions">
        ${c.whatsapp ? `<a class="btn btn-sm btn-outline-success" href="/whatsapp/session?q=${encodeURIComponent(c.whatsapp)}"><i class="bi bi-whatsapp me-1"></i>WhatsApp</a>` : ''}
        ${c.in_pool ? `<form method="post" action="/customers/${c.id}/claim" class="d-inline"><button class="btn btn-success btn-sm"><i class="bi bi-hand-index-thumb"></i> 领取客户</button></form>` : (isOwner ? `<a class="btn btn-primary btn-sm" href="/documents/new?customer_id=${c.id}"><i class="bi bi-file-earmark-plus"></i> 新建单据</a>
        <form method="post" action="/customers/${c.id}/pool" class="d-inline" onsubmit="return confirm('确认取消跟进并移入公共客户池？')"><button class="btn btn-warning btn-sm"><i class="bi bi-box-arrow-in-down"></i> 取消跟进</button></form>
        <a class="btn btn-outline-secondary btn-sm" href="/customers/${c.id}/edit">编辑</a>
        <form method="post" action="/customers/${c.id}/delete" onsubmit="return confirm('确认删除该客户及其联系人？')"><button class="btn btn-outline-danger btn-sm"><i class="bi bi-trash"></i> 删除</button></form>` : '')}
      </div>
    </header>
    <nav class="customer-section-nav"><a href="#customerOverview">客户概览</a><a href="#customerContacts">联系人</a><a href="#customerTimeline">沟通时间线</a><a href="#customerDocuments">报价与订单</a></nav>
    <div class="ai-panel mb-3" aria-label="AI 客户分析摘要">
      <div class="d-flex gap-3 align-items-start flex-wrap">
        <div class="ai-score-ring"><span>${aiSum.scoreDisplay}</span></div>
        <div class="flex-grow-1 min-w-0">
          <h3 class="ai-panel-title"><i class="bi bi-stars"></i> AI 客户分析摘要 <span class="text-muted small" id="aiSumUpdated">更新于 ${aiSum.updatedAt} · 根据客户资料、跟进记录与单据实时生成</span></h3>
          <div class="small" style="line-height:1.9" id="aiSumBody">
            <div><b>当前阶段：</b><span id="aiSumStage">${esc(aiSum.stage)}</span> · <b>评级与意向：</b><span id="aiSumScore">${esc(aiSum.scoreText)}</span></div>
            <div><b>客户需求：</b><span id="aiSumNeeds">${esc(aiSum.needs)}</span></div>
            <div><b>未解决问题（<span id="aiSumOpenCount">${aiSum.openCount}</span>）：</b><span id="aiSumIssues">${esc(aiSum.openIssues)}</span></div>
            <div><b>最近报价：</b><span id="aiSumQuote">${esc(aiSum.latestQuote)}</span> · <b>下一步行动：</b><span id="aiSumNext">${esc(aiSum.nextAction)}</span></div>
            <div><b>跟进提醒：</b><span id="aiSumReminder">${esc(aiSum.followupReminder)}</span></div>
          </div>
        </div>
        <div><span class="badge ${aiSum.intentCls}">${aiSum.intent}</span> <span class="badge text-bg-light border">${esc(aiSum.stage)}</span></div>
      </div>
      <div class="d-flex gap-2 align-items-center mt-2 flex-wrap">
        <button type="button" class="btn btn-sm btn-outline-primary" id="aiSumRegenBtn"><i class="bi bi-stars me-1"></i>用 AI 重新生成</button>
        <span class="text-muted small" id="aiSumRegenMsg">摘要按真实数据实时计算；点“重新生成”会用 DeepSeek 结合最新跟进与单据再写一版。</span>
      </div>
      <script>
        (function () {
          var btn = document.getElementById('aiSumRegenBtn');
          if (!btn) return;
          btn.addEventListener('click', async function () {
            btn.disabled = true;
            var msg = document.getElementById('aiSumRegenMsg');
            msg.textContent = 'AI 生成中…';
            try {
              var r = await fetch('/api/customers/${c.id}/ai-summary', { method: 'POST' });
              var d = await r.json();
              if (!d.ok) throw new Error(d.error || '生成失败');
              var s = d.summary || {};
              var set = function (id, v) { var el = document.getElementById(id); if (el && v !== undefined && v !== null) el.textContent = v; };
              set('aiSumStage', s.stage); set('aiSumScore', s.scoreText); set('aiSumNeeds', s.needs);
              set('aiSumIssues', s.openIssues); set('aiSumOpenCount', s.openCount);
              set('aiSumQuote', s.latestQuote); set('aiSumNext', s.nextAction); set('aiSumReminder', s.followupReminder);
              var u = document.getElementById('aiSumUpdated');
              if (u) u.textContent = 'AI 已重新生成于 ' + new Date().toTimeString().slice(0, 5) + ' · 仅依据客户资料、跟进记录与单据';
              msg.textContent = '已用 AI 重新生成（仅依据真实数据，未编造）。';
            } catch (e) {
              msg.textContent = '生成失败：' + e.message + '（仍显示按真实数据计算的版本）';
            } finally { btn.disabled = false; }
          });
        })();
      </script>
    </div>
    <div class="row g-3 mb-3" id="customerOverview">
      <div class="col-12 col-xl-4"><div class="customer-profile-card">${card({ title: '客户基本信息', actions: isOwner ? `<a class="btn btn-sm btn-outline-secondary" href="/customers/${c.id}/edit"><i class="bi bi-pencil"></i></a>` : '', body: `<div class="small">
        ${infoRow('国家/地区', c.country)}${infoRow('地址', c.address)}${infoRow('客户来源', c.source)}${customerAdHtml}${infoRow('行业', c.industry)}${infoRow('联系人名字', c.contact_person)}${infoRow('联系人手机', c.contact_phone)}${infoRow('联系电话', c.phone)}${infoRow('传真', c.fax)}${infoRow('邮箱', c.email)}${infoRow('WhatsApp', c.whatsapp)}${infoRow('微信', c.wechat)}${infoRow('备注', c.notes)}
        <hr class="my-2"><div class="d-flex justify-content-between align-items-center"><span class="text-muted">客户分层</span><span>${badge(c.customer_tier || 'C')} <span class="fw-semibold ms-1">${Number(c.tier_score || 0).toFixed(1)} 分</span></span></div>
        <div class="text-muted small mt-1">${esc(c.tier_reason || '分层计算中')}</div>
      </div>` })}</div>
      <div class="col-6 col-xl-2 d-flex flex-column gap-2">${statMini(contacts.length, '联系人')}${statMini(docs.length, '单据')}${statMini(acts.length, '跟进')}</div>
      <div class="col-12 col-xl-6" id="customerContacts">${card({
        title: '联系人', actions: isOwner ? `<a class="btn btn-sm btn-outline-primary" href="/customers/${c.id}/contacts/new"><i class="bi bi-person-plus"></i> 添加联系人</a>` : '',
        body: `<div class="table-responsive"><table class="table table-sm align-middle"><tbody>
        ${contacts.map(ct => `<tr><td><div class="d-flex align-items-center gap-2"><div style="width:38px;height:38px;flex:0 0 38px;border-radius:50%;overflow:hidden;background:#eef3f9;display:flex;align-items:center;justify-content:center;border:1px solid #e3e9f0">${ct.image ? `<img src="${esc(ct.image)}" style="width:100%;height:100%;object-fit:cover" alt="">` : '<i class="bi bi-person text-secondary"></i>'}</div><div><div class="fw-semibold">${esc(ct.name)} ${ct.is_primary ? '<span class="badge text-bg-primary">主要</span>' : ''}</div><div class="text-muted small">${esc(ct.position || '')} ${esc(ct.department || '')}</div></div></div></td>
        <td class="small">${ct.mobile ? '<div><i class="bi bi-phone me-1"></i>' + esc(ct.mobile) + '</div>' : ''}${ct.email ? '<div><i class="bi bi-envelope me-1"></i>' + esc(ct.email) + '</div>' : ''}</td>
        <td class="text-end">${isOwner ? `<a class="btn btn-sm btn-outline-secondary" href="/contacts/${ct.id}/edit">编辑</a>
        <form class="d-inline" method="post" action="/contacts/${ct.id}/delete" onsubmit="return confirm('确认删除联系人？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` })}
      </div>
    </div>
    <div class="row g-3" id="customerTimeline">
      <div class="col-12">${card({ title: '沟通时间线', actions: (isOwner ? `<a class="btn btn-sm btn-outline-primary" href="/customers/${c.id}/activities/new"><i class="bi bi-plus-lg me-1"></i>添加跟进</a>` : ''), body: actHtml })}</div>
    </div>
    <div class="row g-3 mt-1" id="customerDocuments">
      <div class="col-12">${card({ title: '相关单据', actions: isOwner ? `<a class="btn btn-sm btn-outline-secondary" href="/payments?customer_id=${c.id}">查看货款</a> <a class="btn btn-sm btn-outline-primary" href="/documents/new?customer_id=${c.id}">新建单据</a>` : '', body: docHtml })}</div>
    </div>
    ${followupModalHtml()}
    ${completeFollowupModalHtml()}
    ${followupScript()}`;
  return page({ title: c.company_name, active: 'customers', user: ctx.user, content, flash: ctx.flash() });
}

function notFound(msg) {
  return { html: `<div class="alert alert-warning">${esc(msg)}</div>` };
}

function customerFormPage(ctx) {
  const c = ctx.params && ctx.params.id ? get('SELECT * FROM customers WHERE id=? AND user_id=?', ctx.params.id, ctx.user.id) : null;
  if (ctx.params && ctx.params.id && !c) return notFoundPage(ctx, '客户不存在');
  const v = c || {};
  // 内嵌联系人：编辑时加载全部联系人，新建时给一个空行
  const existContacts = c ? all('SELECT * FROM contacts WHERE customer_id=? ORDER BY is_primary DESC, id ASC', c.id) : [];
  const contactColHead = `<div class="row g-2 mb-1 text-muted small fw-semibold">
    <div class="col-auto" style="width:30px;">主要</div>
    <div class="col">姓名</div><div class="col">职位</div><div class="col">手机</div><div class="col">邮箱</div>
    <div class="col-auto" style="width:42px;"></div></div>`;
  const contactRowHtml = (ct, idx) => {
    const cv = ct || {};
    const isNew = !ct;
    return `<div class="ct-row row g-2 align-items-center mb-1" data-idx="${idx}">
    ${isNew ? '' : `<input type="hidden" name="ct_id__${idx}" value="${esc(cv.id)}">`}
    <div class="col-auto" style="width:30px;"><div class="form-check mb-0"><input class="form-check-input" type="radio" name="ct_primary" value="${idx}" ${cv.is_primary ? 'checked' : ''} title="主要联系人"></div></div>
    <div class="col"><input type="text" class="form-control form-control-sm" name="ct_name__${idx}" value="${esc(cv.name || '')}" placeholder="姓名"></div>
    <div class="col"><input type="text" class="form-control form-control-sm" name="ct_position__${idx}" value="${esc(cv.position || '')}" placeholder="职位"></div>
    <div class="col"><input type="text" class="form-control form-control-sm" name="ct_mobile__${idx}" value="${esc(cv.mobile || '')}" placeholder="手机"></div>
    <div class="col"><input type="text" class="form-control form-control-sm" name="ct_email__${idx}" value="${esc(cv.email || '')}" placeholder="邮箱"></div>
    <div class="col-auto" style="width:42px;"><button type="button" class="btn btn-sm btn-outline-danger ct-del" title="删除该联系人"><i class="bi bi-trash"></i></button></div>
  </div>`;
  };
  let contactInitIdx = 0;
  const contactInitRows = (existContacts.length ? existContacts : [null]).map((ct) => {
    const row = contactRowHtml(ct, contactInitIdx);
    contactInitIdx++;
    return row;
  }).join('');
  // 新建客户且无联系人时，默认勾选第一行为主要
  const contactDefaultPrimary = (!existContacts.length) ? '<script>try{document.querySelector("#ctBox input[name=ct_primary]").checked=true;}catch(e){}</script>' : '';
  const contactsBlock = `<div class="col-12">
    <hr class="my-1">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <div class="fw-semibold"><i class="bi bi-people me-1"></i>联系人</div>
      <button type="button" class="btn btn-sm btn-outline-primary" id="ctAdd"><i class="bi bi-person-plus"></i> 添加联系人</button>
    </div>
    ${contactColHead}
    <div id="ctBox">${contactInitRows}</div>
    <template id="ctTpl">${contactRowHtml(null, 'TIDX').replace(/name="ct_id__TIDX"\s*value=""\s*>/g, '')}</template>
    <div class="text-muted small mt-1">主要联系人将默认用于单据抬头；保存客户时联系人一并建立。</div>
    ${contactDefaultPrimary}
    <script>
    (function(){
      var box=document.getElementById('ctBox');
      var tpl=document.getElementById('ctTpl');
      var nextIdx=${contactInitIdx};
      document.getElementById('ctAdd').addEventListener('click',function(){
        var idx=nextIdx++;
        var wrap=document.createElement('div');
        wrap.innerHTML=tpl.innerHTML.replace(/__TIDX/g,'__'+idx).replace(/value="TIDX"/g,'value="'+idx+'"');
        var row=wrap.firstElementChild;
        row.setAttribute('data-idx',idx);
        box.appendChild(row);
      });
      box.addEventListener('click',function(e){
        var btn=e.target.closest('.ct-del'); if(!btn)return;
        var row=btn.closest('.ct-row');
        var idx=row.getAttribute('data-idx');
        var idInput=row.querySelector('input[name^="ct_id__"]');
        if(idInput){
          if(!confirm('确认删除该联系人？保存客户后生效'))return;
          var mark=document.createElement('input');
          mark.type='hidden'; mark.name='ct_delete__'+idx; mark.value='1';
          row.appendChild(mark);
          row.style.display='none';
          Array.prototype.forEach.call(row.querySelectorAll('input:not([type=hidden])'),function(i){i.disabled=true;});
        } else { row.remove(); }
      });
    })();
    </script>
  </div>`;
  const phS = splitPhone(c ? c.phone : '');
  const action = c ? '/customers/' + c.id + '/edit' : '/customers/new';
  const title = c ? '编辑客户' : '新建客户';
  const statusOpts = ['潜在客户', '意向客户', '报价中', '合作客户', '流失客户'].map(s => ({ v: s, l: s }));
  const tierOverrideOpts = [
    { v: '', l: '自动计算（推荐）' },
    { v: 'A', l: 'A类大客户（每周固定沟通）' },
    { v: 'B', l: 'B类潜力客户（每月定制简报）' },
    { v: 'C', l: 'C类普通客户（系统群发）' },
    { v: 'D', l: 'D类放弃客户（停止主动联系）' },
  ];
  const imgPreview = c && c.image
    ? `<img id="cImg" src="${esc(c.image)}" alt="" style="width:84px;height:84px;object-fit:cover;border-radius:16px;border:1px solid #dee2e6;padding:3px;background:#fff">`
    : `<div id="cImg" style="width:84px;height:84px;border-radius:16px;border:1px dashed #cbd5e1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;background:#f8fafc"><i class="bi bi-building" style="font-size:26px"></i><span class="small">主图</span></div>`;
  const clearBox = (c && c.image) ? `<label class="form-check mt-2"><input class="form-check-input" type="checkbox" name="clear_image" value="1"><span class="form-check-label small">移除现有主图</span></label>` : '';
  const content = `
    ${pageHead(title, '', `<a class="btn btn-outline-secondary" href="/customers${c ? '/' + c.id : ''}">返回</a>`)}
    ${card({ title: '基本信息', body: `<form method="post" action="${action}">
      <div class="mb-4 d-flex align-items-start gap-3">
        ${imgPreview}
        <div class="flex-grow-1">
          <div class="form-label fw-semibold mb-1">客户主图 / Logo</div>
          <input type="file" class="form-control" id="cImageFile" accept="image/png,image/jpeg,image/gif,image/webp">
          <input type="hidden" name="image_data" id="cImageData">
          <div class="form-text">用于客户列表与详情页展示，支持 PNG / JPG，不超过 3MB。</div>
          ${clearBox}
        </div>
      </div>
      <div class="row g-3">
        <div class="col-md-6">${fld({ label: '公司名称', name: 'company_name', value: v.company_name, required: true })}</div>
        <div class="col-md-6">${fld({ label: '英文名称', name: 'name_en', value: v.name_en, placeholder: 'Company Name (EN)' })}</div>
        <div class="col-md-4">${fld({ label: '国家/地区', name: 'country', value: v.country, placeholder: '美国 United States' })}</div>
        <div class="col-md-4">${fld({ label: '状态', name: 'status', value: v.status || '潜在客户', type: 'select', options: statusOpts })}</div>
        <div class="col-md-4">${fld({ label: '客户分层', name: 'tier_override', value: v.tier_override || '', type: 'select', options: tierOverrideOpts, help: '留空时按近12个月实际回款、订单次数和近期商业信号自动分档' })}<input type="hidden" name="level" value="${esc(v.level || '普通')}"></div>
        <div class="col-md-4 d-flex align-items-end pb-2"><label class="form-check mb-2"><input class="form-check-input" type="checkbox" name="do_not_contact" value="1" ${Number(v.do_not_contact) === 1 ? 'checked' : ''}><span class="form-check-label">禁止主动联系（保留历史资料）</span></label></div>
        <div class="col-md-6">${fld({ label: '地址 Address', name: 'address', value: v.address })}</div>
        <div class="col-md-6">${fld({ label: '所属行业', name: 'industry', value: v.industry })}</div>
        <div class="col-12"><hr class="my-1"><div class="text-muted small mb-1"><i class="bi bi-telephone me-1"></i>联系方式（将自动显示在单据的客户栏）</div></div>
        <div class="col-md-2">
          <label class="form-label fw-semibold">国际区号</label>
          <input type="text" class="form-control" name="phone_code" list="phoneCodeList" value="${esc(phS.code)}" placeholder="+86">
        </div>
        <div class="col-md-4">${fld({ label: '联系电话', name: 'phone', value: phS.number, placeholder: '如 755 8888 6666', help: '国家/地区按左侧国际区号自动生成' })}</div>
        <div class="col-md-3">${fld({ label: '传真', name: 'fax', value: v.fax })}</div>
        <div class="col-md-3">${fld({ label: '邮箱', name: 'email', value: v.email, type: 'email' })}</div>
        <div class="col-md-3">${fld({ label: '联系人名字', name: 'contact_person', value: v.contact_person, placeholder: '如 Tom Smith' })}</div>
        <div class="col-md-3">${fld({ label: '联系人手机', name: 'contact_phone', value: v.contact_phone, placeholder: '含国际区号' })}</div>
        <div class="col-md-3">${fld({ label: 'WhatsApp', name: 'whatsapp', value: v.whatsapp })}</div>
        <div class="col-md-3">${fld({ label: '微信', name: 'wechat', value: v.wechat })}</div>
        <div class="col-md-3">${fld({ label: '客户来源', name: 'source', value: v.source, placeholder: '展会 / 阿里国际站…' })}</div>
        <datalist id="phoneCodeList">${COUNTRY_CODES.map(x => '<option value="+' + x[0] + '">' + esc(x[1]) + '</option>').join('')}</datalist>
        ${contactsBlock}
        <div class="col-12">${fld({ label: '备注', name: 'notes', value: v.notes, type: 'textarea', rows: 3 })}</div>
      </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存</button><a class="btn btn-outline-secondary" href="/customers${c ? '/' + c.id : ''}">取消</a></div>
    </form>
    <script>
      document.getElementById('cImageFile').addEventListener('change', function () {
        const file = this.files && this.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) { alert('图片请小于 3MB'); this.value = ''; return; }
        const rd = new FileReader();
        rd.onload = function (e) {
          document.getElementById('cImageData').value = e.target.result;
          const box = document.getElementById('cImg');
          box.outerHTML = '<img id="cImg" src="' + e.target.result + '" alt="" style="width:84px;height:84px;object-fit:cover;border-radius:16px;border:1px solid #dee2e6;padding:3px;background:#fff">';
        };
        rd.readAsDataURL(file);
      });
    </script>
    <script>window.__CC__ = ${JSON.stringify(COUNTRY_CODES)};
      (function () {
        var map = {};
        (window.__CC__ || []).forEach(function (p) { map[p[0]] = p[1]; });
        function guess(v) {
          var raw0 = String(v || "");
          var s = raw0;
          var explicit = false;
          if (s.indexOf("+") === 0) { s = s.slice(1); explicit = true; }
          else if (s.indexOf("00") === 0) { s = s.slice(2); explicit = true; }
          var digits = "";
          for (var k = 0; k < s.length; k++) {
            var ch = s.charAt(k);
            if (ch >= "0" && ch <= "9") digits += ch;
          }
          if (!digits) return "";
          var best = null;
          Object.keys(map).forEach(function (code) {
            if (digits.indexOf(code) === 0 && (explicit || code.length > 1) && (!best || code.length > best.length)) best = code;
          });
          return best ? map[best] : "";
        }
        var codeIn = document.querySelector("[name=phone_code]");
        var ph = document.querySelector("[name=phone]");
        var wa = document.querySelector("[name=whatsapp]");
        var co = document.querySelector("[name=country]");
        var lastAuto = "";
        function update() {
          if (!co) return;
          var v = (codeIn && codeIn.value) || (ph && ph.value) || (wa && wa.value) || "";
          var g = guess(v);
          if (g && (co.value.trim() === "" || co.value.trim() === lastAuto)) { co.value = g; lastAuto = g; }
          else if (g) { lastAuto = ""; }
        }
        if (codeIn) codeIn.addEventListener("input", update);
        if (ph) ph.addEventListener("input", update);
        if (wa) wa.addEventListener("input", update);
        update();
      })();
    </script>
` })}`;
  return page({ title, active: 'customers', user: ctx.user, content, flash: ctx.flash() });
}

// 联系人表单（新建/编辑）
function contactFormPage(ctx) {
  let customer = null;
  let contact = null;
  let action = '';
  if (ctx.params.id) {
    contact = get('SELECT * FROM contacts WHERE id=?', ctx.params.id);
    if (!contact) return notFoundPage(ctx, '联系人不存在');
    customer = get('SELECT * FROM customers WHERE id=? AND user_id=?', contact.customer_id, ctx.user.id);
    action = '/contacts/' + contact.id + '/edit';
  } else {
    customer = get('SELECT * FROM customers WHERE id=? AND user_id=?', ctx.params.customer_id, ctx.user.id);
    if (!customer) return notFoundPage(ctx, '客户不存在');
    action = '/customers/' + customer.id + '/contacts/new';
  }
  const v = contact || {};
  const title = contact ? '编辑联系人' : '添加联系人';
  const imgPreview = contact && contact.image
    ? `<img id="kImg" src="${esc(contact.image)}" alt="" style="width:76px;height:76px;object-fit:cover;border-radius:50%;border:1px solid #dee2e6;padding:3px;background:#fff">`
    : `<div id="kImg" style="width:76px;height:76px;border-radius:50%;border:1px dashed #cbd5e1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;background:#f8fafc"><i class="bi bi-person" style="font-size:28px"></i></div>`;
  const clearBox = (contact && contact.image) ? `<label class="form-check mt-2"><input class="form-check-input" type="checkbox" name="clear_image" value="1"><span class="form-check-label small">移除照片</span></label>` : '';
  const content = `
    ${pageHead(title, '客户：' + esc(customer.company_name), `<a class="btn btn-outline-secondary" href="/customers/${customer.id}">返回客户</a>`)}
    ${card({ body: `<form method="post" action="${action}">
      <div class="mb-4 d-flex align-items-start gap-3">
        ${imgPreview}
        <div class="flex-grow-1">
          <div class="form-label fw-semibold mb-1">联系人照片</div>
          <input type="file" class="form-control" id="kImageFile" accept="image/png,image/jpeg,image/gif,image/webp">
          <input type="hidden" name="image_data" id="kImageData">
          <div class="form-text">支持 PNG / JPG，不超过 3MB。</div>
          ${clearBox}
        </div>
      </div>
      <div class="row g-3">
        <div class="col-md-4">${fld({ label: '姓名', name: 'name', value: v.name, required: true })}</div>
        <div class="col-md-4">${fld({ label: '职位', name: 'position', value: v.position, placeholder: 'Purchasing Manager' })}</div>
        <div class="col-md-4">${fld({ label: '部门', name: 'department', value: v.department })}</div>
        <div class="col-md-4">${fld({ label: '手机', name: 'mobile', value: v.mobile })}</div>
        <div class="col-md-4">${fld({ label: '电话', name: 'phone', value: v.phone })}</div>
        <div class="col-md-4">${fld({ label: '邮箱', name: 'email', value: v.email, type: 'email' })}</div>
        <div class="col-md-4">${fld({ label: '是否为主要联系人', name: 'is_primary', type: 'checkbox', checked: !!v.is_primary, label2: '主要联系人（默认用于单据抬头）' })}</div>
        <div class="col-12">${fld({ label: '备注', name: 'notes', value: v.notes, type: 'textarea', rows: 2 })}</div>
      </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存</button><a class="btn btn-outline-secondary" href="/customers/${customer.id}">取消</a></div>
    </form>
    <script>
      document.getElementById('kImageFile').addEventListener('change', function () {
        const file = this.files && this.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) { alert('图片请小于 3MB'); this.value = ''; return; }
        const rd = new FileReader();
        rd.onload = function (e) {
          document.getElementById('kImageData').value = e.target.result;
          const box = document.getElementById('kImg');
          box.outerHTML = '<img id="kImg" src="' + e.target.result + '" alt="" style="width:76px;height:76px;object-fit:cover;border-radius:50%;border:1px solid #dee2e6;padding:3px;background:#fff">';
        };
        rd.readAsDataURL(file);
      });
    </script>` })}`;
  return page({ title, active: 'customers', user: ctx.user, content, flash: ctx.flash() });
}

// 跟进记录表单
function activityFormPage(ctx) {
  const isEdit = ctx.url.pathname.indexOf('/activities/') === 0 && ctx.url.pathname.endsWith('/edit');
  let activity = null;
  let customer = null;
  let action = '';
  if (isEdit) {
    activity = get('SELECT * FROM activities WHERE id=? AND user_id=?', ctx.params.id, ctx.user.id);
    if (!activity) return notFoundPage(ctx, '记录不存在');
    customer = get('SELECT * FROM customers WHERE id=? AND user_id=?', activity.customer_id, ctx.user.id);
    action = '/activities/' + activity.id + '/edit';
  } else {
    customer = get('SELECT * FROM customers WHERE id=? AND user_id=?', ctx.params.id, ctx.user.id);
    if (!customer) return notFoundPage(ctx, '客户不存在或无权访问');
    action = '/customers/' + customer.id + '/activities/new';
  }
  const v = activity || {};
  const initImgs = (function () { try { const a = JSON.parse(v.images || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
  const actDate = (v.activity_date || '').slice(0, 16);
  const title = activity ? '编辑跟进记录' : '添加跟进记录';
  const typeOpts = ['WhatsApp', '邮件', '微信', '电话', '样品', '会议', '拜访', '报价', '展会', '其他'].map(s => ({ v: s, l: s }));
  const priorityList = ['高', '中', '低'].map(s => ({ v: s, l: s + '优先级' }));
  const returnTo = ctx.query.return_to === '/followups' ? '/followups' : '/customers/' + customer.id;
  const content = `
    ${pageHead(title, '客户：' + esc(customer.company_name), `<a class="btn btn-outline-secondary" href="${returnTo}">返回</a>`)}
    ${card({ body: `<form method="post" action="${action}">
      <input type="hidden" name="return_to" value="${esc(returnTo)}">
      <div class="row g-3">
        <div class="col-md-3">${fld({ label: '跟进方式', name: 'type', value: v.type || '电话', type: 'select', options: typeOpts })}</div>
        <div class="col-md-3">${fld({ label: '跟进时间', name: 'activity_date', value: actDate, type: 'datetime-local' })}</div>
        <div class="col-md-3">${fld({ label: '联系人', name: 'contact_person', value: v.contact_person })}</div>
        <div class="col-md-6">${fld({ label: '主题', name: 'subject', value: v.subject, required: true, placeholder: '例：确认报价 / 样品反馈 / 交期沟通' })}</div>
        <div class="col-md-3">${fld({ label: '下次跟进日期', name: 'next_follow_date', value: v.next_follow_date || '', type: 'date' })}</div>
        <div class="col-md-3">${fld({ label: '优先级', name: 'priority', value: v.priority || '中', type: 'select', options: priorityList })}</div>
        <div class="col-12">${fld({ label: '跟进内容', name: 'content', value: v.content, type: 'textarea', rows: 4, placeholder: '记录本次沟通、客户反馈和关键结论' })}</div>
        <div class="col-12">${fld({ label: '跟进结果 / 结论（已完成时填写）', name: 'outcome', value: v.outcome, type: 'textarea', rows: 2, placeholder: '例：客户确认数量，等待最终 PI；或客户暂缓项目' })}</div>
        <div class="col-12">${fld({ label: '下次跟进要点', name: 'next_follow_notes', value: v.next_follow_notes, type: 'textarea', rows: 2, placeholder: '下次联系前需要准备或确认的内容' })}</div>
        <div class="col-12">
          <label class="form-label">客户询盘图片（可多张）</label>
          <input type="file" multiple class="form-control" id="actImgFile" accept="image/png,image/jpeg,image/gif,image/webp">
          <input type="hidden" name="keep_images" id="actKeep">
          <input type="hidden" name="new_images" id="actNew">
          <div id="actImgGrid" class="d-flex flex-wrap gap-2 mt-2"></div>
          <div class="form-text">支持多张；单张≤3MB，建议不超过6张；保存后点击缩略图可放大。</div>
        </div>
      </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存</button><a class="btn btn-outline-secondary" href="${returnTo}">取消</a></div>        <script>
          (function () {
            var keep = ${JSON.stringify(initImgs)};
            var news = [];
            var grid = document.getElementById("actImgGrid");
            function sync() {
              document.getElementById("actKeep").value = JSON.stringify(keep);
              document.getElementById("actNew").value = JSON.stringify(news);
            }
            function mkThumb(src, old) {
              var box = document.createElement("div");
              box.className = "position-relative";
              var img = document.createElement("img");
              img.src = src; img.className = "img-preview";
              img.style.cssText = "width:88px;height:88px;object-fit:cover;border-radius:8px;border:1px solid #dee2e6;background:#fff";
              var x = document.createElement("button");
              x.type = "button"; x.className = "btn btn-sm btn-danger position-absolute";
              x.style.cssText = "top:-8px;right:-8px;padding:0 6px;line-height:1;border-radius:50%";
              x.innerHTML = "&times;";
              x.onclick = function () {
                if (old) { keep = keep.filter(function (p) { return p !== src; }); }
                else { news = news.filter(function (p) { return p !== src; }); }
                render();
              };
              box.appendChild(img); box.appendChild(x); return box;
            }
            function render() {
              grid.innerHTML = "";
              keep.forEach(function (p) { grid.appendChild(mkThumb(p, true)); });
              news.forEach(function (d) { grid.appendChild(mkThumb(d, false)); });
              sync();
            }
            var file = document.getElementById("actImgFile");
            if (file) {
              file.addEventListener("change", function () {
                var files = Array.prototype.slice.call(file.files || []);
                var idx = 0;
                function next() {
                  if (idx >= files.length) { file.value = ""; return; }
                  var f = files[idx++];
                  if (f.size > 3 * 1024 * 1024) { alert("图片 " + f.name + " 超过3MB，已跳过"); next(); return; }
                  var rd = new FileReader();
                  rd.onload = function (e) { news.push(e.target.result); render(); next(); };
                  rd.readAsDataURL(f);
                }
                next();
              });
            }
            render();
          })();
        </script>
    </form>` })}`;
  return page({ title, active: 'customers', user: ctx.user, content, flash: ctx.flash() });
}

// ================= 产品 =================
// ---------- 产品分类：添加分类弹窗（列表页筛选区 / 产品表单共用） ----------
function addCategoryModalHtml(categories, backUrl) {
  const parents = (categories || []).filter(c => !c.parent_id);
  const parentOpts = parents.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  return `<div class="modal fade" id="addCategoryModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">添加产品分类</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button></div>
      <form method="post" action="/products/categories">
        <div class="modal-body">
          <input type="hidden" name="back" value="${esc(backUrl)}">
          <div class="mb-3"><label class="form-label">分类名称 <span class="text-danger">*</span></label><input class="form-control" name="name" maxlength="30" required placeholder="如 智能锁 / 门吸 / 地弹簧"></div>
          <div class="mb-3"><label class="form-label">父分类（可选，选了就是二级分类）</label><select class="form-select" name="parent_id"><option value="">无（顶级分类）</option>${parentOpts}</select></div>
          <div class="form-text">保存后立即出现在分类下拉和筛选中，不用重启。</div>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">取消</button><button class="btn btn-primary">保存分类</button></div>
      </form>
    </div></div>
  </div>`;
}
const addCategoryBtnHtml = `<button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#addCategoryModal" title="添加新分类"><i class="bi bi-plus-lg"></i> 添加分类</button>`;

function productsPage(ctx) {
  const kw = ctx.query.search || '';
  const catFilter = parseInt(ctx.query.category || '', 10) || 0;
  const matFilter = String(ctx.query.material || '').trim();
  const statusFilter = String(ctx.query.status || '').trim();
  const posFilter = String(ctx.query.positioning || '').trim();
  const where = ['1=1']; const params = [];
  // LIKE 通配符转义（L8）：搜“%”不能匹配全部产品；ESCAPE '\' 让 \% \_ 按字面匹配
  const likeEsc = (s) => '%' + String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
  if (kw) { where.push('(name LIKE ? ESCAPE \'\\\' OR name_en LIKE ? ESCAPE \'\\\' OR model LIKE ? ESCAPE \'\\\' OR color LIKE ? ESCAPE \'\\\')'); params.push(likeEsc(kw), likeEsc(kw), likeEsc(kw), likeEsc(kw)); }
  if (catFilter) { where.push('category_id=?'); params.push(catFilter); }
  if (matFilter) { where.push('material LIKE ? ESCAPE \'\\\''); params.push(likeEsc(matFilter)); }
  if (statusFilter) { where.push("COALESCE(status,'在售')=?"); params.push(statusFilter); }
  if (posFilter === '__none__') { where.push("COALESCE(positioning,'')=''"); }
  else if (posFilter) { where.push('positioning=?'); params.push(posFilter); }
  let rows = all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY id DESC`, ...params);
  const en = ctx.query.en || "";
  const sortParam = ctx.query.sort || "";
  const normEn = function (p) { return String(p.name_en || "").trim(); };
  if (en) {
    if (en === "__none__") rows = rows.filter(function (p) { return !normEn(p); });
    else rows = rows.filter(function (p) { return normEn(p) === en; });
  }
  if (sortParam === "stock_desc" || sortParam === "stock_asc" || sortParam === "low") {
    rows.sort(function (a, b) {
      const x = Number(a.stock) || 0, y = Number(b.stock) || 0;
      if (sortParam === "low") { if (x === 0 && y > 0) return -1; if (y === 0 && x > 0) return 1; if (x === y) return 0; return x - y; }
      return sortParam === "stock_desc" ? (y - x) : (x - y);
    });
  } else {
    rows.sort(function (a, b) {
      const x = normEn(a), y = normEn(b);
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x.toLowerCase() < y.toLowerCase() ? -1 : 1;
    });
  }
  const categories = all('SELECT * FROM product_categories ORDER BY sort_order, id');
  const catName = {}; categories.forEach(c => { catName[c.id] = c.name; });
  const materials = all("SELECT DISTINCT material FROM products WHERE material<>'' ORDER BY material").map(r => r.material);
  const keepParams = (overrides) => {
    const o = Object.assign({ sort: sortParam, en: en, search: kw, category: catFilter || '', material: matFilter, status: statusFilter, positioning: posFilter }, overrides || {});
    return Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  };
  const baseQ = keepParams({});
  const allEn = all("SELECT name_en FROM products");
  const counts = {};
  allEn.forEach(function (p) { const k = normEn(p) || "__none__"; counts[k] = (counts[k] || 0) + 1; });
  const grpNames = Object.keys(counts).sort(function (a, b) {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  });
  const chipsHtml = "<div class=\"d-flex flex-wrap gap-1 mb-2\">" + ["", ...grpNames].map(function (k) {
    const label = k === "" ? "全部" : (k === "__none__" ? "（未填英文品名）" : k);
    const cnt = k === "" ? allEn.length : counts[k];
    const active = (k === "" && en === "") || (k !== "" && en === k);
    const q = keepParams({ en: k });
    const url = "/products" + (q ? "?" + q : "");
    return "<a class=\"btn btn-sm " + (active ? "btn-primary" : "btn-outline-secondary") + "\" href=\"" + url + "\">" + esc(label) + " (" + cnt + ")</a>";
  }).join(" ") + "</div>";
  const PAGE_SIZE = 15;
  const totalCount = rows.length;
  const curPage = Math.max(1, parseInt(ctx.query.page || "1", 10) || 1);
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(curPage, pageCount);
  rows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const sortBarHtml = "<div class=\"d-flex gap-1 flex-wrap mb-2\">" + [["", "默认(按英文品名)"], ["stock_desc", "库存：高 → 低"], ["stock_asc", "库存：低 → 高"], ["low", "缺货优先"]].map(function (o) {
    const active = sortParam === o[0];
    const q = keepParams({ sort: o[0] });
    const url = "/products" + (q ? "?" + q : "");
    return "<a class=\"btn btn-sm " + (active ? "btn-primary" : "btn-outline-secondary") + "\" href=\"" + url + "\">" + o[1] + "</a>";
  }).join(" ") + "</div>";
  const pagination = pageCount > 1 ? "<nav><ul class=\"pagination pagination-sm\">" + (function () {
    let h = "";
    for (let i = 1; i <= pageCount; i++) {
      h += "<li class=\"page-item " + (i === safePage ? "active" : "") + "\"><a class=\"page-link\" href=\"/products?page=" + i + (baseQ ? "&" + baseQ : "") + "\">" + i + "</a></li>";
    }
    return h;
  })() + "</ul></nav>" : "";
  const pageOptions = Array.from({ length: pageCount }, (_, i) => '<option value="' + (i + 1) + '"' + ((i + 1) === safePage ? ' selected' : '') + '>' + (i + 1) + '</option>').join('');
  const backTarget = '/products' + (ctx.url.search || '');
  // 本页产品已绑定的知识库文章（与详情页“关联知识条目”页签同一口径：product_id 指向该产品的所有文章）
  const linkedArticles = {};
  if (rows.length) {
    const pageIds = rows.map(p => p.id);
    all(`SELECT id, product_id, title FROM knowledge_articles WHERE product_id IN (${pageIds.map(() => '?').join(',')}) ORDER BY updated_at DESC`, ...pageIds).forEach(a => {
      (linkedArticles[a.product_id] = linkedArticles[a.product_id] || []).push(a);
    });
  }
  const kbCellHtml = (p) => {
    const arts = linkedArticles[p.id] || [];
    if (!arts.length) return `<span class="text-muted">未绑定</span><br><a class="btn btn-sm btn-outline-primary mt-1" href="/products/${p.id}?tab=articles">去绑定</a>`;
    const shown = arts.slice(0, 2).map(a => `<a href="/knowledge?article=${a.id}">${esc(a.title)}</a>`).join('<br>');
    return `<span class="badge text-bg-primary">${arts.length} 篇</span><div class="small mt-1">${shown}${arts.length > 2 ? `<br><span class="text-muted">等 ${arts.length} 篇</span>` : ''}</div><a class="btn btn-sm btn-outline-secondary mt-1" href="/products/${p.id}?tab=articles">管理绑定</a>`;
  };
  const rowsHtml = rows.map(p => `<tr>
    <td><div class="d-flex align-items-center gap-2">
      <div style="width:48px;height:48px;flex:0 0 48px;border-radius:8px;overflow:hidden;background:#f1f4f8;border:1px solid #e7ecf2;display:flex;align-items:center;justify-content:center">
        ${p.image ? `<img src="${esc(p.image)}" style="width:100%;height:100%;object-fit:cover" alt="">` : '<i class="bi bi-image text-secondary" style="font-size:19px"></i>'}
      </div>
      <div><div class="fw-semibold"><a class="text-decoration-none" href="/products/${p.id}">${esc(p.name)}</a>${p.status && p.status !== '在售' ? ` <span class="badge ${p.status === '停产' ? 'text-bg-danger' : 'text-bg-secondary'}">${esc(p.status)}</span>` : ''}</div>${p.name_en ? `<div class="text-muted small">${esc(p.name_en)}</div>` : ''}</div>
    </div></td>
    <td>${esc(p.model || '-')}</td>
    <td>${esc(catName[p.category_id] || '未分类')}</td>
    <td class="text-center">${p.positioning ? `<span class="badge ${p.positioning === '高端款' ? 'text-bg-primary' : 'text-bg-success'}">${esc(p.positioning)}</span>` : '<span class="text-muted">未分类</span>'}</td>
    <td class="text-center">${esc(p.color || '-')}</td>
    <td class="text-center">${esc(p.unit || 'PCS')}</td>
    <td class="text-center">${Number(p.moq) ? numFmt(p.moq) + ' ' + esc(p.moq_unit || 'PCS') : '-'}</td>
    <td class="text-center">${Number(p.lead_time_days) ? Number(p.lead_time_days) + ' 天' : '-'}</td>
    <td>${kbCellHtml(p)}</td>
    <td class="text-end">
      <div class="fw-bold">${numFmt(p.stock)} ${esc(p.unit || '')}</div>
      ${p.stock <= 0 ? '<span class="badge text-bg-danger">缺货</span>' : (p.stock <= (p.stock_alert || 0) ? '<span class="badge text-bg-warning">库存偏低</span>' : '<span class="badge text-bg-success">正常</span>')}
      <form method="post" action="/products/${p.id}/stock" class="d-flex gap-1 mt-1" title="正数=入库，负数=出库">
        <input type="number" name="delta" step="any" value="0" class="form-control form-control-sm" style="width:76px">
        <button class="btn btn-sm btn-outline-success" style="white-space:nowrap">入库</button>
      </form>
      <div class="text-muted small mt-1">预警：${numFmt(p.stock_alert)}</div>
    </td>
    <td class="text-end" style="min-width:145px">
      <form method="post" action="/products/${p.id}/cost" class="d-flex gap-1 justify-content-end align-items-center">
        <input type="hidden" name="back" value="${esc(backTarget)}">
        <input type="number" name="cost_price" value="${Number(p.cost_price) || 0}" min="0" step="0.001" class="form-control form-control-sm" style="width:86px" aria-label="进货价">
        <button class="btn btn-sm btn-outline-success" title="保存进货价"><i class="bi bi-check2"></i></button>
      </form>
      <div class="text-muted small mt-1">${esc(p.currency || 'USD')}</div>
    </td>
    <td class="text-end">
      <a class="btn btn-sm btn-outline-primary" href="/stock/product/${p.id}/buyers">客户采购</a> <a class="btn btn-sm btn-outline-primary" href="/quotes?product_id=${p.id}"><i class="bi bi-clock-history"></i> 历史报价</a> <a class="btn btn-sm btn-outline-primary" href="/products/${p.id}/edit?back=${encodeURIComponent(backTarget)}">编辑</a>
        <form class="d-inline" method="post" action="/products/${p.id}/copy"><input type="hidden" name="back" value="${esc(backTarget)}"><button class="btn btn-sm btn-outline-secondary" title="复制为新产品"><i class="bi bi-files"></i></button></form>
      <form class="d-inline" method="post" action="/products/${p.id}/delete" onsubmit="return confirm('确认删除该产品？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
    </td></tr>`).join('') || emptyRow(12, '没有产品，先去新建吧');
  const content = `
    ${pageHead('产品信息', '产品资料库（图片/货号/单价/进货价等），库存与流水请在「库存管理」查看', `<a class="btn btn-primary" href="/products/new"><i class="bi bi-plus-lg"></i> 新建产品</a>`)}
    ${card({ title: 'Excel 批量导入', body: `<div class="d-flex gap-2 flex-wrap align-items-center">
      <a class="btn btn-outline-success btn-sm" href="/api/products/template.xlsx"><i class="bi bi-file-earmark-excel"></i> 下载导入模板</a>
      <form method="post" action="/products/import" enctype="multipart/form-data" class="d-inline">
        <label class="btn btn-outline-success btn-sm mb-0" for="prodImportFile"><i class="bi bi-upload"></i> 选择 Excel 导入</label>
        <input type="file" name="file" id="prodImportFile" accept=".xlsx,.xls" style="display:none">
      </form>
      <span class="text-muted small">按模板导入：相同货号自动更新、没有的自动新建；最后一列「图片」可插入图片或填图片路径。</span>
    </div>
    <script>
      document.getElementById('prodImportFile').addEventListener('change', function () {
        if (this.files && this.files[0]) this.form.submit();
      });
    </script>` })}
    ${card({ body: `
      ${chipsHtml}
      ${sortBarHtml}
      <form class="row g-2 mb-3 align-items-center" method="get">
        <input type="hidden" name="en" value="${esc(en)}"><input type="hidden" name="sort" value="${esc(sortParam)}">
        <div class="col-md-4"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索品名 / 型号 / 颜色"></div>
        <div class="col-md-2"><div class="d-flex gap-1"><select class="form-select" name="category" aria-label="按分类筛选"><option value="">全部分类</option>${categories.map(c => `<option value="${c.id}" ${catFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${addCategoryBtnHtml}</div></div>
        <div class="col-md-2"><select class="form-select" name="material" aria-label="按材质筛选"><option value="">全部材质</option>${materials.map(m => `<option ${matFilter === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
        <div class="col-md-2"><select class="form-select" name="status" aria-label="按状态筛选"><option value="">全部状态</option>${['在售', '下架', '停产'].map(s => `<option ${statusFilter === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="col-md-2"><select class="form-select" name="positioning" aria-label="按定位筛选"><option value="">全部定位</option>${['高端款', '高流通款'].map(s => `<option ${posFilter === s ? 'selected' : ''}>${s}</option>`).join('')}<option value="__none__" ${posFilter === '__none__' ? 'selected' : ''}>未分类</option></select></div>
        <div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/products">重置</a></div>
        <div class="col-auto d-flex align-items-center gap-1"><span class="text-muted small">页码</span><select class="form-select form-select-sm" name="page" onchange="this.form.submit()" style="width:82px">${pageOptions}</select><span class="text-muted small">/ ${pageCount} 页</span></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>产品名称</th><th>规格型号</th><th>分类</th><th class="text-center">定位</th><th class="text-center">颜色</th><th class="text-center">单位</th><th class="text-center">MOQ</th><th class="text-center">交期</th><th>知识库资料</th><th class="text-end">库存</th><th class="text-end">进货价</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mt-2"><span class="text-muted small">共 ${totalCount} 个产品 · 每页 15 · 第 ${safePage}/${pageCount} 页</span>${pagination}</div>
      ${addCategoryModalHtml(categories, backTarget)}` })}`;
  return page({ title: '产品信息', active: 'products', user: ctx.user, content, flash: ctx.flash() });
}

function productFormPage(ctx) {
  const p = ctx.params.id ? get('SELECT * FROM products WHERE id=?', ctx.params.id) : null;
  if (ctx.params.id && !p) return notFoundPage(ctx, '产品不存在');
  const v = p || {};
  const action = p ? '/products/' + p.id + '/edit' : '/products/new';
  const backUrl = /^\/(?!\/)/.test(String(ctx.query.back || '')) ? String(ctx.query.back).replace(/[\r\n]/g, '') : '';
  const returnUrl = backUrl || '/products';
  const categories = all('SELECT * FROM product_categories ORDER BY sort_order, id');
  // 刚在弹窗里加完分类跳回来时（?category_id=新 id），表单直接预选它
  const preselectCat = parseInt(ctx.query.category_id, 10) || 0;
  const catValue = v.category_id || preselectCat || '';
  const formUrl = (p ? '/products/' + p.id + '/edit' : '/products/new') + (backUrl ? '?back=' + encodeURIComponent(backUrl) : '');
  const SPEC_PRESETS = {
    '锁体': [['锁体尺寸', '如 85mm'], ['孔距', '如 72mm'], ['适用门厚', '如 35-55mm'], ['锁舌材质', '如 不锈钢']],
    '把手': [['长度', '如 128mm'], ['孔距', '如 96mm'], ['管径', '如 12mm']],
    '锁芯': [['长度', '如 70mm'], ['偏心距', '如 30+10mm'], ['钥匙数量', '如 3把']],
    '合页': [['尺寸', '如 4寸'], ['承重', '如 25kg'], ['开合角度', '如 180°']],
    '智能锁': [['解锁方式', '如 指纹/密码/刷卡'], ['供电方式', '如 干电池/锂电池'], ['适用门厚', '如 35-55mm'], ['联网方式', '如 WiFi/蓝牙']],
    '门吸': [['材质', '如 不锈钢/锌合金'], ['安装方式', '如 地装/墙装'], ['承重', '如 25kg'], ['表面处理', '如 拉丝']],
    '其他': [['规格', ''], ['参数', '']],
  };
  let curSpecs = {};
  try { curSpecs = JSON.parse(v.specs || '{}') || {}; } catch (e) { curSpecs = {}; }
  if (!curSpecs || typeof curSpecs !== 'object' || Array.isArray(curSpecs)) curSpecs = {};
  const stockField = fld({ id: 'currentStock', label: '当前库存（自动计算）', name: 'stock', value: (p ? numFmt(v.stock) : ''), type: 'number', step: 'any', min: 0, readonly: true, help: '自动按：件数 × 装箱数 计算' });
  const syncStockScript = `<script>
    (function () {
      var per = document.getElementById('pcsPerCtn');
      var ctn = document.getElementById('ctnCount');
      var stock = document.getElementById('currentStock');
      if (!per || !ctn || !stock) return;
      function sync() {
        var a = parseFloat(per.value) || 0;
        var b = parseFloat(ctn.value) || 0;
        stock.value = String(Math.round(a * b * 10000) / 10000);
      }
      per.addEventListener('input', sync);
      ctn.addEventListener('input', sync);
      sync();
    })();
  <\/script>`;
  const specScript = `<script>
    (function () {
      var presets = ${JSON.stringify(SPEC_PRESETS)};
      var catSel = document.getElementById('productCategory');
      var box = document.getElementById('specFields');
      var hidden = document.getElementById('specsJson');
      if (!catSel || !box || !hidden) return;
      var values = {};
      try { values = JSON.parse(hidden.value || '{}') || {}; } catch (e) { values = {}; }
      function catName() {
        var opt = catSel.options[catSel.selectedIndex];
        return opt ? opt.text : '其他';
      }
      function syncHidden() {
        var out = {};
        Object.keys(values).forEach(function (k) { if (String(values[k] || '').trim() !== '') out[k] = String(values[k]).trim(); });
        hidden.value = JSON.stringify(out);
      }
      function build() {
        var list = presets[catName()] || presets['其他'];
        box.innerHTML = '';
        list.forEach(function (kv) {
          var key = kv[0], ph = kv[1];
          var wrap = document.createElement('div');
          wrap.className = 'col-md-3';
          var lab = document.createElement('label');
          lab.className = 'form-label';
          lab.textContent = key;
          var inp = document.createElement('input');
          inp.className = 'form-control';
          inp.placeholder = ph || '';
          inp.value = values[key] || '';
          inp.addEventListener('input', function () { values[key] = inp.value; syncHidden(); });
          wrap.appendChild(lab);
          wrap.appendChild(inp);
          box.appendChild(wrap);
        });
        syncHidden();
      }
      catSel.addEventListener('change', build);
      build();
    })();
  <\/script>`;
  const title = p ? '编辑产品' : '新建产品';
  const curOpts = ['USD', 'EUR', 'CNY', 'GBP', 'JPY'].map(s => ({ v: s, l: s }));
  const imgPreview = p && p.image
    ? `<img id="pImg" src="${esc(p.image)}" alt="" style="max-width:120px;max-height:120px;border-radius:10px;border:1px solid #dee2e6;padding:4px;background:#fff">`
    : `<div id="pImg" style="width:120px;height:120px;border-radius:10px;border:1px dashed #cbd5e1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;background:#f8fafc"><i class="bi bi-image" style="font-size:28px"></i><span class="small mt-1">暂无图片</span></div>`;
  const clearBox = (p && p.image) ? `<label class="form-check mt-2"><input class="form-check-input" type="checkbox" name="clear_image" value="1"><span class="form-check-label small">移除现有图片</span></label>` : '';
  const linkedSps = p ? all('SELECT sp.id, sp.name, sp.model, sp.price, sp.currency, sp.supplier_id, s.name AS supplier_name FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id WHERE sp.product_id=? ORDER BY s.name', p.id) : [];
  const linkedSupHtml = !linkedSps.length ? '' : `<div class="mt-3">
    <div class="form-label fw-semibold mb-1">已关联供应产品（货源 / 采购报价）</div>
    <div class="table-responsive"><table class="table table-sm align-middle">
      <thead><tr><th>供应商</th><th>供应产品</th><th class="text-end">报价</th><th></th></tr></thead>
      <tbody>${linkedSps.map(x => `<tr><td><a href="/suppliers/${x.supplier_id}">${esc(x.supplier_name)}</a></td><td>${esc(x.name)}${x.model ? '（' + esc(x.model) + '）' : ''}</td><td class="text-end">${esc(x.currency || 'CNY')} ${numFmt(x.price)}</td><td class="text-end"><a class="btn btn-sm btn-outline-secondary" href="/supplier-products/${x.id}/edit">编辑</a></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="form-text">如需新增货源，请到「供应商 → 添加/编辑供应产品」里选择“对应我方产品”。</div>
  </div>`;
  const suppliers = all('SELECT id,name,country FROM suppliers ORDER BY name');
  const supplierOpts = [{ v: '', l: '— 请选择供应商 —' }].concat(suppliers.map(s => ({ v: String(s.id), l: s.name + (s.country ? '（' + s.country + '）' : '') })));
  const content = `
    ${pageHead(title, '', `<a class="btn btn-outline-secondary" href="${returnUrl}">返回</a>`)}
    ${card({ body: `<form method="post" action="${action}" >
      <input type="hidden" name="back" value="${esc(backUrl)}">
      <input type="hidden" name="sync_stock_from_pack" value="1">
      <div class="row g-3">
        <div class="col-md-2">
          <div class="form-label fw-semibold">产品图片</div>
          ${imgPreview}
        </div>
        <div class="col-md-10">
          <div class="row g-3">
            <div class="col-md-6">${fld({ label: '品名', name: 'name', value: v.name, required: true })}</div>
            <div class="col-md-6">${fld({ label: '英文品名', name: 'name_en', value: v.name_en, placeholder: 'English Name' })}</div>
            <div class="col-md-3">${fld({ label: '规格型号', name: 'model', value: v.model })}</div>
            <div class="col-md-3">${fld({ label: '颜色', name: 'color', value: v.color, placeholder: '如 SS / 黑色 / 金色' })}</div>
            <div class="col-md-3"><label class="form-label" for="productCategory">分类</label><div class="input-group"><select class="form-select" id="productCategory" name="category_id">${[{ v: '', l: '未分类' }].concat(categories.map(c => ({ v: String(c.id), l: c.name }))).map(op => `<option value="${esc(op.v)}" ${String(op.v) === String(catValue) ? 'selected' : ''}>${esc(op.l)}</option>`).join('')}</select><button type="button" class="btn btn-outline-primary" data-bs-toggle="modal" data-bs-target="#addCategoryModal" title="添加新分类"><i class="bi bi-plus-lg"></i></button></div></div>
            <div class="col-md-3"><label class="form-label" for="productMaterial">材质</label><input class="form-control" id="productMaterial" name="material" list="materialList" value="${esc(v.material || '')}" placeholder="如 不锈钢 / 锌合金"><datalist id="materialList"><option>不锈钢</option><option>锌合金</option><option>铜</option><option>铝合金</option><option>铁</option></datalist><div class="form-text">可直接填，不限于列表</div></div>
            <div class="col-md-3"><label class="form-label" for="productFinish">表面处理</label><input class="form-control" id="productFinish" name="finish" list="finishList" value="${esc(v.finish || '')}" placeholder="如 拉丝 / 电镀"><datalist id="finishList"><option>拉丝</option><option>镜面</option><option>电镀</option><option>喷涂</option><option>古铜</option><option>黑色</option></datalist><div class="form-text">可直接填，不限于列表</div></div>
            <div class="col-md-3">${fld({ label: 'MOQ（最低起订量）', name: 'moq', value: (p ? numFmt(v.moq) : ''), type: 'number', step: 'any', min: 0 })}</div>
            <div class="col-md-3">${fld({ label: 'MOQ单位', name: 'moq_unit', value: v.moq_unit || 'PCS', type: 'select', options: ['PCS', 'SET', 'PAIR'].map(s => ({ v: s, l: s })) })}</div>
            <div class="col-md-3">${fld({ label: '大货交期（天）', name: 'lead_time_days', value: (p ? v.lead_time_days : ''), type: 'number', step: '1', min: 0 })}</div>
            <div class="col-md-3">${fld({ label: '打样交期（天）', name: 'sample_lead_time_days', value: (p ? v.sample_lead_time_days : ''), type: 'number', step: '1', min: 0 })}</div>
            <div class="col-md-3">${fld({ label: '状态', name: 'status', value: v.status || '在售', type: 'select', options: ['在售', '下架', '停产'].map(s => ({ v: s, l: s })), help: '停产的产品不再进报价' })}</div>
            <div class="col-md-3">${fld({ label: '定位', name: 'positioning', value: v.positioning || '', type: 'select', options: [{ v: '', l: '未分类' }, { v: '高端款', l: '高端款' }, { v: '高流通款', l: '高流通款' }], help: '自动回复挑款按定位选：高端精品客户只推高端款，大众流通客户只推高流通款，未分类不参与自动挑款' })}</div>
            <div class="col-md-2">${fld({ label: '单位', name: 'unit', value: v.unit || 'PCS', options: ['PCS','SET','PAIR','CTN','KGS','M'].map(s => ({ v: s, l: s })), type: 'select' })}</div>
            <input type="hidden" name="origin" value="${esc(v.origin || '中国 China')}">
            <div class="col-md-3">${fld({ label: '进货价', name: 'cost_price', value: (p ? numFmt(v.cost_price) : ''), type: 'number', step: '0.001', min: 0, help: '采购/进货成本，可随时手动修改' })}</div>
            <div class="col-md-3">${fld({ label: '供应商', name: 'supplier_id', value: v.supplier_id || '', type: 'select', options: supplierOpts })}</div>
            <div class="col-md-3">${stockField}</div>
            <div class="col-md-3">${fld({ label: '库存预警值', name: 'stock_alert', value: (p ? numFmt(v.stock_alert) : ''), type: 'number', step: 'any', min: 0, help: '低于该值提示补货' })}</div>
            <div class="col-md-3">${fld({ id: 'pcsPerCtn', label: '箱数', name: 'pcs_per_ctn', value: (p ? numFmt(v.pcs_per_ctn) : ''), type: 'number', step: 'any', min: 0, help: '箱数；箱数×装箱数=当前库存参考值' })}</div>
            <div class="col-md-3">${fld({ id: 'ctnCount', label: '装箱数', name: 'ctn_count', value: (p ? numFmt(v.ctn_count) : ''), type: 'number', step: 'any', min: 0, help: '每箱数量；箱数×装箱数=当前库存参考值' })}</div>
            <div class="col-md-3">${fld({ label: '单件体积 (m³)', name: 'volume', value: (p ? numFmt(v.volume) : ''), type: 'number', step: '0.0001', min: 0, help: '用于装箱单：总体积=体积×件数' })}</div>
            <div class="col-md-3">${fld({ label: '单件重量 (kg)', name: 'weight', value: (p ? numFmt(v.weight) : ''), type: 'number', step: '0.001', min: 0, help: '用于装箱单：总重量=重量×件数' })}</div>
            <div class="col-12">
              <label class="form-label fw-semibold">上传 / 更换图片</label>
              <input type="file" class="form-control" id="pImageFile" accept="image/png,image/jpeg,image/gif,image/webp">
              <input type="hidden" name="image_data" id="pImageData">
              <div class="form-text">支持 PNG / JPG，不超过 3MB；选择后自动预览，保存时生效。</div>
              ${clearBox}
            </div>
            <div class="col-12">
              <div class="form-label fw-semibold">类别专属参数</div>
              <div id="specFields" class="row g-2"></div>
              <input type="hidden" name="specs" id="specsJson" value='${esc(JSON.stringify(curSpecs))}'>
              <div class="form-text">按所选分类显示对应参数（锁体：锁体尺寸/孔距；把手：长度/孔距；锁芯：长度/偏心距；合页：尺寸/承重；智能锁：解锁方式/供电方式；门吸：材质/安装方式）；换分类后已填的值会保留。</div>
            </div>
            <div class="col-12">${fld({ label: '产品描述', name: 'description', value: v.description, type: 'textarea', rows: 3, help: '中英双语销售文案，AI 回答和报价时引用；价格、MOQ、交期请填上面字段，不要写在这里' })}</div>
            <div class="col-12">${fld({ label: '备注', name: 'notes', value: v.notes, help: '内部备注（包装方式、可印 Logo 等），不对外' })}</div>
            ${linkedSupHtml}
          </div>
        </div>
      </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存</button><a class="btn btn-outline-secondary" href="${returnUrl}">取消</a></div>
    </form>
    ${syncStockScript}
    ${specScript}
    <script>
      document.getElementById('pImageFile').addEventListener('change', function () {
        const file = this.files && this.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) { alert('图片请小于 3MB'); this.value = ''; return; }
        const rd = new FileReader();
        rd.onload = function (e) {
          document.getElementById('pImageData').value = e.target.result;
          const box = document.getElementById('pImg');
          box.outerHTML = '<img id="pImg" src="' + e.target.result + '" alt="" style="max-width:120px;max-height:120px;border-radius:10px;border:1px solid #dee2e6;padding:4px;background:#fff">';
        };
        rd.readAsDataURL(file);
      });
    </script>
    ${addCategoryModalHtml(categories, formUrl)}` })}`;
  return page({ title, active: 'products', user: ctx.user, content, flash: ctx.flash() });
}

function productDetailPage(ctx) {
  const p = get('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN product_categories c ON c.id=p.category_id WHERE p.id=?', ctx.params.id);
  if (!p) return notFoundPage(ctx, '产品不存在');
  const tab = ['info', 'attachments', 'articles', 'suppliers', 'quotes'].includes(String(ctx.query.tab || '')) ? String(ctx.query.tab) : 'info';
  const tabs = [['info', '资料'], ['attachments', '附件'], ['articles', '关联知识条目'], ['suppliers', '供应商报价'], ['quotes', '历史报价']];
  const tabUrl = t => '/products/' + p.id + (t === 'info' ? '' : '?tab=' + t);
  const tabsHtml = `<div class="d-flex gap-1 flex-wrap mb-3">${tabs.map(([k, label]) => `<a class="btn btn-sm ${tab === k ? 'btn-primary' : 'btn-outline-secondary'}" href="${tabUrl(k)}">${label}</a>`).join('')}</div>`;
  const statusBadge = p.status === '停产' ? 'text-bg-danger' : (p.status === '下架' ? 'text-bg-secondary' : 'text-bg-success');
  let tabHtml = '';
  if (tab === 'info') {
    let specs = {};
    try { specs = JSON.parse(p.specs || '{}') || {}; } catch (e) { specs = {}; }
    const specRows = Object.entries(specs).map(([k, v]) => `<tr><th style="width:160px">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
    const infoRows = [
      ['分类', p.category_name || '未分类'], ['品名', p.name], ['英文品名', p.name_en || '-'], ['规格型号', p.model || '-'],
      ['材质', p.material || '-'], ['表面处理', p.finish || '-'], ['颜色', p.color || '-'], ['单位', p.unit || 'PCS'],
      ['参考单价', (p.currency || 'USD') + ' ' + numFmt(p.price)], ['进货价', (p.currency || 'USD') + ' ' + numFmt(p.cost_price)],
      ['MOQ', Number(p.moq) ? numFmt(p.moq) + ' ' + (p.moq_unit || 'PCS') : '-'], ['大货交期', Number(p.lead_time_days) ? Number(p.lead_time_days) + ' 天' : '-'],
      ['打样交期', Number(p.sample_lead_time_days) ? Number(p.sample_lead_time_days) + ' 天' : '-'],
      ['状态', `<span class="badge ${statusBadge}">${esc(p.status || '在售')}</span>`],
      ['库存', numFmt(p.stock) + ' ' + (p.unit || '') + '（预警 ' + numFmt(p.stock_alert) + '）'],
      ['箱数 / 装箱数', (Number(p.pcs_per_ctn) || Number(p.ctn_count)) ? numFmt(p.pcs_per_ctn) + ' / ' + numFmt(p.ctn_count) : '-'],
      ['单件体积 / 重量', (Number(p.volume) || Number(p.weight)) ? numFmt(p.volume) + ' m³ / ' + numFmt(p.weight) + ' kg' : '-'],
      ['产地', p.origin || '-'], ['HS 编码', p.hs_code || '-'],
    ];
    tabHtml = `<div class="row g-3">
      <div class="col-xl-3">${card({ title: '产品图片', body: `
        ${p.image ? `<img src="${esc(p.image)}" alt="" style="width:100%;border-radius:10px;border:1px solid #dee2e6">` : '<div class="text-muted small">暂无图片，可在编辑页上传</div>'}
        <div class="mt-3 d-grid gap-2"><a class="btn btn-outline-primary btn-sm" href="/products/${p.id}/edit">编辑产品</a><a class="btn btn-outline-secondary btn-sm" href="/stock/product/${p.id}/buyers">客户采购</a></div>` })}</div>
      <div class="col-xl-9">
        ${card({ title: '基本资料', body: `<div class="table-responsive"><table class="table table-sm align-middle mb-0"><tbody>${infoRows.map(([k, v]) => `<tr><th style="width:160px">${k}</th><td>${v}</td></tr>`).join('')}</tbody></table></div>` })}
        ${specRows ? card({ title: '类别专属参数', body: `<div class="table-responsive"><table class="table table-sm align-middle mb-0"><tbody>${specRows}</tbody></table></div>` }) : ''}
        ${p.description ? card({ title: '产品描述', body: `<div style="white-space:pre-wrap">${esc(p.description)}</div>` }) : ''}
        ${p.notes ? card({ title: '内部备注', body: `<div class="small text-muted" style="white-space:pre-wrap">${esc(p.notes)}</div>` }) : ''}
      </div>
    </div>`;
  } else if (tab === 'attachments') {
    const atts = all('SELECT * FROM product_attachments WHERE product_id=? ORDER BY id DESC', p.id);
    const attRows = atts.map(a => `<tr><td>${esc(a.kind || '图片')}</td><td>${esc(a.title || '-')}</td><td><a href="${esc(a.file_path)}" target="_blank" rel="noopener noreferrer">${esc(a.file_path)}</a></td><td class="text-muted small">${esc(String(a.created_at || '').slice(0, 16))}</td><td class="text-end"><form class="d-inline" method="post" action="/products/${p.id}/attachments/${a.id}/delete" onsubmit="return confirm('确认删除该附件？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form></td></tr>`).join('') || emptyRow(5, '还没有附件：产品图、尺寸图、检测报告、安装说明都可以挂在这里');
    tabHtml = card({ title: '图片与附件', body: `
      <form method="post" action="/products/${p.id}/attachments" enctype="multipart/form-data" class="row g-2 mb-3 align-items-end">
        <div class="col-md-2"><label class="form-label">类型</label><select class="form-select" name="kind"><option>图片</option><option>尺寸图</option><option>检测报告</option><option>安装说明</option><option>证书</option></select></div>
        <div class="col-md-3"><label class="form-label">标题</label><input class="form-control" name="title" placeholder="如：尺寸图 / SGS 报告" maxlength="120"></div>
        <div class="col-md-4"><label class="form-label">上传文件（≤10MB）</label><input type="file" class="form-control" name="file"></div>
        <div class="col-md-3"><label class="form-label">或填链接（/uploads/ 路径或网址）</label><input class="form-control" name="file_path" placeholder="/uploads/... 或 https://..."></div>
        <div class="col-auto"><button class="btn btn-primary">添加附件</button></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>类型</th><th>标题</th><th>文件</th><th>添加时间</th><th class="text-end">操作</th></tr></thead><tbody>${attRows}</tbody></table></div>` });
  } else if (tab === 'articles') {
    const linked = all('SELECT * FROM knowledge_articles WHERE product_id=? ORDER BY updated_at DESC', p.id);
    const linkRows = linked.map(a => `<tr><td><a href="/knowledge?article=${a.id}">${esc(a.title)}</a></td><td>${esc(a.category)}</td><td class="text-muted small">${esc(String(a.updated_at || '').slice(0, 10))}</td><td class="text-end"><a class="btn btn-sm btn-outline-secondary" href="/knowledge/${a.id}/edit">编辑</a> <form class="d-inline" method="post" action="/products/${p.id}/unlink-article"><input type="hidden" name="article_id" value="${a.id}"><button class="btn btn-sm btn-outline-danger">取消关联</button></form></td></tr>`).join('') || emptyRow(4, '还没有关联的知识条目：把“怎么选、怎么装、注意事项”这类说明文字挂到这个产品上，价格/MOQ/交期以产品资料为准，不写进文章');
    const unlinked = all("SELECT * FROM knowledge_articles WHERE category='产品资料' AND (product_id IS NULL OR product_id=0) ORDER BY updated_at DESC LIMIT 200");
    tabHtml = card({ title: '关联知识条目', body: `
      <form method="post" action="/products/${p.id}/link-article" class="row g-2 mb-3 align-items-end">
        <div class="col-md-6"><label class="form-label">关联一篇“产品资料”文章</label><select class="form-select" name="article_id" required><option value="">— 请选择 —</option>${unlinked.map(a => `<option value="${a.id}">${esc(a.title)}</option>`).join('')}</select></div>
        <div class="col-auto"><button class="btn btn-primary">关联</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/knowledge/new?product_id=${p.id}&category=${encodeURIComponent('产品资料')}">新建关联文章</a></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>标题</th><th>分类</th><th>更新时间</th><th class="text-end">操作</th></tr></thead><tbody>${linkRows}</tbody></table></div>` });
  } else if (tab === 'suppliers') {
    const sps = all('SELECT sp.*, s.name AS supplier_name FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id WHERE sp.product_id=? ORDER BY s.name', p.id);
    const spRows = sps.map(x => `<tr><td><a href="/suppliers/${x.supplier_id}">${esc(x.supplier_name)}</a></td><td>${esc(x.name)}${x.model ? '（' + esc(x.model) + '）' : ''}</td><td class="text-end">${esc(x.currency || 'CNY')} ${numFmt(x.price)}</td><td class="small">${esc(x.notes || '-')}</td><td class="text-end"><a class="btn btn-sm btn-outline-secondary" href="/supplier-products/${x.id}/edit">编辑</a></td></tr>`).join('') || emptyRow(5, '还没有供应商报价：到「供应商 → 添加/编辑供应产品」里选择“对应我方产品”即可挂接');
    tabHtml = card({ title: '供应商报价', body: `<div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>供应商</th><th>供应产品</th><th class="text-end">报价</th><th>备注</th><th class="text-end">操作</th></tr></thead><tbody>${spRows}</tbody></table></div>` });
  } else if (tab === 'quotes') {
    const qs = all('SELECT q.*, c.company_name FROM quote_history q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.product_id=? ORDER BY q.quote_date DESC, q.id DESC LIMIT 100', p.id);
    const qRows = qs.map(q => `<tr><td>${esc(q.quote_no || '-')}</td><td>${esc(q.company_name || '-')}</td><td class="text-end">${numFmt(q.quantity)} ${esc(q.unit || '')}</td><td class="text-end">${esc(q.currency || 'USD')} ${numFmt(q.unit_price)}</td><td class="text-end">${esc(q.currency || 'USD')} ${numFmt(q.amount)}</td><td>${esc(q.status || '-')}</td><td class="text-muted small">${esc(String(q.quote_date || '').slice(0, 10))}</td></tr>`).join('') || emptyRow(7, '还没有该产品的历史报价');
    tabHtml = card({ title: '历史报价', body: `<div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>报价单号</th><th>客户</th><th class="text-end">数量</th><th class="text-end">单价</th><th class="text-end">金额</th><th>状态</th><th>日期</th></tr></thead><tbody>${qRows}</tbody></table></div>` });
  }
  const content = `
    ${pageHead(p.name, `${p.name_en ? esc(p.name_en) + ' · ' : ''}${esc(p.category_name || '未分类')} · 货号 ${esc(p.model || '-')}`, `<a class="btn btn-outline-secondary" href="/products">返回产品列表</a> <a class="btn btn-primary" href="/products/${p.id}/edit">编辑产品</a>`)}
    ${tabsHtml}
    ${tabHtml}`;
  return page({ title: p.name, active: 'products', user: ctx.user, content, flash: ctx.flash() });
}

// ================= 公共 =================
function notFoundPage(ctx, msg) {
  const content = `<div class="alert alert-warning py-5 text-center"><h5><i class="bi bi-exclamation-triangle me-2"></i>${esc(msg || '内容不存在')}</h5><a class="btn btn-outline-primary mt-3" href="javascript:history.back()">返回上一页</a></div>`;
  return page({ title: '提示', active: ctx.activeKey || '', user: ctx.user, content, flash: ctx.flash() });
}


// ================= 供应商 =================
function suppliersPage(ctx) {
  const kw = ctx.query.search || '';
  const where = ['1=1']; const params = [];
  if (kw) { where.push('(s.name LIKE ? OR s.name_en LIKE ? OR s.country LIKE ? OR s.contact_name LIKE ?)'); const k = '%' + kw + '%'; params.push(k, k, k, k); }
  const rows = all(`SELECT s.* FROM suppliers s WHERE ${where.join(' AND ')} ORDER BY s.id DESC`, ...params);
  const prodCount = {};
  for (const r of all('SELECT supplier_id k, COUNT(*) c FROM supplier_products GROUP BY supplier_id')) prodCount[r.k] = r.c;
  const rowsHtml = rows.map(s => {
    const prodNames = all('SELECT name FROM supplier_products WHERE supplier_id=? ORDER BY id', s.id).map(x => x.name);
    return `<tr>
    <td><a class="fw-semibold text-decoration-none" href="/suppliers/${s.id}">${esc(s.name)}</a>
      ${s.name_en ? `<div class="text-muted small">${esc(s.name_en)}</div>` : ''}</td>
    <td>${esc(s.country || '-')}</td>
    <td class="text-center"><span class="badge text-bg-primary">${prodCount[s.id] || 0} 款</span>
      <div class="text-muted small mt-1" style="max-width:260px">${prodNames.slice(0, 3).map(n => esc(n)).join('、')}${prodNames.length > 3 ? '…' : ''}</div></td>
    <td class="small">${s.contact_name ? '<div>' + esc(s.contact_name) + '</div>' : ''}${s.phone ? '<div><i class="bi bi-telephone me-1"></i>' + esc(s.phone) + '</div>' : ''}${s.email ? '<div class="text-muted"><i class="bi bi-envelope me-1"></i>' + esc(s.email) + '</div>' : ''}</td>
    <td class="small">${esc(s.payment_terms || '-')}</td>
    <td class="text-end">
      <a class="btn btn-sm btn-outline-primary" href="/suppliers/${s.id}">查看</a>
      <a class="btn btn-sm btn-outline-secondary" href="/suppliers/${s.id}/edit">编辑</a>
      <form class="d-inline" method="post" action="/suppliers/${s.id}/delete" onsubmit="return confirm('确认删除该供应商及其供应产品？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
    </td></tr>`;
  }).join('') || emptyRow(6, '暂无供应商，点击右上角新建');
  const content = `
    ${pageHead('供应商管理', '每个供应商维护「供应产品」：可上传产品图片，每款独立报价', `<a class="btn btn-primary" href="/suppliers/new"><i class="bi bi-plus-lg"></i> 新建供应商</a>`)}
    ${card({ body: `
      <form class="row g-2 mb-3" method="get"><div class="col-md-4"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索供应商名称 / 国家 / 联系人"></div><div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div><div class="col-auto"><a class="btn btn-outline-secondary" href="/suppliers">重置</a></div></form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>供应商名称</th><th>国家/地区</th><th>主营产品（款数）</th><th>联系方式</th><th>付款条件</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="text-muted small">共 ${rows.length} 家供应商</div>` })}`;
  return page({ title: '供应商管理', active: 'suppliers', user: ctx.user, content, flash: ctx.flash() });
}

function supplierDetailPage(ctx) {
  const s = get('SELECT * FROM suppliers WHERE id=?', ctx.params.id);
  if (!s) return notFoundPage(ctx, '供应商不存在');
  const prods = all('SELECT * FROM supplier_products WHERE supplier_id=? ORDER BY id DESC', s.id);
  const rowHtml = prods.map(p => `<tr>
    <td><div class="d-flex align-items-center gap-2">
      <div style="width:52px;height:52px;flex:0 0 52px;border-radius:8px;overflow:hidden;background:#f1f4f8;border:1px solid #e7ecf2;display:flex;align-items:center;justify-content:center">
        ${p.image ? `<img src="${esc(p.image)}" style="width:100%;height:100%;object-fit:cover" alt="">` : '<i class="bi bi-image text-secondary" style="font-size:22px"></i>'}
      </div>
      <div><div class="fw-semibold">${esc(p.name)}</div>${p.name_en ? `<div class="text-muted small">${esc(p.name_en)}</div>` : ''}</div>
    </div></td>
    <td>${esc(p.model || '-')}</td>
    <td class="text-center">${esc(p.color || '-')}</td>
    <td class="text-center">${esc(p.unit || 'PCS')}</td>
    <td class="text-end"><span class="fw-bold">${esc(p.currency || 'CNY')} ${numFmt(p.price)}</span></td>
    <td class="small">${esc(p.notes || '-')}</td>
    <td class="text-end">
      <a class="btn btn-sm btn-outline-secondary" href="/supplier-products/${p.id}/edit">编辑</a>
      <form class="d-inline" method="post" action="/supplier-products/${p.id}/delete" onsubmit="return confirm('确认删除该供应产品？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
    </td></tr>`).join('') || emptyRow(7, '还没有供应产品，点击右上角「添加产品」上传图片并报价');
  const infoItems = [['供应商名称', s.name], ['英文名称', s.name_en], ['国家/地区', s.country], ['联系人', s.contact_name + (s.contact_position ? '（' + s.contact_position + '）' : '')], ['电话', s.phone], ['邮箱', s.email], ['网站', s.website], ['地址', s.address], ['付款条件', s.payment_terms], ['备注', s.notes]];
  const content = `
    <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
      <div><h4 class="mb-0 fw-bold">${esc(s.name)}</h4>${s.name_en ? `<div class="text-muted">${esc(s.name_en)}</div>` : ''}</div>
      <div class="d-flex gap-2 flex-wrap">
        <a class="btn btn-outline-primary btn-sm" href="/documents/new?type=po&supplier_id=${s.id}"><i class="bi bi-file-earmark-plus"></i> 给该供应商开采购单</a>
        <a class="btn btn-primary btn-sm" href="/suppliers/${s.id}/products/new"><i class="bi bi-plus-lg"></i> 添加供应产品</a>
        <a class="btn btn-outline-secondary btn-sm" href="/suppliers/${s.id}/edit">编辑资料</a>
        <form method="post" action="/suppliers/${s.id}/delete" onsubmit="return confirm('确认删除该供应商及其供应产品？')"><button class="btn btn-outline-danger btn-sm"><i class="bi bi-trash"></i></button></form>
      </div>
    </div>
    <div class="row g-3">
      <div class="col-xl-3">
        ${card({ title: '基本信息', actions: `<a class="btn btn-sm btn-outline-secondary" href="/suppliers/${s.id}/edit">编辑</a>`, body: `<div class="small">${infoItems.map(([k, v]) => v ? `<div class="mb-1"><span class="text-muted">${k}：</span>${esc(v)}</div>` : '').join('')}</div>` })}
      </div>
      <div class="col-xl-9">
        ${card({ title: '供应产品报价', actions: `<a class="btn btn-sm btn-outline-primary" href="/suppliers/${s.id}/products/new"><i class="bi bi-plus-lg"></i> 添加产品</a>`, body: `<div class="table-responsive"><table class="table table-hover align-middle">
          <thead><tr><th>产品（图片）</th><th>规格型号</th><th class="text-center">颜色</th><th class="text-center">单位</th><th class="text-end">报价</th><th>备注</th><th class="text-end">操作</th></tr></thead>
          <tbody>${rowHtml}</tbody></table></div>
          <div class="text-muted small">每款产品可上传图片并填写独立报价；用于比价与采购参考。</div>` })}
      </div>
    </div>`;
  return page({ title: s.name, active: 'suppliers', user: ctx.user, content, flash: ctx.flash() });
}

function supplierFormPage(ctx) {
  const s = ctx.params.id ? get('SELECT * FROM suppliers WHERE id=?', ctx.params.id) : null;
  if (ctx.params.id && !s) return notFoundPage(ctx, '供应商不存在');
  const v = s || {};
  const action = s ? '/suppliers/' + s.id + '/edit' : '/suppliers/new';
  const title = s ? '编辑供应商' : '新建供应商';
  const content = `
    ${pageHead(title, '', `<a class="btn btn-outline-secondary" href="/suppliers${s ? '/' + s.id : ''}">返回</a>`)}
    ${card({ body: `<form method="post" action="${action}">
      <div class="row g-3">
        <div class="col-md-6">${fld({ label: '供应商名称', name: 'name', value: v.name, required: true })}</div>
        <div class="col-md-6">${fld({ label: '英文名称', name: 'name_en', value: v.name_en, placeholder: 'Supplier Name (EN)' })}</div>
        <div class="col-md-4">${fld({ label: '国家/地区', name: 'country', value: v.country, placeholder: '中国 China' })}</div>
        <div class="col-md-4">${fld({ label: '联系人', name: 'contact_name', value: v.contact_name })}</div>
        <div class="col-md-4">${fld({ label: '联系人职位', name: 'contact_position', value: v.contact_position })}</div>
        <div class="col-md-4">${fld({ label: '联系电话', name: 'phone', value: v.phone })}</div>
        <div class="col-md-4">${fld({ label: '邮箱', name: 'email', value: v.email, type: 'email' })}</div>
        <div class="col-md-4">${fld({ label: '网站', name: 'website', value: v.website })}</div>
        <div class="col-md-6">${fld({ label: '地址', name: 'address', value: v.address })}</div>
        <div class="col-md-6">${fld({ label: '付款条件', name: 'payment_terms', value: v.payment_terms, placeholder: '如：月结 30 天 / T/T 预付' })}</div>
        <div class="col-12"><div class="alert alert-light border small py-2 mb-0"><i class="bi bi-info-circle me-1"></i>主营产品无需在此填写：保存后在供应商详情里「添加供应产品」并上传图片、填写报价即可，系统会自动汇总为主营产品。</div></div>
        <div class="col-12">${fld({ label: '备注', name: 'notes', value: v.notes, type: 'textarea', rows: 3 })}</div>
      </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存${s ? '' : '并进入详情'}</button><a class="btn btn-outline-secondary" href="/suppliers${s ? '/' + s.id : ''}">取消</a></div>
    </form>` })}`;
  return page({ title, active: 'suppliers', user: ctx.user, content, flash: ctx.flash() });
}

function supplierProductFormPage(ctx) {
  const isEdit = !!ctx.params.id;
  let sp = null; let supplier = null; let action = '';
  if (isEdit) {
    sp = get('SELECT * FROM supplier_products WHERE id=?', ctx.params.id);
    if (!sp) return notFoundPage(ctx, '供应产品不存在');
    supplier = get('SELECT * FROM suppliers WHERE id=?', sp.supplier_id);
    action = '/supplier-products/' + sp.id + '/edit';
  } else {
    supplier = get('SELECT * FROM suppliers WHERE id=?', ctx.params.sid || ctx.query.supplier_id);
    if (!supplier) return notFoundPage(ctx, '供应商不存在');
    action = '/suppliers/' + supplier.id + '/products/new';
  }
  const presetProductId = !isEdit ? (parseInt(ctx.query.product_id || '', 10) || 0) : 0;
  const v = sp || { product_id: presetProductId };
  const title = isEdit ? '编辑供应产品' : '添加供应产品';
  const curOpts = ['CNY', 'USD', 'EUR', 'JPY'].map(x => ({ v: x, l: x }));
  const imgPreview = sp && sp.image
    ? `<img id="spImg" src="${esc(sp.image)}" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:10px;border:1px solid #dee2e6;padding:3px;background:#fff">`
    : `<div id="spImg" style="width:96px;height:96px;border-radius:10px;border:1px dashed #cbd5e1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;background:#f8fafc"><i class="bi bi-image" style="font-size:28px"></i><span class="small mt-1">产品图片</span></div>`;
  const clearBox = (sp && sp.image) ? `<label class="form-check mt-2"><input class="form-check-input" type="checkbox" name="clear_image" value="1"><span class="form-check-label small">移除图片</span></label>` : '';
  const linkOpts = [{ v: '', l: '（不关联我方产品）' }].concat(all('SELECT id,name,model FROM products ORDER BY name').map(pr => ({ v: String(pr.id), l: (pr.name || '') + (pr.model ? '（' + pr.model + '）' : '') })));
  const content = `
    ${pageHead(title, '供应商：' + esc(supplier.name), `<a class="btn btn-outline-secondary" href="/suppliers/${supplier.id}">返回供应商</a>`)}
    ${card({ body: `<form method="post" action="${action}">
      <div class="row g-3">
        <div class="col-md-3">
          <div class="form-label fw-semibold">产品图片</div>
          ${imgPreview}
        </div>
        <div class="col-md-9">
          <div class="row g-3">
            <div class="col-md-6">${fld({ label: '产品名称', name: 'name', value: v.name, required: true })}</div>
            <div class="col-md-6">${fld({ label: '英文名称', name: 'name_en', value: v.name_en, placeholder: 'Product Name (EN)' })}</div>
            <div class="col-md-3">${fld({ label: '规格型号', name: 'model', value: v.model })}</div>
            <div class="col-md-3">${fld({ label: '颜色', name: 'color', value: v.color, placeholder: '如 SS / 黑色 / 金色' })}</div>
            <div class="col-md-2">${fld({ label: '单位', name: 'unit', value: v.unit || 'PCS', options: ['PCS','SET','PAIR','CTN','KGS','M'].map(x => ({ v: x, l: x })), type: 'select' })}</div>
            <div class="col-md-2">${fld({ label: '独立报价', name: 'price', value: (v.price === 0 && !isEdit) ? '' : v.price, type: 'number', step: '0.001', min: 0, required: true })}</div>
            <div class="col-md-2">${fld({ label: '币种', name: 'currency', value: v.currency || 'CNY', type: 'select', options: curOpts })}</div>
            <div class="col-md-12">${fld({ label: '对应我方产品（用于采购匹配 / 入库）', name: 'product_id', value: v.product_id ? String(v.product_id) : '', type: 'select', options: linkOpts, help: '把该供应产品对应到产品信息中的某个产品，可留空' })}</div>
            <div class="col-12">
              <label class="form-label fw-semibold">上传 / 更换图片</label>
              <input type="file" class="form-control" id="spImageFile" accept="image/png,image/jpeg,image/gif,image/webp">
              <input type="hidden" name="image_data" id="spImageData">
              <div class="form-text">支持 PNG / JPG，不超过 3MB；每款产品可独立上传与报价。</div>
              ${clearBox}
            </div>
            <div class="col-12">${fld({ label: '备注', name: 'notes', value: v.notes, placeholder: 'MOQ、起订量、包装等' })}</div>
          </div>
        </div>
      </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存</button><a class="btn btn-outline-secondary" href="/suppliers/${supplier.id}">取消</a></div>
    </form>
    <script>
      document.getElementById('spImageFile').addEventListener('change', function () {
        const file = this.files && this.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) { alert('图片请小于 3MB'); this.value = ''; return; }
        const rd = new FileReader();
        rd.onload = function (e) {
          document.getElementById('spImageData').value = e.target.result;
          const box = document.getElementById('spImg');
          box.outerHTML = '<img id="spImg" src="' + e.target.result + '" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:10px;border:1px solid #dee2e6;padding:3px;background:#fff">';
        };
        rd.readAsDataURL(file);
      });
    </script>` })}`;
  return page({ title, active: 'suppliers', user: ctx.user, content, flash: ctx.flash() });
}

function stockMovementsPage(ctx) {
  const kw = ctx.query.search || '';
  let where = '(m.doc_id IS NULL OR d.user_id=?)'; const params = [ctx.user.id];
  if (kw) { where += ' AND (m.product_name LIKE ? OR m.doc_no LIKE ? OR m.party LIKE ? OR m.remark LIKE ?)'; const k = '%' + kw + '%'; params.push(k, k, k, k); }
  const rows = all(`SELECT m.*, p.unit FROM stock_movements m LEFT JOIN products p ON p.id=m.product_id LEFT JOIN documents d ON d.id=m.doc_id WHERE ${where} ORDER BY m.id DESC LIMIT 200`, ...params);
  const rowsHtml = rows.map(m => {
    const arrow = m.change > 0 ? '<span class="text-success fw-bold">+' + numFmt(m.change) + '</span>' : '<span class="text-danger fw-bold">' + numFmt(m.change) + '</span>';
    return `<tr>
      <td class="small">${esc((m.created_at || '').slice(0, 16))}</td>
      <td>${m.doc_no ? `<a href="/documents/${m.doc_id}">${esc(m.doc_no)}</a>` : '-'}</td>
      <td class="small">${esc(m.doc_type === 'so' ? '销售订单' : (m.doc_type === 'po' ? '采购单' : docTypeName(m.doc_type)))}</td>
      <td>${esc(m.party || '')}</td>
      <td>${esc(m.product_name)}${m.unit ? ` <span class="text-muted small">(${esc(m.unit)})</span>` : ''}</td>
      <td class="text-end">${arrow}</td>
      <td class="text-end">${numFmt(m.balance_after)}</td>
      <td class="small">${esc(m.remark || '')}</td>
    </tr>`;
  }).join('') || emptyRow(8, '暂无库存流水');
  const content = `
    ${pageHead('库存流水', '客户采购扣减 / 采购入库 / 回补等每一次变动都会记录在这里', `<a class="btn btn-outline-secondary" href="/products"><i class="bi bi-box-seam"></i> 返回产品信息</a>`)}
    ${card({ body: `
      <form class="row g-2 mb-3" method="get"><div class="col-md-4"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索产品 / 单号 / 客户 / 备注"></div><div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div><div class="col-auto"><a class="btn btn-outline-secondary" href="/stock/movements">重置</a></div></form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>时间</th><th>单据</th><th>类型</th><th>往来对象</th><th>产品</th><th class="text-end">变动</th><th class="text-end">变动后库存</th><th>备注</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="text-muted small">最近 ${rows.length} 条</div>` })}`;
  return page({ title: '库存流水', active: 'products', user: ctx.user, content, flash: ctx.flash() });
}
function docTypeName(k) {
  const map = { quotation: '报价单', pi: '形式发票', so: '销售合同', ci: '商业发票', pl: '装箱单', po: '采购单' };
  return map[k] || k;
}


// ================= 库存管理（集中视图） =================
function miniStat(label, value) {
  return `<div class="col-md-4"><div class="card border-0 shadow-sm"><div class="card-body py-2 px-3"><div class="text-muted small">${label}</div><div class="h5 fw-bold mb-0">${value}</div></div></div></div>`;
}function stockInventoryPage(ctx) {
  const kw = ctx.query.search || '';
  const en = ctx.query.en || '';
  const includeZero = ctx.query.inc === '1';
  const where = ['1=1']; const params = [];
  if (kw) { where.push('(name LIKE ? OR name_en LIKE ? OR model LIKE ? OR color LIKE ?)'); const k = '%' + kw + '%'; params.push(k, k, k, k); }
  if (!includeZero) where.push('stock <> 0');
  let rows = all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY id DESC`, ...params);
  const normEn = function (p) { return String(p.name_en || '').trim(); };
  if (en) {
    if (en === '__none__') rows = rows.filter(function (p) { return !normEn(p); });
    else rows = rows.filter(function (p) { return normEn(p) === en; });
  }
  // 产品分类（按英文品名整词分类，统计不含搜索条件）
  const catRows = all(includeZero ? 'SELECT name_en FROM products' : 'SELECT name_en FROM products WHERE stock<>0');
  const catCounts = {};
  catRows.forEach(function (p) { const k = normEn(p) || '__none__'; catCounts[k] = (catCounts[k] || 0) + 1; });
  const catKeys = Object.keys(catCounts).sort(function (a, b) {
    if (a === '__none__') return 1;
    if (b === '__none__') return -1;
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  });
  const enOpts = [{ v: '', l: '全部产品分类 (' + catRows.length + ')' }].concat(catKeys.map(function (k) {
    return { v: k, l: (k === '__none__' ? '（未填英文品名）' : k) + ' (' + catCounts[k] + ')' };
  }));
  const enSelect = '<select class="form-select" name="en" onchange="this.form.submit()">' + enOpts.map(function (o) {
    return '<option value="' + esc(o.v) + '"' + (o.v === en ? ' selected' : '') + '>' + esc(o.l) + '</option>';
  }).join('') + '</select>';
  // 平均卖货价：取报价单/PI/合同/CI 中有产品关联的明细
  const avgMap = {};
  for (const r of all(`SELECT CAST(i.value ->> '$.product_id' AS INTEGER) pid, SUM(CAST(i.value ->> '$.amount' AS REAL)) a, SUM(CAST(i.value ->> '$.qty' AS REAL)) q
    FROM documents d, json_each(d.items) i WHERE d.user_id=? AND d.doc_type IN ('quotation','pi','so','ci') GROUP BY pid`, ctx.user.id)) {
    if (r.pid && r.q) avgMap[r.pid] = r.a / r.q;
  }
  const totalCount = rows.length;
  const sumStock = rows.reduce((s, p) => s + (Number(p.stock) || 0), 0);
  const lowCount = rows.filter(p => (Number(p.stock) || 0) <= (Number(p.stock_alert) || 0)).length;
  const PAGE_SIZE = 15;
  const curPage = Math.max(1, parseInt(ctx.query.page || '1', 10) || 1);
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(curPage, pageCount);
  const stockBack = '/stock' + (ctx.url.search || '');
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const pageOptions = Array.from({ length: pageCount }, function (_, i) {
    return '<option value="' + (i + 1) + '"' + ((i + 1) === safePage ? ' selected' : '') + '>' + (i + 1) + '</option>';
  }).join('');
  const baseQs = (kw ? '&search=' + encodeURIComponent(kw) : '') + (en ? '&en=' + encodeURIComponent(en) : '') + (includeZero ? '&inc=1' : '');
  const pagination = pageCount >= 1 ? '<nav><ul class="pagination pagination-sm mb-0">' + (function () {
    let h = '';
    for (let i = 1; i <= pageCount; i++) h += '<li class="page-item ' + (i === safePage ? 'active' : '') + '"><a class="page-link" href="/stock?page=' + i + baseQs + '">' + i + '</a></li>';
    return h;
  })() + '</ul></nav>' : '';
  const rowsHtml = pageRows.map(p => {
    const per = Number(p.pcs_per_ctn) || 0;
    const stock = Number(p.stock) || 0;
    const ctnStored = Number(p.ctn_count) || 0;
    const ctn = ctnStored > 0 ? ctnStored : (per > 0 ? Math.round((stock / per) * 100) / 100 : null);
    const cur = p.currency || 'USD';
    const cost = Number(p.cost_price) || 0;
    const avg = avgMap[p.id];
    const statusBadge = stock <= 0 ? '<span class="badge text-bg-danger">缺货</span>' : (stock <= (Number(p.stock_alert) || 0) ? '<span class="badge text-bg-warning">偏低</span>' : '<span class="badge text-bg-success">正常</span>');
    return `<tr>
      <td><div class="d-flex align-items-center gap-2">
        <div style="width:46px;height:46px;flex:0 0 46px;border-radius:8px;overflow:hidden;background:#f1f4f8;border:1px solid #e7ecf2;display:flex;align-items:center;justify-content:center">
          ${p.image ? `<img src="${esc(p.image)}" style="width:100%;height:100%;object-fit:cover" alt="">` : '<i class="bi bi-image text-secondary"></i>'}
        </div>
        <div><div class="fw-semibold">${esc(p.name)}</div>${p.name_en ? `<div class="text-muted small">${esc(p.name_en)}</div>` : ''}</div>
      </div></td>
      <td class="text-center"><span class="text-monospace">${esc(p.model || '-')}</span></td>
      <td class="text-end">${per > 0 ? numFmt(per) : '-'}</td>
      <td class="text-end">${ctn !== null ? numFmt(ctn) : '-'}</td>
      <td class="text-end"><span class="fw-bold">${numFmt(stock)}</span> <span class="text-muted small">${esc(p.unit || '')}</span></td>
      <td class="text-end">${cost > 0 ? esc(cur) + ' ' + moneyFmt(cost) : '-'}</td>
      <td class="text-end">${avg ? esc(cur) + ' ' + moneyFmt(avg) : '-'}</td>
      <td>${statusBadge}</td>
      <td class="text-end">
        <form method="post" action="/products/${p.id}/stock" class="d-flex gap-1 justify-content-end mb-1" title="正数=入库，负数=出库">
          <input type="number" name="delta" step="any" value="0" class="form-control form-control-sm" style="width:78px">
          <button class="btn btn-sm btn-outline-success" style="white-space:nowrap">出入库</button>
        </form>
        <a class="btn btn-sm btn-outline-primary" href="/products/${p.id}/edit?back=${encodeURIComponent(stockBack)}">编辑</a>
      </td>
    </tr>`;
  }).join('') || emptyRow(9, '暂无产品，先到产品信息新建');
  const content = `
    ${pageHead('库存管理', '库存集中看板：箱数 / 装箱数 / 总数量 / 进货价 / 客户平均卖价', `<a class="btn btn-outline-primary" href="/stock/movements"><i class="bi bi-journal-text"></i> 库存流水</a> <a class="btn btn-primary" href="/products/new"><i class="bi bi-plus-lg"></i> 新建产品</a>`)}
    <div class="row g-3 mb-3">
      ${miniStat('产品款数', totalCount + ' 款')}
      ${miniStat('在库总数量', numFmt(sumStock) + ' 件')}
      ${miniStat('待补货', lowCount + ' 款')}
    </div>
    ${card({ body: `
      <form class="row g-2 mb-3 align-items-center" method="get">
        ${includeZero ? '<input type="hidden" name="inc" value="1">' : ''}
        <div class="col-md-3"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索品名 / 货号 / 颜色"></div>
        <div class="col-md-3 d-flex align-items-center gap-1"><span class="text-muted small text-nowrap">产品分类</span>${enSelect}</div>
        <div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/stock">重置</a></div>
        <div class="col-auto d-flex align-items-center gap-1"><span class="text-muted small">页码</span><select class="form-select form-select-sm" name="page" onchange="this.form.submit()" style="width:82px">${pageOptions}</select><span class="text-muted small">/ ${pageCount} 页</span></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>产品（图片）</th><th class="text-center">货号</th><th class="text-end">箱数</th><th class="text-end">装箱数<br>每箱</th><th class="text-end">总数量<br>件</th><th class="text-end">进货价</th><th class="text-end">客户平均卖价</th><th>状态</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span class="text-muted small">共 ${totalCount} 款 · 第 ${safePage}/${pageCount} 页 · 说明：箱数×装箱数=总数量参考值；实际库存以当前库存为准</span>
        ${pagination}
      </div>` })}`;
  return page({ title: '库存管理', active: 'stock', user: ctx.user, content, flash: ctx.flash() });
}

// ================= 跟进（集中看板） =================
function followupsPage(ctx) {
  const kw = ctx.query.search || '';
  const type = ctx.query.type || '';
  const priority = ctx.query.priority || '';
  const tier = ['A', 'B', 'C', 'D'].includes(String(ctx.query.tier || '').toUpperCase()) ? String(ctx.query.tier).toUpperCase() : '';
  let view = ctx.query.view || (ctx.query.upcoming === '1' ? 'today' : 'pending');
  if (!['pending', 'due', 'today', 'overdue', 'week', 'unscheduled', 'completed', 'all'].includes(view)) view = 'pending';
  const ts = dateAfter(0);
  const weekEnd = dateAfter(7);
  const monthStartD = new Date(); monthStartD.setDate(1);
  const monthStart = monthStartD.getFullYear() + '-' + String(monthStartD.getMonth() + 1).padStart(2, '0') + '-01';

  const statCount = (sql, ...params) => Number((get(sql, ...params) || {}).c || 0);
  const stats = {
    pending: statCount('SELECT COUNT(*) c FROM activities WHERE user_id=? AND archived=0', ctx.user.id),
    today: statCount('SELECT COUNT(*) c FROM activities WHERE user_id=? AND archived=0 AND next_follow_date=?', ctx.user.id, ts),
    overdue: statCount('SELECT COUNT(*) c FROM activities WHERE user_id=? AND archived=0 AND next_follow_date IS NOT NULL AND next_follow_date<>? AND next_follow_date<?', ctx.user.id, '', ts),
    week: statCount('SELECT COUNT(*) c FROM activities WHERE user_id=? AND archived=0 AND next_follow_date>? AND next_follow_date<=?', ctx.user.id, ts, weekEnd),
    unscheduled: statCount("SELECT COUNT(*) c FROM activities WHERE user_id=? AND archived=0 AND (next_follow_date IS NULL OR next_follow_date='')", ctx.user.id),
    completedMonth: statCount("SELECT COUNT(*) c FROM activities WHERE user_id=? AND archived=1 AND COALESCE(completed_at,activity_date,created_at)>=?", ctx.user.id, monthStart)
  };

  const where = ['a.user_id=?']; const params = [ctx.user.id];
  if (view === 'pending') where.push('a.archived=0');
  if (view === 'due') { where.push("a.archived=0 AND a.next_follow_date<>'' AND a.next_follow_date<=?"); params.push(ts); }
  if (view === 'today') { where.push('a.archived=0 AND a.next_follow_date=?'); params.push(ts); }
  if (view === 'overdue') { where.push("a.archived=0 AND a.next_follow_date IS NOT NULL AND a.next_follow_date<>'' AND a.next_follow_date<?"); params.push(ts); }
  if (view === 'week') { where.push('a.archived=0 AND a.next_follow_date>? AND a.next_follow_date<=?'); params.push(ts, weekEnd); }
  if (view === 'unscheduled') where.push("a.archived=0 AND (a.next_follow_date IS NULL OR a.next_follow_date='')");
  if (view === 'completed') where.push('a.archived=1');
  if (type) { where.push('a.type=?'); params.push(type); }
  if (priority) { where.push('a.priority=?'); params.push(priority); }
  if (tier) { where.push('c.customer_tier=?'); params.push(tier); }
  if (kw) {
    const k = '%' + kw + '%';
    where.push('(c.company_name LIKE ? OR c.name_en LIKE ? OR a.subject LIKE ? OR a.content LIKE ? OR a.outcome LIKE ? OR a.contact_person LIKE ?)');
    params.push(k, k, k, k, k, k);
  }
  const order = view === 'completed'
    ? 'COALESCE(a.completed_at,a.activity_date,a.created_at) DESC, a.id DESC'
    : "CASE c.customer_tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 WHEN 'D' THEN 3 ELSE 4 END, CASE a.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, (a.next_follow_date IS NULL), a.next_follow_date ASC, a.activity_date DESC";
  const rows = all(`SELECT a.*, c.company_name, c.name_en, c.country, c.phone, c.contact_phone, c.whatsapp,
      c.customer_tier, c.tier_score,
      (SELECT COALESCE(NULLIF(mobile,''), NULLIF(phone,'')) FROM contacts
        WHERE customer_id=c.id ORDER BY COALESCE(is_primary,0) DESC, id ASC LIMIT 1) AS primary_contact_phone
    FROM activities a JOIN customers c ON c.id=a.customer_id
    WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, ...params);

  const customers = all('SELECT id,company_name,name_en,country,customer_tier,tier_score FROM customers WHERE COALESCE(in_pool,0)=0 AND user_id=? ORDER BY company_name', ctx.user.id);
  const customerSearchJson = JSON.stringify(customers.map(c => ({ id:c.id, name:c.company_name, name_en:c.name_en||'', country:c.country||'', tier:c.customer_tier||'', score:c.tier_score||0 }))).replace(/</g, '\\\\u003c');
  const custOpts = [{ v: '', l: '— 选择客户 —' }].concat(customers.map(c => ({ v: String(c.id), l: c.company_name + (c.name_en ? ' / ' + c.name_en : '') })));
  const typeOpts = ['', 'WhatsApp', '邮件', '微信', '电话', '样品', '会议', '拜访', '报价', '展会', '其他'].map(t => ({ v: t, l: t || '全部方式' }));
  const priorityFilterOpts = ['', '高', '中', '低'].map(p => ({ v: p, l: p ? p + '优先级' : '全部优先级' }));
  const tierFilterOpts = ['', 'A', 'B', 'C', 'D'].map(t => ({ v: t, l: t ? t + '类客户' : '全部分层' }));

  const viewUrl = (v) => {
    const qs = [];
    if (v && v !== 'pending') qs.push('view=' + encodeURIComponent(v));
    if (type) qs.push('type=' + encodeURIComponent(type));
    if (priority) qs.push('priority=' + encodeURIComponent(priority));
    if (tier) qs.push('tier=' + encodeURIComponent(tier));
    if (kw) qs.push('search=' + encodeURIComponent(kw));
    return '/followups' + (qs.length ? '?' + qs.join('&') : '');
  };
  const viewChips = [
    ['pending', '全部待办', stats.pending],
    ['due', '待处理', stats.today + stats.overdue],
    ['today', '今天', stats.today],
    ['overdue', '已逾期', stats.overdue],
    ['week', '未来7天', stats.week],
    ['unscheduled', '未排期', stats.unscheduled],
    ['completed', '已完成', stats.completedMonth],
    ['all', '全部记录', null]
  ].map(x => `<a class="btn btn-sm ${view === x[0] ? 'btn-primary' : 'btn-outline-secondary'}" href="${viewUrl(x[0])}">${x[1]}${x[2] !== null ? ' <span class="ms-1 opacity-75">' + x[2] + '</span>' : ''}</a>`).join('');

  const statCard = (icon, label, value, sub, href, tone) => `<div class="col-6 col-xl-6">
    <a class="stat-card text-decoration-none" href="${href}">
      <div class="stat-icon ${tone}"><i class="bi ${icon}"></i></div>
      <div><div class="stat-num">${value}</div><div class="stat-label">${label}</div><div class="stat-sub">${sub}</div></div>
    </a></div>`;

  const rowsHtml = rows.map(a => {
    const nf = a.next_follow_date || '';
    const overdueDays = nf && nf < ts ? Math.max(1, Math.floor((new Date(ts + 'T00:00:00') - new Date(nf + 'T00:00:00')) / 86400000)) : 0;
    const dueToday = !!nf && nf === ts;
    const isOverdue = !a.archived && overdueDays > 0;
    let dueBadge = '<span class="badge text-bg-light border">未排期</span>';
    if (a.archived) dueBadge = '<span class="badge text-bg-success"><i class="bi bi-check2 me-1"></i>已完成</span>';
    else if (isOverdue) dueBadge = `<span class="badge text-bg-danger">逾期 ${overdueDays} 天</span>`;
    else if (dueToday) dueBadge = '<span class="badge text-bg-danger">今天跟进</span>';
    else if (nf && nf <= weekEnd) dueBadge = `<span class="badge text-bg-warning">${esc(nf)}</span>`;
    else if (nf) dueBadge = `<span class="badge text-bg-light border">${esc(nf)}</span>`;

    const contextLine = [a.contact_person ? '联系人：' + a.contact_person : '', a.country || ''].filter(Boolean).join(' · ');
    const waPhone = a.whatsapp || a.contact_phone || a.phone || a.primary_contact_phone || '';
    const quickSnooze = a.archived ? '' : `<div class="fu-snooze"><span>顺延：</span>
      <form method="post" action="/api/activities/${a.id}/reschedule"><input type="hidden" name="days" value="1"><button class="btn btn-sm btn-outline-secondary">明天</button></form>
      <form method="post" action="/api/activities/${a.id}/reschedule"><input type="hidden" name="days" value="3"><button class="btn btn-sm btn-outline-secondary">3天后</button></form>
      <form method="post" action="/api/activities/${a.id}/reschedule"><input type="hidden" name="days" value="7"><button class="btn btn-sm btn-outline-secondary">下周</button></form>
    </div>`;
    return `<article class="fu-task ${isOverdue ? 'is-overdue' : ''} ${a.archived ? 'is-completed' : ''}">
      <div class="fu-task-marker"><i class="bi ${a.archived ? 'bi-check-lg' : (isOverdue ? 'bi-exclamation-lg' : 'bi-dot')}"></i></div>
      <div class="fu-task-main">
        <div class="fu-task-head">
          <div class="fu-task-title-wrap">
            <a class="fu-customer" href="/customers/${a.customer_id}">${esc(a.company_name)}</a>
            ${badge(a.customer_tier || 'C')}
            <span class="badge text-bg-light border">${esc(a.type || '其他')}</span>
            ${priorityBadge(a.priority)}
            ${dueBadge}
          </div>
          <div class="text-muted small">${a.archived ? (a.completed_at ? '完成于 ' + esc(String(a.completed_at).slice(0, 16)) : '已归档') : '上次跟进 ' + esc((a.activity_date || '').slice(0, 16))}</div>
        </div>
        <div class="fu-task-subject">${esc(a.subject || '未命名跟进')}</div>
        ${contextLine ? `<div class="fu-task-meta"><i class="bi bi-person-lines-fill"></i>${esc(contextLine)}</div>` : ''}
        ${a.content ? `<div class="fu-task-note">${esc(String(a.content).slice(0, 180))}${String(a.content).length > 180 ? '…' : ''}</div>` : ''}
        ${a.outcome ? `<div class="fu-task-outcome"><i class="bi bi-check2-circle"></i><span>处理结果：${esc(a.outcome)}</span></div>` : ''}
        ${!a.archived && a.next_follow_notes ? `<div class="fu-next-note"><i class="bi bi-bullseye"></i><span>下一步：${esc(a.next_follow_notes)}</span></div>` : ''}
        ${imagesThumb(a.images)}
      </div>
      <div class="fu-task-actions">
        <button type="button" class="btn btn-sm btn-outline-success fu-wa-send" data-id="${a.id}" data-name="${esc(a.company_name)}" data-phone="${esc(waPhone)}" data-contact="${esc(a.contact_person || '')}" onclick="openFollowupWa(this)" title="直接给客户发送 WhatsApp"><i class="bi bi-whatsapp me-1"></i>WhatsApp</button>
        ${a.archived ? '' : `<button type="button" class="btn btn-sm btn-primary" data-id="${a.id}" data-name="${esc(a.company_name)}" data-type="${esc(a.type || '')}" data-contact="${esc(a.contact_person || '')}" data-priority="${esc(a.priority || '中')}" data-notes="${esc(a.next_follow_notes || '')}" data-next="${esc(nf)}" onclick="completeFu(this)"><i class="bi bi-check2-circle me-1"></i>完成</button>`}
        <a class="btn btn-sm btn-outline-secondary" href="/activities/${a.id}/edit?return_to=/followups"><i class="bi bi-pencil"></i></a>
        <form method="post" action="/activities/${a.id}/delete" onsubmit="return confirm('确认删除该跟进记录？')"><input type="hidden" name="return_to" value="/followups"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
        ${quickSnooze}
      </div>
    </article>`;
  }).join('') || `<div class="fu-empty"><div class="fu-empty-icon"><i class="bi bi-calendar2-check"></i></div><h5>当前筛选下没有跟进任务</h5><p class="text-muted mb-0">可以切换视图，或为客户新建一条跟进计划。</p></div>`;

  const content = `
    ${pageHead('跟进中心', '按优先级管理待办、逾期任务和下一步行动，避免客户遗漏', '<a class="btn btn-primary" href="#quickFollowup"><i class="bi bi-plus-lg"></i> 新建跟进</a>')}
    <div class="row g-3 mb-4">
      ${statCard('bi-exclamation-octagon', '已逾期', stats.overdue, '需要优先处理', viewUrl('overdue'), 'tone-danger')}
      ${statCard('bi-calendar2-day', '今天待跟进', stats.today, '今天的行动清单', viewUrl('today'), 'tone-coral')}
      ${statCard('bi-calendar2-week', '未来 7 天', stats.week, '提前安排重点客户', viewUrl('week'), 'tone-yellow')}
      ${statCard('bi-check2-circle', '本月已完成', stats.completedMonth, '持续沉淀跟进结果', viewUrl('completed'), 'tone-green')}
    </div>
    ${card({ title: '快速新建跟进', body: `<div class="d-flex gap-2 align-items-start flex-wrap" id="quickFollowup">
      <div class="position-relative" style="width:100%;max-width:460px">
        <input type="text" class="form-control" id="fuCustomerSearch" placeholder="搜索客户名称 / 英文名并添加" autocomplete="off">
        <input type="hidden" id="fuCustomer">
        <div id="fuCustomerList" class="list-group position-absolute w-100 shadow" style="max-height:260px;overflow:auto;z-index:90;display:none"></div>
      </div>
      <button class="btn btn-primary" id="fuGo"><i class="bi bi-calendar-plus me-1"></i>为客户添加跟进计划</button>
      <span class="text-muted small">输入客户中文名或英文名，点击结果后添加</span>
    </div>` })}
    ${card({ body: `
      <div class="d-flex gap-1 flex-wrap align-items-center mb-3">${viewChips}</div>
      <form class="search-filter-row" method="get">
        <input type="hidden" name="view" value="${esc(view)}">
        <div>${fld({ name: 'type', value: type, type: 'select', options: typeOpts })}</div>
        <div>${fld({ name: 'priority', value: priority, type: 'select', options: priorityFilterOpts })}</div>
        <div>${fld({ name: 'tier', value: tier, type: 'select', options: tierFilterOpts })}</div>
        <div class="flex-grow-1" style="min-width:220px"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索客户 / 主题 / 内容 / 处理结果"></div>
        <button class="btn btn-primary"><i class="bi bi-search me-1"></i>筛选</button>
        <a class="btn btn-outline-secondary" href="/followups">重置</a>
      </form>
      <div class="fu-task-list">${rowsHtml}</div>
      <div class="text-muted small mt-3">当前显示 ${rows.length} 条 · 红色为逾期任务，黄色为未来 7 天内任务</div>` })}
    ${followupModalHtml()}
    ${completeFollowupModalHtml()}
    ${whatsappFollowupModalHtml()}
    ${followupScript()}
    ${whatsappFollowupScript()}
    <script>
      (function () {
        var customers = ${customerSearchJson};
        var input = document.getElementById('fuCustomerSearch');
        var hidden = document.getElementById('fuCustomer');
        var list = document.getElementById('fuCustomerList');
        function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (x) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[x]; }); }
        function render() {
          var q = input.value.trim().toLowerCase();
          if (!q) { list.style.display = 'none'; return; }
          var rows = customers.filter(function (c) { return c.name.toLowerCase().indexOf(q) >= 0 || (c.name_en || '').toLowerCase().indexOf(q) >= 0 || (c.country || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 30);
          list.innerHTML = rows.map(function (c) { return '<button type="button" class="list-group-item list-group-item-action" data-id="' + c.id + '" data-name="' + escHtml(c.name + (c.name_en ? ' / ' + c.name_en : '')) + '"><div class="fw-semibold">' + escHtml(c.name) + ' <span class="badge text-bg-light border">' + escHtml(c.tier || '待计算') + '</span></div><div class="small text-muted">' + escHtml(c.name_en || '') + (c.country ? ' · ' + escHtml(c.country) : '') + '</div></button>'; }).join('') || '<div class="list-group-item text-muted">没有匹配客户</div>';
          list.style.display = 'block';
        }
        function go() { var cid = hidden.value; if (!cid) { alert('请先搜索并选择客户'); return; } location.href = '/customers/' + cid + '/activities/new?return_to=/followups'; }
        input.addEventListener('focus', render);
        input.addEventListener('input', function () { hidden.value = ''; render(); });
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        list.addEventListener('click', function (e) { var btn = e.target.closest('[data-id]'); if (!btn) return; hidden.value = btn.getAttribute('data-id'); input.value = btn.getAttribute('data-name'); list.style.display = 'none'; });
        document.getElementById('fuGo').addEventListener('click', go);
        document.addEventListener('click', function (e) { if (!e.target.closest('#fuCustomerSearch') && !e.target.closest('#fuCustomerList')) list.style.display = 'none'; });
      })();
    </script>`;
  return page({ title: '跟进中心', active: 'followups', user: ctx.user, content, flash: ctx.flash() });
}
// ================= 公共客户池 =================
function poolPage(ctx) {
  const kw = ctx.query.search || '';
  const where = ['COALESCE(in_pool,0)=1']; const params = [];
  if (kw) {
    where.push('(company_name LIKE ? OR name_en LIKE ? OR country LIKE ? OR phone LIKE ? OR email LIKE ?)');
    const k = '%' + kw + '%'; params.push(k, k, k, k, k);
  }
  const rows = all(`SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY pool_at DESC, id DESC`, ...params);
  const rowsHtml = rows.map(c => `<tr>
      <td><a class="fw-semibold text-decoration-none" href="/customers/${c.id}">${esc(c.company_name)}</a>${c.name_en ? '<div class="text-muted small">' + esc(c.name_en) + '</div>' : ''}</td>
      <td>${esc(c.country || '-')}</td>
      <td>${esc(c.phone || '-')}</td>
      <td>${esc(c.email || '-')}</td>
      <td class="text-center">${esc((c.pool_at || '').slice(0, 16))}</td>
      <td class="small">${esc(c.pool_reason || '-')}</td>
      <td class="text-end">
        <a class="btn btn-sm btn-outline-primary" href="/customers/${c.id}">查看</a>
        <form class="d-inline" method="post" action="/customers/${c.id}/claim"><button class="btn btn-sm btn-success"><i class="bi bi-hand-index-thumb"></i> 领取</button></form>
      </td>
    </tr>`).join('') || emptyRow(7, '公共客户池暂无客户');
  const content = `
    ${pageHead('公共客户池', '已取消跟进的客户，所有账号都可见；领取后可继续跟进', '<a class="btn btn-outline-secondary" href="/customers">返回客户管理</a>')}
    ${card({ body: `
      <form class="row g-2 mb-3" method="get">
        <div class="col-md-4"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索公司 / 国家 / 电话 / 邮箱"></div>
        <div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/pool">重置</a></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>公司名称</th><th>国家/地区</th><th>电话</th><th>邮箱</th><th class="text-center">入池时间</th><th>入池原因</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="text-muted small">共 ${rows.length} 家 · 此池中客户对全部登录账号可见</div>` })}`;
  return page({ title: '公共客户池', active: 'pool', user: ctx.user, content, flash: ctx.flash() });
}

// ================= FOEVE 独立站询盘 =================
function onlyDigits(value) {
  return String(value || '').replace(/[^0-9]/g, '').replace(/^00/, '');
}

function inquiryStateBadge(inPool) {
  return inPool
    ? '<span class="badge text-bg-warning">公共池待领取</span>'
    : '<span class="badge text-bg-success">已领取</span>';
}

function inquiriesPage(ctx) {
  const q = String(ctx.query.search || '').trim();
  const state = String(ctx.query.state || '').trim();
  const where = ['(COALESCE(c.in_pool,0)=1 OR c.user_id=?)'];
  const params = [ctx.user.id];
  if (state === 'pool') where.push('COALESCE(c.in_pool,0)=1');
  if (state === 'mine') where.push('COALESCE(c.in_pool,0)=0');
  if (q) {
    where.push(`(i.name LIKE ? OR i.company LIKE ? OR i.email LIKE ? OR i.whatsapp LIKE ?
      OR i.product LIKE ? OR i.sku LIKE ? OR c.company_name LIKE ?)`);
    const keyword = '%' + q + '%';
    params.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword);
  }
  const rows = all(`SELECT i.*, c.company_name, c.name_en, c.status AS customer_status, c.level AS customer_level,
      c.in_pool, c.user_id AS customer_user_id, c.pool_at, c.pool_reason
    FROM website_inquiries i JOIN customers c ON c.id=i.customer_id
    WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT 500`, ...params);
  const counts = get(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN COALESCE(c.in_pool,0)=1 THEN 1 ELSE 0 END),0) AS pool,
      COALESCE(SUM(CASE WHEN COALESCE(c.in_pool,0)=0 THEN 1 ELSE 0 END),0) AS mine
    FROM website_inquiries i JOIN customers c ON c.id=i.customer_id
    WHERE (COALESCE(c.in_pool,0)=1 OR c.user_id=?)`, ctx.user.id);

  const chip = (value, label) => {
    const on = state === value;
    const href = '/inquiries?state=' + encodeURIComponent(value) + (q ? '&search=' + encodeURIComponent(q) : '');
    return `<a class="btn btn-sm ${on ? 'btn-primary' : 'btn-outline-primary'}" href="${href}">${label}</a>`;
  };
  const rowsHtml = rows.map(i => {
    const inPool = !!Number(i.in_pool);
    const customerHref = '/customers/' + i.customer_id;
    return `<tr>
      <td class="text-nowrap small">${esc((i.created_at || '').slice(0, 16))}</td>
      <td>
        <a class="fw-semibold text-decoration-none" href="/inquiries/${i.id}">${esc(i.name || '未填写姓名')}</a>
        <div class="small text-muted">${esc(i.company || i.company_name || '-')}</div>
        <div class="small text-muted">${i.email ? esc(i.email) : ''}${i.email && i.whatsapp ? ' · ' : ''}${i.whatsapp ? esc(i.whatsapp) : ''}</div>
      </td>
      <td>${esc(i.country || '-')}</td>
      <td><div class="fw-semibold">${esc(i.product || '-')}</div>${i.sku ? `<div class="small text-muted">SKU ${esc(i.sku)}</div>` : ''}</td>
      <td class="text-nowrap">${esc(i.quantity || '-')}</td>
      <td>${i.preferred_channel ? `<span class="badge text-bg-light border">${esc(i.preferred_channel)}</span>` : '-'}</td>
      <td class="small">${esc(i.project_type || '-')}</td>
      <td>${inquiryStateBadge(inPool)}</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-outline-primary" href="/inquiries/${i.id}">详情</a>
        ${(inPool || Number(i.customer_user_id) === Number(ctx.user.id)) ? `<a class="btn btn-sm btn-outline-secondary" href="${customerHref}">客户</a>` : ''}
        ${inPool ? `<form class="d-inline" method="post" action="${customerHref}/claim"><input type="hidden" name="return_to" value="/inquiries/${i.id}"><button class="btn btn-sm btn-success" type="submit"><i class="bi bi-hand-index-thumb"></i> 领取</button></form>` : ''}
      </td>
    </tr>`;
  }).join('') || emptyRow(9, '还没有独立站询盘。官网提交后会自动出现在这里。');

  const content = `
    ${pageHead('独立站询盘', 'FOEVE 官网提交自动建档；新客户默认进入公共客户池，领取后归当前账号', '<a class="btn btn-outline-secondary" href="/pool">打开公共客户池</a>')}
    <div class="row g-3 mb-3">
      <div class="col-md-4">${miniStatCard('可见询盘', String(counts.total || 0))}</div>
      <div class="col-md-4">${miniStatCard('公共池待领取', String(counts.pool || 0))}</div>
      <div class="col-md-4">${miniStatCard('已领取给我', String(counts.mine || 0))}</div>
    </div>
    ${card({ body: `
      <div class="d-flex gap-2 flex-wrap mb-3">${chip('', '全部')}${chip('pool', '公共池待领取')}${chip('mine', '已领取给我')}</div>
      <form class="row g-2 mb-3" method="get">
        <input type="hidden" name="state" value="${esc(state)}">
        <div class="col-md-5"><input class="form-control" name="search" value="${esc(q)}" placeholder="搜索姓名 / 公司 / 邮箱 / WhatsApp / 产品 / SKU"></div>
        <div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/inquiries">重置</a></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>提交时间</th><th>联系人 / 公司</th><th>国家</th><th>产品</th><th>数量</th><th>回复偏好</th><th>项目类型</th><th>状态</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
      <div class="text-muted small">最多显示最近 500 条。已领取的询盘只对领取账号可见；公共池询盘对所有登录账号可见。</div>
    ` })}`;
  return page({ title: '独立站询盘', active: 'inquiries', user: ctx.user, content, flash: ctx.flash() });
}

function inquiryDetailPage(ctx) {
  const inquiry = get(`SELECT i.*, c.company_name, c.name_en, c.country AS customer_country,
      c.status AS customer_status, c.level AS customer_level, c.in_pool, c.user_id AS customer_user_id,
      c.pool_at, c.pool_reason, c.email AS customer_email, c.whatsapp AS customer_whatsapp
    FROM website_inquiries i JOIN customers c ON c.id=i.customer_id
    WHERE i.id=? AND (COALESCE(c.in_pool,0)=1 OR c.user_id=?)`, ctx.params.id, ctx.user.id);
  if (!inquiry) return notFoundPage(ctx, '询盘不存在或无权查看');

  const inPool = !!Number(inquiry.in_pool);
  const isOwner = Number(inquiry.customer_user_id) === Number(ctx.user.id) && !inPool;
  const canViewCustomer = inPool || isOwner;
  const customerHref = '/customers/' + inquiry.customer_id;
  const waDigits = onlyDigits(inquiry.whatsapp);
  const emailHref = inquiry.email
    ? 'mailto:' + inquiry.email + '?subject=' + encodeURIComponent('FOEVE inquiry #' + inquiry.id)
    : '';
  const waHref = waDigits ? 'https://wa.me/' + waDigits : '';
  const pageUrl = isHttpUrl(inquiry.page_url) ? inquiry.page_url : '';
  const utm = [
    inquiry.utm_source && 'source=' + inquiry.utm_source,
    inquiry.utm_medium && 'medium=' + inquiry.utm_medium,
    inquiry.utm_campaign && 'campaign=' + inquiry.utm_campaign,
    inquiry.utm_content && 'content=' + inquiry.utm_content,
    inquiry.utm_term && 'term=' + inquiry.utm_term,
  ].filter(Boolean).join(' / ');
  const info = (label, value) => value ? `<div class="mb-2"><div class="text-muted small">${label}</div><div class="fw-semibold">${esc(value)}</div></div>` : '';
  const longInfo = (label, value) => value ? `<div class="mb-3"><div class="text-muted small">${label}</div><div style="white-space:pre-wrap;word-break:break-word">${esc(value)}</div></div>` : '';
  const actions = `<a class="btn btn-outline-secondary" href="/inquiries">返回列表</a>
    ${emailHref ? `<a class="btn btn-outline-primary" href="${esc(emailHref)}"><i class="bi bi-envelope"></i> 用 Email 回复</a>` : ''}
    ${waHref ? `<a class="btn btn-success" href="${esc(waHref)}" target="_blank" rel="noopener noreferrer"><i class="bi bi-whatsapp"></i> 用 WhatsApp 回复</a>` : ''}
    ${canViewCustomer ? `<a class="btn btn-outline-dark" href="${customerHref}">查看客户</a>` : ''}
    ${inPool ? `<form class="d-inline" method="post" action="${customerHref}/claim"><input type="hidden" name="return_to" value="/inquiries/${inquiry.id}"><button class="btn btn-success" type="submit"><i class="bi bi-hand-index-thumb"></i> 领取客户</button></form>` : ''}`;

  const content = `
    ${pageHead('独立站询盘 #' + inquiry.id, `${esc(inquiry.name || inquiry.company_name || '官网访客')} · ${esc((inquiry.created_at || '').slice(0, 16))} ${inquiryStateBadge(inPool)}`, actions)}
    <div class="row g-3">
      <div class="col-12 col-xl-8">
        ${card({ title: '询盘内容', body: `
          ${longInfo('客户留言', inquiry.message || '（未填写留言）')}
          <div class="row g-3">
            <div class="col-md-6">${info('产品', inquiry.product)}${info('SKU / 型号', inquiry.sku)}${info('数量', inquiry.quantity)}${info('表面处理', inquiry.finish)}</div>
            <div class="col-md-6">${info('项目类型', inquiry.project_type)}${info('回复偏好', inquiry.preferred_channel)}${info('语言 / Locale', inquiry.locale)}${info('客户状态', inquiry.customer_status)}</div>
          </div>
        ` })}
        ${card({ title: '来源与归因', body: `
          ${info('提交页面', pageUrl || inquiry.page_url || '-')}
          ${pageUrl ? `<div class="mb-3"><a href="${esc(pageUrl)}" target="_blank" rel="noopener noreferrer">打开原页面 <i class="bi bi-box-arrow-up-right"></i></a></div>` : ''}
          ${info('UTM', utm)}
          ${info('询盘编号', '#' + inquiry.id)}
          ${info('提交时间', inquiry.created_at)}
        ` })}
      </div>
      <div class="col-12 col-xl-4">
        ${card({ title: '联系人', body: `
          ${info('姓名', inquiry.name)}${info('公司', inquiry.company || inquiry.company_name)}
          ${info('邮箱', inquiry.email)}${info('WhatsApp', inquiry.whatsapp)}${info('国家/地区', inquiry.country)}
        ` })}
        ${card({ title: '客户归属', body: `
          <div class="mb-3">${inquiryStateBadge(inPool)} ${badge(inquiry.customer_status || '潜在客户')} ${badge(inquiry.customer_level || '普通')}</div>
          ${info('入池时间', inquiry.pool_at)}
          ${info('入池原因', inquiry.pool_reason)}
          ${info('关联客户', inquiry.company_name)}
          ${canViewCustomer ? `<a class="btn btn-sm btn-outline-primary" href="${customerHref}">打开客户详情</a>` : ''}
        ` })}
      </div>
    </div>`;
  return page({ title: '独立站询盘 #' + inquiry.id, active: 'inquiries', user: ctx.user, content, flash: ctx.flash() });
}

// ================= 产品 -> 客户采购记录（V1.01） =================
function productBuyersPage(ctx) {
  const p = get('SELECT * FROM products WHERE id=?', ctx.params.id);
  if (!p) return notFoundPage(ctx, '产品不存在');
  const rows = all(`SELECT d.id AS doc_id, d.doc_no, d.doc_type, d.issue_date, d.status, c.company_name, c.country,
    CAST(i.value ->> '$.qty' AS REAL) qty, CAST(i.value ->> '$.amount' AS REAL) amount
    FROM documents d JOIN customers c ON c.id=d.customer_id, json_each(d.items) i
    WHERE CAST(i.value ->> '$.product_id' AS INTEGER)=? AND d.doc_type IN ('so','ci','pi','quotation')
      AND d.user_id=? AND d.customer_id>0 AND d.status<>'已作废' ORDER BY d.issue_date DESC, d.id DESC`, p.id, ctx.user.id);
  const totalQty = rows.reduce(function (s, r) { return s + (Number(r.qty) || 0); }, 0);
  const totalAmt = rows.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
  const custAgg = {};
  rows.forEach(function (r) {
    const key = r.customer_id;
    if (!custAgg[key]) custAgg[key] = { name: r.company_name, country: r.country, qty: 0, amt: 0, docs: 0 };
    custAgg[key].qty += Number(r.qty) || 0; custAgg[key].amt += Number(r.amount) || 0; custAgg[key].docs += 1;
  });
  const aggHtml = Object.keys(custAgg).map(function (k) {
    const a = custAgg[k];
    return `<tr><td><span class="fw-semibold">${esc(a.name)}</span><div class="text-muted small">${esc(a.country || '')}</div></td><td class="text-center">${a.docs}</td><td class="text-end">${numFmt(a.qty)}</td><td class="text-end">${esc(p.currency || 'USD')} ${moneyFmt(a.amt)}</td></tr>`;
  }).join('') || emptyRow(4, '还没有客户采购过该产品');
  const rowsHtml = rows.map(function (r) {
    return `<tr><td><a class="text-decoration-none" href="/documents/${'${r.doc_id}'}">${esc(r.doc_no)}</a></td><td>${esc(r.company_name)}</td><td class="text-center">${esc(r.issue_date || '-')}</td><td>${badge(r.status)}</td><td class="text-end">${numFmt(r.qty)}</td><td class="text-end">${esc(p.currency || 'USD')} ${moneyFmt(r.amount)}</td></tr>`;
  }).join('') || emptyRow(6, '暂无采购单据');
  const content = `
    ${pageHead('客户采购记录', `${esc(p.name)} · ${esc(p.model || '无货号')} · 当前库存 ${numFmt(p.stock)} ${esc(p.unit || '')}`, `<a class="btn btn-outline-secondary" href="/stock">返回库存</a>`)}
    <div class="row g-3 mb-3">
      <div class="col-md-4">${miniStatCard('采购客户数', Object.keys(custAgg).length + ' 家')}</div>
      <div class="col-md-4">${miniStatCard('累计采购数量', numFmt(totalQty) + ' ' + esc(p.unit || '件'))}</div>
      <div class="col-md-4">${miniStatCard('累计金额', esc(p.currency || 'USD') + ' ' + moneyFmt(totalAmt))}</div>
    </div>
    ${card({ title: '按客户汇总', body: `<div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>客户</th><th class="text-center">采购单数</th><th class="text-end">数量</th><th class="text-end">金额</th></tr></thead><tbody>${aggHtml}</tbody></table></div>` })}
    ${card({ title: '采购明细（单据）', body: `<div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>单号</th><th>客户</th><th class="text-center">日期</th><th>状态</th><th class="text-end">数量</th><th class="text-end">金额</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` })}`;
  return page({ title: '客户采购记录', active: 'stock', user: ctx.user, content, flash: ctx.flash() });
}
function miniStatCard(label, value) {
  return `<div class="card border-0 shadow-sm"><div class="card-body py-2 px-3"><div class="text-muted small">${label}</div><div class="h5 fw-bold mb-0">${value}</div></div></div>`;
}

module.exports = { dashboardPage, dashboardPipelineCustomers, customersPage, customerDetailPage, customerFormPage, contactFormPage, activityFormPage, productsPage, productFormPage, productDetailPage, notFoundPage, suppliersPage, supplierFormPage, supplierDetailPage, supplierProductFormPage, stockMovementsPage, stockInventoryPage, followupsPage, productBuyersPage, poolPage, inquiriesPage, inquiryDetailPage };



































