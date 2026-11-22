// 单据编辑页：明细行（货号搜索添加 / 颜色 / CTN / 每箱QTY / T.T QTY 联动）、客户联系人、供应商/模板切换
(function () {
  'use strict';
  if (!window.__INIT_ITEMS__) return;
  var items = window.__INIT_ITEMS__ || [];
  var PRODS = window.__PRODUCTS__ || [];
  var lastPriceSeq = {};
  var loadLastPriceForItem = function () {};

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function fmtNum(x) { var v = Number(x || 0); return (Math.round(v * 1000) / 1000).toString(); }
  var plOn = false;
  function applyColOrder(pl) {
    var tbl = document.getElementById('docForm');
    if (!tbl) return;
    var ordered = tbl.getAttribute('data-plorder') === '1';
    if (pl === ordered) return;
    var thC = tbl.querySelector('th.colh-ctn'), thP = tbl.querySelector('th.colh-per');
    if (thC && thP) {
      if (pl) thC.parentNode.insertBefore(thP, thC); else thP.parentNode.insertBefore(thC, thP);
    }
    Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
      var c = tr.querySelector('.col-ctn'), p = tr.querySelector('.col-per');
      var cTd = c ? c.parentNode : null, pTd = p ? p.parentNode : null;
      if (cTd && pTd) {
        if (pl) cTd.parentNode.insertBefore(pTd, cTd); else pTd.parentNode.insertBefore(cTd, pTd);
      }
    });
    tbl.setAttribute('data-plorder', pl ? '1' : '0');
  }
  function setPLMode(pl) {
    plOn = pl;
    applyColOrder(pl);
    ['col-color','col-price','col-amt','colh-color','colh-price','colh-amt'].forEach(function (k) {
      Array.prototype.forEach.call(document.querySelectorAll('.' + k), function (el) {
        el.style.display = pl ? 'none' : '';
        var td = el.closest ? el.closest('td') : null;
        if (td && td !== el) td.style.display = pl ? 'none' : '';
      });
    });
    ['col-vol','col-tvol','col-wt','col-tw','colh-vol','colh-tvol','colh-wt','colh-tw'].forEach(function (k) {
      Array.prototype.forEach.call(document.querySelectorAll('.' + k), function (el) {
        el.style.display = pl ? '' : 'none';
        var td = el.closest ? el.closest('td') : null;
        if (td && td !== el) td.style.display = pl ? '' : 'none';
      });
    });
    var hc = document.querySelector('.colh-ctn'); if (hc) hc.textContent = pl ? '装箱数' : 'CTN 箱数';
    var hp = document.querySelector('.colh-per'); if (hp) hp.textContent = pl ? '件数/每箱' : 'QTY 每箱';
    var hq = document.querySelector('.colh-qty'); if (hq) hq.textContent = pl ? '总数量' : 'T.T QTY 总数量';
    var hco = document.querySelector('.colh-color'); if (hco) hco.textContent = pl ? '' : 'COLOR 颜色';
  }
  function money(n) { return num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function curSym() { var sel = document.querySelector('[name=currency]'); return sel ? sel.value : 'USD'; }

  function rowHtml(it, i) {
    return '<tr data-idx="' + i + '">' +
      '<td class="text-center idx">' + (i + 1) + '</td>' +
      '<td class="text-center">' + (it.image ? '<img class="img-preview" src="' + esc(it.image) + '" style="width:46px;height:46px;object-fit:cover;border-radius:6px;border:1px solid #dee2e6;background:#fff" alt="">' : '<i class="bi bi-image text-secondary"></i>') + '</td>' +
      '<td><input class="form-control form-control-sm it-name" value="' + esc(it.name) + '" placeholder="品名">' +
      '<input class="form-control form-control-sm mt-1 it-name_en" value="' + esc(it.name_en || '') + '" placeholder="英文品名"></td>' +
      '<td><input class="form-control form-control-sm it-color col-color" value="' + esc(it.color || '') + '" placeholder="颜色"></td>' +
      '<td><input class="form-control form-control-sm it-model" value="' + esc(it.model || '') + '"></td>' +
      '<td><input class="form-control form-control-sm it-unit" value="' + esc(it.unit || 'PCS') + '"></td>' +
      '<td><input class="form-control form-control-sm it-ctn text-end col-ctn" type="number" min="0" step="any" value="' + esc(it.ctn || '') + '"></td>' +
      '<td><input class="form-control form-control-sm it-per text-end col-per" type="number" min="0" step="any" value="' + esc(it.per_ctn || '') + '"></td>' +
      '<td><input class="form-control form-control-sm it-qty text-end" type="number" min="0" step="any" value="' + esc(it.qty) + '"></td>' +
      '<td><input class="form-control form-control-sm it-volume text-end col-vol" type="number" min="0" step="any" value="' + esc(it.volume || '') + '"></td>' +
      '<td class="text-end align-middle it-tvol col-tvol">0</td>' +
      '<td><input class="form-control form-control-sm it-weight text-end col-wt" type="number" min="0" step="any" value="' + esc(it.weight || '') + '"></td>' +
      '<td class="text-end align-middle it-tw col-tw">0</td>' +
      '<td><input class="form-control form-control-sm it-price text-end col-price' + (it.price_auto ? ' auto-price-filled' : '') + '" type="number" min="0" step="any" placeholder="单价" value="' + (it.price > 0 ? esc(it.price) : '') + '"><div class="last-price-hint small"></div></td>' +
      '<td class="text-end align-middle it-amount fw-semibold col-amt"></td>' +
      '<td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger rm-btn"><i class="bi bi-x-lg"></i></button></td>' +
      '</tr>';
  }

  function dedupePriceCols() {
    var tbl = document.getElementById('docForm'); if (!tbl) return;
    var ths = Array.prototype.slice.call(tbl.querySelectorAll('th.colh-price'));
    for (var k = 1; k < ths.length; k++) { var thP = ths[k].parentNode; if (thP) thP.removeChild(ths[k]); }
    Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
      var cells = Array.prototype.slice.call(tr.querySelectorAll('td .col-price'));
      if (cells.length > 1) { for (var j = 1; j < cells.length; j++) { var inp = cells[j]; var td = inp ? inp.parentNode : null; if (td) td.remove(); } }
    });
  }

  function render() {
    var tbody = document.getElementById('itemTbody');
    if (!tbody) return;
    tbody.innerHTML = items.map(rowHtml).join('');
    dedupePriceCols();
    syncAll();
    renderPriceHints();
    // 行重建后重新应用列显隐（PO/非PO 隐藏体积/重量等列），避免行尾多出输入框
    setPLMode(plOn);
  }
  function rowAmount(it) { return Math.round(num(it.qty) * num(it.price) * 100) / 100; }
  function syncAll() {
    var tbody = document.getElementById('itemTbody');
    if (!tbody) return;
    var total = 0;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      var i = parseInt(tr.getAttribute('data-idx'), 10);
      var it = items[i]; if (!it) return;
      var amt = rowAmount(it);
      tr.querySelector('.it-amount').textContent = curSym() + ' ' + money(amt);
      var tv = tr.querySelector('.it-tvol'); if (tv) tv.textContent = fmtNum(num(it.volume) * num(it.per_ctn));
      var tw = tr.querySelector('.it-tw'); if (tw) tw.textContent = fmtNum(num(it.weight) * num(it.per_ctn));
      total += amt;
    });
    var t = document.getElementById('totalAmount');
    if (t) t.textContent = curSym() + ' ' + money(total);
    Array.prototype.forEach.call(tbody.querySelectorAll('.idx'), function (td, k) { td.textContent = k + 1; });
  }
  function renderPriceHints() {
    var tbody = document.getElementById('itemTbody');
    if (!tbody) return;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      var i = parseInt(tr.getAttribute('data-idx'), 10);
      var it = items[i] || {};
      var box = tr.querySelector('.last-price-hint');
      if (!box) return;
      var info = it.last_price_info;
      if (!info || !info.found) { box.innerHTML = ''; return; }
      var price = num(info.price).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
      var meta = esc(info.currency || '') + ' ' + price + ' · ' + esc(info.doc_no || '') + (info.date ? ' · ' + esc(info.date) : '');
      box.title = '上次卖价 ' + meta;
      if (String(info.currency || '') !== curSym()) {
        box.className = 'last-price-hint small text-warning';
        box.innerHTML = '上次 ' + esc(info.currency || '') + ' ' + price + ' · 币种不同 <button type="button" class="btn btn-link btn-sm p-0 use-last-price" data-idx="' + i + '">填入</button>';
      } else if (it.price_auto) {
        box.className = 'last-price-hint small text-success';
        box.innerHTML = '<i class="bi bi-clock-history me-1"></i>已带入 ' + esc(info.currency || '') + ' ' + price;
      } else {
        box.className = 'last-price-hint small text-muted';
        box.innerHTML = '<i class="bi bi-clock-history me-1"></i>上次 ' + esc(info.currency || '') + ' ' + price;
      }
    });
  }
  function refreshLastPricesForCustomer() {
    var sel = document.getElementById('selCustomer');
    var cid = parseInt(sel && sel.value, 10) || 0;
    Array.prototype.forEach.call(items, function (it, i) {
      if (!it || !it.product_id) return;
      if (it.price_auto) { it.price = ''; it.price_auto = false; }
      it.last_price_info = null;
      lastPriceSeq[i] = (lastPriceSeq[i] || 0) + 1;
    });
    render();
    if (!cid) return;
    Array.prototype.forEach.call(items, function (it, i) {
      if (!it || !it.product_id) return;
      var p = PRODS.filter(function (x) { return Number(x.id) === Number(it.product_id); })[0];
      if (p) loadLastPriceForItem(i, p);
    });
  }
  function applyAutoTotal(it, tr) {
    var ctn = num(it.ctn), per = num(it.per_ctn);
    if (ctn > 0 && per > 0) {
      it.qty = Math.round(ctn * per * 10000) / 10000;
      var q = tr.querySelector('.it-qty');
      if (q) q.value = it.qty;
    }
  }
  function addItemFromProduct(p) {
    // 添加前清理残留的完全空白行（防旧缓存带出的默认空行）
    for (var k = items.length - 1; k >= 0; k--) {
      var e = items[k];
      if (!String(e.name || '').trim() && !String(e.name_en || '').trim() && !String(e.model || '').trim()) items.splice(k, 1);
    }

    var hasBoxCount = p.pcs_per_ctn !== '' && p.pcs_per_ctn !== null && p.pcs_per_ctn !== undefined;
    var hasPackingQty = p.ctn_count !== '' && p.ctn_count !== null && p.ctn_count !== undefined;
    var boxCount = hasBoxCount ? Number(p.pcs_per_ctn) || 0 : '';
    var packingQty = hasPackingQty ? Number(p.ctn_count) || 0 : '';
    var autoQty = (boxCount !== '' && packingQty !== '') ? Math.round(boxCount * packingQty * 10000) / 10000 : 1;
    var newIndex = items.length;
    items.push({
      name: p.name || '', name_en: p.name_en || '', model: p.model || '', color: p.color || '',
      unit: p.unit || 'PCS', ctn: boxCount, per_ctn: packingQty, qty: autoQty, price: '', remark: '',
      product_id: p.id || null, image: p.image || '', volume: p.volume || '', weight: p.weight || '',
      price_auto: false, last_price_info: null,
    });
    render();
    loadLastPriceForItem(newIndex, p);
  }
  function addEmpty() {
    items.push({ name: '', name_en: '', model: '', color: '', unit: 'PCS', ctn: '', per_ctn: '', qty: '', price: 0, remark: '', product_id: null, image: '', volume: '', weight: '' });
    render();
    var tbody = document.getElementById('itemTbody');
    if (tbody) { var last = tbody.querySelector('tr:last-child input.it-name'); if (last) last.focus(); }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var tbody = document.getElementById('itemTbody');
    var form = document.getElementById('docForm');
    if (!tbody || !form) return;
    render();

    tbody.addEventListener('input', function (e) {
      var tr = e.target.closest('tr'); if (!tr) return;
      var i = parseInt(tr.getAttribute('data-idx'), 10);
      var it = items[i]; if (!it) return;
      var cls = e.target.className;
      if (cls.indexOf('it-name') >= 0) it.name = e.target.value;
      else if (cls.indexOf('it-name_en') >= 0) it.name_en = e.target.value;
      else if (cls.indexOf('it-color') >= 0) it.color = e.target.value;
      else if (cls.indexOf('it-model') >= 0) it.model = e.target.value;
      else if (cls.indexOf('it-unit') >= 0) it.unit = e.target.value;
      else if (cls.indexOf('it-ctn') >= 0) { it.ctn = e.target.value; applyAutoTotal(it, tr); }
      else if (cls.indexOf('it-per') >= 0) { it.per_ctn = e.target.value; applyAutoTotal(it, tr); }
      else if (cls.indexOf('it-qty') >= 0) it.qty = e.target.value;
      else if (cls.indexOf('it-volume') >= 0) it.volume = e.target.value;
      else if (cls.indexOf('it-weight') >= 0) it.weight = e.target.value;
      else if (cls.indexOf('it-price') >= 0) { it.price = e.target.value; it.price_auto = false; e.target.classList.remove('auto-price-filled'); renderPriceHints(); }
      else if (cls.indexOf('it-remark') >= 0) it.remark = e.target.value;
      syncAll();
    });
    tbody.addEventListener('click', function (e) {
      var useLast = e.target.closest('.use-last-price');
      if (useLast) {
        var useIdx = parseInt(useLast.getAttribute('data-idx'), 10);
        var useItem = items[useIdx];
        if (useItem && useItem.last_price_info) {
          useItem.price = useItem.last_price_info.price;
          useItem.price_auto = true;
          var useTr = useLast.closest('tr');
          var useInput = useTr ? useTr.querySelector('.it-price') : null;
          if (useInput) { useInput.value = useItem.price; useInput.classList.add('auto-price-filled'); }
          renderPriceHints(); syncAll();
        }
        return;
      }
      var btn = e.target.closest('.rm-btn'); if (!btn) return;
      var tr = btn.closest('tr');
      items.splice(parseInt(tr.getAttribute('data-idx'), 10), 1);
      render();
    });

    var addEmptyBtn = Array.prototype.find.call(document.querySelectorAll('button'), function (b) { return b.textContent.indexOf('添加空行') >= 0; });
    if (addEmptyBtn) addEmptyBtn.addEventListener('click', addEmpty);

    // 按货号搜索添加
    var qi = document.getElementById('quickSearch');
    var ql = document.getElementById('quickList');
    function qMatch(p, q) {
      q = q.toLowerCase();
      return String(p.model || '').toLowerCase().indexOf(q) >= 0 || String(p.name || '').toLowerCase().indexOf(q) >= 0 || String(p.name_en || '').toLowerCase().indexOf(q) >= 0;
    }
    if (qi && ql) {
      qi.addEventListener('input', function () {
        var q = qi.value.trim();
        if (!q) { ql.style.display = 'none'; return; }
        var list = PRODS.filter(function (p) { return qMatch(p, q); }).slice(0, 8);
        if (!list.length) { ql.innerHTML = '<div class="list-group-item text-muted small">未找到，可点“添加空行”手工填写</div>'; }
        else {
          ql.innerHTML = list.map(function (p) {
            return '<a href="javascript:void(0)" class="list-group-item list-group-item-action small" data-id="' + p.id + '"><span class="fw-semibold">' + (p.model ? esc(p.model) + ' — ' : '') + esc(p.name) + '</span>' + (p.name_en ? '<div class="text-muted">' + esc(p.name_en) + '</div>' : '') + '</a>';
          }).join('');
        }
        ql.style.display = 'block';
      });
      ql.addEventListener('click', function (e) {
        var a = e.target.closest('a[data-id]');
        if (!a) return;
        var p = PRODS.filter(function (x) { return x.id === parseInt(a.getAttribute('data-id'), 10); })[0];
        if (p) { addItemFromProduct(p); qi.value = ''; ql.style.display = 'none'; qi.focus(); }
      });
      document.addEventListener('click', function (e) { if (!e.target.closest('#quickSearch,#quickList')) ql.style.display = 'none'; });
    }

    // 按分类查找添加
    var catPicker = document.getElementById('catPicker');
    var catList = document.getElementById('catList');
    if (catPicker && catList) {
      function renderCatList() {
        var cat = catPicker.value;
        if (!cat) { catList.style.display = 'none'; return; }
        var list = PRODS.filter(function (p) { return (String(p.name_en || '').trim() || '__none__') === cat; }).slice(0, 60);
        if (!list.length) catList.innerHTML = '<div class="list-group-item text-muted small">该分类下暂无产品</div>';
        else catList.innerHTML = list.map(function (p) { return '<a href="javascript:void(0)" class="list-group-item list-group-item-action small" data-id="' + p.id + '"><span class="fw-semibold">' + (p.model ? esc(p.model) + ' — ' : '') + esc(p.name) + '</span>' + (p.name_en ? '<div class="text-muted">' + esc(p.name_en) + '</div>' : '') + '</a>'; }).join('');
        catList.style.display = 'block';
      }
      catPicker.addEventListener('change', renderCatList);
      catList.addEventListener('click', function (e) {
        var a = e.target.closest('a[data-id]'); if (!a) return;
        var p = PRODS.filter(function (x) { return x.id === parseInt(a.getAttribute('data-id'), 10); })[0];
        if (p) { addItemFromProduct(p); }
      });
      document.addEventListener('click', function (e) { if (!e.target.closest('#catPicker,#catList')) catList.style.display = 'none'; });
    }
    var custSel = document.getElementById('selCustomer');
    var contactSel = document.getElementById('selContact');

    loadLastPriceForItem = function (idx, product) {
      var customerSelect = document.getElementById('selCustomer');
      var typeSelect = document.querySelector('[name=doc_type]');
      var cid = parseInt(customerSelect && customerSelect.value, 10) || 0;
      if (!cid || !product || !product.id) return;
      if (!typeSelect || typeSelect.value !== 'pi') return;
      var seq = (lastPriceSeq[idx] || 0) + 1;
      lastPriceSeq[idx] = seq;
      var params = new URLSearchParams({ product_id: String(product.id), model: product.model || '', name: product.name || '' });
      if (window.__DOC_ID__) params.set('exclude_doc_id', String(window.__DOC_ID__));
      fetch('/api/customers/' + cid + '/last-price?' + params.toString(), { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (seq !== lastPriceSeq[idx] || !data || !data.ok || !data.found) return;
          var item = items[idx];
          if (!item || Number(item.product_id) !== Number(product.id)) return;
          item.last_price_info = data;
          var tr = document.querySelector('#itemTbody tr[data-idx="' + idx + '"]');
          var priceInput = tr ? tr.querySelector('.it-price') : null;
          var untouched = priceInput && !String(priceInput.value || '').trim() && !num(item.price);
          if (untouched && String(data.currency || '') === curSym()) {
            item.price = data.price;
            item.price_auto = true;
            priceInput.value = data.price;
            priceInput.classList.add('auto-price-filled');
          }
          renderPriceHints();
          syncAll();
        }).catch(function () {});
    };
    var pendingContactId = window.__CONTACT_ID__ || null;
    function loadContacts(cid) {
      if (!cid) { contactSel.innerHTML = '<option value="">— 请先选择客户 —</option>'; return; }
      fetch('/api/customers/' + cid + '/contacts').then(function (r) { return r.json(); }).then(function (list) {
        var html = '<option value="">— 请选择联系人 —</option>';
        list.forEach(function (c) {
          html += '<option value="' + c.id + '">' + esc(c.name) + (c.position ? '（' + esc(c.position) + '）' : '') + '</option>';
        });
        contactSel.innerHTML = html;
        var useId = '';
        if (pendingContactId && list.some(function (c) { return String(c.id) === String(pendingContactId); })) useId = String(pendingContactId);
        else if (list.length) useId = String(list[0].id);
        pendingContactId = null;
        if (useId) contactSel.value = useId;
      }).catch(function () {});
    }
    function syncCustomerSearchBox() {
      var cqs2 = document.getElementById('custQuickSearch');
      if (!custSel || !cqs2) return;
      var cid = String(custSel.value || '');
      var list = window.__CUSTOMERS__ || [];
      var hit = list.filter(function (c) { return String(c.id) === cid; })[0];
      if (hit) cqs2.value = hit.name;
      else if (!cid) cqs2.value = '';
    }
    if (custSel && contactSel) {
      if (window.__CUSTOMER_ID__) loadContacts(window.__CUSTOMER_ID__);
      custSel.addEventListener('change', function () {
        contactSel.innerHTML = '<option value="">— 加载中… —</option>';
        loadContacts(parseInt(custSel.value, 10) || 0);
        syncCustomerSearchBox();
        refreshLastPricesForCustomer();
      });
      syncCustomerSearchBox();
    }

    var typeSel = document.querySelector('[name=doc_type]');
    var tplSel = document.querySelector('[name=template_id]');
    function applyDocType(type) {
      var po = type === 'po';
      var cust = document.getElementById('wrapCustomer');
      var cont = document.getElementById('wrapContact');
      var opp = document.getElementById('wrapOpp');
      var sup = document.getElementById('wrapSupplier');
      if (cust) cust.classList.toggle('d-none', po);
      if (cont) cont.classList.toggle('d-none', po);
      if (opp) opp.classList.toggle('d-none', po);
      if (sup) sup.classList.toggle('d-none', !po);
      var tt = document.getElementById('wrapTradeTerms');
      var plg = document.getElementById('wrapPortLoading');
      var pdt = document.getElementById('wrapPortDestination');
      if (tt) tt.classList.toggle('d-none', po);
      if (plg) plg.classList.toggle('d-none', po);
      if (pdt) pdt.classList.toggle('d-none', po);
      var cs = cust ? cust.querySelector('[name=customer_id]') : null;
      var ss = sup ? sup.querySelector('[name=supplier_id]') : null;
      if (cs) cs.required = !po;
      if (ss) ss.required = po;
    }
    if (typeSel) setPLMode(typeSel.value === 'pl');
    var currencySel = document.querySelector('[name=currency]');
    if (currencySel) currencySel.addEventListener('change', function () {
      items.forEach(function (it) {
        if (it && it.price_auto && it.last_price_info && String(it.last_price_info.currency || '') !== curSym()) {
          it.price = '';
          it.price_auto = false;
        }
      });
      render();
    });
    if (typeSel && tplSel) {
      typeSel.addEventListener('change', function () {
        applyDocType(typeSel.value);
        setPLMode(typeSel.value === 'pl');
        if (typeSel.value === 'pi') refreshLastPricesForCustomer();
        else items.forEach(function (it) { if (it && it.price_auto) { it.price = ''; it.price_auto = false; } });
        render();
        fetch('/api/templates?doc_type=' + encodeURIComponent(typeSel.value))
          .then(function (r) { return r.json(); })
          .then(function (list) {
            var html = '';
            list.forEach(function (t) { html += '<option value="' + t.id + '">' + (t.is_system ? '[系统] ' : '[自定义] ') + esc(t.name) + '</option>'; });
            tplSel.innerHTML = html;
          }).catch(function () {});
      });
    }


    // 客户搜索选中 / 新建（新建单据）
    var custData = window.__CUSTOMERS__ || [];
    var cqs = document.getElementById('custQuickSearch');
    var cql = document.getElementById('custQuickList');
    var selCust = document.getElementById('selCustomer');
    if (cqs && cql && selCust) {
      function cMatch(c, q) { q = q.toLowerCase(); return String(c.name || '').toLowerCase().indexOf(q) >= 0 || String(c.name_en || '').toLowerCase().indexOf(q) >= 0 || String(c.country || '').toLowerCase().indexOf(q) >= 0; }
      cqs.addEventListener('input', function () {
        var q = cqs.value.trim();
        if (!q) { cql.style.display = 'none'; return; }
        var list = custData.filter(function (c) { return cMatch(c, q); }).slice(0, 8);
        var html = '';
        if (!list.length) html = '<div class="list-group-item text-muted small">未找到该客户</div>';
        else html = list.map(function (c) { return '<a href="javascript:void(0)" class="list-group-item list-group-item-action small" data-cid="' + c.id + '"><span class="fw-semibold">' + esc(c.name) + '</span>' + (c.country ? ' <span class="text-muted">(' + esc(c.country) + ')</span>' : '') + '</a>'; }).join('');
        html += '<a href="javascript:void(0)" class="list-group-item list-group-item-action small text-primary" data-newcust="' + esc(q) + '"><i class="bi bi-plus-lg me-1"></i>用「' + esc(q) + '」新建客户</a>';
        cql.innerHTML = html; cql.style.display = 'block';
      });
      cql.addEventListener('click', function (e) {
        // 手填名字直接建档（不跳页面）
        var nw = e.target.closest('a[data-newcust]');
        if (nw) {
          var nm = nw.getAttribute('data-newcust');
          nw.textContent = '正在新建…';
          fetch('/api/quick-entity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'kind=customer&name=' + encodeURIComponent(nm)
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.ok) { alert((d && d.error) || '新建失败'); return; }
            var opt = document.createElement('option');
            opt.value = String(d.id); opt.textContent = d.name;
            selCust.appendChild(opt);
            custData.push({ id: d.id, name: d.name, country: '' });
            selCust.value = String(d.id);
            cqs.value = d.name;
            cql.style.display = 'none';
            selCust.dispatchEvent(new Event('change'));
          }).catch(function () { alert('新建失败，请检查网络'); });
          return;
        }
        var a = e.target.closest('a[data-cid]'); if (!a) return;
        var id = String(a.getAttribute('data-cid'));
        var c = custData.filter(function (x) { return String(x.id) === id; })[0];
        if (c) { selCust.value = id; cqs.value = c.name; cql.style.display = 'none'; selCust.dispatchEvent(new Event('change')); }
      });
      document.addEventListener('click', function (e) { if (!e.target.closest('#custQuickSearch,#custQuickList')) cql.style.display = 'none'; });
      var curCid = String(selCust.value || '');
      if (curCid) { var c0 = custData.filter(function (x) { return String(x.id) === curCid; })[0]; if (c0) cqs.value = c0.name; }
    }

    // 供应商：手填名字直接建档
    (function () {
      var link = document.getElementById('supQuickAdd');
      var sel = document.getElementById('selSupplier');
      if (!link || !sel) return;
      link.addEventListener('click', function () {
        var name = window.prompt('输入供应商名称（不存在会自动创建）');
        if (!name || !name.trim()) return;
        link.textContent = '正在新建…';
        fetch('/api/quick-entity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'kind=supplier&name=' + encodeURIComponent(name.trim())
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.ok) { alert((d && d.error) || '新建失败'); link.textContent = '＋ 系统里没有？手填名字新建供应商'; return; }
          var opt = document.createElement('option');
          opt.value = String(d.id); opt.textContent = d.name;
          sel.appendChild(opt); sel.value = String(d.id);
          link.innerHTML = '<i class="bi bi-check2"></i> 已选：' + esc(d.name);
        }).catch(function () { alert('新建失败，请检查网络'); });
      });
    })();

    form.addEventListener('submit', function (e) {
      var rows = tbody.querySelectorAll('tr');
      var finalItems = [];
      Array.prototype.forEach.call(rows, function (tr) {
        var i = parseInt(tr.getAttribute('data-idx'), 10);
        var base = items[i] || {};
        var g = function (cls) { var el = tr.querySelector('.' + cls); return el ? el.value : ''; };
        finalItems.push({
          name: g('it-name'), name_en: g('it-name_en'), color: g('it-color'), model: g('it-model'),
          unit: g('it-unit') || 'PCS', ctn: g('it-ctn'), per_ctn: g('it-per'), qty: g('it-qty'),
          volume: g('it-volume'), weight: g('it-weight'), price: g('it-price'), remark: g('it-remark'),
          product_id: base.product_id || null, image: base.image || ''
        });
      });
      var valid = finalItems.filter(function (it) { return (it.name || '').trim(); });
      if (!finalItems.length) { alert('请至少填写一行商品明细'); e.preventDefault(); return; }
      if (!valid.length) { alert('请至少填写一行有效的商品明细（品名）'); e.preventDefault(); return; }
      document.getElementById('items_json').value = JSON.stringify(finalItems);
    });
  });

  window.addItem = function () { addEmpty(); };
  window.removeItem = function (btn) {
    var tr = btn.closest('tr'); if (!tr) return;
    items.splice(parseInt(tr.getAttribute('data-idx'), 10), 1);
    render();
  };
})();

