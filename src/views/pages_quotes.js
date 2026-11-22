'use strict';
// ============ 历史报价：与产品管理联动，新增后自动生成跟进 ============
const { esc } = require('../util');
const { page } = require('./layout');
const { fld, card, pageHead, emptyRow } = require('./ui');
const { get, all } = require('../db');

function moneyFmt(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function numFmt(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function nextQuoteNo() {
  const d = new Date();
  const prefix = 'HQ-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-';
  const last = get("SELECT quote_no FROM quote_history WHERE quote_no LIKE ? ORDER BY id DESC LIMIT 1", prefix + '%');
  let seq = 1;
  if (last && last.quote_no) { const n = parseInt(String(last.quote_no).slice(prefix.length), 10); if (n > 0) seq = n + 1; }
  return prefix + String(seq).padStart(3, '0');
}
function quoteStatusBadge(s) {
  const map = { '已报价': 'primary', '跟进中': 'warning', '报价已接受': 'info', '已成交': 'success', '已失效': 'secondary' };
  const cls = map[s] || 'secondary';
  return '<span class="badge text-bg-' + cls + '">' + esc(s || '已报价') + '</span>';
}
function miniStat(label, value, sub) {
  return `<div class="col-6 col-xl-3"><div class="stat-card"><div class="stat-icon tone-coral"><i class="bi bi-clock-history"></i></div><div><div class="stat-num">${value}</div><div class="stat-label">${label}</div><div class="stat-sub">${sub || ''}</div></div></div></div>`;
}

function quotesPage(ctx) {
  const kw = String(ctx.query.search || '').trim();
  const status = String(ctx.query.status || '').trim();
  const productId = parseInt(ctx.query.product_id || '', 10) || 0;
  const where = ['q.user_id=?']; const params = [ctx.user.id];
  if (kw) { where.push('(q.quote_no LIKE ? OR q.product_name LIKE ? OR q.model LIKE ? OR c.company_name LIKE ?)'); const k = '%' + kw + '%'; params.push(k, k, k, k); }
  if (status) { where.push('q.status=?'); params.push(status); }
  if (productId) { where.push("EXISTS (SELECT 1 FROM json_each(q.items) qi WHERE CAST(qi.value ->> '$.product_id' AS INTEGER)=?)"); params.push(productId); }
  const rows = all(`SELECT q.*, c.company_name, c.country, p.image, a.next_follow_date, a.archived AS followup_archived, a.id AS followup_id
    FROM quote_history q LEFT JOIN customers c ON c.id=q.customer_id LEFT JOIN products p ON p.id=q.product_id LEFT JOIN activities a ON a.id=q.activity_id
    WHERE ${where.join(' AND ')} ORDER BY q.id DESC LIMIT 500`, ...params);
  const products = all('SELECT id,name,name_en,model FROM products ORDER BY name,model');
  const productOpts = [{ v: '', l: '全部产品' }].concat(products.map(p => ({ v: String(p.id), l: (p.model ? p.model + ' · ' : '') + p.name + (p.name_en ? ' / ' + p.name_en : '') })));
  const statuses = ['', '已报价', '跟进中', '报价已接受', '已成交', '已失效'];
  const statusCounts = {};
  for (const r of all('SELECT status k, COUNT(*) c FROM quote_history WHERE user_id=? GROUP BY status', ctx.user.id)) statusCounts[r.k] = r.c;
  const statusChips = statuses.map(s => `<a class="btn btn-sm ${status === s ? 'btn-primary' : 'btn-outline-secondary'}" href="/quotes?status=${encodeURIComponent(s)}${productId ? '&product_id=' + productId : ''}">${s || '全部' }${statusCounts[s] ? ' ' + statusCounts[s] : ''}</a>`).join(' ');
  const month = today().slice(0, 7);
  const monthRow = get("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM quote_history WHERE user_id=? AND quote_date LIKE ?", ctx.user.id, month + '%');
  const activeCount = get("SELECT COUNT(*) c FROM quote_history WHERE user_id=? AND status IN ('已报价','跟进中')", ctx.user.id).c;
  const wonCount = get("SELECT COUNT(*) c FROM quote_history WHERE user_id=? AND status='已成交'", ctx.user.id).c;
  const rowsHtml = rows.map(q => {
    let itemCount = 1; try { const a = JSON.parse(q.items || '[]'); if (Array.isArray(a) && a.length) itemCount = a.length; } catch (e) {}
    const follow = q.followup_id ? (q.followup_archived ? '<span class="badge text-bg-success">已跟进</span>' : `<span class="badge text-bg-warning">${esc(q.next_follow_date || '待跟进')}</span>`) : '<span class="badge text-bg-secondary">未生成</span>';
    return `<tr>
      <td><a class="fw-semibold text-decoration-none" href="/quotes/${q.id}/edit">${esc(q.quote_no)}</a><div class="text-muted small">${esc(q.quote_date || '-')} · ${esc(q.created_by || '-')}</div></td>
      <td><div class="fw-semibold">${esc(q.company_name || '-')}</div><div class="text-muted small">${esc(q.contact_person || '')}</div></td>
      <td><div class="d-flex align-items-center gap-2">${q.image ? `<img src="${esc(q.image)}" class="img-preview" style="width:38px;height:38px;object-fit:cover;border-radius:8px" alt="">` : ''}<div><div class="fw-semibold">${esc(q.product_name || '-')}${itemCount > 1 ? ' <span class="badge text-bg-light border">共 ' + itemCount + ' 款</span>' : ''}</div><div class="text-muted small">${esc(q.model || '-')}</div></div></div></td>
      <td class="text-end">${numFmt(q.quantity)} ${esc(q.unit || '')}<div class="text-muted small">× ${esc(q.currency || 'USD')} ${moneyFmt(q.unit_price)}</div></td>
      <td class="text-end fw-bold">${esc(q.currency || 'USD')} ${moneyFmt(q.amount)}</td>
      <td>${quoteStatusBadge(q.status)}</td>
      <td>${follow}${q.followup_id ? `<div class="mt-1"><a class="small text-decoration-none" href="/followups?view=all&search=${encodeURIComponent(q.quote_no)}">查看跟进</a></div>` : ''}</td>
      <td class="text-end"><a class="btn btn-sm btn-outline-primary" href="/quotes/${q.id}/edit">编辑</a><form class="d-inline" method="post" action="/quotes/${q.id}/delete" onsubmit="return confirm('确认删除这条历史报价？已生成的跟进记录会保留。')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form></td>
    </tr>`;
  }).join('') || emptyRow(8, '暂无历史报价，点击右上角新建报价记录');
  const content = `
    ${pageHead('历史报价', '记录客户历史报价、产品价格和跟进状态，自动同步到跟进中心', `<a class="btn btn-primary" href="/quotes/new${productId ? '?product_id=' + productId : ''}"><i class="bi bi-plus-lg"></i> 新增历史报价</a>`)}
    <div class="row g-3 mb-4">
      ${miniStat('历史报价总数', rows.length + ' 条', '当前筛选结果')}
      ${miniStat('本月报价', monthRow.c + ' 条', '按报价日期统计')}
      ${miniStat('跟进中', activeCount + ' 条', '已报价 / 跟进中')}
      ${miniStat('已成交', wonCount + ' 条', '历史报价成交记录')}
    </div>
    ${card({ body: `
      <div class="d-flex gap-1 flex-wrap mb-3">${statusChips}</div>
      <form class="row g-2 mb-3 align-items-center" method="get">
        <input type="hidden" name="status" value="${esc(status)}">
        <div class="col-md-4"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索报价号 / 客户 / 产品 / 型号"></div>
        <div class="col-md-4"><select class="form-select" name="product_id" onchange="this.form.submit()"><option value="">全部产品</option>${productOpts.slice(1).map(o => `<option value="${o.v}" ${String(productId) === o.v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select></div>
        <div class="col-auto"><button class="btn btn-primary"><i class="bi bi-search"></i> 筛选</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/quotes">重置</a></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th>报价单号</th><th>客户</th><th>产品</th><th class="text-end">数量 / 单价</th><th class="text-end">金额</th><th>状态</th><th>跟进</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="text-muted small mt-3">共 ${rows.length} 条记录 · 新增报价后系统会自动创建一条“报价”跟进记录</div>` })}`;
  return page({ title: '历史报价', active: 'quotes', user: ctx.user, content, flash: ctx.flash() });
}

function quoteFormPage(ctx) {
  const id = parseInt(ctx.params.id || '', 10) || 0;
  const existing = id ? get('SELECT * FROM quote_history WHERE id=? AND user_id=?', id, ctx.user.id) : null;
  if (id && !existing) return page({ title: '报价不存在', active: 'quotes', user: ctx.user, content: '<div class="alert alert-warning">报价记录不存在</div>', flash: ctx.flash() });
  const activity = existing && existing.activity_id ? get('SELECT * FROM activities WHERE id=?', existing.activity_id) : null;
  const products = all(`SELECT p.id,p.name,p.name_en,p.model,p.unit,p.price,p.currency,p.image,p.cost_price,p.stock,p.supplier_id,
      s.name AS primary_supplier_name
    FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.name,p.model`);
  const supplierQuoteRows = all(`SELECT sp.id AS supplier_product_id,sp.product_id,sp.model AS supplier_model,sp.name AS supplier_product_name,
      sp.price,sp.currency,sp.image,sp.notes,s.id AS supplier_id,s.name AS supplier_name
    FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id
    WHERE sp.product_id IS NOT NULL ORDER BY s.name,sp.currency,sp.price`);
  const factoryQuoteMap = {};
  for (const row of supplierQuoteRows) {
    const pid = Number(row.product_id) || 0;
    if (!pid) continue;
    if (!factoryQuoteMap[pid]) factoryQuoteMap[pid] = [];
    factoryQuoteMap[pid].push(row);
  }
  const recentQuoteRows = all(`SELECT quote_no,quote_date,currency,items FROM quote_history
    WHERE user_id=? ORDER BY quote_date DESC,id DESC LIMIT 500`, ctx.user.id);
  const lastQuoteMap = {};
  for (const row of recentQuoteRows) {
    let historyItems = [];
    try { historyItems = JSON.parse(row.items || '[]'); } catch (e) {}
    if (!Array.isArray(historyItems)) continue;
    for (const item of historyItems) {
      const pid = Number(item.product_id) || 0;
      if (!pid || lastQuoteMap[pid]) continue;
      lastQuoteMap[pid] = {
        unit_price: Number(item.unit_price) || 0,
        currency: String(item.currency || row.currency || 'USD').toUpperCase(),
        quote_date: row.quote_date || '',
        quote_no: row.quote_no || ''
      };
    }
  }
  for (const product of products) {
    product.cost_price = Number(product.cost_price) || 0;
    product.stock = Number(product.stock) || 0;
    product.factory_quotes = factoryQuoteMap[product.id] || [];
    product.last_quote = lastQuoteMap[product.id] || null;
    if (!product.image) {
      const withImage = product.factory_quotes.find(q => String(q.image || '').trim());
      product.image = withImage ? withImage.image : '';
    }
  }
  const customers = all('SELECT id,company_name,name_en,country,status,contact_person,whatsapp,email FROM customers WHERE COALESCE(in_pool,0)=0 AND user_id=? ORDER BY company_name', ctx.user.id);
  const contacts = all('SELECT customer_id,name FROM contacts WHERE is_primary=1 ORDER BY id DESC');
  const contactMap = {}; contacts.forEach(c => { if (!contactMap[c.customer_id]) contactMap[c.customer_id] = c.name; });
  const requestedProduct = parseInt(ctx.query.product_id || '', 10) || 0;
  const v = existing || {};
  const productId = existing ? String(v.product_id || '') : String(requestedProduct || '');
  const selectedProduct = products.find(p => String(p.id) === String(productId)) || null;
  const selectedProductLabel = selectedProduct ? ((selectedProduct.model ? selectedProduct.model + ' · ' : '') + selectedProduct.name + (selectedProduct.name_en ? ' / ' + selectedProduct.name_en : '')) : '';
  const customerId = existing ? String(v.customer_id || '') : '';
  const selectedCustomer = customers.find(c => String(c.id) === String(customerId)) || null;
  const selectedCustomerLabel = selectedCustomer ? selectedCustomer.company_name + (selectedCustomer.name_en ? ' / ' + selectedCustomer.name_en : '') : '';
  const qNo = existing ? v.quote_no : nextQuoteNo();
  const catCounts = {}; products.forEach(p => { const k = String(p.name_en || '').trim() || '__none__'; catCounts[k] = (catCounts[k] || 0) + 1; });
  const catKeys = Object.keys(catCounts).sort((a, b) => { if (a === '__none__') return 1; if (b === '__none__') return -1; return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
  const categoryOptions = '<option value="">全部英文品名分类</option>' + catKeys.map(k => '<option value="' + esc(k) + '">' + esc(k === '__none__' ? '（未填英文品名）' : k) + ' (' + catCounts[k] + ')</option>').join('');
  const curOpts = ['USD', 'EUR', 'CNY', 'GBP', 'JPY'].map(s => ({ v: s, l: s }));
  const statusOpts = ['已报价', '跟进中', '报价已接受', '已成交', '已失效'].map(s => ({ v: s, l: s }));
  const priorityList = ['高', '中', '低'].map(s => ({ v: s, l: s + '优先级' }));
  const productMap = {}; products.forEach(p => { productMap[p.id] = p; });
  let initialItems = [];
  try { initialItems = JSON.parse(existing && existing.items || '[]'); } catch (e) { initialItems = []; }
  if (!Array.isArray(initialItems) || !initialItems.length) {
    if (existing && existing.product_name) initialItems = [{ product_id: existing.product_id || null, product_name: existing.product_name || '', product_name_en: existing.product_name_en || '', model: existing.model || '', unit: existing.unit || 'PCS', quantity: Number(existing.quantity) || 0, unit_price: Number(existing.unit_price) || 0, currency: existing.currency || 'USD', amount: Number(existing.amount) || 0, image: '' }];
  }
  initialItems = initialItems.map(item => {
    const product = productMap[item.product_id];
    if (!product) return item;
    return Object.assign({}, item, {
      image: item.image || product.image || '',
      cost_price: product.cost_price,
      cost_currency: product.currency || 'USD',
      factory_quotes: product.factory_quotes || [],
      primary_supplier_name: product.primary_supplier_name || '',
      supplier_id: product.supplier_id || 0,
      last_quote: product.last_quote || null
    });
  });
  const initialItemsJson = JSON.stringify(initialItems).replace(/</g, '\\u003c');
  const productJson = JSON.stringify(productMap).replace(/</g, '\\u003c');
  const customerData = customers.map(c => ({ id: c.id, name: c.company_name, name_en: c.name_en || '', country: c.country || '', status: c.status || '', contact_person: c.contact_person || '', whatsapp: c.whatsapp || '', email: c.email || '' }));
  const customerJson = JSON.stringify(customerData).replace(/</g, '\\u003c');
  const contactJson = JSON.stringify(contactMap).replace(/</g, '\\u003c');
  const action = existing ? '/quotes/' + existing.id + '/edit' : '/quotes/new';
  const content = `
    ${pageHead(existing ? '编辑历史报价' : '新增历史报价', '图片、出厂价、供应商和上次报价集中在同一个报价工作台，保存后自动生成跟进记录', `<a class="btn btn-outline-secondary" href="/quotes">返回历史报价</a>`)}
    <div class="quote-workspace quote-3col workbench-2">
    <section class="quote-workspace-form">${card({ body: `<form method="post" action="${action}" id="quoteForm">
      <div class="row g-3">
        <div class="col-md-5">
          <label class="form-label">客户 <span class="text-danger">*</span></label>
          <div class="position-relative">
            <input type="text" class="form-control" id="quoteCustomerSearch" value="${esc(selectedCustomerLabel)}" placeholder="输入客户名称搜索并添加" autocomplete="off">
            <input type="hidden" name="customer_id" id="quoteCustomer" value="${esc(customerId)}">
            <div id="quoteCustomerList" class="list-group position-absolute w-100 shadow" style="max-height:260px;overflow:auto;z-index:80;display:none"></div>
          </div>
          <div class="form-text">输入公司名称 / 英文名称后，从结果中点击添加</div>
        </div>
        <div class="col-md-5">
          <label class="form-label">产品（来自产品管理） <span class="text-danger">*</span></label>
          <div class="position-relative">
            <input type="text" class="form-control" id="quoteProductSearch" value="${esc(selectedProductLabel)}" placeholder="点击选择产品：按英文品名分类或搜索货号" autocomplete="off">
            <input type="hidden" name="product_id" id="quoteProduct" value="${esc(productId)}">
            <div id="quoteProductPanel" class="quote-product-panel p-3 border rounded-3 shadow bg-white position-absolute w-100" style="top:calc(100% + 6px);z-index:90;display:none">
              <div class="row g-2 mb-2">
                <div class="col-md-5"><select class="form-select form-select-sm" id="quoteCategory">${categoryOptions}</select></div>
                <div class="col-md-7"><input type="text" class="form-control form-control-sm" id="quoteModelSearch" placeholder="搜索货号 / 英文品名 / 中文品名"></div>
              </div>
              <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
                <div id="quoteProductCount" class="small text-muted">输入货号可快速定位</div>
                <div class="small text-muted"><i class="bi bi-image me-1"></i>图片 · <i class="bi bi-cash-stack mx-1"></i>出厂价 · <i class="bi bi-clock-history mx-1"></i>上次报价</div>
              </div>
              <div id="quoteProductResults" class="list-group" style="max-height:380px;overflow:auto"></div>
            </div>
          </div>
          <div class="form-text">产品卡片直接展示图片、出厂价和上次报价；货号精确匹配会排在最前</div>
        </div>
        <div class="col-md-2">${fld({ label: '报价单号', name: 'quote_no', value: qNo, readonly: true, id: 'quoteNo' })}</div>
        <div class="col-md-3">${fld({ label: '报价日期', name: 'quote_date', value: v.quote_date || today(), type: 'date', required: true })}</div>
        <div class="col-md-3">${fld({ label: '有效期至', name: 'valid_until', value: v.valid_until || addDays(15), type: 'date' })}</div>
        <div class="col-md-3">${fld({ label: '联系人', name: 'contact_person', value: v.contact_person || (activity && activity.contact_person) || '', id: 'quoteContact' })}</div>
        <div class="col-md-3">${fld({ label: '报价状态', name: 'status', value: v.status || '已报价', type: 'select', options: statusOpts })}</div>
        <div class="col-md-2">${fld({ label: '币种', name: 'currency', value: v.currency || 'USD', type: 'select', options: curOpts, id: 'quoteCurrency' })}</div>
        <input type="hidden" name="items_json" id="quoteItemsJson" value="${esc(initialItemsJson)}">
        <div class="col-12">
          <div class="border rounded-3 p-3 bg-light">
            <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-2">
              <div><div class="fw-semibold">产品明细（内部成本信息不会出现在客户报价单）</div><div class="small text-muted">每款产品显示图片、出厂价和毛利；可一键使用该产品的上次报价。</div></div>
              <div class="text-end"><div class="fw-bold">总金额：<span id="quoteTotal">0.00</span></div><div id="quoteProfitSummary" class="small text-muted mt-1">选择产品后计算预估毛利</div></div>
            </div>
            <div class="table-responsive"><table class="table table-sm align-middle mb-0">
              <thead><tr><th>产品 / 出厂价</th><th style="width:105px">数量</th><th style="width:64px">单位</th><th style="width:115px">报价单价</th><th style="width:66px">币种</th><th style="width:115px">毛利</th><th style="width:110px" class="text-end">金额</th><th style="width:44px"></th></tr></thead>
              <tbody id="quoteItemsBody"></tbody>
            </table></div>
          </div>
        </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存报价</button><a class="btn btn-outline-secondary" href="/quotes">取消</a></div>
    </form>
    <script>window.__QUOTE_DATA__ = { products: ${productJson}, customers: ${customerJson}, contacts: ${contactJson} };</script>
    <script src="/static/js/quote-form.js"></script>
` })}</section>
      <aside class="quote-reference-pane">
        <div class="quote-reference-heading"><i class="bi bi-card-list"></i><span>客户与产品参考</span></div>
        <section class="quote-reference-section"><div class="quote-reference-label">客户资料</div><div id="quoteReferenceCustomer" class="quote-reference-body"><span class="text-muted">选择客户后显示客户档案信息</span></div></section>
        <section class="quote-reference-section"><div class="d-flex justify-content-between align-items-center"><div class="quote-reference-label">已选产品</div><span id="quoteReferenceCount" class="badge text-bg-light">0 款</span></div><div id="quoteReferenceProducts" class="quote-reference-body"><span class="text-muted">选择产品后显示供应商报价与历史报价</span></div></section>
        <section class="quote-reference-total"><span>当前报价合计</span><strong id="quoteReferenceTotal">0.00</strong></section>
      </aside>
      <aside class="ai-panel quote-ai-panel" aria-label="AI 报价助手">
        <h3 class="ai-panel-title"><i class="bi bi-stars"></i> AI 报价助手</h3>
        <div><span class="ai-tab active">价格分析</span><span class="ai-tab">历史报价</span><span class="ai-tab">利润测算</span><span class="ai-tab">政策规则</span></div>
        <div class="small" style="margin:8px 0"><b>AI 报价建议</b><br>基于相似款式的历史报价、面料成本和当前产能，建议该报价合理，毛利率约 24%，具备竞争力。</div>
        <div class="small" style="line-height:1.9">
          <div><span class="ai-check">✓</span> 价格评估：合理</div>
          <div><span class="ai-check">✓</span> 毛利率：24%（目标 ≥20%）</div>
          <div><span class="ai-check">✓</span> MOQ 检查：符合（≥50）</div>
          <div><span class="ai-check">✓</span> 交期评估：可行（20–25 天）</div>
        </div>
        <div class="small" style="margin-top:8px"><span class="ai-warn">⚠ 风险提示</span><br>· 套装款需确认尺码配比和面料成本；<br>· 若客户对价格敏感，可提供 100+ 总量的阶梯价。</div>
        <div class="small" style="margin-top:8px"><b>历史报价参考（同款/相似）</b><br>2026-10-28 Anna (US) 100 件 $35.00<br>2026-09-15 KAMP (US) 80 件 $37.00<br>2026-08-20 Alexx (UK) 50 件 $38.00</div>
        <div class="d-flex justify-content-between align-items-center mt-3"><span class="small">审核状态：<b>待确认</b></span><button type="button" class="btn btn-sm btn-primary" onclick="alert('已提交审批（演示占位：审批流复用现有报价状态字段，不改数据库）。')">提交审批</button></div>
        <div class="d-flex gap-2 mt-2 flex-wrap"><button type="button" class="btn btn-sm btn-outline-secondary" onclick="document.getElementById('quoteForm').requestSubmit()">保存草稿</button><button type="button" class="btn btn-sm btn-outline-secondary" onclick="window.print()">生成 PDF 报价单</button></div>
        <div class="text-muted small mt-2">示例：产品总金额 7,770.00 USD，报价总额（FOB）8,120.00 USD；真实金额以左侧明细合计为准。</div>
      </aside>
    </div>`;
  return page({ title: existing ? '编辑历史报价' : '新增历史报价', active: 'quotes', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { quotesPage, quoteFormPage };




