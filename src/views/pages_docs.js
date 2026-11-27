'use strict';
// ============ 页面渲染：单据中心 / 模板 / 系统设置 ============
const { esc } = require('../util');
const { page } = require('./layout');
const { fld, card, pageHead, badge, emptyRow } = require('./ui');
const dbx = require('../db');
const { get, all, DOC_TYPES, DOC_TYPE_MAP, DOC_STATUS } = dbx;
const docx = require('../documents');
const payments = require('../payments');
const pagesWa = require('./pages_wa'); // WhatsApp 连接与自动回复卡片（原在 WhatsApp 页顶部，现移到系统设置）

function moneyFmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ================= 单据中心 =================
function documentsPage(ctx) {
  const type = ctx.query.type || '';
  const status = ctx.query.status || '';
  const kw = ctx.query.search || '';
  const where = ['d.user_id=?']; const params = [ctx.user.id];
  if (type) { where.push('d.doc_type=?'); params.push(type); }
  if (status) { where.push('d.status=?'); params.push(status); }
  if (kw) { where.push('(d.doc_no LIKE ? OR d.title LIKE ? OR c.company_name LIKE ? OR s.name LIKE ?)'); params.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%', '%' + kw + '%'); }
  const rows = all(`SELECT d.*, c.company_name, s.name AS supplier_name FROM documents d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN suppliers s ON s.id=d.supplier_id WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 500`, ...params);
  const typeCount = {};
  for (const r of all('SELECT doc_type k, COUNT(*) c FROM documents WHERE user_id=? GROUP BY doc_type', ctx.user.id)) typeCount[r.k] = r.c;
  const statusCount = {};
  for (const r of all('SELECT status k, COUNT(*) c FROM documents WHERE user_id=? GROUP BY status', ctx.user.id)) statusCount[r.k] = r.c;
  const typeChips = ['', ...DOC_TYPES.map(t => t.key)].map(k => {
    const on = type === k;
    const label = k === '' ? '全部' : DOC_TYPE_MAP[k].name;
    return `<a class="btn btn-sm ${on ? 'btn-primary' : 'btn-outline-primary'}" href="/documents?type=${encodeURIComponent(k)}${status ? '&status=' + encodeURIComponent(status) : ''}">${label}${typeCount[k] ? ' (' + typeCount[k] + ')' : ''}</a>`;
  }).join(' ');
  const statusChips = ['', ...DOC_STATUS.map(s => s.key)].map(k => {
    const on = status === k;
    const label = k === '' ? '全部状态' : k;
    return `<a class="btn btn-sm ${on ? 'btn-dark' : 'btn-outline-secondary'}" href="/documents?status=${encodeURIComponent(k)}${type ? '&type=' + encodeURIComponent(type) : ''}">${label}${statusCount[k] ? ' (' + statusCount[k] + ')' : ''}</a>`;
  }).join(' ');
  const rowsHtml = rows.map(d => `
    <tr>
      <td class="text-center"><input type="checkbox" class="doc-check" value="${d.id}" data-no="${esc(d.doc_no)}"></td>
      <td><a class="fw-semibold text-decoration-none" href="/documents/${d.id}">${esc(d.doc_no)}</a>
        <div class="text-muted small">${esc(docx.typeName(d.doc_type))}${d.title ? ' · ' + esc(d.title) : ''}</div></td>
      <td>${esc(d.doc_type === "po" ? (d.supplier_name || "") : (d.company_name || ""))}</td>
      <td class="text-center">${esc(d.issue_date || '-')}</td>
      <td class="text-end">${esc(d.currency || 'USD')} ${moneyFmt(d.total_amount)}</td>
      <td>${badge(d.status)}</td>
      <td>${esc(d.created_by || '-')}</td>
      <td class="text-end">
        <a class="btn btn-sm btn-outline-primary" href="/documents/${d.id}">查看</a>
        <a class="btn btn-sm btn-outline-primary" href="/api/documents/${d.id}/export.png" title="导出单据图片" aria-label="导出单据图片"><i class="bi bi-image"></i></a>
        <a class="btn btn-sm btn-outline-secondary" href="/documents/${d.id}/print" target="_blank"><i class="bi bi-printer"></i></a>
      </td>
    </tr>`).join('') || emptyRow(8, '暂无单据，点击右上角「新建单据」开始');
  const qs = (type ? '&type=' + encodeURIComponent(type) : '') + (status ? '&status=' + encodeURIComponent(status) : '') + (kw ? '&search=' + encodeURIComponent(kw) : '');
  const content = `
    ${pageHead('单据中心', '报价单 / 形式发票 PI / 销售合同 / 商业发票 CI / 装箱单 PL', `<a class="btn btn-primary" href="/documents/new"><i class="bi bi-file-earmark-plus"></i> 新建单据</a>`)}
    ${card({ title: '批量操作', body: `<div class="d-flex gap-2 flex-wrap align-items-center">
      <a class="btn btn-outline-primary btn-sm" href="/api/documents/export.xlsx?${qs.slice(1)}"><i class="bi bi-download"></i> 导出当前列表</a>
      <a class="btn btn-outline-success btn-sm" href="/api/documents/template.xlsx"><i class="bi bi-file-earmark-excel"></i> 下载导入模板</a>
      <form method="post" action="/documents/import" enctype="multipart/form-data" class="d-inline">
        <label class="btn btn-outline-success btn-sm mb-0" for="docImportFile"><i class="bi bi-upload"></i> 导入 Excel</label>
        <input type="file" name="file" id="docImportFile" accept=".xlsx,.xls" style="display:none">
      </form>
      <button class="btn btn-outline-primary btn-sm" id="exportSelBtn" disabled><i class="bi bi-download"></i> 导出所选</button>
      <button class="btn btn-outline-danger btn-sm" id="batchDelBtn" disabled><i class="bi bi-trash"></i> 批量删除所选</button>
      <span class="text-muted small ms-2" id="selCount">已选 0 张</span>
    </div>` })}
    ${card({ body: `
      <div class="d-flex gap-1 flex-wrap mb-2">${typeChips}</div>
      <div class="d-flex gap-1 flex-wrap mb-3">${statusChips}</div>
      <form class="row g-2 mb-3" method="get">
        <input type="hidden" name="type" value="${esc(type)}"><input type="hidden" name="status" value="${esc(status)}">
        <div class="col-md-4"><input class="form-control" name="search" value="${esc(kw)}" placeholder="搜索单号 / 标题 / 客户"></div>
        <div class="col-auto"><button class="btn btn-outline-primary"><i class="bi bi-search"></i> 搜索</button></div>
        <div class="col-auto"><a class="btn btn-outline-secondary" href="/documents">重置</a></div>
      </form>
      <div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr><th style="width:36px" class="text-center"><input type="checkbox" id="checkAll"></th><th>单号 / 类型</th><th>客户</th><th class="text-center">单据日期</th><th class="text-end">金额</th><th>状态</th><th>业务员</th><th class="text-end">操作</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      <div class="text-muted small">共 ${rows.length} 张单据</div>` })}
    <script>
      document.getElementById('docImportFile').addEventListener('change', function () {
        if (this.files && this.files[0]) this.form.submit();
      });
      function selIds() {
        return Array.prototype.map.call(document.querySelectorAll('.doc-check:checked'), function (c) { return c.value; });
      }
      function upd() {
        var n = selIds().length;
        document.getElementById('selCount').textContent = '已选 ' + n + ' 张';
        document.getElementById('exportSelBtn').disabled = n === 0;
        document.getElementById('batchDelBtn').disabled = n === 0;
      }
      document.getElementById('checkAll').addEventListener('change', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.doc-check'), function (c) { c.checked = this.checked; }.bind(this));
        upd();
      });
      document.querySelectorAll('.doc-check').forEach(function (c) { c.addEventListener('change', upd); });
      document.getElementById('exportSelBtn').addEventListener('click', function () {
        var ids = selIds(); if (!ids.length) return;
        location.href = '/api/documents/export.xlsx?ids=' + ids.join(',');
      });
      document.getElementById('batchDelBtn').addEventListener('click', function () {
        var ids = selIds(); if (!ids.length) return;
        if (!confirm('确认删除所选的 ' + ids.length + ' 张单据？（已确认/完成的单据将同时回补库存）')) return;
        var form = document.createElement('form');
        form.method = 'post'; form.action = '/documents/batch-delete';
        var inp = document.createElement('input'); inp.type = 'hidden'; inp.name = 'ids'; inp.value = ids.join(',');
        form.appendChild(inp); document.body.appendChild(form); form.submit();
      });
    </script>`;
  return page({ title: '单据中心', active: 'documents', user: ctx.user, content, flash: ctx.flash() });
}

// ================= 单据详情 =================
function documentDetailPage(ctx) {
  const d = docx.getDoc(ctx.params.id);
  if (!d || Number(d.user_id) !== Number(ctx.user.id)) return require('./pages_core').notFoundPage(ctx, '单据不存在或无权访问');
  const customer = get('SELECT * FROM customers WHERE id=?', d.customer_id);
  const supplier = d.supplier_id ? (get('SELECT * FROM suppliers WHERE id=?', d.supplier_id) || null) : null;
  const isPo = d.doc_type === 'po';
  const waChats = (!isPo && d.customer_id) ? all(`SELECT c.* FROM wa_chats c
    WHERE c.customer_id=? AND COALESCE(c.is_group,0)=0
      AND c.account_id IN (SELECT id FROM wa_accounts WHERE user_id=?)
    ORDER BY COALESCE(c.last_msg_at,'') DESC, c.id DESC`, d.customer_id, ctx.user.id) : [];
  const partyName = isPo ? (supplier ? supplier.name : '') : (customer ? customer.company_name : '');
  const partyContactName = isPo ? (supplier ? supplier.contact_name : '') : (d.contact_id ? (get('SELECT name FROM contacts WHERE id=?', d.contact_id) || {}).name : '');
  const statusOpts = DOC_STATUS.map(s => s.key);
  const prev = { '草稿': '已发送', '已发送': '已确认', '已确认': '已完成' };
  const nextStatus = prev[d.status];
  const isPayable = payments.SALE_TYPES.includes(d.doc_type) && d.status !== '已作废';
  const payBlockHtml = (function () {
    const pr = get('SELECT * FROM document_payments WHERE doc_id=?', d.id);
    const recs = payments.readRecords(d);
    if (!pr && !recs.length) return '';
    const ttl = payments.cents(d.total_amount);
    const dep = payments.cents(pr?.deposit);
    const paid = recs.length ? recs.reduce((sum, row) => sum + payments.cents(row.amount), 0) : payments.cents(pr?.paid);
    const currency = esc(payments.currencyCode(d.currency));
    const recRows = recs.map(rr => `<tr><td class="text-nowrap">${esc(String(rr.paid_at || '').slice(0, 16))}</td><td class="text-end text-nowrap">${esc(rr.received_currency)} ${moneyFmt(rr.received_amount)}</td><td class="text-end text-nowrap">${currency} ${moneyFmt(rr.amount)}</td><td class="small">${esc(rr.note || '')}</td></tr>`).join('');
    return `<div class="row g-3 mt-1">
      <div class="col-12">${card({ title: '收款记录', body: `<div class="table-responsive"><table class="table table-sm align-middle">
        <thead><tr><th>收款时间</th><th class="text-end">实收原币</th><th class="text-end">冲抵金额</th><th>备注</th></tr></thead><tbody>${recRows || '<tr><td colspan="4" class="text-muted">暂无分笔收款记录</td></tr>'}</tbody></table></div>
        <div class="small d-flex flex-wrap gap-4 mt-2"><span>单据金额 <b>${currency} ${moneyFmt(ttl / 100)}</b></span><span>已收定金 <b>${moneyFmt(dep / 100)}</b></span><span>已冲抵 <b class="text-success">${moneyFmt(paid / 100)}</b></span><span>待收 <b>${moneyFmt(Math.max(ttl - paid, 0) / 100)}</b></span>${paid > ttl ? `<span>超收 <b>${moneyFmt((paid - ttl) / 100)}</b></span>` : ''}</div>` })}</div>
    </div>`;
  })();
  const content = `
    <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
      <div>
        <h4 class="mb-0 fw-bold">${esc(d.doc_no)} <span class="fs-6 fw-normal text-muted">${esc(docx.typeName(d.doc_type))}</span> ${badge(d.status)}</h4>
        <div class="text-muted small mt-1">${esc(partyName)} · 单据日期 ${esc(d.issue_date || '-')} · 金额 ${esc(d.currency)} ${moneyFmt(d.total_amount)} · 业务员 ${esc(d.created_by || '-')}</div>
      </div>
      <div class="d-flex gap-2 flex-wrap">
        <form method="post" action="/documents/${d.id}/status" class="d-flex gap-1 align-items-center">
          <select class="form-select form-select-sm" name="status" onchange="this.form.submit()">
            ${statusOpts.map(s => `<option value="${s}" ${s === d.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </form>
        ${nextStatus ? `<form method="post" action="/documents/${d.id}/status"><input type="hidden" name="status" value="${nextStatus}"><button class="btn btn-sm btn-success">标记为「${nextStatus}」</button></form>` : ''}
        ${d.doc_type === 'pi' ? `<a class="btn btn-sm btn-outline-primary" href="/documents/new?type=po&from_pi=${d.id}"><i class="bi bi-cart-plus"></i> 一键生成采购单</a>` : ''}
        ${isPayable ? `<a class="btn btn-sm btn-outline-success" href="/payments/${d.id}/edit"><i class="bi bi-cash-coin me-1"></i>登记收款</a>` : ''}
        <a class="btn btn-sm btn-primary" href="/documents/${d.id}/print" target="_blank"><i class="bi bi-printer"></i> 打印 / PDF</a>
        <a class="btn btn-sm btn-outline-primary" href="/api/documents/${d.id}/pdf"><i class="bi bi-file-earmark-pdf"></i> 下载 PDF</a>
        <a class="btn btn-sm btn-outline-primary" href="/api/documents/${d.id}/export.png" title="导出单据图片"><i class="bi bi-image"></i> 导出图片</a>
        ${!isPo ? `<button class="btn btn-sm btn-success" type="button" data-bs-toggle="collapse" data-bs-target="#waSharePanel" aria-expanded="false" aria-controls="waSharePanel"><i class="bi bi-whatsapp"></i> 发送到 WhatsApp</button>` : ''}
        <a class="btn btn-sm btn-outline-success" href="/api/documents/${d.id}/export.xlsx"><i class="bi bi-file-earmark-excel"></i> 导出 Excel</a>
        <a class="btn btn-sm btn-outline-secondary" href="/documents/${d.id}/edit"><i class="bi bi-pencil"></i> 编辑</a>
        <a class="btn btn-sm btn-outline-secondary" href="/documents/new?copy_from=${d.id}"><i class="bi bi-files"></i> 复制新建</a>
        <form method="post" action="/documents/${d.id}/delete" onsubmit="return confirm('确认删除该单据？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
      </div>
    </div>
    ${!isPo ? `<div class="collapse mb-3" id="waSharePanel">
      ${card({ title: '发送单据到 WhatsApp', body: waChats.length ? `<form method="post" action="/documents/${d.id}/share-whatsapp">
        <div class="row g-3">
          <div class="col-lg-5">
            <label class="form-label fw-semibold">选择客户会话</label>
            <select class="form-select" name="chat_id" required>
              ${waChats.map(c => `<option value="${Number(c.id)}">${esc(c.name || c.phone || c.jid)}${c.phone && c.name ? ' · ' + esc(c.phone) : ''}${c.last_msg_at ? ' · ' + esc(String(c.last_msg_at).slice(0, 16)) : ''}</option>`).join('')}
            </select>
            <div class="form-text">只会显示当前账号已绑定到「${esc(customer ? customer.company_name : '')}」的 WhatsApp 私聊会话。</div>
          </div>
          <div class="col-lg-7">
            <label class="form-label fw-semibold">附加留言（可选）</label>
            <textarea class="form-control" name="message" rows="2" maxlength="2000" placeholder="例如：Please find our PI attached. Looking forward to your confirmation."></textarea>
          </div>
        </div>
        <div class="d-flex gap-2 align-items-center mt-3 flex-wrap">
          <button class="btn btn-success"><i class="bi bi-send"></i> 生成 PDF 并发送</button>
          <span class="text-muted small">系统会按当前模板生成单页 A4 PDF，发送成功后自动写入跟进记录，并在 3 天后安排下一次跟进。</span>
        </div>
      </form>` : `<div class="alert alert-warning mb-0 d-flex justify-content-between align-items-center gap-3 flex-wrap">
        <span><i class="bi bi-exclamation-triangle me-1"></i>该客户还没有已绑定的 WhatsApp 会话，请先在 WhatsApp 中绑定客户后再发送。</span>
        <a class="btn btn-sm btn-outline-primary" href="/whatsapp/session">打开 WhatsApp 并绑定</a>
      </div>` })}
    </div>` : ''}
    <div class="row g-3">
      <div class="col-xl-10">
        <div class="doc-paper shadow-sm">${d.content_html || '<div class="p-4 text-muted">（无内容，请编辑生成）</div>'}</div>
      </div>
      <div class="col-xl-2">
        ${card({ title: '单据信息', body: `<table class="table table-sm small mb-0"><tbody>
          ${[['模板', (get('SELECT name FROM doc_templates WHERE id=?', d.template_id) || {}).name || '系统默认'],
            ['对方', partyName], ['联系人', partyContactName],
            ['币种', d.currency], ['交货期', d.delivery_date || '-'], ['有效期', d.valid_until || '-'],
            ['付款方式', d.payment_terms || '-']].concat(isPo ? [] : [['贸易条款', d.trade_terms || '-'], ['起运港', d.port_loading || '-'], ['目的港', d.port_destination || '-']])
            .map(([k, v]) => `<tr><td class="text-muted" style="width:64px">${k}</td><td>${esc(v)}</td></tr>`).join('')}
        </tbody></table>` })}
        <div class="text-muted small">创建：${esc((d.created_at || '').slice(0, 16))}<br>更新：${esc((d.updated_at || '').slice(0, 16))}</div>
      </div>
    </div>
    ${payBlockHtml}`;
  return page({ title: d.doc_no, active: 'documents', user: ctx.user, content, flash: ctx.flash() });
}

// ================= 打印 / PDF 预览页 =================
function documentPrintPage(ctx) {
  const d = docx.getDoc(ctx.params.id);
  if (!d || Number(d.user_id) !== Number(ctx.user.id)) return '<html><body><p>单据不存在或无权访问</p></body></html>';
  const customer = get('SELECT * FROM customers WHERE id=?', d.customer_id);
  const supplier = d.supplier_id ? (get('SELECT * FROM suppliers WHERE id=?', d.supplier_id) || null) : null;
  const isPo = d.doc_type === 'po';
  const partyName = isPo ? (supplier ? supplier.name : '') : (customer ? customer.company_name : '');
  const meta = `${esc(docx.typeName(d.doc_type))} ${esc(d.doc_no)} - ${esc(partyName)}`;
  // 实时按当前模板渲染（历史单据也能立即应用新版式），不再使用保存时的 content_html 快照
  const printItems = Array.isArray(d.items) ? d.items : docx.itemsFromDoc(d);
  const printHtml = docx.renderDocument(d, printItems);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><title>${esc(d.doc_no)}</title>
<link rel="stylesheet" href="/static/vendor/bootstrap/css/bootstrap.min.css">
<link rel="stylesheet" href="/static/vendor/bootstrap-icons/bootstrap-icons.min.css">
<link rel="stylesheet" href="/static/css/print.css">
</head>
<body class="print-body">
<div class="print-toolbar no-print">
  <button class="btn btn-primary btn-sm" onclick="window.print()"><i class="bi bi-printer me-1"></i>打印 / 另存为 PDF</button>
  <a class="btn btn-outline-secondary btn-sm" href="/documents/${d.id}">返回详情</a>
  <a class="btn btn-outline-secondary btn-sm" href="/documents/${d.id}/edit">编辑</a>
  <span class="ms-2 text-muted small">${esc(meta)}</span>
</div>
<div class="paper" id="printPaper">${printHtml}</div>
<script>
(function () {
  var paper = document.getElementById('printPaper');
  function fitWidth() {
    if (!paper) return;
    paper.style.zoom = '';
    var tbl = paper.querySelector('table.doc-items');
    if (!tbl) return;
    var avail = paper.clientWidth;
    var need = tbl.scrollWidth;
    if (need > avail && avail > 0) {
      var ratio = Math.max(0.4, avail / need);
      paper.style.zoom = ratio;
    }
  }
  window.addEventListener('load', fitWidth);
  window.addEventListener('beforeprint', fitWidth);
  window.addEventListener('afterprint', function(){ setTimeout(function(){ window.close(); }, 200); });
})();
</script>
</body></html>`;
}

function documentFormPage(ctx) {
  const isEdit = !!ctx.params.id;
  let d = null;
  if (isEdit) { d = docx.getDoc(ctx.params.id); if (d && Number(d.user_id) !== Number(ctx.user.id)) d = null; }
  let copyFrom = null;
  if (ctx.query.copy_from) { copyFrom = docx.getDoc(parseInt(ctx.query.copy_from, 10)); if (copyFrom && Number(copyFrom.user_id) !== Number(ctx.user.id)) copyFrom = null; }
  let sourcePi = null;
  if (ctx.query.from_pi) { sourcePi = docx.getDoc(parseInt(ctx.query.from_pi, 10)); if (!sourcePi || sourcePi.doc_type !== 'pi' || Number(sourcePi.user_id) !== Number(ctx.user.id)) sourcePi = null; }

  const customers = all('SELECT * FROM customers WHERE user_id=? AND COALESCE(in_pool,0)=0 ORDER BY company_name', ctx.user.id);
  const products = all('SELECT * FROM products ORDER BY name');
  const productsJson = JSON.stringify(products.map(p => ({
    id: p.id, name: p.name, name_en: p.name_en || '', model: p.model || '', color: p.color || '', unit: p.unit || 'PCS', price: p.price || 0, image: p.image || '', volume: p.volume || '', weight: p.weight || '', pcs_per_ctn: p.pcs_per_ctn || '', ctn_count: p.ctn_count || '',
  })));
  const catMap = {};
  products.forEach(function (p) { const k = String(p.name_en || '').trim() || '__none__'; catMap[k] = (catMap[k] || 0) + 1; });
  const catKeys = Object.keys(catMap).sort(function (a, b) { if (a === '__none__') return 1; if (b === '__none__') return -1; return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
  const catOptions = '<option value="">按分类查找添加…</option>' + catKeys.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k === '__none__' ? '（未填英文品名）' : k) + ' (' + catMap[k] + ')</option>'; }).join('');

  let docType = (isEdit || copyFrom) ? (d || copyFrom).doc_type : (sourcePi ? 'po' : (ctx.query.type || 'quotation'));
  if (!DOC_TYPE_MAP[docType]) docType = 'quotation';
  const typeOpts = DOC_TYPES.map(t => ({ v: t.key, l: t.name }));
  const templates = docx.templatesByType(docType);
  const customerId = (isEdit || copyFrom) ? String((d || copyFrom).customer_id) : String(ctx.query.customer_id || '');
  const contactId = (isEdit || copyFrom) ? String((d || copyFrom).contact_id || '') : '';
  const tplId = (isEdit || copyFrom) ? String((d || copyFrom).template_id || (templates[0] ? templates[0].id : '')) : String(templates[0] ? templates[0].id : '');
  let sourceItems = sourcePi ? (Array.isArray(sourcePi.items) ? sourcePi.items : docx.itemsFromDoc(sourcePi)) : [];
  const linkedSupplierIds = new Set();
  let sourceCurrency = sourcePi ? (sourcePi.currency || 'USD') : 'USD';
  if (sourcePi) {
    sourceItems = sourceItems.map(function (it) {
      var sp = it.product_id ? get('SELECT * FROM supplier_products WHERE product_id=? ORDER BY id LIMIT 1', it.product_id) : null;
      if (sp && sp.supplier_id) linkedSupplierIds.add(Number(sp.supplier_id));
      if (sp && sp.currency) sourceCurrency = sp.currency;
      return Object.assign({}, it, { price: sp ? (Number(sp.price) || 0) : '', supplier_id: sp ? sp.supplier_id : null });
    });
  }
  const defaultSupplierId = linkedSupplierIds.size === 1 ? String(Array.from(linkedSupplierIds)[0]) : '';
  const items = (isEdit || copyFrom) ? (d || copyFrom).items : (sourcePi ? sourceItems : []);
  const title = isEdit ? '编辑单据 ' + d.doc_no : (copyFrom ? '复制新建单据' : '新建单据');
  const action = isEdit ? '/documents/' + d.id + '/edit' : '/documents/new';

  const v = (isEdit || copyFrom) ? (d || copyFrom) : {};
  const remarkImgs = (function () { try { const a = JSON.parse((v.remark_images || '') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
  const def = {
    title: v.title || (sourcePi ? '采购单 - ' + sourcePi.doc_no : ''), issue_date: v.issue_date || today(), valid_until: v.valid_until || addDay(15),
    delivery_date: v.delivery_date || (sourcePi ? sourcePi.delivery_date : addDay(45)), currency: v.currency || sourceCurrency, payment_terms: v.payment_terms || '',
    trade_terms: v.trade_terms || '', port_loading: v.port_loading || '', port_destination: v.port_destination || '',
    shipping_marks: v.shipping_marks || '', remarks: v.remarks || (sourcePi ? '根据 PI ' + sourcePi.doc_no + ' 一键生成' : ''), status: (isEdit || copyFrom) ? (v.status || '草稿') : '草稿',
  };
  const suppliers = all('SELECT * FROM suppliers ORDER BY name');
  const supplierId = (isEdit || copyFrom) ? String((d || copyFrom).supplier_id || '') : String(sourcePi ? defaultSupplierId : (ctx.query.supplier_id || ''));
  const isPo = docType === 'po';
  const supOpts = [{ v: '', l: '— 请选择供应商 —' }].concat(suppliers.map(s => ({ v: String(s.id), l: s.name + (s.country ? '（' + s.country + '）' : '') })));
  const custOpts = [{ v: '', l: '— 请选择客户 —' }].concat(customers.map(c => ({ v: String(c.id), l: c.company_name + (c.country ? '（' + c.country + '）' : '') })));
  const tplOpts = templates.map(t => ({ v: String(t.id), l: (t.is_system ? '[系统] ' : '[自定义] ') + t.name }));
  def.currency = payments.currencyCode(def.currency);
  const curOpts = payments.currencyOptions(def.currency);
  const customersJson = JSON.stringify(customers.map(c => ({ id: c.id, name: c.company_name, name_en: c.name_en || '', country: c.country || '' })));

  const itemRowsHtml = items.map((it, i) => itemRowHtml(it, i)).join('');
  const initialItems = JSON.stringify(items.map(it => ({
    name: it.name || '', name_en: it.name_en || '', model: it.model || '', unit: it.unit || 'PCS',
    qty: it.qty, price: it.price, color: it.color || '', ctn: it.ctn || '', per_ctn: it.per_ctn || '', remark: it.remark || '', product_id: it.product_id || null, image: it.image || '', volume: it.volume || '', weight: it.weight || '',
  })));

  const content = `
    ${pageHead(title, '', `<a class="btn btn-outline-secondary" href="/documents${isEdit ? '/' + d.id : ''}">返回</a>`)}
    <form method="post" action="${action}" id="docForm">
    <input type="hidden" name="items_json" id="items_json">
    <div class="row g-3">
      <div class="col-xl-8 doc-main-col">
        ${card({ title: '基本信息', body: `<div class="row g-3">
          <div class="col-md-3">${fld({ label: '单据类型', name: 'doc_type', value: docType, type: 'select', options: typeOpts, required: true, help: isEdit ? '编辑时不建议更改类型' : '' })}</div>
          <div class="col-md-5">${fld({ label: '使用模板', name: 'template_id', value: tplId, type: 'select', options: tplOpts, required: true, help: '<a href="/templates" target="_blank">管理模板 / 自定义模板</a>' })}</div>
          <div class="col-md-4">${fld({ label: '单据标题', name: 'title', value: def.title, placeholder: '如：圣诞季保温杯订单' })}</div>
          <div class="col-md-6 ${isPo ? 'd-none' : ''}" id="wrapCustomer"><div class="position-relative mb-1"><input type="text" class="form-control form-control-sm" id="custQuickSearch" placeholder="搜索客户…（可选中或新建）" autocomplete="off"><div id="custQuickList" class="list-group position-absolute w-100 shadow" style="max-height:220px;overflow:auto;z-index:60;display:none"></div></div>${fld({ label: '客户 *', name: 'customer_id', value: customerId, type: 'select', options: custOpts, required: !isPo, id: 'selCustomer' })}</div>
          <div class="col-md-8 ${isPo ? '' : 'd-none'}" id="wrapSupplier">${fld({ label: '供应商 *（采购单）', name: 'supplier_id', value: supplierId, type: 'select', options: supOpts, required: isPo, id: 'selSupplier' })}<div class="form-text"><a href="javascript:void(0)" id="supQuickAdd"><i class="bi bi-plus-lg"></i> 系统里没有？手填名字新建供应商</a></div></div>
          <div class="col-md-3 ${isPo ? 'd-none' : ''}" id="wrapContact">${fld({ label: '联系人', name: 'contact_id', value: contactId, type: 'select', options: [{ v: '', l: '— 选择客户后自动带出 —' }], id: 'selContact' })}</div>
          <div class="col-md-3">${fld({ label: '单据日期', name: 'issue_date', value: def.issue_date, type: 'date', required: true })}</div>
          <div class="col-md-3">${fld({ label: '有效期至', name: 'valid_until', value: def.valid_until, type: 'date' })}</div>
          <div class="col-md-3">${fld({ label: '交货期 / 船期', name: 'delivery_date', value: def.delivery_date, type: 'date' })}</div>
          <div class="col-md-3">${fld({ label: '币种', name: 'currency', value: def.currency, type: 'select', options: curOpts })}</div>
        </div>` })}

        ${card({ title: '商品明细', actions: `<div class="d-flex gap-2 align-items-center flex-wrap">
          <div class="position-relative" style="width:230px"><select class="form-select form-select-sm" id="catPicker">${catOptions}</select><div id="catList" class="list-group position-absolute w-100 shadow" style="max-height:260px;overflow:auto;z-index:55;display:none"></div></div><div class="position-relative" style="width:300px">
            <input type="text" class="form-control form-control-sm" id="quickSearch" placeholder="按货号搜索添加（如 DL-100）" autocomplete="off">
            <div id="quickList" class="list-group position-absolute w-100 shadow" style="max-height:240px;overflow:auto;z-index:50;display:none"></div>
          </div>
          <button type="button" class="btn btn-sm btn-outline-primary" id="addEmptyBtn"><i class="bi bi-plus-lg"></i> 添加空行</button>
        </div>`, body: `<div class="table-responsive"><table class="table table-sm align-middle item-table">
          <thead><tr><th style="width:34px">#</th><th style="width:60px">图片</th><th style="min-width:150px">品名（中/英）</th><th style="width:76px" class="colh-color">COLOR<br>颜色</th><th style="width:86px">规格型号</th><th style="width:70px">单位</th><th style="width:74px" class="colh-ctn">CTN<br>箱数</th><th style="width:80px" class="colh-per">QTY<br>每箱</th><th class="colh-qty" style="width:100px">T.T QTY<br>总数量</th><th class="colh-vol" style="width:80px">体积<br>(m³)</th><th class="colh-tvol" style="width:84px">总体积<br>(m³)</th><th class="colh-wt" style="width:80px">重量<br>(kg)</th><th class="colh-tw" style="width:84px">总重量<br>(kg)</th><th class="colh-price" style="width:120px">单价</th><th class="colh-amt" style="width:110px">金额</th><th style="width:36px"></th></tr></thead>
          <tbody id="itemTbody">${itemRowsHtml}</tbody>
        </table></div>
        <div class="d-flex justify-content-between align-items-end flex-wrap gap-2">
          <div class="form-text">PI 添加该客户历史采购过的产品时，会自动带入同一币种的上次卖价，并标明来源单据；手工输入或修改的价格不会被覆盖。</div>
          <div style="width:300px"><div class="d-flex justify-content-between py-1"><span class="text-muted">合计金额</span><span id="totalAmount" class="fw-bold fs-5">$0.00</span></div></div>
        </div>` })}
      </div>
      <div class="col-xl-4 doc-terms-col">
        ${card({ title: '商务条款', body: `<div class="row g-3">
          <div class="col-12">${fld({ label: '付款方式 Payment Terms', name: 'payment_terms', value: def.payment_terms, type: 'textarea', rows: 2, placeholder: '如：T/T 30% 定金，余款见提单副本付清' })}</div>
          <div class="col-12 ${isPo ? 'd-none' : ''}" id="wrapTradeTerms">${fld({ label: '贸易条款 Trade Terms', name: 'trade_terms', value: def.trade_terms, placeholder: '如：FOB / CIF / EXW' })}</div>
          <div class="col-12 ${isPo ? 'd-none' : ''}" id="wrapPortLoading">${fld({ label: '起运港 Port of Loading', name: 'port_loading', value: def.port_loading, placeholder: '深圳盐田 Yantian, Shenzhen' })}</div>
          <div class="col-12 ${isPo ? 'd-none' : ''}" id="wrapPortDestination">${fld({ label: '目的港 Port of Destination', name: 'port_destination', value: def.port_destination, placeholder: '洛杉矶 Los Angeles' })}</div>
          <div class="col-12">${fld({ label: '唛头 Shipping Marks', name: 'shipping_marks', value: def.shipping_marks, type: 'textarea', rows: 2 })}</div>
          <div class="col-12">${fld({ label: '备注 Remarks', name: 'remarks', value: def.remarks, type: 'textarea', rows: 4 })}</div>
          <div class="col-12">
            <label class="form-label fw-semibold">备注图片（PI 会显示在单据上）</label>
            <input type="file" class="form-control" id="docRemarkImgFile" accept="image/png,image/jpeg,image/gif,image/webp" multiple>
            <input type="hidden" name="remark_images_keep" id="docRemarkKeep">
            <input type="hidden" name="remark_images_new" id="docRemarkNew">
            <div id="docRemarkGrid" class="d-flex flex-wrap gap-2 mt-2"></div>
            <div class="form-text">支持多张（单张≤3MB）；点击缩略图可移除。</div>
          </div>
        </div>` })}
        <div class="d-grid gap-2">
          <button class="btn btn-primary btn-lg" type="submit" name="save_mode" value="save"><i class="bi bi-check-lg me-1"></i>保存单据</button>
          <a class="btn btn-outline-secondary" href="/documents${isEdit ? '/' + d.id : ''}">取消</a>
        </div>
        <div class="text-muted small mt-2">保存后系统会按所选模板自动生成正式单据，可打印或导出 Excel。</div>
      </div>
    </div>
    </form>
    <script>window.__PRODUCTS__=${productsJson}; window.__CUSTOMERS__=${customersJson}; window.__INIT_ITEMS__=${initialItems}; window.__CUSTOMER_ID__=${customerId || 'null'}; window.__CONTACT_ID__=${contactId || 'null'}; window.__DOC_ID__=${isEdit && d ? d.id : 'null'};</script>
    <script>
(function () {
  var keep = ${JSON.stringify(remarkImgs)};
  var news = [];
  var grid = document.getElementById('docRemarkGrid');
  var keepInput = document.getElementById('docRemarkKeep');
  var newInput = document.getElementById('docRemarkNew');
  var fileInput = document.getElementById('docRemarkImgFile');
  function render() {
    grid.innerHTML = '';
    keep.forEach(function (u, i) {
      var d = document.createElement('div'); d.style.cssText = 'position:relative';
      d.innerHTML = '<img src="' + u + '" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid #2e2e44;background:#fff" title="点击移除"><button type="button" class="btn btn-sm btn-danger" style="position:absolute;top:-6px;right:-6px;padding:0 5px" data-kind="keep" data-idx="' + i + '">×</button>';
      grid.appendChild(d);
    });
    news.forEach(function (u, i) {
      var d = document.createElement('div'); d.style.cssText = 'position:relative';
      d.innerHTML = '<img src="' + u + '" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid #2e2e44;background:#fff" title="点击移除"><button type="button" class="btn btn-sm btn-danger" style="position:absolute;top:-6px;right:-6px;padding:0 5px" data-kind="new" data-idx="' + i + '">×</button>';
      grid.appendChild(d);
    });
    keepInput.value = JSON.stringify(keep);
    newInput.value = JSON.stringify(news);
  }
  if (fileInput) fileInput.addEventListener('change', function () {
    Array.prototype.forEach.call(fileInput.files || [], function (file) {
      if (file.size > 3 * 1024 * 1024) { alert('图片「' + file.name + '」超过 3MB，已跳过'); return; }
      var rd = new FileReader();
      rd.onload = function (e) { news.push(e.target.result); render(); };
      rd.readAsDataURL(file);
    });
    fileInput.value = '';
  });
  grid.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-kind]'); if (!btn) return;
    var kind = btn.getAttribute('data-kind'); var idx = parseInt(btn.getAttribute('data-idx'), 10);
    if (kind === 'keep') keep.splice(idx, 1); else news.splice(idx, 1);
    render();
  });
  var form = document.getElementById('docForm');
  if (form) form.addEventListener('submit', render);
  render();
})();
</script>
<script src="/static/js/document-form.js?v=20261114-2"></script>`;
  return page({ title, active: 'documents', user: ctx.user, content, flash: ctx.flash() });
}

function emptyItem() {
  return { name: '', name_en: '', model: '', color: '', unit: 'PCS', ctn: '', per_ctn: '', qty: 1, price: 0, remark: '', product_id: null, image: '', volume: '', weight: '' };
}
function itemRowHtml(it, i) {
  return `<tr data-idx="${i}">
    <td class="text-center idx">${i + 1}</td>
    <td class="text-center">${it.image ? `<img class="img-preview" src="${esc(it.image)}" style="width:46px;height:46px;object-fit:cover;border-radius:6px;border:1px solid #2e2e44;background:#fff" alt="">` : '<i class="bi bi-image text-secondary"></i>'}</td>
    <td><input class="form-control form-control-sm it-name" value="${esc(it.name)}" placeholder="品名"><input class="form-control form-control-sm mt-1 it-name_en" value="${esc(it.name_en || '')}" placeholder="英文品名"></td>
    <td><input class="form-control form-control-sm it-color col-color" value="${esc(it.color || '')}" placeholder="颜色"></td>
    <td><input class="form-control form-control-sm it-model" value="${esc(it.model || '')}"></td>
    <td><input class="form-control form-control-sm it-unit" value="${esc(it.unit || 'PCS')}"></td>
    <td><input class="form-control form-control-sm it-ctn text-end col-ctn" type="number" min="0" step="any" value="${it.ctn ? it.ctn : ''}"></td>
    <td><input class="form-control form-control-sm it-per text-end col-per" type="number" min="0" step="any" value="${it.per_ctn ? it.per_ctn : ''}"></td>
    <td><input class="form-control form-control-sm it-qty text-end" type="number" min="0" step="any" value="${it.qty}"></td>
    <td><input class="form-control form-control-sm it-volume text-end" type="number" min="0" step="any" value="${it.volume || ''}"></td><td class="col-tvol text-end it-tvol">0</td>
    <td><input class="form-control form-control-sm it-weight text-end" type="number" min="0" step="any" value="${it.weight || ''}"></td><td class="col-tw text-end it-tw">0</td>
    <td><input class="form-control form-control-sm it-price text-end col-price" type="number" min="0" step="any" placeholder="单价" value="${it.price > 0 ? it.price : ''}"></td>
    <td class="text-end align-middle it-amount fw-semibold col-amt">0.00</td>
    <td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger" onclick="removeItem(this)"><i class="bi bi-x-lg"></i></button></td>
  </tr>`;

}

function today() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function addDay(n) { const d = new Date(Date.now() + n * 86400000); const p = x => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }


// ================= 模板管理 =================
function templatesPage(ctx) {
  const groups = DOC_TYPES.map(t => {
    const list = docx.templatesByType(t.key);
    return { t, list };
  });
  const groupsHtml = groups.map(g => {
    const items = g.list.map(t => `
      <div class="list-item">
        <div class="flex-grow-1">
          <div class="fw-semibold">${esc(t.name)} ${t.is_system ? '<span class="badge text-bg-info ms-1">系统内置</span>' : '<span class="badge text-bg-secondary ms-1">自定义</span>'}</div>
          <div class="text-muted small">${esc(t.description || '')}</div>
        </div>
        <div class="d-flex gap-1 flex-wrap">
          <a class="btn btn-sm btn-outline-primary" href="/templates/${t.id}/edit"><i class="bi bi-pencil"></i> 编辑</a>
          <form method="post" action="/templates/${t.id}/copy" class="d-inline"><button class="btn btn-sm btn-outline-secondary"><i class="bi bi-files"></i> 复制</button></form>
          ${t.is_system ? `<form method="post" action="/templates/${t.id}/reset" class="d-inline" onsubmit="return confirm('将系统模板恢复为默认内容？')"><button class="btn btn-sm btn-outline-warning"><i class="bi bi-arrow-counterclockwise"></i> 恢复默认</button></form>`
          : `<form method="post" action="/templates/${t.id}/delete" class="d-inline" onsubmit="return confirm('确认删除该模板？')"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>`}
        </div>
      </div>`).join('') || '<div class="text-muted small py-2">该类型暂无模板</div>';
    return card({
      title: `${g.t.name} <span class="text-muted small fw-normal">${esc(g.t.en)}</span>`,
      actions: `<a class="btn btn-sm btn-outline-primary" href="/templates/new?doc_type=${g.t.key}"><i class="bi bi-plus-lg"></i> 新建模板</a>`,
      body: `<div class="list-group-flush">${items}</div>
      <div class="text-muted small mt-2"><i class="bi bi-info-circle me-1"></i>系统内置模板可自由编辑排版；「恢复默认」可还原初始内容。「复制」可另存为自定义模板再修改。</div>`,
    });
  }).join('');
  const content = `
    ${pageHead('单据模板', '每一类单据都可配置多个模板，开单时选用；模板支持中英双语文案与占位符', `<a class="btn btn-primary" href="/templates/new"><i class="bi bi-plus-lg"></i> 新建模板</a>`)}
    ${card({ title: '模板说明', body: `<div class="small">
      模板 = HTML 排版 + 占位符。明细区域用 <code>&lt;!-- ITEMS:BEGIN --&gt;</code> 与 <code>&lt;!-- ITEMS:END --&gt;</code> 包裹，中间内容会按每一条明细自动重复。
      常用占位符：<code>{{company.name}}</code> 公司名、<code>{{customer.company_name}}</code> 客户、<code>{{contact.name}}</code> 联系人、
      <code>{{doc.doc_no}}</code> 单号、<code>{{doc.total_amount}}</code> 总金额、<code>{{doc.total_amount_cn}}</code> 大写金额、
      <code>{{item.seq}}</code>/<code>{{item.name}}</code>/<code>{{item.qty}}</code>/<code>{{item.price}}</code>/<code>{{item.amount}}</code> 明细字段。
      编辑器内提供完整占位符清单。
    </div>` })}
    ${groupsHtml}`;
  return page({ title: '单据模板', active: 'templates', user: ctx.user, content, flash: ctx.flash() });
}

const TOKEN_HELP = [
  ['公司资料 company', '{{company.name}} {{company.name_en}} {{company.address}} {{company.tel}} {{company.fax}} {{company.email}} {{company.website}} {{company.salesman}} {{company.bank_name}} {{company.bank_account}} {{company.bank_swift}} {{company.logo_html}}'],
  ['客户 customer', '{{customer.company_name}} {{customer.name_en}} {{customer.country}} {{customer.address}} {{customer.website}} {{customer.phone}} {{customer.fax}} {{customer.email}} {{customer.whatsapp}} {{customer.wechat}} {{customer.contact_line}}'],
  ['联系人 contact', '{{contact.name}} {{contact.position}} {{contact.position_html}} {{contact.mobile}} {{contact.phone}} {{contact.phone_html}} {{contact.email}}'],
  ['单据 doc', '{{doc.doc_no}} {{doc.type_name}} {{doc.issue_date}} {{doc.valid_until}} {{doc.delivery_date}} {{doc.currency}} {{doc.payment_terms}} {{doc.trade_terms}} {{doc.port_loading}} {{doc.port_destination}} {{doc.shipping_marks}} {{doc.remarks}} {{doc.subtotal}} {{doc.discount}} {{doc.total_amount}} {{doc.total_amount_cn}} {{doc.created_by}}'],
  ['明细 item（仅在 ITEMS 区内）', '{{item.seq}} {{item.name}} {{item.name_en}} {{item.name_html}} {{item.model}} {{item.unit}} {{item.qty}} {{item.price}} {{item.amount}} {{item.remark}}'],
  ['明细循环区', '&lt;!-- ITEMS:BEGIN --&gt; 行模板（含 item 占位符） &lt;!-- ITEMS:END --&gt;'],
];

function templateFormPage(ctx) {
  const isEdit = !!ctx.params.id;
  let t = null;
  if (isEdit) {
    t = docx.getTemplate(ctx.params.id);
    if (!t) return require('./pages_core').notFoundPage(ctx, '模板不存在');
  }
  const docType = t ? t.doc_type : (ctx.query.doc_type || 'quotation');
  const action = t ? '/templates/' + t.id + '/edit' : '/templates/new';
  const title = t ? '模板：' + t.name : '新建模板';
  const v = t || {};
  const typeOpts = DOC_TYPES.map(x => ({ v: x.key, l: x.name }));
  const helpHtml = TOKEN_HELP.map(([k, toks]) => `<tr><td class="text-nowrap align-top" style="width:170px">${k}</td><td class="font-mono">${toks.replace(/ /g, ' ')}</td></tr>`).join('');
  const content = `
    ${pageHead(title, '', `<a class="btn btn-outline-secondary" href="/templates">返回模板列表</a>`)}
    <form method="post" action="${action}" id="tplForm">
    <div class="row g-3">
      <div class="col-xl-7">
        ${card({ title: '模板内容（HTML + 占位符）', actions: `<button type="button" class="btn btn-sm btn-outline-secondary" onclick="previewTpl()"><i class="bi bi-eye"></i> 刷新预览</button>`, body: `
          <div class="row g-2 mb-2">
            <div class="col-md-4">${fld({ label: '模板名称', name: 'name', value: v.name, required: true, placeholder: '如：标准报价单（带Logo）' })}</div>
            <div class="col-md-3">${fld({ label: '单据类型', name: 'doc_type', value: docType, type: 'select', options: typeOpts, required: true })}</div>
            <div class="col-md-5">${fld({ label: '描述', name: 'description', value: v.description, placeholder: '说明适用场景' })}</div>
          </div>
          <textarea class="form-control font-mono" name="content" id="tplContent" rows="26" spellcheck="false">${esc(v.content || '')}</textarea>
        ` })}
        <div class="d-flex gap-2">
          <button class="btn btn-primary" type="submit"><i class="bi bi-check-lg"></i> 保存模板</button>
          ${t && t.is_system ? `<button class="btn btn-outline-warning" type="submit" name="reset" value="1" onclick="return confirm('恢复为系统默认内容？')"><i class="bi bi-arrow-counterclockwise"></i> 恢复默认</button>` : ''}
          ${t && !t.is_system ? `<form method="post" action="/templates/${t.id}/delete" class="d-inline" onsubmit="return confirm('确认删除？')"><button class="btn btn-outline-danger"><i class="bi bi-trash"></i> 删除模板</button></form>` : ''}
          <a class="btn btn-outline-secondary" href="/templates">取消</a>
        </div>
      </div>
      <div class="col-xl-5">
        ${card({ title: '占位符清单（复制到模板中使用）', body: `<div style="max-height:520px;overflow:auto"><table class="table table-sm small"><tbody>${helpHtml}</tbody></table></div>` })}
        ${card({ title: '实时预览', body: `<iframe id="tplPreview" src="/api/templates/${t ? t.id + '/preview' : 'preview'}?doc_type=${encodeURIComponent(docType)}" style="width:100%;height:560px;border:1px solid #2e2e44;border-radius:6px;background:#fff"></iframe>
        <div class="text-muted small mt-2">预览使用示例数据渲染；保存后点「刷新预览」查看最新效果。</div>` })}
      </div>
    </div>
    </form>
    <script>
      function previewTpl() {
        const f = document.getElementById('tplForm');
        const body = new URLSearchParams(new FormData(f));
        fetch('/api/templates/preview', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body })
          .then(r => r.text()).then(html => {
            const fr = document.getElementById('tplPreview');
            fr.srcdoc = html;
          });
      }
    </script>`;
  return page({ title: '模板管理', active: 'templates', user: ctx.user, content, flash: ctx.flash(), scripts: [] });
}

// ================= 系统设置 =================
// GitHub 应用内自动升级 + 系统重启卡片（仅管理员可见）。
// 注意：本段生成页面 <script> 时，字符串字面量里的换行必须写 \\n（双反斜杠），
// 否则外层模板字符串会把它解析成真实换行，导致页面脚本 SyntaxError、按钮全部失效。
function githubUpdateCard() {
  return card({ title: "GitHub 自动升级 / 系统重启", body: `
    <div id="guBox" class="small text-muted">正在读取升级状态…</div>
    <div class="d-flex flex-wrap gap-2 my-3">
      <button type="button" class="btn btn-sm btn-outline-primary" id="guStatus"><i class="bi bi-arrow-clockwise"></i> 刷新状态</button>
      <button type="button" class="btn btn-sm btn-outline-info" id="guCheck"><i class="bi bi-search"></i> 检查更新</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" id="guBaseline"><i class="bi bi-flag"></i> 建立基线</button>
      <button type="button" class="btn btn-sm btn-primary" id="guApply"><i class="bi bi-download"></i> 一键升级</button>
      <button type="button" class="btn btn-sm btn-outline-warning" id="guRollback"><i class="bi bi-arrow-counterclockwise"></i> 回滚</button>
      <button type="button" class="btn btn-sm btn-danger" id="sysRestart"><i class="bi bi-power"></i> 重启系统</button>
    </div>
    <label class="form-check small mb-2"><input class="form-check-input" type="checkbox" id="guForce"><span class="form-check-label">强制覆盖本地改动（默认关闭，保护本机定制）</span></label>
    <pre id="guOut" class="bg-dark text-light p-3 rounded small" style="max-height:340px;overflow:auto;white-space:pre-wrap;display:none"></pre>
    <div class="form-text">升级只覆盖预设的代码文件；客户数据、聊天记录、登录态、上传素材永不写入，覆盖前自动备份、可回滚。升级或重启完成后需等待几秒让服务恢复，再刷新页面。</div>
    <script>
    (function(){
      if (window.__guBound) return; window.__guBound = true;
      var out = document.getElementById('guOut');
      var box = document.getElementById('guBox');
      function show(o){ out.style.display='block'; out.textContent = typeof o==='string'?o:JSON.stringify(o,null,2); }
      function post(url, body){
        return fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body||''}).then(function(r){return r.json();});
      }
      function status(){
        fetch('/api/upgrade/status').then(function(r){return r.json();}).then(function(r){
          if(!r.ok){ box.textContent='读取状态失败：'+(r.error||'未知'); return; }
          box.innerHTML = '当前版本 <b>'+(r.currentVersion||'?')+'</b> · 仓库 '+escHtml(r.repo||'?')
            +'<br>已装提交 <code>'+escHtml(String(r.installedCommit||'未建立基线').slice(0,12))+'</code>'
            +'<br>升级次数 '+(r.appliedCount||0)+(r.installedAt?(' · 最近 '+escHtml(r.installedAt.slice(0,19).replace('T',' '))):'');
        }).catch(function(e){ box.textContent='读取状态失败：'+e.message; });
      }
      function escHtml(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
      document.getElementById('guStatus').onclick = status;
      document.getElementById('guCheck').onclick = function(){
        show('正在检查更新…');
        post('/api/upgrade/check').then(function(r){
          if(!r.ok){ show(r); return; }
          if(r.needBaseline){ show('尚未建立基线。请先点「建立基线」，把当前版本标记为升级起点。'); return; }
          if(!r.hasUpdate){ var lc=(r.latestCommit&&r.latestCommit.sha)||r.latestCommit||''; show('已是最新版本。远端提交：'+String(lc).slice(0,12)); return; }
          var lines=['发现新版本（远端领先 '+(r.aheadBy||'?')+' 个提交）：'];
          (r.items||[]).forEach(function(it){ lines.push((it.willUpdate?'[将更新] ':(it.allowed?'[本地改动·跳过] ':'[受保护·跳过] '))+it.name); });
          show(lines.join('\\n'));
        }).catch(function(e){ show('检查失败：'+e.message); });
      };
      document.getElementById('guBaseline').onclick = function(){
        if(!confirm('把当前 GitHub 最新版本标记为「已安装基线」？\\n\\n适用于首次启用升级功能。之后的新提交才会被识别为更新。')) return;
        show('正在建立基线…');
        post('/api/upgrade/baseline').then(function(r){ show(r); status(); }).catch(function(e){ show('失败：'+e.message); });
      };
      document.getElementById('guApply').onclick = function(){
        var force = document.getElementById('guForce').checked ? '1':'0';
        var tip = force ? '警告：强制模式会覆盖本机改过的文件（含本升级界面所在文件可能导致界面消失）。\\n\\n确认继续？' : '从 GitHub 下载并覆盖有更新的代码文件？\\n\\n· 数据与聊天记录目录永不写入\\n· 本机改过的文件自动跳过\\n· 升级前自动备份，可回滚\\n· 完成后需重启系统生效';
        if(!confirm(tip)) return;
        show('正在升级，请稍候…');
        post('/api/upgrade/apply','force='+force).then(function(r){ show(r); status(); }).catch(function(e){ show('失败：'+e.message); });
      };
      document.getElementById('guRollback').onclick = function(){
        if(!confirm('回滚到上一次升级前的文件状态？\\n\\n只恢复升级备份的代码文件，不会改动客户数据与聊天记录。')) return;
        show('正在回滚…');
        post('/api/upgrade/rollback').then(function(r){ show(r); status(); }).catch(function(e){ show('失败：'+e.message); });
      };
      document.getElementById('sysRestart').onclick = function(){
        if(!confirm('立即重启系统？\\n\\n服务会在几秒内自动恢复，期间页面暂时无法访问。数据与聊天记录不会丢失。')) return;
        show('正在重启系统，请稍候…');
        post('/api/system/restart').then(function(r){
          show(r);
          if(r.ok){ var n=15; var t=setInterval(function(){ n--; if(n<=0){ clearInterval(t); location.reload(); } },1000); }
        }).catch(function(e){ show('失败：'+e.message); });
      };
      status();
    })();
    </script>` });
}

function settingsPage(ctx) {
  const company = dbx.getCompany();
  const isAdmin = ctx.user.role === 'admin';
  const users = all('SELECT * FROM users ORDER BY id');
  const parts = [];

  // WhatsApp 连接与自动回复原来在 WhatsApp 页顶部，现统一移到系统设置（DeepSeek 设置下方）。
  // 连接是按账号的，业务员也能连自己的号，所以非管理员也在设置页看到这三张卡；开关本身仍只限管理员操作。
  const waCards = pagesWa.waSettingsCards(ctx);

  if (isAdmin) {
    const aiKey = dbx.getSetting("ai_api_key") || "";
    const aiClearHtml = aiKey ? "<label class=\"form-check mt-2\"><input class=\"form-check-input\" type=\"checkbox\" name=\"clear_ai_key\" value=\"1\"><span class=\"form-check-label small\">清除已保存的 API Key</span></label>" : "";
    const tmapKey = dbx.getSetting("tmap_key") || "";
    parts.push(githubUpdateCard());
    parts.push(card({ title: "腾讯地图 Key（AI 外贸工作台地图）", body: `<form method="post" action="/settings/tmap">
      <div class="row g-3">
        <div class="col-md-8">${fld({ label: "腾讯位置服务 Key", name: "tmap_key", type: "password", value: "", placeholder: tmapKey ? "已配置，输入新值可替换；留空保持不变" : "请到腾讯位置服务控制台申请" })}</div>
        <div class="col-md-4"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存地图 Key</button></div>
      </div>
      <div class="form-text mt-2">地图用于「AI 外贸工作台 → 客户开发地图」。海外底图属非默认场景，需自行申请 Key：<a href="https://lbs.qq.com/dev/console/application/mine" target="_blank" rel="noopener">腾讯位置服务控制台</a>，创建应用并勾选 JavaScript GL / WebServiceAPI。建议为该 Key 配置 Referer 白名单（仅填你访问 CRM 的地址），避免被盗用。系统不内嵌任何 Key。</div>
    </form>` }));
    parts.push(card({ title: "DeepSeek 设置（系统全部 AI）", body: `<form method="post" action="/settings/ai">
      <div class="row g-3">
        <div class="col-md-8">${fld({ label: "DeepSeek API Key", name: "api_key", type: "password", value: "", placeholder: aiKey ? "已配置（sk-••••••••），输入新值可替换；留空保持不变" : "sk-…" })}</div>
        <div class="col-md-4">${fld({ label: "模型", name: "model", value: dbx.getSetting("ai_model") || "deepseek-chat" })}</div>
      </div>
      ${aiClearHtml}
      <button class="btn btn-primary mt-3"><i class="bi bi-check-lg"></i> 保存 DeepSeek 设置</button>
      <div class="form-text mt-1">系统全部 AI 共用这一个 Key 和模型：WhatsApp 草稿、行业简报、AI 外贸工作台、CRM 数据助理（AI 助手）。翻译已改为谷歌免费机翻，不需要这里的 Key。模型默认 deepseek-chat。</div>
    </form>` }));
    parts.push(...waCards);
    const logoHtml = company.logo ? `<img src="${esc(company.logo)}" id="logoPreview" class="mb-2" style="max-height:60px;border:1px solid #2e2e44;border-radius:6px;padding:4px">` : '<div id="logoPreview" class="text-muted small mb-2">未上传 Logo</div>';
    parts.push(card({ title: '公司资料（单据抬头 / 落款使用）', body: `<form method="post" action="/settings/company" id="companyForm">
      <div class="row g-3">
        <div class="col-md-6">${fld({ label: '公司中文名', name: 'name', value: company.name })}</div>
        <div class="col-md-6">${fld({ label: '公司英文名', name: 'name_en', value: company.name_en })}</div>
        <div class="col-12">${fld({ label: '地址 Address', name: 'address', value: company.address, type: 'textarea', rows: 2 })}</div>
        <div class="col-md-4">${fld({ label: '电话 Tel', name: 'tel', value: company.tel })}</div>
        <div class="col-md-4">${fld({ label: '传真 Fax', name: 'fax', value: company.fax })}</div>
        <div class="col-md-4">${fld({ label: '邮箱 Email', name: 'email', value: company.email })}</div>
        <div class="col-md-6">${fld({ label: '网址 Website', name: 'website', value: company.website })}</div>
        <div class="col-md-6">${fld({ label: '默认业务员 Sales', name: 'salesman', value: company.salesman })}</div>
        <div class="col-12"><label class="form-label fw-semibold">公司 Logo</label>${logoHtml}
          <input type="file" class="form-control" id="logoFile" accept="image/png,image/jpeg,image/gif,image/webp">
          <input type="hidden" name="logo_data" id="logoData">
          <div class="form-text">上传 PNG / JPG 图片，将显示在单据抬头。留空表示不修改（有 Logo 时若要删除请先清空再保存）。</div>
        </div>
        <div class="col-md-4">${fld({ label: '开户银行 Bank', name: 'bank_name', value: company.bank_name })}</div>
        <div class="col-md-4">${fld({ label: '银行账号 Account', name: 'bank_account', value: company.bank_account })}</div>
        <div class="col-md-4">${fld({ label: 'SWIFT Code', name: 'bank_swift', value: company.bank_swift })}</div>
      </div>
      <div class="mt-3"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存公司资料</button></div>
    </form>
    <script>
      document.getElementById('logoFile').addEventListener('change', function(){
        const file = this.files && this.files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) { alert('Logo 图片请小于 1MB'); this.value=''; return; }
        const rd = new FileReader();
        rd.onload = e => { document.getElementById('logoData').value = e.target.result; };
        rd.readAsDataURL(file);
      });
    </script>` }));
  }

  // 非管理员的设置页没有上面那个管理员区块，两张 WhatsApp 卡片在这里补上（管理员上面已加过，不重复）。
  if (!isAdmin) parts.push(...waCards);

  parts.push(card({ title: '修改我的密码', body: `<form method="post" action="/settings/password" class="row g-3">
    <div class="col-md-4">${fld({ label: '当前密码', name: 'current_password', type: 'password', required: true })}</div>
    <div class="col-md-4">${fld({ label: '新密码', name: 'new_password', type: 'password', required: true, min: 4 })}</div>
    <div class="col-md-4">${fld({ label: '确认新密码', name: 'confirm_password', type: 'password', required: true })}</div>
    <div class="col-12"><button class="btn btn-primary"><i class="bi bi-key"></i> 修改密码</button></div>
  </form>` }));

  if (isAdmin) {
    const userRows = users.map(u => `<tr>
      <td><div class="fw-semibold">${esc(u.display_name)}</div><div class="text-muted small">@${esc(u.username)}</div></td>
      <td>${badge(u.role === 'admin' ? '管理员' : '业务员')}</td>
      <td>${u.active ? '<span class="text-success"><i class="bi bi-check-circle"></i> 启用</span>' : '<span class="text-danger"><i class="bi bi-x-circle"></i> 停用</span>'}</td>
      <td>
        <form method="post" action="/settings/users/${u.id}/toggle" class="d-inline"><button class="btn btn-sm btn-outline-secondary">${u.active ? '停用' : '启用'}</button></form>
        <form method="post" action="/settings/users/${u.id}/password" class="d-inline-flex gap-1 align-items-center" onsubmit="return confirm('重置该用户密码？')">
          <input type="text" name="new_password" class="form-control form-control-sm" style="width:140px" placeholder="新密码" required><button class="btn btn-sm btn-outline-warning">重置密码</button>
        </form>
        ${u.id === ctx.user.id ? '<span class="text-muted small">（当前账号）</span>' : `<form method="post" action="/settings/users/${u.id}/delete" class="d-inline" onsubmit="return confirm('删除该用户？')"><button class="btn btn-sm btn-outline-danger">删除</button></form>`}
      </td></tr>`).join('');
    parts.push(card({ title: '用户管理（局域网登录账号）', actions: '', body: `
      <div class="row g-3">
        <div class="col-lg-5">
          <h6 class="fw-bold">添加用户</h6>
          <form method="post" action="/settings/users/new" class="row g-2">
            <div class="col-6">${fld({ label: '姓名', name: 'display_name', required: true })}</div>
            <div class="col-6">${fld({ label: '用户名', name: 'username', required: true })}</div>
            <div class="col-6">${fld({ label: '初始密码', name: 'password', required: true, min: 4 })}</div>
            <div class="col-6">${fld({ label: '角色', name: 'role', type: 'select', value: 'staff', options: [{ v: 'staff', l: '业务员' }, { v: 'admin', l: '管理员' }] })}</div>
            <div class="col-12"><button class="btn btn-primary btn-sm"><i class="bi bi-person-plus"></i> 添加用户</button></div>
          </form>
          <div class="text-muted small mt-2">管理员：可管理设置与用户；业务员：日常客户/单据操作。</div>
        </div>
        <div class="col-lg-7">
          <div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${userRows}</tbody></table></div>
        </div>
      </div>` }));
  }
  const content = `${pageHead('系统设置', '维护公司抬头资料（用于单据模板）、账号密码与登录用户')}${parts.join('\n')}`;
  return page({ title: '系统设置', active: 'settings', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { documentsPage, documentDetailPage, documentPrintPage, documentFormPage, templatesPage, templateFormPage, settingsPage };





















