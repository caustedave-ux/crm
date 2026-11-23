'use strict';
// ============ 页面渲染：物流跟踪（供应商发货 / 客户出货） ============
const { esc, todayStr } = require('../util');
const { page } = require('./layout');
const { fld, card, pageHead, badge } = require('./ui');
const { all, get } = require('../db');
const L = require('../logistics');

const DIR_OPTS = [{ v: 'out', l: '客户出货' }, { v: 'in', l: '供应商发货' }];
const STATUS_OPTS = L.STATUSES.map(s => ({ v: s, l: s }));

function dirBadge(d) {
  return d === 'in'
    ? '<span class="badge text-bg-warning">供应商发货</span>'
    : '<span class="badge text-bg-primary">客户出货</span>';
}
function statusBadge(s) {
  return `<span class="badge text-bg-${L.statusCls(s)}">${esc(s || '')}</span>`;
}

/* ---------------- 列表 ---------------- */

function listPage(ctx) {
  const dir = ['in', 'out'].includes(String(ctx.query.dir || '')) ? String(ctx.query.dir) : '';
  const status = String(ctx.query.status || '');
  const kw = String(ctx.query.q || '').trim();
  const today = todayStr();

  const where = ['s.user_id=?'];
  const params = [ctx.user.id];
  if (dir) { where.push('s.direction=?'); params.push(dir); }
  if (status) { where.push('s.status=?'); params.push(status); }
  if (kw) {
    where.push('(s.waybill_no LIKE ? OR s.reference_no LIKE ? OR s.notes LIKE ? OR EXISTS(SELECT 1 FROM logistics_items i WHERE i.shipment_id=s.id AND (i.marks LIKE ? OR i.order_no LIKE ? OR i.description LIKE ?)))');
    const k = '%' + kw + '%';
    params.push(k, k, k, k, k, k);
  }
  const rows = all(`SELECT s.*, (SELECT COUNT(*) FROM logistics_items i WHERE i.shipment_id=s.id) AS item_count
    FROM logistics_shipments s WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.next_check_at,'9999') ASC, s.id DESC LIMIT 200`, ...params);

  const itemSummary = (sid) => {
    const items = all(`SELECT i.*, c.company_name FROM logistics_items i LEFT JOIN customers c ON c.id=i.customer_id
      WHERE i.shipment_id=? ORDER BY i.id`, sid);
    if (!items.length) return '<span class="text-muted small">—</span>';
    const names = [...new Set(items.map(i => i.company_name || i.customer_text || i.order_no || '未指定'))];
    const extra = names.length > 2 ? ` +${names.length - 2}` : '';
    return `<div class="small">${esc(names.slice(0, 2).join('、'))}${extra}</div>
      <div class="text-muted" style="font-size:12px">${items.length} 票 · ${items.map(i => i.marks).filter(Boolean).slice(0, 2).map(esc).join(' / ') || '无唛头'}</div>`;
  };

  const dueCount = rows.filter(r => L.dueForCheck(r, today)).length;
  const activeCount = rows.filter(r => !L.isClosed(r.status)).length;

  const tableRows = rows.map(r => {
    const due = L.dueForCheck(r, today);
    return `<tr class="${due ? 'table-warning' : ''}">
      <td>
        <a href="/logistics/${r.id}" class="fw-semibold text-decoration-none">${esc(r.waybill_no || '（无单号）')}</a>
        <div class="text-muted" style="font-size:12px">${esc(r.carrier || '')}</div>
      </td>
      <td>${dirBadge(r.direction)}</td>
      <td>${itemSummary(r.id)}</td>
      <td class="small">${esc(r.reference_no || '')}</td>
      <td class="small text-muted">${esc((r.ship_date || '').slice(0, 10))}</td>
      <td class="small ${due ? 'text-danger fw-semibold' : 'text-muted'}">${esc((r.next_check_at || '').slice(0, 10) || '—')}${due ? '<br>该查了' : ''}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="text-end"><a class="btn btn-sm btn-outline-secondary" href="/logistics/${r.id}">详情</a></td>
    </tr>`;
  }).join('');

  const stat = (n, l, cls) => `<div class="col-6 col-md-3"><div class="bg-light rounded-3 p-3 text-center"><div class="h4 mb-0 fw-bold ${cls || ''}">${n}</div><div class="text-muted small">${l}</div></div></div>`;

  const content = `
    ${pageHead('物流跟踪', '供应商发货 / 客户出货，一张运单可以拆成多票（每个客户一票，带唛头与订单号）',
      `<a class="btn btn-primary" href="/logistics/new?dir=${esc(dir || 'out')}"><i class="bi bi-plus-lg"></i> 新建运单</a>`)}
    <div class="row g-2 mb-3">
      ${stat(dueCount, '待查询', dueCount ? 'text-danger' : '')}
      ${stat(activeCount, '在途运单')}
      ${stat(rows.filter(r => r.direction === 'in').length, '供应商发货')}
      ${stat(rows.filter(r => r.direction === 'out').length, '客户出货')}
    </div>
    <div class="d-flex gap-2 flex-wrap mb-3">
      <a class="btn btn-sm ${dir === '' ? 'btn-primary' : 'btn-outline-secondary'}" href="/logistics">全部</a>
      <a class="btn btn-sm ${dir === 'in' ? 'btn-primary' : 'btn-outline-secondary'}" href="/logistics?dir=in">供应商发货</a>
      <a class="btn btn-sm ${dir === 'out' ? 'btn-primary' : 'btn-outline-secondary'}" href="/logistics?dir=out">客户出货</a>
      <form class="d-flex gap-2 ms-auto" method="get" action="/logistics">
        <input type="hidden" name="dir" value="${esc(dir)}">
        <select class="form-select form-select-sm" name="status" style="width:auto">
          <option value="">全部状态</option>
          ${STATUS_OPTS.map(o => `<option value="${o.v}" ${status === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
        </select>
        <input class="form-control form-control-sm" name="q" value="${esc(kw)}" placeholder="单号 / 订单号 / 唛头 / 品名" style="width:220px">
        <button class="btn btn-sm btn-outline-primary">筛选</button>
      </form>
    </div>
    ${card({
      title: '运单列表',
      body: rows.length ? `<div class="table-responsive"><table class="table table-sm align-middle mb-0">
        <thead><tr><th>运单号</th><th>方向</th><th>分票（客户/唛头）</th><th>订单号</th><th>发货日</th><th>下次查询</th><th>状态</th><th></th></tr></thead>
        <tbody>${tableRows}</tbody></table></div>`
        : `<div class="text-muted small py-4 text-center">还没有运单。点右上角「新建运单」录入第一票。</div>`
    })}`;
  return page({ title: '物流跟踪', active: 'logistics', user: ctx.user, content, flash: ctx.flash() });
}

/* ---------------- 新建 / 编辑 ---------------- */

function itemRowHtml(it, customers, suppliers) {
  // 客户/供应商：可直接输入名字（带自动补全），也可以从下拉里挑系统里的记录
  const cVal = it.company_name || it.customer_text || (it.customer_id ? String(it.customer_id) : '') || '';
  const sVal = it.supplier_name || it.supplier_text || (it.supplier_id ? String(it.supplier_id) : '') || '';
  return `<tr class="lgs-item">
    <td><input class="form-control form-control-sm" name="customer" list="dlCustomers" value="${esc(cVal)}" placeholder="选或直接打字"></td>
    <td><input class="form-control form-control-sm" name="supplier" list="dlSuppliers" value="${esc(sVal)}" placeholder="选或直接打字"></td>
    <td><input class="form-control form-control-sm" name="order_no" value="${esc(it.order_no || '')}" placeholder="PI-2026-001"></td>
    <td><input class="form-control form-control-sm" name="marks" value="${esc(it.marks || '')}" placeholder="唛头 / C/NO."></td>
    <td><input class="form-control form-control-sm" name="description" value="${esc(it.description || '')}" placeholder="品名"></td>
    <td><input class="form-control form-control-sm" name="qty" value="${it.qty ? it.qty : ''}" placeholder="数量"></td>
    <td><input class="form-control form-control-sm" name="unit" value="${esc(it.unit || 'PCS')}" style="width:80px"></td>
    <td><input class="form-control form-control-sm" name="ctn" value="${it.ctn ? it.ctn : ''}" placeholder="箱数" style="width:80px"></td>
    <td><input class="form-control form-control-sm" name="item_notes" value="${esc(it.notes || '')}" placeholder="备注"></td>
    <td><button type="button" class="btn btn-sm btn-outline-danger" onclick="this.closest('tr').remove()">×</button></td>
  </tr>`;
}

function datalists(customers, suppliers) {
  return `<datalist id="dlCustomers">${customers.map(c => `<option value="${esc(c.company_name)}"></option>`).join('')}</datalist>
  <datalist id="dlSuppliers">${suppliers.map(s => `<option value="${esc(s.name)}"></option>`).join('')}</datalist>`;
}

function imagesBlock(s) {
  let initial = [];
  try { initial = JSON.parse(s.images || '[]') || []; } catch (e) { initial = []; }
  return `<div class="col-12">
    <label class="form-label">物流单图片（可多张）</label>
    <input type="file" multiple class="form-control" id="lgsImgFile" accept="image/png,image/jpeg,image/gif,image/webp">
    <input type="hidden" name="keep_images" id="lgsKeep" value="${esc(JSON.stringify(initial))}">
    <input type="hidden" name="new_images" id="lgsNew" value="[]">
    <div id="lgsGrid" class="d-flex flex-wrap gap-2 mt-2"></div>
    <div class="form-text">面单 / 装箱单 / 货物照片都行；单张≤3MB，点缩略图看大图。</div>
    <script>
      (function () {
        var keep = [];
        try { keep = JSON.parse(document.getElementById('lgsKeep').value || '[]') || []; } catch (e) { keep = []; }
        var news = [];
        var grid = document.getElementById('lgsGrid');
        var input = document.getElementById('lgsImgFile');
        function sync() {
          document.getElementById('lgsKeep').value = JSON.stringify(keep);
          document.getElementById('lgsNew').value = JSON.stringify(news);
        }
        function thumb(src, isOld) {
          var box = document.createElement('div');
          box.className = 'position-relative';
          var img = document.createElement('img');
          img.src = src;
          img.style.cssText = 'width:88px;height:88px;object-fit:cover;border-radius:8px;border:1px solid #dee2e6;background:#fff;cursor:zoom-in';
          img.onclick = function () { window.open(src, '_blank'); };
          var x = document.createElement('button');
          x.type = 'button'; x.className = 'btn btn-sm btn-danger position-absolute';
          x.style.cssText = 'top:-8px;right:-8px;padding:0 6px;line-height:1;border-radius:50%';
          x.innerHTML = '&times;';
          x.onclick = function () {
            if (isOld) keep = keep.filter(function (p) { return p !== src; });
            else news = news.filter(function (d) { return d !== src; });
            render();
          };
          box.appendChild(img); box.appendChild(x);
          return box;
        }
        function render() {
          grid.innerHTML = '';
          keep.forEach(function (p) { grid.appendChild(thumb(p, true)); });
          news.forEach(function (d) { grid.appendChild(thumb(d, false)); });
          sync();
        }
        input.addEventListener('change', function () {
          var files = Array.prototype.slice.call(input.files || []);
          var i = 0;
          function next() {
            if (i >= files.length) { input.value = ''; render(); return; }
            var f = files[i++];
            if (f.size > 3 * 1024 * 1024) { alert('图片超过 3MB，已跳过：' + f.name); return next(); }
            var rd = new FileReader();
            rd.onload = function (e) { news.push(e.target.result); next(); };
            rd.readAsDataURL(f);
          }
          next();
        });
        render();
      })();
    </script>
  </div>`;
}

function formPage(ctx, opts) {
  const isEdit = !!(opts && opts.item);
  const s = (opts && opts.item) || {};
  const items = (opts && opts.items) || [];
  const customers = all('SELECT id, company_name FROM customers WHERE user_id=? ORDER BY company_name', ctx.user.id);
  const suppliers = all('SELECT id, name FROM suppliers ORDER BY name LIMIT 200');
  const dir = String(s.direction || ctx.query.dir || 'out');
  const today = todayStr();
  const checkDays = Number(s.check_days || L.DEFAULT_CHECK_DAYS);

  const rows = items.length ? items.map(it => itemRowHtml(it, customers, suppliers)).join('')
    : itemRowHtml({}, customers, suppliers).repeat(2);

  const dirRadios = DIR_OPTS.map(o => `<div class="form-check form-check-inline">
      <input class="form-check-input" type="radio" name="direction" id="dir_${o.v}" value="${o.v}" ${dir === o.v ? 'checked' : ''}>
      <label class="form-check-label" for="dir_${o.v}">${o.l}</label>
    </div>`).join('');

  const content = `
    ${datalists(customers, suppliers)}
    ${pageHead(isEdit ? '编辑运单' : '新建运单', '一张运单 = 一次实际发货；多客户拼在一起就拆成多票，每票填自己的唛头和订单号',
      `<a class="btn btn-outline-secondary" href="${isEdit ? '/logistics/' + s.id : '/logistics'}">返回</a>`)}
    <form method="post" action="${isEdit ? '/logistics/' + s.id + '/edit' : '/logistics/new'}">
      ${card({
        title: '运单信息',
        body: `<div class="row g-3">
          <div class="col-12 col-md-4"><label class="form-label">方向</label><div>${dirRadios}</div></div>
          <div class="col-6 col-md-3">${fld({ label: '运单号', name: 'waybill_no', value: s.waybill_no, placeholder: '快递单号 / 提单号' })}</div>
          <div class="col-6 col-md-5">${fld({ label: '承运商', name: 'carrier', value: s.carrier, placeholder: '顺丰 / DHL / 美森 / 货代名称' })}</div>
          <div class="col-6 col-md-3">${fld({ label: '发货日期', name: 'ship_date', value: (s.ship_date || today).slice(0, 10), type: 'date' })}</div>
          <div class="col-6 col-md-3">${fld({ label: '预计到达', name: 'eta', value: (s.eta || '').slice(0, 10), type: 'date' })}</div>
          <div class="col-6 col-md-3">${fld({ label: '状态', name: 'status', value: s.status || '已下单', type: 'select', options: STATUS_OPTS })}</div>
          <div class="col-6 col-md-3">${fld({ label: '整单参考号', name: 'reference_no', value: s.reference_no, placeholder: '合同号 / 客单号（可空）' })}</div>
          <div class="col-6 col-md-3">${fld({ label: '发货方', name: 'sender_name', value: s.sender_name, placeholder: '供应商 / 我司仓库' })}</div>
          <div class="col-6 col-md-3">${fld({ label: '收货方', name: 'receiver_name', value: s.receiver_name, placeholder: '我司仓库 / 客户' })}</div>
          <div class="col-6 col-md-2">${fld({ label: '运费', name: 'cost', value: s.cost || '', placeholder: '0' })}</div>
          <div class="col-6 col-md-2">${fld({ label: '币种', name: 'currency', value: s.currency || 'CNY', type: 'select', options: [{ v: 'CNY', l: 'CNY' }, { v: 'USD', l: 'USD' }, { v: 'EUR', l: 'EUR' }] })}</div>
          <div class="col-6 col-md-4">${fld({ label: '隔几天提醒我查物流（天）', name: 'check_days', value: String(checkDays), type: 'number', min: 1, help: '到点后会在仪表盘和左侧菜单出现提醒；签收后自动停止' })}</div>
          <div class="col-12">${fld({ label: '备注', name: 'notes', value: s.notes, type: 'textarea', rows: 2, placeholder: '整柜/拼柜、特殊要求等' })}</div>
          ${imagesBlock(s)}
        </div>`
      })}
      ${card({
        title: '分票明细（每个客户 / 订单一行）',
        actions: `<button type="button" class="btn btn-sm btn-outline-primary" onclick="addLgsRow()"><i class="bi bi-plus"></i> 加一行</button>`,
        body: `<div class="table-responsive"><table class="table table-sm align-middle mb-0" id="lgsItems">
          <thead><tr>
            <th style="min-width:150px">客户</th><th style="min-width:130px">供应商</th><th>订单号</th><th>唛头</th>
            <th>品名</th><th style="width:90px">数量</th><th style="width:80px">单位</th><th style="width:80px">箱数</th><th>备注</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div class="form-text mt-2">客户 / 供应商可以<b>直接打字</b>（输入时会自动提示系统里的名字），也可以从提示里选；<b>系统里没有的客户直接写名字就行</b>，会按手填存下来。唛头写客户箱唛，订单号填对应 PI/SO 号。</div>`
      })}
      <div class="d-flex gap-2">
        <button class="btn btn-primary"><i class="bi bi-check-lg"></i> ${isEdit ? '保存修改' : '创建运单'}</button>
        <a class="btn btn-outline-secondary" href="${isEdit ? '/logistics/' + s.id : '/logistics'}">取消</a>
      </div>
    </form>
    <script>
      function addLgsRow() {
        var tb = document.querySelector('#lgsItems tbody');
        var first = tb.querySelector('tr');
        if (!first) return;
        var tr = first.cloneNode(true);
        tr.querySelectorAll('input').forEach(function (i) { i.value = i.name === 'unit' ? 'PCS' : ''; });
        tr.querySelectorAll('select').forEach(function (s) { s.selectedIndex = 0; });
        tb.appendChild(tr);
      }
    </script>`;
  return page({ title: isEdit ? '编辑运单' : '新建运单', active: 'logistics', user: ctx.user, content, flash: ctx.flash() });
}

/* ---------------- 详情 ---------------- */

function detailPage(ctx, s, items, events) {
  const today = todayStr();
  const due = L.dueForCheck(s, today);
  const closed = L.isClosed(s.status);

  const itemsHtml = items.length ? `<div class="table-responsive"><table class="table table-sm align-middle mb-0">
    <thead><tr><th>客户</th><th>供应商</th><th>订单号</th><th>唛头</th><th>品名</th><th>数量</th><th>箱数</th><th>备注</th></tr></thead>
    <tbody>${items.map(i => `<tr>
      <td>${i.customer_id
        ? `<a href="/customers/${i.customer_id}">${esc(i.company_name || '')}</a>`
        : (i.customer_text ? `<span class="badge text-bg-light border">${esc(i.customer_text)}</span> <span class="text-muted" style="font-size:12px">手填</span>` : '<span class="text-muted">—</span>')}</td>
      <td class="small">${i.supplier_id ? esc(i.supplier_name || '')
        : (i.supplier_text ? `${esc(i.supplier_text)} <span class="text-muted" style="font-size:12px">手填</span>` : '<span class="text-muted">—</span>')}</td>
      <td class="small">${esc(i.order_no || '')}</td>
      <td class="small"><code>${esc(i.marks || '')}</code></td>
      <td class="small">${esc(i.description || '')}</td>
      <td class="small">${i.qty ? esc(String(i.qty)) + ' ' + esc(i.unit || '') : ''}</td>
      <td class="small">${i.ctn ? esc(String(i.ctn)) : ''}</td>
      <td class="small text-muted">${esc(i.notes || '')}</td>
    </tr>`).join('')}</tbody></table></div>`
    : '<div class="text-muted small py-3">没有分票明细（只记了运单本身）。</div>';

  const eventHtml = events.length ? events.map(e => `<div class="d-flex gap-2 py-2 border-bottom">
      <div class="text-muted small" style="width:130px;white-space:nowrap">${esc(String(e.at || '').slice(0, 16))}</div>
      <div>${e.status ? statusBadge(e.status) : ''} ${e.location ? `<span class="small">${esc(e.location)}</span>` : ''}
        ${e.note ? `<div class="small text-muted">${esc(e.note)}</div>` : ''}</div>
    </div>`).join('') : '<div class="text-muted small py-3">还没有轨迹。查到物流进度后在这里记一笔。</div>';

  const info = (k, v) => v ? `<div class="mb-1"><span class="text-muted">${k}：</span>${esc(v)}</div>` : '';

  const content = `
    ${pageHead(s.waybill_no || '运单', `${L.DIRECTION[s.direction] || ''} · ${s.carrier || '未填承运商'}`,
      `<a class="btn btn-outline-secondary" href="/logistics?dir=${esc(s.direction)}">返回列表</a>
       <a class="btn btn-outline-primary" href="/logistics/${s.id}/edit">编辑</a>`)}
    ${due ? `<div class="alert alert-warning d-flex align-items-center gap-2">
      <i class="bi bi-bell"></i><div>这票该查物流了（计划查询日 ${esc((s.next_check_at || '').slice(0, 10))}）。
      查到进度后记一笔，提醒会自动往后推 ${Number(s.check_days || 2)} 天。</div>
      <form method="post" action="/logistics/${s.id}/snooze" class="ms-auto d-flex gap-1">
        <button class="btn btn-sm btn-outline-secondary" name="days" value="1">推迟 1 天</button>
        <button class="btn btn-sm btn-outline-secondary" name="days" value="2">推迟 2 天</button>
      </form>
    </div>` : ''}
    <div class="row g-3">
      <div class="col-12 col-xl-4">${card({
        title: '运单信息',
        body: `<div class="small">
          ${info('状态', '')}
          <div class="mb-2">${statusBadge(s.status)} ${dirBadge(s.direction)}</div>
          ${info('承运商', s.carrier)}${info('运单号', s.waybill_no)}
          ${info('发货方', s.sender_name)}${info('收货方', s.receiver_name)}
          ${info('整单参考号', s.reference_no)}
          ${info('发货日期', (s.ship_date || '').slice(0, 10))}${info('预计到达', (s.eta || '').slice(0, 10))}
          ${info('运费', s.cost ? s.cost + ' ' + (s.currency || '') : '')}
          ${info('下次查询', closed ? '已结束，不再提醒' : (s.next_check_at || '').slice(0, 10))}
          ${info('备注', s.notes)}
        </div>
        ${(function () {
          let imgs = [];
          try { imgs = JSON.parse(s.images || '[]') || []; } catch (e) { imgs = []; }
          return imgs.length ? `<div class="mt-2"><div class="text-muted small mb-1">物流单图片（${imgs.length}）</div>
            <div class="d-flex flex-wrap gap-2">${imgs.map(p => `<a href="${esc(p)}" target="_blank" rel="noopener"><img src="${esc(p)}" alt="物流单" style="width:76px;height:76px;object-fit:cover;border-radius:8px;border:1px solid #e3e9f0;background:#fff"></a>`).join('')}</div></div>` : '';
        })()}
        <div class="mt-2 d-flex gap-2 flex-wrap">
          ${s.waybill_no ? `<button class="btn btn-sm btn-outline-secondary" onclick="navigator.clipboard.writeText('${esc(s.waybill_no)}');this.textContent='已复制'">复制单号</button>` : ''}
          <a class="btn btn-sm btn-outline-secondary" href="https://t.17track.net/zh-cn#nums=${encodeURIComponent(s.waybill_no || '')}" target="_blank" rel="noopener">去 17TRACK 查</a>
        </div>`
      })}
      ${card({
        title: '更新进度',
        body: `<form method="post" action="/logistics/${s.id}/event">
          <div class="row g-2">
            <div class="col-6">${fld({ label: '状态', name: 'status', type: 'select', options: STATUS_OPTS, value: s.status })}</div>
            <div class="col-6">${fld({ label: '时间', name: 'at', value: today + ' 00:00', type: 'datetime-local' })}</div>
            <div class="col-12">${fld({ label: '位置 / 节点', name: 'location', placeholder: '如：深圳仓已发出 / 到达洛杉矶港' })}</div>
            <div class="col-12">${fld({ label: '备注', name: 'note', type: 'textarea', rows: 2, placeholder: '查询结果要点、异常说明' })}</div>
          </div>
          <div class="form-text mb-2">记录后：状态会同步到运单，提醒自动往后推 ${Number(s.check_days || 2)} 天；选「已签收」或「已取消」则停止提醒。</div>
          <button class="btn btn-primary btn-sm"><i class="bi bi-check2"></i> 记录一笔</button>
        </form>`
      })}</div>
      <div class="col-12 col-xl-8">
        ${card({ title: '分票明细', body: itemsHtml })}
        ${card({ title: '物流轨迹', body: eventHtml })}
      </div>
    </div>`;
  return page({ title: s.waybill_no || '运单详情', active: 'logistics', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { listPage, formPage, detailPage, dirBadge, statusBadge };
