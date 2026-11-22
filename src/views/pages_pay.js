'use strict';
// ============ 货款管理 / 发货管理 ============
const { esc } = require('../util');
const { page } = require('./layout');
const { fld, card, pageHead, badge, emptyRow } = require('./ui');
const { get, all, run, DOC_TYPES } = require('../db');
const { nowStr } = require('../util');

function moneyFmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function typeCn(k) {
  const map = { quotation: '报价单', pi: '形式发票', so: '销售合同', ci: '商业发票', pl: '装箱单', po: '采购单' };
  return map[k] || k;
}
const SALES = ["'so'", "'pi'", "'ci'"]; // 参与货款跟踪的单据类型
const SHIP = ["'so'", "'ci'"]; // 参与发货跟踪的单据类型

// ================= 货款管理 =================
function paymentsPage(ctx) {
  const rows = all(`SELECT d.*, c.company_name, p.deposit, p.paid AS paid_amt, p.remark AS pay_remark
    FROM documents d LEFT JOIN customers c ON c.id=d.customer_id
    LEFT JOIN document_payments p ON p.doc_id=d.id
    WHERE d.user_id=? AND d.doc_type IN (${SALES.join(',')}) AND d.status<>'已作废' ORDER BY d.id DESC`, ctx.user.id);
  const rowsHtml = rows.map(d => {
    const total = Number(d.total_amount) || 0;
    const dep = Number(d.deposit) || 0;
    const paid = Number(d.paid_amt) || 0;
    const unpaid = Math.max(total - paid, 0);
    const tail = Math.max(total - dep, 0);
    const st = paid >= total && total > 0 ? '<span class="badge text-bg-success">已结清</span>' : (paid > 0 ? '<span class="badge text-bg-info">部分已付</span>' : '<span class="badge text-bg-danger">未付</span>');
    return `<tr>
      <td><a class="fw-semibold text-decoration-none" href="/documents/${d.id}">${esc(d.doc_no)}</a><div class="text-muted small">${esc(typeCn(d.doc_type))} · ${esc(d.issue_date || '')}</div></td>
      <td>${esc(d.company_name || '')}</td>
      <td class="text-end">${esc(d.currency || 'USD')} ${moneyFmt(total)}</td>
      <td class="text-end">${moneyFmt(dep)}</td>
      <td class="text-end">${moneyFmt(tail)}</td>
      <td class="text-end">${moneyFmt(paid)}</td>
      <td class="text-end">${moneyFmt(unpaid)}</td>
      <td>${st}</td>
      <td class="text-end"><div class="d-flex gap-1 justify-content-end"><a class="btn btn-sm btn-outline-success" href="/shipments/${d.id}/edit">发货</a><a class="btn btn-sm btn-outline-primary" href="/payments/${d.id}/edit">登记收款</a></div></td>
    </tr>`;
  }).join('') || emptyRow(9, '暂无需要收款跟踪的单据（销售合同/PI/CI）');
  const content = `
    ${pageHead('货款', '按单据跟踪：定金 / 尾款 / 已付 / 未付', '')}
    ${card({ body: `<div class="table-responsive"><table class="table table-hover align-middle">
      <thead><tr><th>单据</th><th>客户</th><th class="text-end">单据金额</th><th class="text-end">定金</th><th class="text-end">尾款</th><th class="text-end">已付</th><th class="text-end">未付</th><th>状态</th><th class="text-end">操作</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>
      <div class="text-muted small">说明：定金=已收定金；尾款=单据金额−定金；已付=累计实收；未付=单据金额−已付。登记收款后在单据详情亦可见。</div>` })}`;
  return page({ title: '货款', active: 'payments', user: ctx.user, content, flash: ctx.flash() });
}

function paymentEditPage(ctx) {
  const d = get('SELECT * FROM documents WHERE id=? AND user_id=?', ctx.params.id, ctx.user.id);
  if (!d) return '<div class="alert alert-warning">单据不存在或无权访问</div>';
  const p = get('SELECT * FROM document_payments WHERE doc_id=?', d.id) || {};
  const customer = get('SELECT * FROM customers WHERE id=?', d.customer_id);
  const recs = all('SELECT * FROM payment_records WHERE doc_id=? ORDER BY paid_at ASC, id ASC', d.id);
  const total = Number(d.total_amount) || 0;
  const dep = Number(p.deposit) || 0;
  const paid = Math.round(recs.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;
  const recRow = (rr, idx) => `<tr>
    <td class="text-center text-muted small idx">${idx + 1}</td>
    <td><input class="form-control form-control-sm rec-amt" type="number" step="0.01" min="0" value="${rr ? (Number(rr.amount) || '') : ''}" placeholder="0.00"></td>
    <td><input class="form-control form-control-sm rec-time" type="datetime-local" value="${rr ? esc(String(rr.paid_at || '').replace(' ', 'T').slice(0, 16)) : ''}"></td>
    <td><input class="form-control form-control-sm rec-note" value="${rr ? esc(rr.note || '') : ''}" placeholder="备注（可选）"></td>
    <td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger rec-del" title="删除该笔"><i class="bi bi-x-lg"></i></button></td>
  </tr>`;
  const recRowsHtml = (recs.length ? recs : [null]).map(recRow).join('');
  const content = `
    ${pageHead('登记收款', `${esc(d.doc_no)} · ${customer ? esc(customer.company_name) : ''} · 单据金额 ${esc(d.currency)} ${moneyFmt(total)}`, `<a class="btn btn-outline-secondary" href="/payments">返回货款</a>`)}
    ${card({ body: `<form method="post" action="/payments/${d.id}/edit" id="payForm">
      <div class="row g-3 mb-3">
        <div class="col-md-3">${fld({ label: '定金（已收）', name: 'deposit', value: dep || '', type: 'number', step: '0.01', min: 0, id: 'inDep' })}</div>
        <div class="col-md-9">
          <div class="d-flex flex-wrap gap-4 mt-2 small">
            <div>尾款：<b id="outTail">${moneyFmt(Math.max(total - dep, 0))}</b></div>
            <div>已付（自动汇总）：<b class="text-success" id="outPaid">${moneyFmt(paid)}</b></div>
            <div>未付：<b id="outUnpaid">${moneyFmt(Math.max(total - paid, 0))}</b></div>
            <div>欠款（待收）：<b class="text-danger" id="outOwe">${moneyFmt(Math.max(total - paid, 0))}</b></div>
          </div>
        </div>
      </div>
      <div class="row g-3 mb-3">
        <div class="col-12">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <label class="form-label fw-semibold mb-0">分笔收款（每笔填写金额 + 收款时间）</label>
            <button type="button" class="btn btn-sm btn-outline-primary" id="addRec"><i class="bi bi-plus-lg"></i> 添加一笔</button>
          </div>
          <input type="hidden" name="records" id="recordsJson" value="">
          <div class="table-responsive"><table class="table table-sm align-middle" id="recTable">
            <thead><tr><th style="width:44px" class="text-center">#</th><th style="width:220px">收款金额</th><th style="width:260px">收款时间</th><th>备注</th><th style="width:60px"></th></tr></thead>
            <tbody id="recTbody">${recRowsHtml}</tbody>
          </table></div>
          <div class="form-text">收款时间必填；保存后自动汇总“已付”，未付＝单据金额−已付。“全额收讫”会记一笔＝单据金额。</div>
        </div>
      </div>
      <div class="row g-3 mb-3">
        <div class="col-12">${fld({ label: '收款备注', name: 'remark', value: p.remark || '', type: 'textarea', rows: 2 })}</div>
      </div>
      <div class="mt-4 d-flex gap-2">
        <button class="btn btn-primary" type="submit"><i class="bi bi-check-lg"></i> 保存分笔收款</button>
        <button class="btn btn-outline-success" type="button" id="fullPaid"><i class="bi bi-check2-circle"></i> 全额收讫</button>
        <a class="btn btn-outline-primary" href="/shipments/${d.id}/edit"><i class="bi bi-box-arrow-up-right me-1"></i>去发货（填写发货信息）</a>
        <a class="btn btn-outline-secondary" href="/payments">取消</a>
      </div>
    </form>
    <script>
      (function () {
        var total = ${total};
        var tbody = document.getElementById('recTbody');
        var inDep = document.getElementById('inDep');
        function p2(n) { return (n < 10 ? '0' : '') + n; }
        function nowLocal() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
        function fmt(n) { return Math.max(0, n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
        function sumRows() {
          var s = 0;
          Array.prototype.forEach.call(tbody.querySelectorAll('.rec-amt'), function (inp) { var v = parseFloat(inp.value) || 0; if (v > 0) s += v; });
          return Math.round(s * 100) / 100;
        }
        function upd() {
          var depV = parseFloat(inDep.value) || 0;
          var paidV = sumRows();
          document.getElementById('outTail').textContent = fmt(Math.max(total - depV, 0));
          document.getElementById('outPaid').textContent = fmt(paidV);
          document.getElementById('outUnpaid').textContent = fmt(Math.max(total - paidV, 0));
          document.getElementById('outOwe').textContent = fmt(Math.max(total - paidV, 0));
        }
        function blankRow() {
          var tr = document.createElement('tr');
          tr.innerHTML = '<td class="text-center text-muted small idx"></td>' +
            '<td><input class="form-control form-control-sm rec-amt" type="number" step="0.01" min="0" placeholder="0.00"></td>' +
            '<td><input class="form-control form-control-sm rec-time" type="datetime-local" value="' + nowLocal() + '"></td>' +
            '<td><input class="form-control form-control-sm rec-note" placeholder="备注（可选）"></td>' +
            '<td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger rec-del"><i class="bi bi-x-lg"></i></button></td>';
          tbody.appendChild(tr);
          renum();
          return tr;
        }
        function renum() {
          Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr, i) { var c = tr.querySelector('.idx'); if (c) c.textContent = i + 1; });
        }
        tbody.addEventListener('input', function (e) { if (e.target.classList.contains('rec-amt') || e.target.classList.contains('rec-time')) upd(); });
        tbody.addEventListener('click', function (e) {
          var btn = e.target.closest('.rec-del');
          if (!btn) return;
          var rows = tbody.querySelectorAll('tr');
          if (rows.length <= 1) {
            var a = btn.closest('tr').querySelector('.rec-amt'); if (a) a.value = '';
            var t = btn.closest('tr').querySelector('.rec-time'); if (t) t.value = nowLocal();
            upd(); return;
          }
          btn.closest('tr').remove(); renum(); upd();
        });
        document.getElementById('addRec').addEventListener('click', function () { blankRow(); upd(); });
        document.getElementById('fullPaid').addEventListener('click', function () {
          tbody.innerHTML = '';
          blankRow();
          var amtIn = tbody.querySelector('.rec-amt'); if (amtIn) amtIn.value = total;
          upd();
        });
        document.getElementById('payForm').addEventListener('submit', function () {
          var list = [];
          Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
            var amt = parseFloat((tr.querySelector('.rec-amt') || {}).value) || 0;
            if (amt > 0) list.push({ amount: amt, paid_at: ((tr.querySelector('.rec-time') || {}).value || ''), note: ((tr.querySelector('.rec-note') || {}).value || '') });
          });
          document.getElementById('recordsJson').value = JSON.stringify(list);
        });
        if (inDep) inDep.addEventListener('input', upd);
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
