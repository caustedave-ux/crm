'use strict';
/** 获客工作台地图采集单屏：多关键词提交建批次、2 秒轮询批次、右侧 AI 执行流、
 * 底部关键词时间线、地图打点 + 地点搜索。
 * 后端契约：POST /api/maps/search {keywords:[...]} → {ok:true, batch_id, task_ids}；
 * GET /api/batches/:id → {ok:true, batch, tasks, leads_count}；
 * GET /api/batches/latest → {ok:true, batch|null}。
 * 地图：Google Maps JS 由服务端代理端点 /maps-js 提供（Key 不进页面源码，
 * callback=initMapsSuite，后端在 URL 上加 &libraries=places）；脚本加载失败
 * （google 未定义）时降级只显示列表，不阻塞采集（#mapsMapFallback）。
 * 地图中心用服务端定位到的城市坐标（任务的 center_lat/center_lng），不再让浏览器
 * 端 Geocoder 重算一次。
 * 兼容兜底：若后端批次接口尚未就绪、POST 只返回旧的 {task_id}，则按单任务适配
 * 显示（GET /api/tasks/:id），时间线文案注明“单任务兼容显示”；批次接口就绪后
 * 走主链路。本文件不编造任何数据：调用日志只写各任务 calls 的真实计数，
 * 不写单条请求的耗时与状态码。 */
(function(){
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtMMSS(secs){
    secs = Math.max(0, Math.floor(Number(secs) || 0));
    var m = Math.floor(secs / 60), s = secs % 60;
    return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
  }
  function elapsedSecs(startedISO, finishedISO){
    if (!startedISO) return null;
    var end = finishedISO ? new Date(finishedISO) : new Date();
    return Math.max(0, Math.round((end - new Date(startedISO)) / 1000));
  }
  function statusCn(status){
    return { queued: '排队中', running: '采集中', organizing: 'AI 整理中', enriching: 'AI 整理中', done: '已完成', failed: '失败' }[status] || String(status || '—');
  }
  function badgeClass(status){
    return { queued: 'secondary', running: 'info', organizing: 'warning', enriching: 'warning', done: 'success', failed: 'danger' }[status] || 'secondary';
  }
  function taskBadge(status){
    return '<span class="badge bg-' + badgeClass(status) + '">' + esc(statusCn(status)) + '</span>';
  }
  function leadStatusBadge(status){
    if (status === 'new') return '<span class="badge bg-success">新增</span>';
    if (status === 'duplicate') return '<span class="badge bg-secondary">重复</span>';
    if (status === 'failed') return '<span class="badge bg-danger">失败</span>';
    return '<span class="badge bg-secondary">' + esc(status || '—') + '</span>';
  }
  // 预估调用量（与服务端 places.js 的 estimateCalls 同一套算法，不发请求）：
  // 搜索每页 20 家 → ceil(条数/20) 次；详情每家 1 次；填了半径且有城市才定位 1 次（整批共 1 次）。
  function estimatePerKeyword(maxResults, radius, hasLocation){
    var search = Math.max(1, Math.ceil(maxResults / 20));
    return { geocode: (radius && hasLocation) ? 1 : 0, search: search, details: maxResults, per: search + maxResults };
  }
  function parseKeywords(text){
    var seen = {}, out = [];
    String(text || '').split(/\r?\n/).forEach(function(line){
      var k = line.trim();
      if (k && !seen[k]) { seen[k] = true; out.push(k); }
    });
    return out;
  }
  function isTerminalBatch(batch, tasks){
    if (batch && (batch.status === 'done' || batch.status === 'failed')) return true;
    if (tasks && tasks.length) return tasks.every(function(t){ return t.status === 'done' || t.status === 'failed'; });
    return false;
  }

  // ── 地图（Google Maps JS API 回调；失败时 window.google 不存在，直接降级）──
  var map = null, markers = [], markerByKey = {}, infoWindows = [], circle = null;
  var mapReady = false, pendingBatch = null, mapFitted = false, autocompleteReady = false;
  window.initMapsSuite = function(){
    try {
      if (!window.google || !google.maps) return;
      map = new google.maps.Map(document.getElementById('mapsMap'), { center: { lat: 20, lng: 0 }, zoom: 2 });
      mapReady = true;
      setupPlaceSearch();
      if (pendingBatch) applyBatchToMap(pendingBatch);
    } catch (e) {
      var fb = document.getElementById('mapsMapFallback');
      if (fb) fb.style.display = 'block';
    }
  };
  // 地图脚本加载失败的兜底：5 秒后 google 仍不存在，显示降级提示（列表照常）。
  setTimeout(function(){
    if (!mapReady) {
      var fb = document.getElementById('mapsMapFallback');
      var note = document.getElementById('mapsMapNote');
      if (fb && window.google === undefined) { fb.style.display = 'block'; }
      if (note && !mapReady) note.textContent = '地图未加载，仅显示列表';
    }
  }, 5000);

  function batchCenter(batch){
    if (!batch || !Array.isArray(batch.tasks)) return null;
    for (var i = 0; i < batch.tasks.length; i++) {
      var t = batch.tasks[i];
      if (t && t.center_lat != null && t.center_lng != null) {
        return { lat: Number(t.center_lat), lng: Number(t.center_lng) };
      }
    }
    return null;
  }
  function batchRadiusKm(batch){
    if (batch && batch.batch && batch.batch.radius_km != null) return Number(batch.batch.radius_km);
    if (batch && batch.batch && batch.batch.radiusKm != null) return Number(batch.batch.radiusKm);
    return null;
  }
  function centerMap(center, radiusKm){
    if (!map || !center) return;
    map.setCenter(center);
    map.setZoom(radiusKm ? 12 : 4);
    if (circle) { circle.setMap(null); circle = null; }
    if (radiusKm) {
      circle = new google.maps.Circle({ map: map, center: center, radius: radiusKm * 1000, fillOpacity: 0.08, strokeOpacity: 0.5 });
    }
  }
  function moveCircle(center, radiusKm){
    if (!map || !center) return;
    if (circle) { circle.setMap(null); circle = null; }
    if (radiusKm) {
      circle = new google.maps.Circle({ map: map, center: center, radius: radiusKm * 1000, fillOpacity: 0.08, strokeOpacity: 0.5 });
    }
  }
  function openMarker(key){
    var mk = markerByKey[key];
    if (!mk || !map) return;
    map.panTo(mk.getPosition());
    infoWindows.forEach(function(iw){ iw.close(); });
    if (mk._iw) mk._iw.open(map, mk);
  }
  function plotResults(results){
    if (!map) return;
    var bounds = new google.maps.LatLngBounds();
    var plotted = 0, added = 0;
    (results || []).forEach(function(x, idx){
      var lat = x.lat != null ? x.lat : (x.location && x.location.latitude);
      var lng = x.lng != null ? x.lng : (x.location && x.location.longitude);
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      var key = x.place_id || (x.name + '#' + idx);
      plotted++;
      bounds.extend({ lat: lat, lng: lng });
      if (markerByKey[key]) return; // 轮询只补新增点，不重建已有 marker
      var mk = new google.maps.Marker({ map: map, position: { lat: lat, lng: lng }, title: x.name || '' });
      var iw = new google.maps.InfoWindow({ content: '<div style="max-width:240px;color:#1b1a17"><b>' + esc(x.name || '') + '</b><br><span style="font-size:12px">' + esc(x.address || '') + '<br>' + esc(x.phone || '') + '</span></div>' });
      mk._iw = iw;
      infoWindows.push(iw);
      mk.addListener('click', function(){ infoWindows.forEach(function(w){ w.close(); }); iw.open(map, mk); });
      markers.push(mk);
      markerByKey[key] = mk;
      added++;
    });
    var note = document.getElementById('mapsMapNote');
    if (note) note.textContent = plotted > 0 ? ('已在地图上标出 ' + plotted + ' 家') : '本次结果无坐标，仅显示列表';
    // 只在首次出现坐标时自动适配视野，之后轮询不再抢用户正在看的视图。
    if (added > 0 && !mapFitted && plotted > 0) { map.fitBounds(bounds); mapFitted = true; }
  }
  function applyBatchToMap(batch){
    pendingBatch = batch;
    if (!mapReady) return;
    var center = batchCenter(batch);
    var radiusKm = batchRadiusKm(batch);
    if (center && !mapFitted) { centerMap(center, radiusKm); mapFitted = true; }
    var all = [];
    (batch.tasks || []).forEach(function(t){ (t.results || []).forEach(function(r){ all.push(r); }); });
    plotResults(all);
    renderMapOverlayList(all);
  }
  function renderMapOverlayList(results){
    var wrap = document.getElementById('mapsMapList');
    var itemsEl = document.getElementById('mapsMapListItems');
    var countEl = document.getElementById('mapsMapListCount');
    if (!wrap || !itemsEl) return;
    var withCoord = (results || []).filter(function(x){
      var lat = x.lat != null ? x.lat : (x.location && x.location.latitude);
      var lng = x.lng != null ? x.lng : (x.location && x.location.longitude);
      return typeof lat === 'number' && typeof lng === 'number';
    });
    if (!withCoord.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    if (countEl) countEl.textContent = '（' + withCoord.length + ' 家）';
    itemsEl.innerHTML = withCoord.map(function(x, idx){
      var key = x.place_id || (x.name + '#' + idx);
      return '<button type="button" class="maps-map-list-item" data-marker-key="' + esc(key) + '">' + esc(x.name || '—') + '</button>';
    }).join('');
    itemsEl.querySelectorAll('[data-marker-key]').forEach(function(btn){
      btn.addEventListener('click', function(){ openMarker(btn.dataset.markerKey); });
    });
  }

  // 地点搜索框：Autocomplete 可用时选地点后重定位 + 移半径圈 + 写回城市框；
  // 不可用时降级为普通输入框，回车仅把文字写进城市输入框，不报错。
  function setupPlaceSearch(){
    var input = document.getElementById('mapsPlaceSearch');
    if (!input || !map) return;
    var ac = null;
    try {
      if (window.google && google.maps && google.maps.places && google.maps.places.Autocomplete) {
        ac = new google.maps.places.Autocomplete(input, { types: ['geocode'] });
        autocompleteReady = true;
      }
    } catch (e) { ac = null; }
    if (ac) {
      ac.addListener('place_changed', function(){
        var place = null;
        try { place = ac.getPlace(); } catch (e) { place = null; }
        if (!place) return;
        var locInput = document.getElementById('mapsLocation');
        var label = place.formatted_address || place.name || input.value.trim();
        if (locInput && label) locInput.value = label;
        if (place.geometry && place.geometry.location) {
          var pos = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() };
          var radiusKm = parseFloat((document.getElementById('mapsRadius') || {}).value) || batchRadiusKm(pendingBatch);
          map.setCenter(pos);
          map.setZoom(radiusKm ? 12 : 10);
          moveCircle(pos, radiusKm);
          mapFitted = true;
        }
        if (typeof window.refreshEstimate === 'function') window.refreshEstimate();
      });
    }
    input.addEventListener('keydown', function(e){
      if (e.key !== 'Enter') return;
      if (autocompleteReady) return; // Autocomplete 接管回车选地点
      e.preventDefault();
      var locInput = document.getElementById('mapsLocation');
      if (locInput && input.value.trim()) { locInput.value = input.value.trim(); if (typeof window.refreshEstimate === 'function') window.refreshEstimate(); }
    });
  }

  // ── 批次渲染（右侧 AI 执行流 + 底部时间线 + 地图）──
  var currentBatch = null, currentBatchId = null, pollTimer = null, batchStartedAt = null;
  var compatSingleTask = false, pollFailStreak = 0;

  function allResults(batch){
    var all = [];
    (batch.tasks || []).forEach(function(t){ (t.results || []).forEach(function(r){ all.push(r); }); });
    return all;
  }
  function currentTask(batch){
    var tasks = batch.tasks || [];
    for (var i = 0; i < tasks.length; i++) if (tasks[i].status === 'running' || tasks[i].status === 'organizing' || tasks[i].status === 'enriching') return tasks[i];
    for (var j = 0; j < tasks.length; j++) if (tasks[j].status === 'queued') return tasks[j];
    for (var k = 0; k < tasks.length; k++) if (tasks[k].status === 'failed') return tasks[k];
    return tasks.length ? tasks[tasks.length - 1] : null;
  }
  function batchStatusText(batch){
    var st = (batch.batch && batch.batch.status) || '';
    if (st) return { queued: '排队中…', running: '采集中…', organizing: 'AI 整理中…', enriching: 'AI 整理中…', done: '已完成', failed: '已失败' }[st] || st;
    var t = currentTask(batch);
    return t ? statusCn(t.status) + '…' : '—';
  }
  function batchElapsedSecs(batch){
    if (batch.batch && batch.batch.elapsed_seconds != null) return Number(batch.batch.elapsed_seconds) || 0;
    if (batch.batch && batch.batch.created_at) return Math.max(0, Math.round((Date.now() - new Date(batch.batch.created_at)) / 1000));
    return batchStartedAt ? Math.max(0, Math.round((Date.now() - batchStartedAt) / 1000)) : 0;
  }

  function renderBatch(batch){
    currentBatch = batch;
    var tasks = (batch.tasks || []).slice().sort(function(a, b){ return (a.id || 0) - (b.id || 0); });
    batch.tasks = tasks;
    var b = batch.batch || {};
    var total = 0, done = 0;
    tasks.forEach(function(t){ total += Number(t.total || 0); done += Number(t.done || 0); });
    var elapsed = batchElapsedSecs(batch);

    // 右侧：T 任务列表（T-序号按批次内顺序，不是任务全局 id）
    var listEl = document.getElementById('aiTaskList');
    if (listEl) {
      listEl.innerHTML = tasks.length ? tasks.map(function(t, i){
        var es = elapsedSecs(t.started_at, t.finished_at);
        return '<div class="ai-task-row"><span class="ai-task-no">T-' + String(i + 1).padStart(2, '0') + '</span>'
          + '<span class="ai-task-kw" title="' + esc(t.keyword || '') + '">' + esc(t.keyword || '') + '</span>'
          + taskBadge(t.status)
          + '<span class="ai-task-prog">已解析 ' + Number(t.done || 0) + ' / ' + Number(t.total || 0) + ' 条</span>'
          + '<span class="ai-task-time">' + (es == null ? '—' : fmtMMSS(es)) + '</span></div>'
          + (t.error ? '<div class="ai-task-error">失败原因：' + esc(t.error) + '</div>' : '');
      }).join('') : '<div class="ai-flow-empty">尚未发起采集。</div>';
    }
    // 右侧：当前任务详情卡
    var curEl = document.getElementById('aiCurrentCard');
    var cur = currentTask(batch);
    if (curEl) {
      if (!cur) {
        curEl.innerHTML = '<div class="ai-flow-empty">暂无进行中的任务。</div>';
      } else {
        var idx = tasks.indexOf(cur) + 1;
        var ces = elapsedSecs(cur.started_at, cur.finished_at);
        var searching = cur.current_name ? esc(cur.current_name) : '正在搜索商家…';
        curEl.innerHTML = '<div class="ai-current-head"><span class="ai-task-no">T-' + String(idx).padStart(2, '0') + '</span>'
          + '<span class="ai-task-kw">' + esc(cur.keyword || '') + '</span>' + taskBadge(cur.status) + '</div>'
          + '<div class="ai-current-line">已解析 ' + Number(cur.done || 0) + ' / ' + Number(cur.total || 0) + ' 条 · 用时 ' + (ces == null ? '—' : fmtMMSS(ces)) + '</div>'
          + '<div class="ai-current-line ai-current-name"><i class="bi bi-search"></i> ' + searching + '</div>'
          + (cur.error ? '<div class="ai-task-error">失败原因：' + esc(cur.error) + '</div>' : '');
      }
    }
    // 右侧：本批次已采商家列表（汇总各任务 results）
    var leadsEl = document.getElementById('aiLeadsList');
    var leadsCountEl = document.getElementById('aiLeadsCount');
    var results = allResults(batch);
    if (leadsCountEl) leadsCountEl.textContent = results.length ? '（' + results.length + ' 家）' : '';
    if (leadsEl) {
      if (!results.length) {
        leadsEl.innerHTML = '<div class="ai-flow-empty">暂无已采商家。</div>';
      } else {
        var shown = results.slice(0, 60);
        leadsEl.innerHTML = shown.map(function(x){
          var name = x.lead_id ? '<a href="/lead/' + x.lead_id + '">' + esc(x.name || '—') + '</a>' : esc(x.name || '—');
          var brief = [x.phone ? esc(x.phone) : '', (x.rating != null ? '★' + esc(x.rating) + (x.user_rating_count != null ? '（' + esc(x.user_rating_count) + ' 条评价）' : '') : '')].filter(Boolean).join(' · ');
          return '<div class="ai-lead-row"><span class="ai-lead-name">' + name + '</span>' + leadStatusBadge(x.status)
            + (brief ? '<span class="ai-lead-brief">' + brief + '</span>' : '') + '</div>';
        }).join('') + (results.length > 60 ? '<div class="ai-flow-empty">共 ' + results.length + ' 家，仅显示前 60 家。</div>' : '');
      }
    }
    // 右侧：API 调用日志——只写各任务 calls 的真实计数，不编造单条耗时与状态码
    var logEl = document.getElementById('aiCallsLog');
    if (logEl) {
      var lines = [];
      tasks.forEach(function(t, i){
        var c = t.calls;
        if (!c) return;
        var parts = [];
        if (c.search != null) parts.push('搜索 ×' + Number(c.search));
        if (c.details != null) parts.push('详情 ×' + Number(c.details));
        if (c.geocode != null) parts.push('定位 ×' + Number(c.geocode));
        var tot = c.total != null ? Number(c.total) : (Number(c.search || 0) + Number(c.details || 0) + Number(c.geocode || 0));
        if (parts.length) lines.push('<div class="ai-log-row">T-' + String(i + 1).padStart(2, '0') + ' · ' + esc(t.keyword || '') + '：' + parts.join(' · ') + '（合计 ' + tot + ' 次）</div>');
      });
      logEl.innerHTML = lines.length ? lines.join('') : '<div class="ai-flow-empty">暂无调用记录。</div>';
    }
    var flowBatchEl = document.getElementById('aiFlowBatch');
    if (flowBatchEl) flowBatchEl.textContent = b.id != null ? ('· 批次 #' + b.id) : '';
    var actionsBox = document.getElementById('mapsActions');
    if (actionsBox && results.length) actionsBox.style.display = 'block';

    // 底部时间线：已完成蓝色、当前黄色、待跑灰色、失败红色
    var counterEl = document.getElementById('tlCounter');
    var nodesEl = document.getElementById('tlNodes');
    var parsedEl = document.getElementById('tlParsed');
    var ctxEl = document.getElementById('tlContext');
    var allDone = tasks.length > 0 && tasks.every(function(t){ return t.status === 'done'; });
    var curIdx = -1;
    for (var ci = 0; ci < tasks.length; ci++) {
      if (tasks[ci].status === 'running' || tasks[ci].status === 'organizing' || tasks[ci].status === 'enriching') { curIdx = ci; break; }
    }
    if (curIdx < 0) for (var qi = 0; qi < tasks.length; qi++) { if (tasks[qi].status === 'queued') { curIdx = qi; break; } }
    if (counterEl) counterEl.textContent = tasks.length ? ((allDone ? tasks.length : (curIdx >= 0 ? curIdx + 1 : tasks.length)) + ' / ' + tasks.length) : '— / —';
    if (nodesEl) {
      if (!tasks.length) {
        nodesEl.innerHTML = '<div class="maps-tl-empty">尚未发起采集</div>';
      } else {
        nodesEl.innerHTML = tasks.map(function(t, i){
          var cls = t.status === 'done' ? 'mtl-done' : t.status === 'failed' ? 'mtl-failed' : (i === curIdx ? 'mtl-current' : 'mtl-queued');
          return (i > 0 ? '<div class="mtl-line"></div>' : '')
            + '<div class="mtl-node ' + cls + '"><div class="mtl-dot">' + (i + 1) + '</div><div class="mtl-label">' + esc(t.keyword || '') + '</div><div class="mtl-sub">' + esc(statusCn(t.status)) + '</div></div>';
        }).join('');
      }
    }
    if (parsedEl) parsedEl.textContent = '已解析 ' + done + ' / ' + total + ' 条 · 用时 ' + fmtMMSS(elapsed);
    if (ctxEl) {
      var loc = b.location || (tasks[0] && tasks[0].location) || '不限城市';
      var radius = (b.radius_km != null ? b.radius_km : (b.radiusKm != null ? b.radiusKm : (tasks[0] && tasks[0].radius_km)));
      ctxEl.textContent = loc + ' · 采集半径 ' + (radius != null ? radius + ' km' : '不限') + ' · ' + batchStatusText(batch)
        + (compatSingleTask ? '（单任务兼容显示，后端批次接口未就绪）' : '');
    }
    applyBatchToMap(batch);
  }

  function renderEmpty(){
    currentBatch = null;
    var listEl = document.getElementById('aiTaskList');
    if (listEl) listEl.innerHTML = '<div class="ai-flow-empty">尚未发起采集。</div>';
    var curEl = document.getElementById('aiCurrentCard');
    if (curEl) curEl.innerHTML = '<div class="ai-flow-empty">暂无进行中的任务。</div>';
    var leadsEl = document.getElementById('aiLeadsList');
    if (leadsEl) leadsEl.innerHTML = '<div class="ai-flow-empty">暂无已采商家。</div>';
    var logEl = document.getElementById('aiCallsLog');
    if (logEl) logEl.innerHTML = '<div class="ai-flow-empty">暂无调用记录。</div>';
    var nodesEl = document.getElementById('tlNodes');
    if (nodesEl) nodesEl.innerHTML = '<div class="maps-tl-empty">尚未发起采集</div>';
    var counterEl = document.getElementById('tlCounter');
    if (counterEl) counterEl.textContent = '— / —';
    var parsedEl = document.getElementById('tlParsed');
    if (parsedEl) parsedEl.textContent = '已解析 — / — 条 · 用时 --:--';
    var ctxEl = document.getElementById('tlContext');
    if (ctxEl) ctxEl.textContent = '—';
  }

  function stopPolling(){
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function startPolling(){
    stopPolling();
    pollTimer = setInterval(function(){ pollBatch(); }, 2000);
  }
  function setRunBtnEnabled(enabled){
    var runBtn = document.getElementById('mapsRunBtn');
    if (runBtn) runBtn.disabled = !enabled;
  }

  async function pollBatch(){
    if (currentBatchId == null) return;
    try {
      var r;
      if (compatSingleTask) {
        r = await fetch('/api/tasks/' + currentBatchId).then(function(x){ return x.json(); });
        if (!r.ok || !r.task) throw new Error((r && r.error) || '查询任务失败');
        renderBatch(adaptTaskToBatch(r.task));
      } else {
        r = await fetch('/api/batches/' + currentBatchId).then(function(x){ return x.json(); });
        if (!r.ok || !r.batch) throw new Error((r && r.error) || '查询批次失败');
        renderBatch({ batch: r.batch, tasks: r.tasks || [] });
      }
      pollFailStreak = 0;
      if (isTerminalBatch(currentBatch && currentBatch.batch, currentBatch && currentBatch.tasks)) {
        stopPolling();
        setRunBtnEnabled(true);
      }
    } catch (err) {
      // 轮询一次失败不中断，下一轮继续；连续失败 10 次才停并提示。
      pollFailStreak++;
      if (pollFailStreak >= 10) {
        stopPolling();
        setRunBtnEnabled(true);
        var errorBox = document.getElementById('mapsError');
        if (errorBox) errorBox.innerHTML = '<div class="alert alert-danger">轮询批次失败多次：' + esc(err && err.message ? err.message : '网络错误') + '，请刷新页面后到任务流查看。</div>';
      }
    }
  }

  // 兼容兜底：旧后端只有单任务（GET /api/tasks/:id），把它适配成一批次一批任务的形状。
  function adaptTaskToBatch(t){
    var results = t.results || [];
    var task = {
      id: t.id, keyword: t.keyword, status: t.status,
      total: t.total || results.length, done: t.done || 0,
      started_at: t.started_at, finished_at: t.finished_at, error: t.error,
      center_lat: t.center_lat, center_lng: t.center_lng,
      current_name: t.current_name || null, calls: t.calls || null, results: results,
    };
    return {
      batch: { id: t.batch_id || t.id, keywords: [t.keyword], location: t.location || '', radius_km: t.radius_km, max_results: t.max_results, created_at: t.created_at, status: t.status },
      tasks: [task],
    };
  }

  async function loadBatch(id, opts){
    opts = opts || {};
    currentBatchId = id;
    batchStartedAt = Date.now();
    try {
      var r = await fetch('/api/batches/' + id).then(function(x){ return x.json(); });
      if (!r.ok || !r.batch) throw new Error((r && r.error) || '查询批次失败');
      compatSingleTask = false;
      renderBatch({ batch: r.batch, tasks: r.tasks || [] });
      if (!isTerminalBatch(r.batch, r.tasks || [])) startPolling();
      else setRunBtnEnabled(true);
      return true;
    } catch (err) {
      // 批次接口未就绪（404 等）时不报错刷屏：只显示空态，联调时再看。
      if (opts.silent) return false;
      var errorBox = document.getElementById('mapsError');
      if (errorBox) errorBox.innerHTML = '<div class="alert alert-warning">批次接口暂不可用：' + esc(err && err.message ? err.message : '未知错误') + '。页面仍可正常填写，联调完成后再刷新。</div>';
      return false;
    }
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const form = document.getElementById('mapsForm');
    if (!form) return;
    const hasKey = form.dataset.hasKey === '1';
    const kwInput = document.getElementById('mapsKeywords');
    const kwCount = document.getElementById('mapsKwCount');
    const locInput = document.getElementById('mapsLocation');
    const radiusInput = document.getElementById('mapsRadius');
    const maxInput = document.getElementById('mapsMax');
    const estBox = document.getElementById('mapsEstimate');
    const runBtn = document.getElementById('mapsRunBtn');
    const refreshBtn = document.getElementById('mapsRefreshBtn');
    const errorBox = document.getElementById('mapsError');
    const container = document.getElementById('mapsSingle');

    function keywords(){ return parseKeywords(kwInput.value); }
    function refreshKwCount(){
      var n = keywords().length;
      if (kwCount) kwCount.textContent = '已填 ' + n + ' / 5 个';
    }
    function refreshEstimate(){
      const max = Math.min(60, Math.max(1, parseInt(maxInput.value, 10) || 20));
      const radius = parseFloat(radiusInput.value) || 0;
      const e = estimatePerKeyword(max, radius, !!locInput.value.trim());
      var n = Math.max(1, keywords().length);
      var total = e.geocode + n * e.per;
      let text = '预估调用：' + n + ' 个关键词 × 每词约 ' + e.per + ' 次 = 合计约 ' + total + ' 次（定位 ' + e.geocode + ' 次 + 搜索 ' + (n * e.search) + ' 次 + 详情 ' + (n * e.details) + ' 次）。免费额度内：Text Search Pro 5,000 次/月、Place Details Pro 5,000 次/月，超了才收费。';
      // L4：只填半径不填城市时半径会被忽略，这里直接提示，不要等用户采完才发现。
      if (radius && !locInput.value.trim()) text += ' 注意：只填半径不填城市时，半径不起作用（需配合城市使用）。';
      estBox.textContent = text;
    }
    window.refreshEstimate = refreshEstimate; // 地点搜索框选地点后复用
    document.querySelectorAll('.preset-kw').forEach(b => b.addEventListener('click', ()=>{
      var list = keywords();
      if (list.indexOf(b.dataset.kw) < 0) {
        if (list.length >= 5) { errorBox.innerHTML = '<div class="alert alert-warning">最多 5 个关键词，请先删掉一行再添加。</div>'; return; }
        list.push(b.dataset.kw);
        kwInput.value = list.join('\n');
      }
      refreshKwCount(); refreshEstimate(); kwInput.focus();
    }));
    document.querySelectorAll('.preset-loc').forEach(b => b.addEventListener('click', ()=>{ locInput.value = b.dataset.loc; refreshEstimate(); locInput.focus(); }));
    [kwInput, radiusInput, maxInput, locInput].forEach(el => el.addEventListener('input', ()=>{ refreshKwCount(); refreshEstimate(); }));
    refreshKwCount();
    refreshEstimate();

    if (refreshBtn) refreshBtn.addEventListener('click', ()=>{
      // 重新定位到当前批次城市中心 + 半径圈；无批次时回到世界视图。
      if (currentBatch) {
        mapFitted = false;
        var center = batchCenter(currentBatch);
        if (mapReady && center) { centerMap(center, batchRadiusKm(currentBatch)); mapFitted = true; }
        if (mapReady) plotResults(allResults(currentBatch));
        if (currentBatchId != null) pollBatch();
      } else if (mapReady && map) {
        map.setCenter({ lat: 20, lng: 0 });
        map.setZoom(2);
        if (circle) { circle.setMap(null); circle = null; }
      }
    });

    form.addEventListener('submit', async e=>{
      e.preventDefault();
      if (!hasKey) return;
      var kws = keywords();
      if (!kws.length) { errorBox.innerHTML = '<div class="alert alert-warning">请先填写关键词，一行一个，最多 5 个。</div>'; return; }
      if (kws.length > 5) { errorBox.innerHTML = '<div class="alert alert-warning">最多 5 个关键词，当前填了 ' + kws.length + ' 个，请删到 5 个以内再提交。</div>'; return; }
      errorBox.innerHTML = '';
      if (pollTimer) stopPolling();
      compatSingleTask = false;
      currentBatch = null; currentBatchId = null;
      markers.forEach(function(m){ m.setMap(null); });
      markers = []; markerByKey = {}; infoWindows = []; mapFitted = false;
      var overlay = document.getElementById('mapsMapList');
      if (overlay) overlay.style.display = 'none';
      renderEmpty();
      runBtn.disabled = true;
      try {
        const r = await fetch('/api/maps/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keywords: kws, location: locInput.value.trim(), radiusKm: radiusInput.value.trim(), maxResults: maxInput.value.trim() }),
        }).then(x => x.json());
        if (!r.ok) {
          let msg = esc(r.error || '采集失败');
          if (r.code === 'NO_API_KEY' || r.code === 'MAPS_DISABLED') msg = esc(r.error || (r.code === 'NO_API_KEY' ? '未配置 Google Places API Key' : '地图采集通道未启用'));
          if (r.settings_url) msg += ' <a href="' + esc(r.settings_url) + '">去数据源设置填写</a>';
          errorBox.innerHTML = '<div class="alert alert-danger">' + msg + '</div>';
          runBtn.disabled = false;
          return;
        }
        if (r.batch_id != null) {
          currentBatchId = r.batch_id;
          batchStartedAt = Date.now();
          await loadBatch(r.batch_id, { silent: false });
          if (currentBatchId != null && !isTerminalBatch(currentBatch && currentBatch.batch, currentBatch && currentBatch.tasks)) startPolling();
          else setRunBtnEnabled(true);
          return;
        }
        // 兼容兜底：旧后端只返回 task_id（批次接口未就绪），按单任务适配显示。
        if (r.task_id != null) {
          compatSingleTask = true;
          currentBatchId = r.task_id;
          batchStartedAt = Date.now();
          await pollBatch();
          if (!isTerminalBatch(currentBatch && currentBatch.batch, currentBatch && currentBatch.tasks)) startPolling();
          else setRunBtnEnabled(true);
          return;
        }
        errorBox.innerHTML = '<div class="alert alert-danger">服务端返回异常：既没有 batch_id 也没有 task_id。</div>';
        runBtn.disabled = false;
      } catch (err) {
        errorBox.innerHTML = '<div class="alert alert-danger">请求失败：' + esc(err && err.message ? err.message : '网络错误') + '，请稍后再试。</div>';
        runBtn.disabled = false;
      }
    });

    // 刷新 / 重进页面显示最近一个批次：服务端 data-latest-batch-id 优先，
    // 没有时再试 GET /api/batches/latest；都没有则显示空态。
    (async function restoreLatest(){
      var latestId = container && container.dataset ? (container.dataset.latestBatchId || '') : '';
      if (latestId) { await loadBatch(latestId, { silent: true }); return; }
      try {
        var r = await fetch('/api/batches/latest').then(function(x){ return x.json(); });
        if (r.ok && r.batch && r.batch.id != null) { await loadBatch(r.batch.id, { silent: true }); }
      } catch (e) { /* 批次接口未就绪：保持空态 */ }
    })();
  });
})();
