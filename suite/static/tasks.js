'use strict';
/**
 * 任务流前端（获客工作台 · 任务流）
 *
 * 只调本服务接口，不直接调 Google API：
 * - GET  /api/tasks              轮询任务列表（每 2 秒），返回 { ok, tasks: [...] } 或数组
 * - POST /api/tasks              新建任务 { keyword, location, radiusKm, maxResults }
 * - POST /api/tasks/:id/retry    重试失败任务
 * 任务行字段（suite/src/tasks.js）：id, keyword, location, radius_km, max_results,
 * status(queued/running/organizing/done/failed), total, done, batch_id, error,
 * created_at, started_at, finished_at。
 *
 * 页面元素约定（由 suite/src/views.js 渲染，缺失时对应功能静默跳过）：
 * - #taskList      任务卡片容器
 * - #taskTimeline  底部时间线容器（按 created_at 顺序渲染节点）
 * - #taskForm / #taskKeyword / #taskLocation / #taskRadius / #taskMax / #taskFormError
 *   新建任务表单（可选）；#taskEstimate 用于显示预估调用量（本地按 places 的
 *   estimateCalls 同一套公式算：搜索每页 20 家，详情每家 1 次，填了半径且有
 *   城市才定位 1 次，不发请求）
 */
(function () {
  var POLL_MS = 2000;

  var STATUS_LABEL = {
    queued: '排队中',
    running: '采集中',
    organizing: '整理中',
    done: '已完成',
    failed: '失败',
  };
  var STATUS_CLASS = {
    queued: 'bg-secondary',
    running: 'bg-primary',
    organizing: 'bg-info',
    done: 'bg-success',
    failed: 'bg-danger',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  }

  /** 用时：started_at → finished_at 或现在，显示为 x分y秒 / x秒。 */
  function fmtElapsed(task) {
    if (!task.started_at) return '—';
    var start = new Date(task.started_at).getTime();
    var end = task.finished_at ? new Date(task.finished_at).getTime() : Date.now();
    if (isNaN(start) || isNaN(end) || end < start) return '—';
    var sec = Math.round((end - start) / 1000);
    if (sec < 60) return sec + ' 秒';
    return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
  }

  function statusBadge(status) {
    var cls = STATUS_CLASS[status] || 'bg-secondary';
    return '<span class="badge ' + cls + '">' + esc(STATUS_LABEL[status] || status) + '</span>';
  }

  function taskCard(t) {
    var total = Number(t.total) || 0;
    var done = Number(t.done) || 0;
    var pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    var meta = esc(t.keyword || '') + (t.location ? ' · ' + esc(t.location) : '');
    if (t.radius_km) meta += ' · 半径 ' + esc(t.radius_km) + ' 公里';
    meta += ' · 最多 ' + esc(t.max_results) + ' 家';
    var html = '<div class="card mb-2"><div class="card-body py-2">'
      + '<div class="d-flex justify-content-between align-items-start gap-2">'
      + '<div><div class="fw-bold">' + meta + '</div>'
      + '<div class="text-muted small">创建于 ' + esc(fmtTime(t.created_at))
      + ' · 用时 ' + esc(fmtElapsed(t))
      + (t.batch_id ? ' · 批次 #' + esc(t.batch_id) : '') + '</div></div>'
      + '<div class="text-nowrap">' + statusBadge(t.status) + '</div></div>'
      + '<div class="d-flex align-items-center gap-2 mt-2">'
      + '<div class="progress flex-grow-1" style="height: 8px;"><div class="progress-bar" role="progressbar" style="width: ' + pct + '%"></div></div>'
      + '<span class="small text-nowrap">已解析 ' + done + ' / ' + total + '</span>';
    if (t.status === 'failed') {
      html += '<button class="btn btn-sm btn-outline-warning" data-retry-id="' + esc(t.id) + '">重试</button>';
    }
    html += '</div>';
    if (t.status === 'failed' && t.error) {
      html += '<div class="alert alert-danger py-1 px-2 mt-2 mb-0 small">' + esc(t.error) + '</div>';
    }
    html += '</div></div>';
    return html;
  }

  /** 底部时间线：按 created_at 顺序（同时间按 id）渲染节点。 */
  function renderTimeline(tasks) {
    var box = document.getElementById('taskTimeline');
    if (!box) return;
    var sorted = tasks.slice().sort(function (a, b) {
      var d = String(a.created_at || '').localeCompare(String(b.created_at || ''));
      return d !== 0 ? d : (Number(a.id) - Number(b.id));
    });
    if (!sorted.length) {
      box.innerHTML = '<div class="text-muted small">暂无任务。</div>';
      return;
    }
    box.innerHTML = sorted.map(function (t) {
      var dot = STATUS_CLASS[t.status] || 'bg-secondary';
      return '<div class="d-flex gap-2 mb-2">'
        + '<span class="badge rounded-pill ' + dot + '" style="width: 10px; height: 10px; padding: 0; margin-top: 6px;">&nbsp;</span>'
        + '<div><div class="small fw-bold">' + esc(t.keyword || '') + (t.location ? ' · ' + esc(t.location) : '') + '</div>'
        + '<div class="text-muted small">' + esc(fmtTime(t.created_at)) + ' · ' + esc(STATUS_LABEL[t.status] || t.status)
        + ' · 已解析 ' + (Number(t.done) || 0) + ' / ' + (Number(t.total) || 0) + '</div></div></div>';
    }).join('');
  }

  function renderTasks(tasks) {
    var box = document.getElementById('taskList');
    if (!box) return;
    if (!tasks.length) {
      box.innerHTML = '<div class="text-muted small">暂无任务，先新建一个采集任务。</div>';
      return;
    }
    box.innerHTML = tasks.map(taskCard).join('');
  }

  async function fetchTasks() {
    var r = await fetch('/api/tasks').then(function (x) { return x.json(); });
    var tasks = Array.isArray(r) ? r : (r.tasks || []);
    renderTasks(tasks);
    renderTimeline(tasks);
    return tasks;
  }

  async function poll() {
    try { await fetchTasks(); } catch (e) { /* 轮询失败静默，下个周期再试 */ }
  }

  async function retryTask(id, btn) {
    if (btn) btn.disabled = true;
    try {
      var r = await fetch('/api/tasks/' + encodeURIComponent(id) + '/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).then(function (x) { return x.json(); });
      if (r && r.ok === false) { alert(r.error || '重试失败'); return; }
      await poll();
    } catch (e) {
      alert('请求失败：' + (e && e.message ? e.message : '网络错误'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** 预估调用量（本地公式，与 places.estimateCalls 一致，不发请求）。 */
  function estimate(maxResults, radius, hasLocation) {
    var search = Math.max(1, Math.ceil(maxResults / 20));
    var details = maxResults;
    var geocode = (radius && hasLocation) ? 1 : 0;
    return { geocode: geocode, search: search, details: details, total: geocode + search + details };
  }

  document.addEventListener('DOMContentLoaded', function () {
    var list = document.getElementById('taskList');
    if (list) {
      list.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-retry-id]');
        if (btn) retryTask(btn.getAttribute('data-retry-id'), btn);
      });
    }

    var form = document.getElementById('taskForm');
    if (form) {
      var kwInput = document.getElementById('taskKeyword');
      var locInput = document.getElementById('taskLocation');
      var radiusInput = document.getElementById('taskRadius');
      var maxInput = document.getElementById('taskMax');
      var estBox = document.getElementById('taskEstimate');
      var errBox = document.getElementById('taskFormError');
      var submitBtn = form.querySelector('[type="submit"]');

      var refreshEstimate = function () {
        if (!estBox) return;
        var max = Math.min(60, Math.max(1, parseInt(maxInput.value, 10) || 20));
        var radius = parseFloat(radiusInput.value) || 0;
        var e = estimate(max, radius, !!(locInput.value || '').trim());
        estBox.textContent = '预估调用：定位 ' + e.geocode + ' 次 + 搜索 ' + e.search + ' 次 + 详情 ' + e.details + ' 次（合计 ' + e.total + ' 次）。';
      };
      [radiusInput, maxInput, locInput].forEach(function (el) {
        if (el) el.addEventListener('input', refreshEstimate);
      });
      refreshEstimate();

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (errBox) errBox.innerHTML = '';
        var keyword = (kwInput.value || '').trim();
        if (!keyword) {
          if (errBox) errBox.innerHTML = '<div class="alert alert-warning py-1 px-2 mb-0">请先填写关键词。</div>';
          return;
        }
        if (submitBtn) submitBtn.disabled = true;
        try {
          var r = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              keyword: keyword,
              location: (locInput.value || '').trim(),
              radiusKm: (radiusInput.value || '').trim() === '' ? null : Number(radiusInput.value),
              maxResults: parseInt(maxInput.value, 10) || 20,
            }),
          }).then(function (x) { return x.json(); });
          if (r && r.ok === false) {
            if (errBox) errBox.innerHTML = '<div class="alert alert-danger py-1 px-2 mb-0">' + esc(r.error || '新建任务失败') + '</div>';
            return;
          }
          form.reset();
          refreshEstimate();
          await poll();
        } catch (err) {
          if (errBox) errBox.innerHTML = '<div class="alert alert-danger py-1 px-2 mb-0">请求失败：' + esc(err && err.message ? err.message : '网络错误') + '</div>';
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    poll();
    setInterval(poll, POLL_MS);
  });
})();
