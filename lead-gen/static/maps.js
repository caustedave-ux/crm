'use strict';
/** 地图采集页交互：预设快捷按钮、预估调用量、提交采集、渲染结果、去核验 */
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
    const errorBox = document.getElementById('mapsError');
    const resultBox = document.getElementById('mapsResult');
    const summaryEl = document.getElementById('mapsSummary');
    const actionsBox = document.getElementById('mapsActions');
    const verifyBtn = document.getElementById('btnVerifyBatch');
    let currentBatchId = null;

    function refreshEstimate(){
      const max = Math.min(60, Math.max(1, parseInt(maxInput.value, 10) || 20));
      const radius = parseFloat(radiusInput.value) || 0;
      const e = estimate(max, radius, !!locInput.value.trim());
      estBox.textContent = '预估调用：定位 ' + e.geocode + ' 次 + 搜索 ' + e.search + ' 次 + 详情 ' + e.details + ' 次（合计 ' + e.total + ' 次）。免费额度内：Text Search Pro 5,000 次/月、Place Details Pro 5,000 次/月，超了才收费。';
    }
    document.querySelectorAll('.preset-kw').forEach(b => b.addEventListener('click', ()=>{ kwInput.value = b.dataset.kw; kwInput.focus(); }));
    document.querySelectorAll('.preset-loc').forEach(b => b.addEventListener('click', ()=>{ locInput.value = b.dataset.loc; refreshEstimate(); locInput.focus(); }));
    [radiusInput, maxInput, locInput].forEach(el => el.addEventListener('input', refreshEstimate));
    refreshEstimate();

    form.addEventListener('submit', async e=>{
      e.preventDefault();
      if (!hasKey) return;
      const keyword = kwInput.value.trim();
      if (!keyword) { errorBox.innerHTML = '<div class="alert alert-warning">请先填写关键词。</div>'; return; }
      errorBox.innerHTML = '';
      resultBox.innerHTML = '';
      summaryEl.textContent = '';
      actionsBox.style.display = 'none';
      currentBatchId = null;
      runBtn.disabled = true;
      progressBox.style.display = 'block';
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
          return;
        }
        currentBatchId = r.batch_id;
        const c = r.calls || {};
        summaryEl.textContent = '找到 ' + r.found + ' 家 · 新增 ' + r.inserted + ' 家 · 重复 ' + r.duplicates + ' 家' + (r.skipped ? ' · 跳过 ' + r.skipped + ' 家' : '') + ' · 调用：定位 ' + (c.geocode || 0) + ' / 搜索 ' + (c.search || 0) + ' / 详情 ' + (c.details || 0);
        if (!r.results || !r.results.length) {
          resultBox.innerHTML = '<div class="text-muted small">本次没有找到商家，换个关键词或城市再试。</div>';
          return;
        }
        const rows = r.results.map(x => {
          const rating = x.rating != null ? esc(x.rating) + (x.user_rating_count != null ? '（' + esc(x.user_rating_count) + ' 条评价）' : '') : '—';
          const site = x.website ? '<a href="' + esc(x.website) + '" target="_blank" rel="noopener">' + esc(x.website.replace(/^https?:\/\//, '')) + '</a>' : '—';
          const name = x.lead_id ? '<a href="/lead/' + x.lead_id + '">' + esc(x.name) + '</a>' : esc(x.name);
          return '<tr><td>' + name + '</td><td class="small">' + esc(x.address || '—') + '</td><td class="small">' + esc(x.phone || '—') + '</td><td class="small">' + site + '</td><td class="small text-nowrap">' + rating + '</td><td>' + statusBadge(x.status) + (x.error ? '<div class="small text-danger">' + esc(x.error) + '</div>' : '') + '</td></tr>';
        }).join('');
        resultBox.innerHTML = '<div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th>商家</th><th>地址</th><th>电话</th><th>网址</th><th>评分</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        if (r.batch_id && r.inserted > 0) actionsBox.style.display = 'block';
      } catch (err) {
        errorBox.innerHTML = '<div class="alert alert-danger">请求失败：' + esc(err && err.message ? err.message : '网络错误') + '，请稍后再试。</div>';
      } finally {
        runBtn.disabled = false;
        progressBox.style.display = 'none';
      }
    });

    if (verifyBtn) verifyBtn.addEventListener('click', async ()=>{
      if (!currentBatchId) return;
      verifyBtn.disabled = true;
      const r = await fetch('/api/maps/verify-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: currentBatchId }),
      }).then(x => x.json()).catch(() => ({ ok: false, error: '网络错误' }));
      if (!r.ok) { alert(r.error || '启动核验失败'); verifyBtn.disabled = false; return; }
      location.href = '/verify';
    });
  });
})();
