'use strict';
/** 获客工作台地图采集页交互：预设快捷按钮、预估调用量、提交建任务、轮询任务进度、渲染结果、地图打点。
 * 任务制：POST /api/maps/search 只建任务返回 task_id，再轮询 GET /api/tasks/:id 直到 done/failed。
 * 地图：Google Maps JS API 由服务端代理端点 /maps-js 提供（Key 不进页面源码，
 * callback=initMapsSuite）；脚本加载失败（google 未定义）时降级只显示列表，不阻塞采集。
 * 地图中心用服务端定位到的城市坐标（任务的 center_lat/center_lng），不再让浏览器
 * 端 Geocoder 重算一次。 */
(function(){
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // 预估调用量（与服务端 places.js 的 estimateCalls 同一套算法，不发请求）：
  // 搜索每页 20 家 → ceil(条数/20) 次；详情每家 1 次；填了半径且有城市才定位 1 次。
  function estimate(maxResults, radius, hasLocation){
    const search = Math.max(1, Math.ceil(maxResults / 20));
    const details = maxResults;
    const geocode = (radius && hasLocation) ? 1 : 0;
    return { geocode, search, details, total: geocode + search + details };
  }
  function statusBadge(status){
    if (status === 'new') return '<span class="badge bg-success">新增</span>';
    if (status === 'duplicate') return '<span class="badge bg-secondary">重复</span>';
    if (status === 'failed') return '<span class="badge bg-danger">失败</span>';
    return '<span class="badge bg-secondary">' + esc(status) + '</span>';
  }

  // ── 地图（Google Maps JS API 回调；失败时 window.google 不存在，直接降级）──
  var map = null, markers = [], circle = null, mapReady = false, pendingResults = null, pendingCenter = null, pendingRadiusKm = null, mapCentered = false;
  window.initMapsSuite = function(){
    try {
      if (!window.google || !google.maps) return;
      map = new google.maps.Map(document.getElementById('mapsMap'), { center: { lat: 20, lng: 0 }, zoom: 2 });
      mapReady = true;
      if (pendingCenter) centerMap(pendingCenter, pendingRadiusKm);
      if (pendingResults) plotResults(pendingResults.results || []);
    } catch (e) {
      document.getElementById('mapsMapFallback').style.display = 'block';
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

  function centerMap(center, radiusKm){
    if (!map || !center) return;
    map.setCenter(center);
    map.setZoom(radiusKm ? 12 : 4);
    if (circle) circle.setMap(null);
    if (radiusKm) {
      circle = new google.maps.Circle({ map: map, center: center, radius: radiusKm * 1000, fillOpacity: 0.08, strokeOpacity: 0.5 });
    }
  }
  function plotResults(results){
    if (!map) return;
    markers.forEach(function(m){ m.setMap(null); });
    markers = [];
    var bounds = new google.maps.LatLngBounds();
    var plotted = 0;
    (results || []).forEach(function(x){
      // 结果带经纬度时才打点（collectLeads 返回每家的 lat/lng）。
      var lat = x.lat != null ? x.lat : (x.location && x.location.latitude);
      var lng = x.lng != null ? x.lng : (x.location && x.location.longitude);
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      var pos = { lat: lat, lng: lng };
      var mk = new google.maps.Marker({ map: map, position: pos, title: x.name || '' });
      var iw = new google.maps.InfoWindow({ content: '<div style="max-width:240px"><b>' + esc(x.name || '') + '</b><br><span style="font-size:12px">' + esc(x.address || '') + '<br>' + esc(x.phone || '') + '</span></div>' });
      mk.addListener('click', function(){ iw.open(map, mk); });
      markers.push(mk);
      bounds.extend(pos);
      plotted++;
    });
    if (plotted > 0) map.fitBounds(bounds);
    var note = document.getElementById('mapsMapNote');
    if (note) note.textContent = plotted > 0 ? ('已在地图上标出 ' + plotted + ' 家') : '本次结果无坐标，仅显示列表';
  }
  // 地图中心用服务端定位到的城市坐标（任务的 center_lat/center_lng）：
  // 地图未就绪时先存进 pendingCenter，等 initMapsSuite 回调时再定位。
  function centerFromTask(task){
    if (!task || task.center_lat == null || task.center_lng == null) return;
    pendingCenter = { lat: Number(task.center_lat), lng: Number(task.center_lng) };
    pendingRadiusKm = task.radius_km != null ? Number(task.radius_km) : null;
    if (mapReady && !mapCentered) {
      centerMap(pendingCenter, pendingRadiusKm);
      mapCentered = true;
    }
  }

  function renderResults(task){
    var resultBox = document.getElementById('mapsResult');
    var summaryEl = document.getElementById('mapsSummary');
    var actionsBox = document.getElementById('mapsActions');
    var results = task.results || [];
    var batchId = task.batch_id;
    if (results.length) {
      summaryEl.textContent = '找到 ' + (task.total || results.length) + ' 家 · 已解析 ' + (task.done || 0) + ' 条' + (batchId ? ' · 批次 #' + batchId : '');
      var rows = results.map(function(x){
        var rating = x.rating != null ? esc(x.rating) + (x.user_rating_count != null ? '（' + esc(x.user_rating_count) + ' 条评价）' : '') : '—';
        var site = x.website ? '<a href="' + esc(x.website) + '" target="_blank" rel="noopener">' + esc(x.website.replace(/^https?:\/\//, '')) + '</a>' : '—';
        var name = x.lead_id ? '<a href="/lead/' + x.lead_id + '">' + esc(x.name) + '</a>' : esc(x.name);
        return '<tr><td>' + name + '</td><td class="small">' + esc(x.address || '—') + '</td><td class="small">' + esc(x.phone || '—') + '</td><td class="small">' + site + '</td><td class="small text-nowrap">' + rating + '</td><td>' + statusBadge(x.status) + (x.error ? '<div class="small text-danger">' + esc(x.error) + '</div>' : '') + '</td></tr>';
      }).join('');
      resultBox.innerHTML = '<div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th>商家</th><th>地址</th><th>电话</th><th>网址</th><th>评分</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      plotResults(results);
    } else {
      summaryEl.textContent = '已解析 ' + (task.done || 0) + ' / ' + (task.total || 0) + ' 条' + (batchId ? ' · 批次 #' + batchId : '');
      resultBox.innerHTML = '<div class="text-muted small">任务已完成，结果已入库。' + (batchId ? '去<a href="/leads">线索库</a>查看本批线索。' : '去<a href="/leads">线索库</a>查看。') + '</div>';
    }
    if (batchId) actionsBox.style.display = 'block';
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const form = document.getElementById('mapsForm');
    if (!form) return;
    const hasKey = form.dataset.hasKey === '1';
    const kwInput = document.getElementById('mapsKeyword');
    const locInput = document.getElementById('mapsLocation');
    const radiusInput = document.getElementById('mapsRadius');
    const maxInput = document.getElementById('mapsMax');
    const estBox = document.getElementById('mapsEstimate');
    const runBtn = document.getElementById('mapsRunBtn');
    const progressBox = document.getElementById('mapsProgress');
    const progressLabel = document.getElementById('mapsProgressLabel');
    const progressPct = document.getElementById('mapsProgressPct');
    const progressBar = document.getElementById('mapsProgressBar');
    const errorBox = document.getElementById('mapsError');
    const resultBox = document.getElementById('mapsResult');
    const summaryEl = document.getElementById('mapsSummary');
    const actionsBox = document.getElementById('mapsActions');
    let pollTimer = null;

    function refreshEstimate(){
      const max = Math.min(60, Math.max(1, parseInt(maxInput.value, 10) || 20));
      const radius = parseFloat(radiusInput.value) || 0;
      const e = estimate(max, radius, !!locInput.value.trim());
      let text = '预估调用：定位 ' + e.geocode + ' 次 + 搜索 ' + e.search + ' 次 + 详情 ' + e.details + ' 次（合计 ' + e.total + ' 次）。免费额度内：Text Search Pro 5,000 次/月、Place Details Pro 5,000 次/月，超了才收费。';
      // L4：只填半径不填城市时半径会被忽略，这里直接提示，不要等用户采完才发现。
      if (radius && !locInput.value.trim()) text += ' 注意：只填半径不填城市时，半径不起作用（需配合城市使用）。';
      estBox.textContent = text;
    }
    document.querySelectorAll('.preset-kw').forEach(b => b.addEventListener('click', ()=>{ kwInput.value = b.dataset.kw; kwInput.focus(); }));
    document.querySelectorAll('.preset-loc').forEach(b => b.addEventListener('click', ()=>{ locInput.value = b.dataset.loc; refreshEstimate(); locInput.focus(); }));
    [radiusInput, maxInput, locInput].forEach(el => el.addEventListener('input', refreshEstimate));
    refreshEstimate();

    async function pollTask(taskId, startedAt){
      try {
        const r = await fetch('/api/tasks/' + taskId).then(x => x.json());
        if (!r.ok || !r.task) { errorBox.innerHTML = '<div class="alert alert-danger">' + esc(r.error || '查询任务失败') + '</div>'; progressBox.style.display = 'none'; runBtn.disabled = false; return; }
        const t = r.task;
        const total = Number(t.total || 0), done = Number(t.done || 0);
        const pct = total ? Math.min(100, Math.round(100 * done / total)) : (t.status === 'done' ? 100 : 0);
        const statusCn = { queued: '排队', running: '采集中', organizing: 'AI 整理中', enriching: 'AI 整理中', done: '完成', failed: '失败' }[t.status] || t.status;
        // 地图中心用服务端定位到的城市坐标（任务的 center_lat/center_lng）。
        centerFromTask(t);
        // L2：搜索阶段 total 还是 0，“已解析 0 / 0 条”像卡死，显示阶段文案 + 不定进度。
        if (!total && (t.status === 'running' || t.status === 'queued' || t.status === 'organizing')) {
          progressLabel.textContent = '任务 T-' + taskId + ' · ' + statusCn + '：正在搜索商家，结果陆续入库…';
          progressPct.textContent = '';
          progressBar.style.width = '30%';
        } else {
          progressLabel.textContent = '任务 T-' + taskId + ' · ' + statusCn + '：已解析 ' + done + ' / ' + total + ' 条';
          progressPct.textContent = pct + '%';
          progressBar.style.width = pct + '%';
        }
        if (startedAt) {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          progressLabel.textContent += ' · 用时 ' + secs + ' 秒';
        }
        if (t.status === 'done') {
          clearInterval(pollTimer); pollTimer = null;
          progressBox.style.display = 'none'; runBtn.disabled = false;
          renderResults(t);
          return;
        }
        if (t.status === 'failed') {
          clearInterval(pollTimer); pollTimer = null;
          progressBox.style.display = 'none'; runBtn.disabled = false;
          errorBox.innerHTML = '<div class="alert alert-danger">任务失败：' + esc(t.error || '未知错误') + ' <button class="btn btn-sm btn-outline-primary" onclick="location.reload()">重试请到任务流</button></div>';
          return;
        }
      } catch (err) {
        // 轮询一次失败不中断，下一轮继续；连续失败时用户可刷新页面到任务流查看。
      }
    }

    form.addEventListener('submit', async e=>{
      e.preventDefault();
      if (!hasKey) return;
      const keyword = kwInput.value.trim();
      if (!keyword) { errorBox.innerHTML = '<div class="alert alert-warning">请先填写关键词。</div>'; return; }
      errorBox.innerHTML = '';
      resultBox.innerHTML = '';
      summaryEl.textContent = '';
      actionsBox.style.display = 'none';
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      runBtn.disabled = true;
      progressBox.style.display = 'block';
      progressLabel.textContent = '正在创建任务…';
      progressBar.style.width = '0%';
      progressPct.textContent = '';
      try {
        const r = await fetch('/api/maps/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword, location: locInput.value.trim(), radiusKm: radiusInput.value.trim(), maxResults: maxInput.value.trim() }),
        }).then(x => x.json());
        if (!r.ok) {
          let msg = esc(r.error || '采集失败');
          if (r.settings_url) msg += ' <a href="' + esc(r.settings_url) + '">去数据源设置填写</a>';
          errorBox.innerHTML = '<div class="alert alert-danger">' + msg + '</div>';
          progressBox.style.display = 'none';
          runBtn.disabled = false;
          return;
        }
        const startedAt = Date.now();
        pollTask(r.task_id, startedAt);
        pollTimer = setInterval(()=>pollTask(r.task_id, startedAt), 2000);
      } catch (err) {
        errorBox.innerHTML = '<div class="alert alert-danger">请求失败：' + esc(err && err.message ? err.message : '网络错误') + '，请稍后再试。</div>';
        progressBox.style.display = 'none';
        runBtn.disabled = false;
      }
    });
  });
})();
