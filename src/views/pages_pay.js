'use strict';
// ============ 货款管理 / 发货管理 ============
const { esc } = require('../util');
const { page } = require('./layout');
const { fld, card, pageHead, emptyRow } = require('./ui');
const { get, all } = require('../db');
const payments = require('../payments');
const { currencyCode, currencyOptions, cents } = payments;

function moneyFmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function typeCn(k) {
  const map = { quotation: '报价单', pi: '形式发票', so: '销售合同', ci: '商业发票', pl: '装箱单', po: '采购单' };
  return map[k] || k;
}
const SHIP = ["'so'", "'ci'"]; // 参与发货跟踪的单据类型

// ================= 货款管理 =================
function paymentsPage(ctx) {
  const customerId = Number(ctx.query.customer_id) || 0;
  const currency = ctx.query.currency ? currencyCode(ctx.query.currency) : '';
  const list = payments.listDocuments(ctx.user.id, customerId);
  const summaries = new Map(currencyOptions().map(({ v, l }) => [v, { label: l, total: 0, paid: 0, balance: 0, received: 0 }]));
  const getSummary = code => {
    if (!summaries.has(code)) summaries.set(code, { label: code, total: 0, paid: 0, balance: 0, received: 0 });
    return summaries.get(code);
  };
  for (const row of list) {
    const summary = getSummary(currencyCode(row.currency));
    summary.total += cents(row.total_amount);
    summary.paid += cents(row.paid_amt);
    summary.balance += Math.max(cents(row.total_amount) - cents(row.paid_amt), 0);
  }
  for (const row of payments.receiptTotals(ctx.user.id, customerId)) {
    getSummary(currencyCode(row.currency)).received += cents(row.amount);
  }
  const query = new URLSearchParams();
  if (customerId) query.set('customer_id', customerId);
  const clearUrl = '/payments' + (query.size ? '?' + query : '');
  const rows = currency ? list.filter(row => currencyCode(row.currency) === currency) : list;
  const summaryRows = [...summaries].filter(([code, row]) =>
    ['NGN', 'CNY', 'GBP', 'EUR'].includes(code) || row.total || row.paid || row.received || code === currency)
    .map(([code, row]) => {
      const params = new URLSearchParams(query);
      params.set('currency', code);
      return `<tr${currency === code ? ' class="table-active"' : ''}><th scope="row"><a href="/payments?${esc(params.toString())}">${esc(row.label)}</a></th>
        ${[row.total, row.paid, row.balance, row.received].map(value => `<td class="text-end text-nowrap">${moneyFmt(value / 100)}</td>`).join('')}</tr>`;
    }).join('');
  const rowsHtml = rows.map(d => {
    const total = cents(d.total_amount);
    const dep = cents(d.deposit);
    const paid = cents(d.paid_amt);
    const unpaid = Math.max(total - paid, 0);
    const st = paid > total ? '<span class="badge text-bg-warning">超收</span>'
      : paid >= total && total > 0 ? '<span class="badge text-bg-success">已结清</span>'
      : paid > 0 ? '<span class="badge text-bg-info">部分已收</span>' : '<span class="badge text-bg-secondary">未收</span>';
    const label = esc(currencyCode(d.currency));
    const ownerCanView = d.customer_owner === ctx.user.id || d.in_pool;
    return `<tr>
      <td><a class="fw-semibold text-decoration-none" href="/documents/${d.id}">${esc(d.doc_no)}</a><div class="text-muted small">${esc(typeCn(d.doc_type))} · ${esc(d.issue_date || '')}</div></td>
      <td>${ownerCanView ? `<a href="/customers/${d.customer_id}">${esc(d.company_name)}</a>` : esc(d.company_name || '—')}</td>
      ${[total, dep, paid, unpaid].map(value => `<td class="text-end text-nowrap">${label} ${moneyFmt(value / 100)}</td>`).join('')}
      <td>${st}</td>
      <td class="text-end"><div class="d-flex gap-1 justify-content-end"><a class="btn btn-sm btn-outline-success" href="/shipments/${d.id}/edit">发货</a><a class="btn btn-sm btn-outline-primary" href="/payments/${d.id}/edit">登记收款</a></div></td>
    </tr>`;
  }).join('') || emptyRow(8, '暂无符合条件的销售单据');
  const customer = customerId && get('SELECT company_name FROM customers WHERE id=? AND (user_id=? OR COALESCE(in_pool,0)=1)', customerId, ctx.user.id);
  const content = `
    ${pageHead('货款管理', customer ? esc(customer.company_name) : '按订单和客户追踪应收、实收与余额', customerId ? '<a class="btn btn-outline-secondary" href="/payments">查看全部客户</a>' : '')}
    ${card({ title: '分币种汇总', body: `<div class="table-responsive"><table class="table align-middle mb-2">
      <thead><tr><th>币种</th><th class="text-end">单据金额</th><th class="text-end">已冲抵</th><th class="text-end">待收</th><th class="text-end">实收原币</th></tr></thead>
      <tbody>${summaryRows}</tbody></table></div><p class="text-muted small mb-0">前三项按单据币种汇总，实收按到账币种汇总。点击币种筛选下方单据。</p>` })}
    ${card({ title: currency ? esc(currency) + ' 单据' : '销售单据', actions: currency ? `<a class="btn btn-sm btn-outline-secondary" href="${esc(clearUrl)}">清除币种筛选</a>` : '', body: `<div class="table-responsive"><table class="table table-hover align-middle mb-0">
      <thead><tr><th>单据</th><th>客户</th><th class="text-end">单据金额</th><th class="text-end">已收定金</th><th class="text-end">已冲抵</th><th class="text-end">待收</th><th>状态</th><th class="text-end">操作</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>` })}`;
  return page({ title: '货款管理', active: 'payments', user: ctx.user, content, flash: ctx.flash() });
}

function paymentEditPage(ctx) {
  const d = payments.findPayableDoc(ctx.params.id, ctx.user.id);
  if (!d) return page({ title: '登记收款', active: 'payments', user: ctx.user, flash: ctx.flash(),
    content: '<div class="alert alert-warning">单据不存在或不可登记收款。 <a href="/payments">返回货款管理</a></div>' });
  const p = get('SELECT * FROM document_payments WHERE doc_id=?', d.id) || {};
  const customer = get('SELECT * FROM customers WHERE id=?', d.customer_id);
  const recs = payments.readRecords(d);
  const currency = currencyCode(d.currency);
  const total = cents(d.total_amount) / 100;
  const dep = Number(p.deposit) || 0;
  const paid = (recs.length ? recs.reduce((sum, row) => sum + cents(row.amount), 0) : cents(p.paid)) / 100;
  const recRow = (rr, idx) => {
    const receivedCurrency = rr?.received_currency || currency;
    const options = currencyOptions(currency);
    if (!options.some(option => option.v === receivedCurrency)) options.push({ v: receivedCurrency, l: receivedCurrency });
    return `<tr data-id="${rr?.id || ''}">
    <td class="text-center text-muted small idx">${idx + 1}</td>
    <td><select class="form-select form-select-sm rec-currency" aria-label="实收币种">${options.map(({ v, l }) => `<option value="${esc(v)}"${v === receivedCurrency ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
    <td><input class="form-control form-control-sm rec-amt" type="number" step="0.01" min="0" value="${rr ? cents(rr.received_amount) / 100 : ''}" placeholder="0.00" aria-label="实收金额"></td>
    <td><input class="form-control form-control-sm rec-credit" type="number" step="0.01" min="0" value="${rr ? cents(rr.amount) / 100 : ''}" placeholder="0.00" aria-label="冲抵单据金额" ${receivedCurrency === currency ? 'readonly' : ''}></td>
    <td><input class="form-control form-control-sm rec-time" type="datetime-local" value="${rr ? esc(String(rr.paid_at || '').replace(' ', 'T').slice(0, 16)) : ''}" aria-label="收款时间"></td>
    <td><input class="form-control form-control-sm rec-note" maxlength="1000" value="${rr ? esc(rr.note || '') : ''}" placeholder="备注（可选）" aria-label="单笔备注"></td>
    <td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger rec-del" title="删除该笔"><i class="bi bi-x-lg"></i></button></td>
  </tr>`;
  };
  const recRowsHtml = (recs.length ? recs : [null]).map(recRow).join('');
  const content = `
    ${pageHead('登记收款', `${esc(d.doc_no)} · ${customer ? esc(customer.company_name) : ''} · 单据金额 ${esc(currency)} ${moneyFmt(total)}`, `<a class="btn btn-outline-secondary" href="/documents/${d.id}">打开单据</a><a class="btn btn-outline-secondary" href="/payments">返回货款</a>`)}
    ${card({ body: `<form method="post" action="/payments/${d.id}/edit" id="payForm">
      <input type="hidden" name="revision" value="${esc(p.updated_at || '')}">
      <input type="hidden" name="document_currency" value="${esc(currency)}">
      <input type="hidden" name="document_total" value="${total}">
      <div class="row g-3 mb-3">
        <div class="col-md-3">${fld({ label: '已收定金 · ' + esc(currency), name: 'deposit', value: dep || '', type: 'number', step: '0.01', min: 0 })}</div>
        <div class="col-md-9">
          <div class="d-flex flex-wrap gap-4 mt-2 small">
            <div>已冲抵 ${esc(currency)} <b class="text-success" id="outPaid">${moneyFmt(paid)}</b></div>
            <div>待收 ${esc(currency)} <b id="outUnpaid">${moneyFmt(Math.max(total - paid, 0))}</b></div>
            <div>超收 ${esc(currency)} <b id="outOver">${moneyFmt(Math.max(paid - total, 0))}</b></div>
          </div>
        </div>
      </div>
      <div class="row g-3 mb-3">
        <div class="col-12">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="fw-semibold">分笔收款</span>
            <button type="button" class="btn btn-sm btn-outline-primary" id="addRec"><i class="bi bi-plus-lg"></i> 添加一笔</button>
          </div>
          <input type="hidden" name="records" id="recordsJson" value="">
          <div class="table-responsive"><table class="table table-sm align-middle" id="recTable" style="min-width:850px">
            <thead><tr><th>#</th><th>实收币种</th><th>实收金额</th><th>冲抵 ${esc(currency)}</th><th>收款时间</th><th>备注</th><th></th></tr></thead>
            <tbody id="recTbody">${recRowsHtml}</tbody>
          </table></div>
          <template id="recTemplate">${recRow(null, 0)}</template>
          <div class="form-text">币种不同时，按本次实际结算填写冲抵金额。定金是分笔收款中的一部分，请同时录入对应流水。</div>
        </div>
      </div>
      <div class="row g-3 mb-3">
        <div class="col-12">${fld({ label: '收款备注', name: 'remark', value: p.remark || '', type: 'textarea', rows: 2 })}</div>
      </div>
      <div class="mt-4 d-flex flex-wrap gap-2">
        <button class="btn btn-primary" type="submit"><i class="bi bi-check-lg"></i> 保存分笔收款</button>
        <button class="btn btn-outline-success" type="button" id="fullPaid"><i class="bi bi-check2-circle"></i> 填入待收金额</button>
        <a class="btn btn-outline-primary" href="/shipments/${d.id}/edit"><i class="bi bi-box-arrow-up-right me-1"></i>去发货（填写发货信息）</a>
        <a class="btn btn-outline-secondary" href="/payments">取消</a>
      </div>
    </form>
    <script>
      (function () {
        var total = ${cents(d.total_amount)};
        var currency = ${JSON.stringify(currency).replace(/</g, '\\u003c')};
        var tbody = document.getElementById('recTbody');
        var template = document.getElementById('recTemplate');
        var fullPaid = document.getElementById('fullPaid');
        var payForm = document.getElementById('payForm');
        function p2(n) { return (n < 10 ? '0' : '') + n; }
        function nowLocal() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
        function fmt(n) { return (Math.max(0, n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
        function sumRows() {
          return Array.from(tbody.querySelectorAll('.rec-credit')).reduce(function (sum, input) {
            return sum + Math.round((Number(input.value) || 0) * 100);
          }, 0);
        }
        function upd() {
          var paidV = sumRows();
          document.getElementById('outPaid').textContent = fmt(paidV);
          document.getElementById('outUnpaid').textContent = fmt(total - paidV);
          document.getElementById('outOver').textContent = fmt(paidV - total);
          fullPaid.disabled = paidV >= total;
        }
        function blankRow() {
          var tr = template.content.firstElementChild.cloneNode(true);
          tr.querySelector('.rec-time').value = nowLocal();
          tbody.prepend(tr);
          renum();
          return tr;
        }
        function renum() {
          Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr, i) { var c = tr.querySelector('.idx'); if (c) c.textContent = i + 1; });
        }
        function syncRow(row, currencyChanged) {
          var same = row.querySelector('.rec-currency').value === currency;
          var credit = row.querySelector('.rec-credit');
          credit.readOnly = same;
          if (same) credit.value = row.querySelector('.rec-amt').value;
          else if (currencyChanged) credit.value = '';
          upd();
        }
        tbody.addEventListener('input', function (e) {
          if (e.target.matches('.rec-currency, .rec-amt, .rec-credit')) syncRow(e.target.closest('tr'), e.target.matches('.rec-currency'));
        });
        tbody.addEventListener('click', function (e) {
          var btn = e.target.closest('.rec-del');
          if (!btn) return;
          btn.closest('tr').remove(); renum(); upd();
        });
        document.getElementById('addRec').addEventListener('click', function () { blankRow(); upd(); });
        fullPaid.addEventListener('click', function () {
          var balance = total - sumRows();
          if (balance <= 0) return;
          var row = blankRow();
          row.querySelector('.rec-amt').value = (balance / 100).toFixed(2);
          syncRow(row);
        });
        payForm.addEventListener('submit', function (event) {
          var list = [];
          for (var tr of tbody.querySelectorAll('tr')) {
            var amount = tr.querySelector('.rec-amt');
            var credit = tr.querySelector('.rec-credit');
            var time = tr.querySelector('.rec-time');
            if (!tr.dataset.id && !amount.value && !credit.value) continue;
            if (!(Number(amount.value) > 0) || !(Number(credit.value) > 0) || !time.value) {
              event.preventDefault();
              alert('请填写每笔实收金额、冲抵金额和收款时间。');
              (Number(amount.value) <= 0 ? amount : Number(credit.value) <= 0 ? credit : time).focus();
              return;
            }
            list.push({ id: tr.dataset.id, received_currency: tr.querySelector('.rec-currency').value,
              received_amount: amount.value, amount: credit.value, paid_at: time.value, note: tr.querySelector('.rec-note').value });
          }
          document.getElementById('recordsJson').value = JSON.stringify(list);
        });
        if (tbody.rows.length === 1 && !tbody.rows[0].dataset.id) tbody.rows[0].querySelector('.rec-time').value = nowLocal();
        upd();
      })();
    </script>` })}`;
  return page({ title: '登记收款', active: 'payments', user: ctx.user, content, flash: ctx.flash() });
}
// ================= 发货管理 =================
function shipmentsPage(ctx) {
  const rows = all(`SELECT d.*, c.company_name, s.warehouse_address, s.contact, s.marks AS s_marks, s.ship_date, s.receive_image, s.inspect_image
    FROM documents d LEFT JOIN customers c ON c.id=d.customer_id
    LEFT JOIN document_shipments s ON s.doc_id=d.id
    WHERE d.user_id=? AND d.status<>'已作废' AND (d.doc_type IN (${SHIP.join(',')}) OR (d.doc_type='pi' AND EXISTS(SELECT 1 FROM document_payments pp WHERE pp.doc_id=d.id AND (pp.paid>0 OR pp.deposit>0)))) ORDER BY d.id DESC`, ctx.user.id);
  const rowsHtml = rows.map(d => {
    const marks = d.s_marks || d.shipping_marks || '';
    const imgCell = (img, label) => img
      ? `<a href="${esc(img)}" target="_blank"><img src="${esc(img)}" style="width:44px;height:44px;object-fit:cover;border-radius:6px" title="${label}"></a>`
      : `<span class="text-muted small">${label}未传</span>`;
    const completeBtn = (d.doc_type === "so" && Number(d.stock_applied) === 1)
      ? (Number(d.stock_restored) === 1
          ? "<span class=\"badge text-bg-success\">已回补</span>"
          : "<form class=\"d-inline\" method=\"post\" action=\"/shipments/" + d.id + "/complete\" onsubmit=\"return confirm('标记完成发货？按 V1.01 规则回补欠货数量')\"><button class=\"btn btn-sm btn-success\">完成发货</button></form>")
      : "";
    return `<tr>
      <td><a class="fw-semibold text-decoration-none" href="/documents/${d.id}">${esc(d.doc_no)}</a><div class="text-muted small">${esc(typeCn(d.doc_type))}</div></td>
      <td>${esc(d.company_name || '')}</td>
      <td class="small">${esc(marks || '-')}</td>
      <td class="small">${esc(d.warehouse_address || '-')}</td>
      <td class="small">${esc(d.contact || '-')}</td>
      <td class="text-center">${esc(d.ship_date || '-')}</td>
      <td><div class="d-flex gap-2">${imgCell(d.receive_image, '仓库签收')}</div></td>
      <td><div class="d-flex gap-2">${imgCell(d.inspect_image, '验货')}</div></td>
      <td class="text-end"><div class="d-flex gap-1 justify-content-end">${completeBtn}<a class="btn btn-sm btn-outline-primary" href="/shipments/${d.id}/edit">填写发货</a></div></td>
    </tr>`;
  }).join('') || emptyRow(9, '暂无待发货单据（销售合同/CI 及已登记收款的 PI）');
  const content = `
    ${pageHead('发货', '仓库地址 / 联系方式 / 唛头 / 发货日期 + 仓库签收与验货图片', '')}
    ${card({ body: `<div class="table-responsive"><table class="table table-hover align-middle">
      <thead><tr><th>单据</th><th>客户</th><th>唛头</th><th>仓库地址</th><th>联系方式</th><th class="text-center">发货日期</th><th>仓库签收图片</th><th>验货图片</th><th class="text-end">操作</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>` })}`;
  return page({ title: '发货', active: 'shipments', user: ctx.user, content, flash: ctx.flash() });
}

function shipmentEditPage(ctx) {
  const d = get('SELECT * FROM documents WHERE id=? AND user_id=?', ctx.params.id, ctx.user.id);
  if (!d) return '<div class="alert alert-warning">单据不存在或无权访问</div>';
  const s = get('SELECT * FROM document_shipments WHERE doc_id=?', d.id) || {};
  const customer = get('SELECT * FROM customers WHERE id=?', d.customer_id);
  const marks = s.marks || d.shipping_marks || '';
  const imgBox = (name, img, idPrefix, title) => {
    const prev = img ? `<img id="${idPrefix}Prev" src="${esc(img)}" alt="" style="max-height:90px;border-radius:8px;border:1px solid #dee2e6;padding:3px;background:#fff;display:block;margin-bottom:6px">` : `<div id="${idPrefix}Prev" style="width:120px;height:90px;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;color:#94a3b8;background:#f8fafc;border-radius:8px"><i class="bi bi-image"></i></div>`;
    const clear = img ? `<label class="form-check mt-1"><input class="form-check-input" type="checkbox" name="${idPrefix}_clear" value="1"><span class="form-check-label small">移除已传图片</span></label>` : '';
    return `<div class="mb-2">${prev}
      <input type="file" class="form-control form-control-sm" id="${idPrefix}File" accept="image/png,image/jpeg,image/gif,image/webp">
      <input type="hidden" name="${idPrefix}_data" id="${idPrefix}Data">
      <div class="form-text">${title}，PNG/JPG ≤3MB</div>${clear}
    </div>`;
  };
  const content = `
    ${pageHead('填写发货信息', `${esc(d.doc_no)} · ${customer ? esc(customer.company_name) : ''}`, `<a class="btn btn-outline-secondary" href="/shipments">返回发货</a>`)}
    ${card({ body: `<form method="post" action="/shipments/${d.id}/edit">
      <div class="row g-3">
        <div class="col-md-8">${fld({ label: '仓库地址', name: 'warehouse_address', value: s.warehouse_address || '', type: 'textarea', rows: 2, placeholder: '如：广东省深圳市龙岗区… 第X号仓' })}</div>
        <div class="col-md-4">${fld({ label: '仓库联系方式', name: 'contact', value: s.contact || '', placeholder: '联系人 / 电话' })}</div>
        <div class="col-md-8">${fld({ label: '唛头 Shipping Marks', name: 'marks', value: marks, type: 'textarea', rows: 2 })}</div>
        <div class="col-md-4">${fld({ label: '发货日期', name: 'ship_date', value: s.ship_date || d.delivery_date || '', type: 'date' })}</div>
        <div class="col-md-6">${imgBox('receive', s.receive_image, 'receive', '仓库签收图片')}</div>
        <div class="col-md-6">${imgBox('inspect', s.inspect_image, 'inspect', '验货图片')}</div>
      </div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary"><i class="bi bi-check-lg"></i> 保存</button><a class="btn btn-outline-secondary" href="/shipments">取消</a></div>
    </form>
    <script>
      ['receive','inspect'].forEach(function (k) {
        var fi = document.getElementById(k + 'File');
        if (!fi) return;
        fi.addEventListener('change', function () {
          var file = fi.files && fi.files[0]; if (!file) return;
          if (file.size > 3 * 1024 * 1024) { alert('图片请小于 3MB'); fi.value=''; return; }
          var rd = new FileReader();
          rd.onload = function (e) {
            document.getElementById(k + 'Data').value = e.target.result;
            var box = document.getElementById(k + 'Prev');
            box.outerHTML = '<img id="' + k + 'Prev" src="' + e.target.result + '" alt="" style="max-height:90px;border-radius:8px;border:1px solid #dee2e6;padding:3px;background:#fff;display:block;margin-bottom:6px">';
          };
          rd.readAsDataURL(file);
        });
      });
    </script>` })}`;
  return page({ title: '填写发货信息', active: 'shipments', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { paymentsPage, paymentEditPage, shipmentsPage, shipmentEditPage };
