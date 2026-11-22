// 历史报价表单：客户搜索、产品分类/货号搜索、多产品添加、出厂价与毛利
(function () {
  var cfg = window.__QUOTE_DATA__ || {};
  var products = cfg.products || {};
  var customers = cfg.customers || [];
  var contacts = cfg.contacts || {};

  function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (x) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[x]; }); }
  function productLabel(p) { return (p.model ? p.model + ' · ' : '') + (p.name || '') + (p.name_en ? ' / ' + p.name_en : ''); }
  function numberValue(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function money(v) { return numberValue(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }
  function upperCurrency(v) { return String(v || 'USD').trim().toUpperCase(); }
  function productCurrency(p) { return upperCurrency(p.cost_currency || p.currency || 'USD'); }
  function productImage(p) { return String(p.image || '').trim(); }

  var productSearch = document.getElementById('quoteProductSearch');
  var productHidden = document.getElementById('quoteProduct');
  var productPanel = document.getElementById('quoteProductPanel');
  var category = document.getElementById('quoteCategory');
  var modelSearch = document.getElementById('quoteModelSearch');
  var productResults = document.getElementById('quoteProductResults');
  var productCount = document.getElementById('quoteProductCount');
  var customerSearch = document.getElementById('quoteCustomerSearch');
  var customerHidden = document.getElementById('quoteCustomer');
  var customerList = document.getElementById('quoteCustomerList');
  var contact = document.getElementById('quoteContact');
  var itemsBody = document.getElementById('quoteItemsBody');
  var itemsJson = document.getElementById('quoteItemsJson');
  var totalEl = document.getElementById('quoteTotal');
  var profitSummary = document.getElementById('quoteProfitSummary');
  var currency = document.getElementById('quoteCurrency');
  var referenceCustomer = document.getElementById('quoteReferenceCustomer');
  var referenceProducts = document.getElementById('quoteReferenceProducts');
  var referenceCount = document.getElementById('quoteReferenceCount');
  var referenceTotal = document.getElementById('quoteReferenceTotal');
  var selectedItems = [];
  try { selectedItems = JSON.parse(itemsJson.value || '[]'); } catch (e) { selectedItems = []; }
  if (!Array.isArray(selectedItems)) selectedItems = [];

  function supplierFactoryPrices(p) {
    var list = [];
    if (numberValue(p.cost_price) > 0) {
      list.push({ price: numberValue(p.cost_price), currency: productCurrency(p), supplier_name: '产品档案', source: 'cost' });
    }
    var rows = Array.isArray(p.factory_quotes) ? p.factory_quotes : [];
    rows.forEach(function (q) {
      var price = numberValue(q.price);
      if (price <= 0) return;
      list.push({
        price: price,
        currency: upperCurrency(q.currency || 'CNY'),
        supplier_name: String(q.supplier_name || '供应商'),
        supplier_id: Number(q.supplier_id) || 0,
        model: String(q.supplier_model || ''),
        source: 'supplier'
      });
    });
    return list;
  }

  function bestFactoryPrices(p) {
    var map = {};
    supplierFactoryPrices(p).forEach(function (q) {
      var key = q.currency;
      if (!map[key] || q.price < map[key].price) map[key] = q;
    });
    return Object.keys(map).map(function (key) { return map[key]; }).sort(function (a, b) {
      return a.currency === productCurrency(p) ? -1 : (b.currency === productCurrency(p) ? 1 : a.currency.localeCompare(b.currency));
    });
  }

  function factoryCostHtml(p, selected) {
    var prices = bestFactoryPrices(p);
    if (!prices.length) {
      var supplier = String(p.primary_supplier_name || '').trim();
      return '<span class="quote-cost-missing"><i class="bi bi-exclamation-circle me-1"></i>' + (supplier ? '缺出厂价 · ' + escHtml(supplier) : '未录入出厂价') + '</span>';
    }
    var html = prices.slice(0, 2).map(function (q) {
      return '<span class="quote-cost-badge"><b>' + escHtml(q.currency) + ' ' + money(q.price) + '</b><span class="quote-cost-source">' + escHtml(q.supplier_name) + '</span></span>';
    }).join('');
    if (prices.length > 2) html += '<span class="quote-cost-more">+' + (prices.length - 2) + ' 个币种</span>';
    return html;
  }

  function lastQuoteHtml(p) {
    var q = p.last_quote;
    if (!q || numberValue(q.unit_price) <= 0) return '';
    return '<span class="quote-last-price"><i class="bi bi-clock-history me-1"></i>上次 ' + escHtml(upperCurrency(q.currency)) + ' ' + money(q.unit_price) + (q.quote_date ? ' · ' + escHtml(String(q.quote_date).slice(0, 10)) : '') + '</span>';
  }

  function costForQuote(item, quoteCurrency) {
    var candidates = supplierFactoryPrices(item);
    var wanted = upperCurrency(quoteCurrency);
    var same = candidates.filter(function (q) { return q.currency === wanted; }).sort(function (a, b) { return a.price - b.price; });
    return same[0] || candidates[0] || null;
  }

  function costLineHtml(item) {
    var q = costForQuote(item, currency.value);
    if (!q) {
      var supplier = String(item.primary_supplier_name || '').trim();
      var supplierId = Number(item.supplier_id) || 0;
      var target = supplierId ? '/suppliers/' + supplierId + '/products/new?product_id=' + encodeURIComponent(item.product_id) : '/suppliers';
      return '<span class="quote-cost-missing">' + (supplier ? '缺出厂价 · ' + escHtml(supplier) : '未录入出厂价') + '</span>'
        + '<a href="' + target + '" target="_blank" rel="noopener" class="quote-fill-cost">' + (supplierId ? '补录出厂价' : '关联供应商') + '</a>';
    }
    return '<span class="quote-cost-badge"><b>成本 ' + escHtml(q.currency) + ' ' + money(q.price) + '</b><span class="quote-cost-source">' + escHtml(q.supplier_name) + '</span></span>';
  }

  function marginInfo(item) {
    var q = costForQuote(item, currency.value);
    if (!q) return { kind: 'missing', text: '待补成本' };
    var quoteCurrency = upperCurrency(currency.value);
    if (q.currency !== quoteCurrency) return { kind: 'mismatch', text: '成本 ' + q.currency + '，需换算' };
    var price = numberValue(item.unit_price);
    if (price <= 0) return { kind: 'muted', text: '待填报价' };
    var profit = price - q.price;
    var pct = price > 0 ? profit / price * 100 : 0;
    return {
      kind: profit >= 0 ? 'good' : 'bad',
      text: (profit >= 0 ? '毛利 ' : '亏损 ') + pct.toFixed(1) + '%',
      sub: (profit >= 0 ? '+' : '') + q.currency + ' ' + money(profit)
    };
  }
  function marginHtml(item) {
    var m = marginInfo(item);
    return '<span class="quote-margin quote-margin-' + m.kind + '">' + escHtml(m.text) + (m.sub ? '<small>' + escHtml(m.sub) + '</small>' : '') + '</span>';
  }

  function renderReference() {
    if (referenceCustomer) {
      var selectedCustomer = customers.find(function (row) { return String(row.id) === String(customerHidden.value); });
      if (!selectedCustomer) {
        referenceCustomer.innerHTML = '<span class="text-muted">选择客户后显示客户档案信息</span>';
      } else {
        referenceCustomer.innerHTML = '<strong>' + escHtml(selectedCustomer.name || '') + '</strong>'
          + (selectedCustomer.name_en ? '<span>' + escHtml(selectedCustomer.name_en) + '</span>' : '')
          + '<span>' + escHtml(selectedCustomer.country || '国家/地区未填写') + '</span>'
          + (selectedCustomer.status ? '<span class="quote-reference-state">' + escHtml(selectedCustomer.status) + '</span>' : '')
          + (selectedCustomer.contact_person ? '<span><i class="bi bi-person me-1"></i>' + escHtml(selectedCustomer.contact_person) + '</span>' : '')
          + (selectedCustomer.whatsapp ? '<span><i class="bi bi-whatsapp me-1"></i>' + escHtml(selectedCustomer.whatsapp) + '</span>' : '')
          + (selectedCustomer.email ? '<span><i class="bi bi-envelope me-1"></i>' + escHtml(selectedCustomer.email) + '</span>' : '')
          + '<a href="/customers/' + Number(selectedCustomer.id) + '" target="_blank" rel="noopener">查看客户档案 <i class="bi bi-arrow-up-right"></i></a>';
      }
    }
    if (!referenceProducts) return;
    var total = selectedItems.reduce(function (sum, item) { return sum + numberValue(item.quantity) * numberValue(item.unit_price); }, 0);
    if (referenceCount) referenceCount.textContent = selectedItems.length + ' 款';
    if (referenceTotal) referenceTotal.textContent = upperCurrency(currency.value) + ' ' + money(total);
    if (!selectedItems.length) {
      referenceProducts.innerHTML = '<span class="text-muted">选择产品后显示供应商报价与历史报价</span>';
      return;
    }
    referenceProducts.innerHTML = selectedItems.map(function (item) {
      var costRows = supplierFactoryPrices(item).slice(0, 4).map(function (quote) {
        return '<div class="quote-reference-price-row"><span>' + escHtml(quote.supplier_name || '供应商') + '</span><b>' + escHtml(quote.currency) + ' ' + money(quote.price) + '</b></div>';
      }).join('') || '<div class="quote-reference-empty">没有录入出厂价</div>';
      var last = item.last_quote;
      var history = last && numberValue(last.unit_price) > 0
        ? '<div class="quote-reference-history"><i class="bi bi-clock-history me-1"></i>上次成交/报价 ' + escHtml(upperCurrency(last.currency)) + ' ' + money(last.unit_price) + (last.quote_date ? ' · ' + escHtml(String(last.quote_date).slice(0, 10)) : '') + '</div>'
        : '<div class="quote-reference-empty">没有历史报价</div>';
      return '<div class="quote-reference-product">'
        + '<div class="quote-reference-product-head"><span class="quote-item-thumb">' + (productImage(item) ? '<img src="' + escHtml(productImage(item)) + '" alt="">' : '<i class="bi bi-image"></i>') + '</span><span><strong>' + escHtml(item.product_name || '') + '</strong><small>' + escHtml(item.model || '') + '</small></span></div>'
        + '<div class="quote-reference-label">供应商报价</div>' + costRows + history + '</div>';
    }).join('');
  }

  function sync() {
    if (!selectedItems.length) productHidden.value = '';
    else productHidden.value = String(selectedItems[0].product_id || '');
    itemsJson.value = JSON.stringify(selectedItems);
    var total = selectedItems.reduce(function (s, it) { return s + (numberValue(it.quantity) || 0) * (numberValue(it.unit_price) || 0); }, 0);
    totalEl.textContent = (Math.round(total * 10000) / 10000).toFixed(2);
    if (selectedItems.length) productSearch.value = '已选择 ' + selectedItems.length + ' 款产品，可继续添加';

    var knownCost = 0;
    var hasCost = false;
    var comparable = true;
    selectedItems.forEach(function (it) {
      var q = costForQuote(it, currency.value);
      if (!q) return;
      hasCost = true;
      if (q.currency !== upperCurrency(currency.value)) comparable = false;
      else knownCost += numberValue(it.quantity) * q.price;
    });
    if (profitSummary) {
      if (!selectedItems.length) profitSummary.textContent = '选择产品后计算预估毛利';
      else if (!hasCost) profitSummary.textContent = '未录入可计算的出厂价';
      else if (!comparable) profitSummary.textContent = '部分成本币种不同，请统一币种后计算毛利';
      else {
        var profit = total - knownCost;
        var pct = total > 0 ? profit / total * 100 : 0;
        profitSummary.textContent = '预估毛利 ' + upperCurrency(currency.value) + ' ' + money(profit) + ' · ' + pct.toFixed(1) + '%';
        profitSummary.className = 'small mt-1 ' + (profit >= 0 ? 'text-success' : 'text-danger');
      }
    }
    renderReference();
    var rows = itemsBody.querySelectorAll('tr[data-i]');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var idx = parseInt(row.getAttribute('data-i'), 10);
      var item = selectedItems[idx];
      if (!item) continue;
      var amountCell = row.querySelector('[data-role="amount"]');
      var marginCell = row.querySelector('[data-role="margin"]');
      if (amountCell) amountCell.textContent = money(numberValue(item.quantity) * numberValue(item.unit_price));
      if (marginCell) marginCell.innerHTML = marginHtml(item);
    }
  }

  function renderItems() {
    itemsBody.innerHTML = selectedItems.map(function (it, i) {
      var amount = numberValue(it.quantity) * numberValue(it.unit_price);
      var last = it.last_quote;
      var lastBtn = last && numberValue(last.unit_price) > 0
        ? '<button type="button" class="btn btn-link btn-sm p-0 qi-use-last" data-price="' + numberValue(last.unit_price) + '" data-currency="' + escHtml(upperCurrency(last.currency)) + '">用上次价 ' + escHtml(upperCurrency(last.currency)) + ' ' + money(last.unit_price) + '</button>'
        : '';
      return '<tr data-i="' + i + '">'
        + '<td><div class="quote-selected-product">'
        + '<span class="quote-item-thumb">' + (productImage(it) ? '<img src="' + escHtml(productImage(it)) + '" alt="">' : '<i class="bi bi-image"></i>') + '</span>'
        + '<span class="min-w-0"><span class="quote-selected-name">' + escHtml(it.product_name) + '</span>'
        + '<span class="quote-selected-meta">' + escHtml(it.model || '') + (it.product_name_en ? ' · ' + escHtml(it.product_name_en) : '') + '</span>'
        + '<span class="quote-selected-cost">' + costLineHtml(it) + lastBtn + '</span></span></div></td>'
        + '<td><input type="number" min="0" step="any" class="form-control form-control-sm qi-qty" value="' + (numberValue(it.quantity) || 0) + '"></td>'
        + '<td>' + escHtml(it.unit || 'PCS') + '</td>'
        + '<td><input type="number" min="0" step="0.0001" class="form-control form-control-sm qi-price" value="' + (numberValue(it.unit_price) || 0) + '"></td>'
        + '<td>' + escHtml(it.currency || currency.value) + '</td>'
        + '<td data-role="margin">' + marginHtml(it) + '</td>'
        + '<td class="text-end fw-semibold" data-role="amount">' + money(amount) + '</td>'
        + '<td><button type="button" class="btn btn-sm btn-outline-danger qi-remove" title="移除"><i class="bi bi-x-lg"></i></button></td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="8" class="text-center text-muted py-4">还没有产品，请点击上方产品框选择添加</td></tr>';
    sync();
  }

  function addProduct(p) {
    var idx = selectedItems.findIndex(function (x) { return String(x.product_id) === String(p.id); });
    if (idx >= 0) { selectedItems.splice(idx, 1); renderItems(); renderProducts(); productPanel.style.display = 'block'; return; }
    if (selectedItems.length && currency.value && p.currency && String(p.currency).toUpperCase() !== String(currency.value).toUpperCase()) {
      alert('同一张报价只能使用一种币种。该产品为 ' + p.currency + '，当前报价为 ' + currency.value);
      return;
    }
    if (!selectedItems.length && p.currency) currency.value = String(p.currency).toUpperCase();
    selectedItems.push({
      product_id: p.id,
      product_name: p.name || '',
      product_name_en: p.name_en || '',
      model: p.model || '',
      unit: p.unit || 'PCS',
      quantity: 1,
      unit_price: numberValue(p.price),
      currency: upperCurrency(p.currency || currency.value || 'USD'),
      amount: 0,
      image: productImage(p),
      cost_price: numberValue(p.cost_price),
      cost_currency: productCurrency(p),
      factory_quotes: Array.isArray(p.factory_quotes) ? p.factory_quotes : [],
      primary_supplier_name: p.primary_supplier_name || '',
      supplier_id: p.supplier_id || 0,
      last_quote: p.last_quote || null
    });
    renderItems(); renderProducts(); productPanel.style.display = 'block';
  }

  function renderCustomers() {
    var q = customerSearch.value.trim().toLowerCase();
    var list = customers.filter(function (x) { return !q || x.name.toLowerCase().indexOf(q) >= 0 || (x.name_en || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 30);
    customerList.innerHTML = list.map(function (x) { return '<button type="button" class="list-group-item list-group-item-action" data-id="' + x.id + '"><div class="fw-semibold">' + escHtml(x.name) + '</div><div class="small text-muted">' + escHtml(x.name_en || '') + (x.country ? ' · ' + escHtml(x.country) : '') + '</div></button>'; }).join('') || '<div class="list-group-item text-muted">没有匹配客户</div>';
    customerList.style.display = 'block';
  }

  function productScore(p, q) {
    if (!q) return 0;
    var model = String(p.model || '').toLowerCase();
    var name = String(p.name || '').toLowerCase();
    var en = String(p.name_en || '').toLowerCase();
    if (model === q) return 0;
    if (model.indexOf(q) === 0) return 1;
    if (model.indexOf(q) >= 0) return 2;
    if (name.indexOf(q) >= 0 || en.indexOf(q) >= 0) return 3;
    return 99;
  }

  function renderProducts() {
    var key = category.value;
    var q = modelSearch.value.trim().toLowerCase();
    var all = Object.keys(products).map(function (k) { return products[k]; });
    var list = all.filter(function (p) {
      var cat = String(p.name_en || '').trim() || '__none__';
      if (key && cat !== key) return false;
      if (q && productScore(p, q) >= 99) return false;
      return true;
    }).sort(function (a, b) {
      var scoreDiff = productScore(a, q) - productScore(b, q);
      if (scoreDiff) return scoreDiff;
      return String(a.model || a.name || '').localeCompare(String(b.model || b.name || ''));
    }).slice(0, 200);
    if (productCount) productCount.textContent = '显示 ' + list.length + ' 款 / 共 ' + all.length + ' 款' + (q ? ' · 货号精确匹配优先' : '');
    productResults.innerHTML = list.map(function (p) {
      var on = selectedItems.some(function (x) { return String(x.product_id) === String(p.id); });
      var img = productImage(p);
      var listPrice = numberValue(p.price) > 0 ? escHtml(upperCurrency(p.currency)) + ' ' + money(p.price) : '未设默认价';
      return '<button type="button" class="list-group-item list-group-item-action quote-product-result' + (on ? ' active' : '') + '" data-id="' + p.id + '">'
        + '<span class="quote-product-thumb">' + (img ? '<img src="' + escHtml(img) + '" loading="lazy" alt="">' : '<i class="bi bi-image"></i>') + '</span>'
        + '<span class="quote-product-main">'
        + '<span class="quote-product-title"><b>' + escHtml(p.model || '-') + '</b><span>' + escHtml(p.name || '') + '</span></span>'
        + '<span class="quote-product-en">' + escHtml(p.name_en || '') + '</span>'
        + '<span class="quote-product-tags">' + factoryCostHtml(p, on) + lastQuoteHtml(p) + '</span>'
        + '</span>'
        + '<span class="quote-product-side"><span class="quote-reference-price">参考 ' + listPrice + '</span><span class="quote-stock">库存 ' + numberValue(p.stock).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '</span><span class="quote-add-label">' + (on ? '已添加' : '+ 添加') + '</span></span>'
        + '</button>';
    }).join('') || '<div class="list-group-item text-muted py-4 text-center">没有匹配产品，请切换英文品名分类或检查货号</div>';
  }
  customerSearch.addEventListener('focus', renderCustomers);
  customerSearch.addEventListener('input', function () { customerHidden.value = ''; renderCustomers(); });
  customerList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-id]'); if (!btn) return;
    var id = btn.getAttribute('data-id');
    var x = customers.find(function (c) { return String(c.id) === String(id); });
    customerHidden.value = id;
    customerSearch.value = x ? x.name + (x.name_en ? ' / ' + x.name_en : '') : '';
    customerList.style.display = 'none';
    if (contacts[id]) contact.value = contacts[id];
    renderReference();
  });
  productSearch.addEventListener('focus', function () { productPanel.style.display = 'block'; renderProducts(); });
  productSearch.addEventListener('input', function () { category.value = ''; modelSearch.value = productSearch.value; productPanel.style.display = 'block'; renderProducts(); });
  category.addEventListener('change', renderProducts);
  modelSearch.addEventListener('input', renderProducts);
  productResults.addEventListener('click', function (e) {
    e.stopPropagation();
    var btn = e.target.closest('[data-id]'); if (!btn) return;
    var p = products[btn.getAttribute('data-id')]; if (p) addProduct(p);
  });
  itemsBody.addEventListener('input', function (e) {
    var row = e.target.closest('tr[data-i]'); if (!row) return;
    var i = parseInt(row.getAttribute('data-i'), 10);
    if (e.target.classList.contains('qi-qty')) selectedItems[i].quantity = numberValue(e.target.value);
    if (e.target.classList.contains('qi-price')) selectedItems[i].unit_price = numberValue(e.target.value);
    sync();
  });
  itemsBody.addEventListener('click', function (e) {
    var lastBtn = e.target.closest('.qi-use-last');
    if (lastBtn) {
      var lastRow = lastBtn.closest('tr[data-i]');
      var lastIndex = parseInt(lastRow.getAttribute('data-i'), 10);
      var lastCurrency = upperCurrency(lastBtn.getAttribute('data-currency'));
      if (lastCurrency !== upperCurrency(currency.value)) {
        alert('上次报价币种为 ' + lastCurrency + '，当前报价币种为 ' + upperCurrency(currency.value) + '，请先切换币种。');
        return;
      }
      selectedItems[lastIndex].unit_price = numberValue(lastBtn.getAttribute('data-price'));
      renderItems();
      return;
    }
    var btn = e.target.closest('.qi-remove'); if (!btn) return;
    var row = btn.closest('tr[data-i]');
    var i = parseInt(row.getAttribute('data-i'), 10);
    selectedItems.splice(i, 1);
    renderItems(); renderProducts();
  });
  currency.addEventListener('change', function () {
    selectedItems.forEach(function (it) { it.currency = upperCurrency(currency.value); });
    renderItems();
  });
  if (customerSearch.value && customerHidden.value) renderReference();
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#quoteProductSearch') && !e.target.closest('#quoteProductPanel')) productPanel.style.display = 'none';
    if (!e.target.closest('#quoteCustomerSearch') && !e.target.closest('#quoteCustomerList')) customerList.style.display = 'none';
  });
  renderItems();
})();
