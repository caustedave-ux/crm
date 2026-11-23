'use strict';
/**
 * 开发信前端（获客工作台 · 开发信）
 *
 * 单发流程（V1，不直连 SMTP，见 suite/src/letters.js 文件头）：
 *   选模板 + 选线索 → 调渲染接口出预览 → 复制全文 / 打开 mailto:（收件人取
 *   线索的邮箱证据，若无邮箱则只复制）→ 用户在自己邮箱发完后点「标记已手动发送」
 *   调 recordSend 接口写一条发送记录（5 分钟内同一内容重复标记只记一次）。
 *
 * 调用的本服务接口（由 suite/server.js 接线，需与 suite/src/letters.js 对应）：
 * - GET    /api/letter-templates                 模板列表
 * - POST   /api/letter-templates                 新建/更新 { id?, name, lang, subject, body }
 * - DELETE /api/letter-templates/:id             删除模板
 * - GET    /api/letters/render?template_id=&lead_id=
 *          渲染预览 → { ok, subject, body, contact: { phone, website, email } }
 * - POST   /api/send-records                     标记已手动发送 { lead_id, template_id, channel, subject, body }
 * - GET    /api/send-records?lead_id=            某线索的发送记录
 * 响应统一按 { ok, ... } 或数组处理（两种都兼容）。
 *
 * 页面元素约定（由 suite/src/views.js 渲染，缺失时对应功能静默跳过）：
 * - #templateList       模板列表容器
 * - #templateForm / #tplId / #tplName / #tplLang / #tplSubject / #tplBody / #tplSave / #tplNew / #tplFormError
 * - #leadSelect         线索下拉框（option 的 value 为 lead_id）
 * - #templateSelect     模板下拉框（与 #templateList 二选一或并存都可）
 * - #letterPreviewSubject / #letterPreviewBody / #letterContact  预览区
 * - #btnCopy / #btnMailto / #channelSelect / #btnMarkSent / #sendHistory / #letterError
 */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function getJson(url) {
    var r = await fetch(url).then(function (x) { return x.json(); });
    return r;
  }

  async function postJson(url, data) {
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    }).then(function (x) { return x.json(); });
    return r;
  }

  function asList(r) {
    if (Array.isArray(r)) return r;
    if (r && Array.isArray(r.templates)) return r.templates;
    if (r && Array.isArray(r.records)) return r.records;
    return [];
  }

  var currentTemplateId = null;
  var currentLeadId = null;
  var currentSubject = '';
  var currentBody = '';
  var currentEmail = '';

  function showError(msg) {
    var box = document.getElementById('letterError');
    if (box) box.innerHTML = msg ? '<div class="alert alert-danger py-1 px-2 mb-0">' + esc(msg) + '</div>' : '';
    else if (msg) alert(msg);
  }

  /* ---------- 模板列表 ---------- */

  function renderTemplateList(templates) {
    var box = document.getElementById('templateList');
    if (box) {
      if (!templates.length) {
        box.innerHTML = '<div class="text-muted small">暂无模板。</div>';
      } else {
        box.innerHTML = templates.map(function (t) {
          return '<div class="d-flex justify-content-between align-items-start gap-2 border rounded p-2 mb-2">'
            + '<div><div class="fw-bold">' + esc(t.name) + ' <span class="badge bg-secondary">' + esc(t.lang || 'en') + '</span></div>'
            + '<div class="text-muted small">' + esc(t.subject || '') + '</div></div>'
            + '<div class="text-nowrap">'
            + '<button class="btn btn-sm btn-outline-primary me-1" data-tpl-edit="' + esc(t.id) + '">编辑</button>'
            + '<button class="btn btn-sm btn-outline-danger" data-tpl-del="' + esc(t.id) + '">删除</button>'
            + '</div></div>';
        }).join('');
      }
    }
    var sel = document.getElementById('templateSelect');
    if (sel) {
      var prev = sel.value;
      sel.innerHTML = '<option value="">请选择模板…</option>' + templates.map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.name) + '（' + esc(t.lang || 'en') + '）</option>';
      }).join('');
      if (prev) sel.value = prev;
      currentTemplateId = sel.value ? Number(sel.value) : currentTemplateId;
    }
  }

  async function refreshTemplates() {
    try {
      var r = await getJson('/api/letter-templates');
      renderTemplateList(asList(r));
    } catch (e) { /* 模板列表拉取失败静默，页面其他功能照常 */ }
  }

  function fillTemplateForm(t) {
    var idEl = document.getElementById('tplId');
    var nameEl = document.getElementById('tplName');
    var langEl = document.getElementById('tplLang');
    var subjEl = document.getElementById('tplSubject');
    var bodyEl = document.getElementById('tplBody');
    if (idEl) idEl.value = t ? t.id : '';
    if (nameEl) nameEl.value = t ? (t.name || '') : '';
    if (langEl) langEl.value = t ? (t.lang || 'en') : 'en';
    if (subjEl) subjEl.value = t ? (t.subject || '') : '';
    if (bodyEl) bodyEl.value = t ? (t.body || '') : '';
  }

  /* ---------- 渲染预览 ---------- */

  function renderPreview(subject, body, contact) {
    currentSubject = subject || '';
    currentBody = body || '';
    currentEmail = (contact && contact.email) || '';
    var subjEl = document.getElementById('letterPreviewSubject');
    var bodyEl = document.getElementById('letterPreviewBody');
    var contactEl = document.getElementById('letterContact');
    if (subjEl) subjEl.textContent = currentSubject;
    if (bodyEl) bodyEl.textContent = currentBody;
    if (contactEl) {
      var phone = (contact && contact.phone) || '';
      var website = (contact && contact.website) || '';
      contactEl.innerHTML = '电话：' + esc(phone || '未公开')
        + ' · 网址：' + (website ? '<a href="' + esc(website) + '" target="_blank" rel="noopener">' + esc(website) + '</a>' : '未公开')
        + ' · 邮箱：' + esc(currentEmail || '无邮箱证据（只能复制后手动发送）');
    }
    var mailtoBtn = document.getElementById('btnMailto');
    if (mailtoBtn) mailtoBtn.disabled = !currentEmail;
  }

  async function refreshPreview() {
    if (!currentTemplateId || !currentLeadId) return;
    try {
      var r = await getJson('/api/letters/render?template_id=' + encodeURIComponent(currentTemplateId)
        + '&lead_id=' + encodeURIComponent(currentLeadId));
      if (r && r.ok === false) { showError(r.error || '渲染失败'); return; }
      showError('');
      renderPreview(r.subject, r.body, r.contact || {});
    } catch (e) {
      showError('渲染失败：' + (e && e.message ? e.message : '网络错误'));
    }
  }

  /* ---------- 复制 / mailto / 标记已手动发送 ---------- */

  function letterFullText() {
    return (currentSubject ? '主题：' + currentSubject + '\n\n' : '') + currentBody;
  }

  async function copyLetter(btn) {
    var text = letterFullText();
    if (!text.trim()) { alert('请先选模板和线索，生成预览后再复制。'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (btn) {
        var old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = old; }, 1500);
      }
    } catch (e) {
      alert('复制失败，请手动选中预览全文复制。');
    }
  }

  function openMailto() {
    if (!currentBody.trim()) { alert('请先选模板和线索，生成预览后再发送。'); return; }
    if (!currentEmail) {
      alert('该线索没有邮箱证据，只能复制全文后在邮箱里手动发送。');
      return;
    }
    var href = 'mailto:' + encodeURIComponent(currentEmail)
      + '?subject=' + encodeURIComponent(currentSubject)
      + '&body=' + encodeURIComponent(currentBody);
    window.location.href = href;
  }

  async function markSent(btn) {
    if (!currentLeadId) { alert('请先选择线索。'); return; }
    if (!currentBody.trim()) { alert('请先选模板生成预览，再标记已手动发送。'); return; }
    var channelEl = document.getElementById('channelSelect');
    var channel = channelEl ? channelEl.value : 'email';
    if (btn) btn.disabled = true;
    try {
      var r = await postJson('/api/send-records', {
        lead_id: Number(currentLeadId),
        template_id: currentTemplateId ? Number(currentTemplateId) : null,
        channel: channel,
        subject: currentSubject,
        body: currentBody,
      });
      if (r && r.ok === false) { showError(r.error || '标记失败'); return; }
      showError('');
      if (btn) {
        var old = btn.textContent;
        btn.textContent = '已标记';
        setTimeout(function () { btn.textContent = old; }, 1500);
      }
      await refreshHistory();
    } catch (e) {
      showError('标记失败：' + (e && e.message ? e.message : '网络错误'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshHistory() {
    var box = document.getElementById('sendHistory');
    if (!box || !currentLeadId) return;
    try {
      var r = await getJson('/api/send-records?lead_id=' + encodeURIComponent(currentLeadId));
      var records = asList(r);
      if (!records.length) {
        box.innerHTML = '<div class="text-muted small">该线索暂无发送记录。</div>';
        return;
      }
      box.innerHTML = records.map(function (rec) {
        return '<div class="small border-bottom py-1">'
          + '<span class="badge bg-secondary">' + esc(rec.channel || '') + '</span> '
          + esc(rec.subject || '') + ' · ' + esc(rec.status || 'sent')
          + ' <span class="text-muted">' + esc(rec.created_at || '') + '</span></div>';
      }).join('');
    } catch (e) { /* 发送记录拉取失败静默 */ }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var list = document.getElementById('templateList');
    if (list) {
      list.addEventListener('click', async function (e) {
        var editBtn = e.target.closest('[data-tpl-edit]');
        var delBtn = e.target.closest('[data-tpl-del]');
        if (editBtn) {
          var id = editBtn.getAttribute('data-tpl-edit');
          try {
            var r = await getJson('/api/letter-templates/' + encodeURIComponent(id));
            var t = r && r.template ? r.template : r;
            fillTemplateForm(t);
            currentTemplateId = Number(id);
            var sel = document.getElementById('templateSelect');
            if (sel) sel.value = String(id);
            refreshPreview();
          } catch (err) { showError('读取模板失败'); }
        }
        if (delBtn) {
          if (!confirm('确认删除这个模板吗？')) return;
          var delId = delBtn.getAttribute('data-tpl-del');
          try {
            var resp = await fetch('/api/letter-templates/' + encodeURIComponent(delId), { method: 'DELETE' })
              .then(function (x) { return x.json(); });
            if (resp && resp.ok === false) { showError(resp.error || '删除失败'); return; }
            if (Number(currentTemplateId) === Number(delId)) currentTemplateId = null;
            await refreshTemplates();
          } catch (err) { showError('删除失败：' + (err && err.message ? err.message : '网络错误')); }
        }
      });
    }

    var form = document.getElementById('templateForm');
    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var idEl = document.getElementById('tplId');
        var nameEl = document.getElementById('tplName');
        var langEl = document.getElementById('tplLang');
        var subjEl = document.getElementById('tplSubject');
        var bodyEl = document.getElementById('tplBody');
        var saveBtn = document.getElementById('tplSave');
        var payload = {
          id: idEl && idEl.value ? Number(idEl.value) : undefined,
          name: nameEl ? nameEl.value.trim() : '',
          lang: langEl ? langEl.value : 'en',
          subject: subjEl ? subjEl.value.trim() : '',
          body: bodyEl ? bodyEl.value : '',
        };
        if (!payload.name || !payload.subject || !payload.body.trim()) {
          showError('模板名称、主题、正文都不能为空。');
          return;
        }
        if (saveBtn) saveBtn.disabled = true;
        try {
          var r = await postJson('/api/letter-templates', payload);
          if (r && r.ok === false) { showError(r.error || '保存失败'); return; }
          showError('');
          fillTemplateForm(null);
          await refreshTemplates();
        } catch (err) {
          showError('保存失败：' + (err && err.message ? err.message : '网络错误'));
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });
      var newBtn = document.getElementById('tplNew');
      if (newBtn) newBtn.addEventListener('click', function () { fillTemplateForm(null); });
    }

    var tplSel = document.getElementById('templateSelect');
    if (tplSel) {
      tplSel.addEventListener('change', function () {
        currentTemplateId = tplSel.value ? Number(tplSel.value) : null;
        refreshPreview();
      });
    }

    var leadSel = document.getElementById('leadSelect');
    if (leadSel) {
      leadSel.addEventListener('change', function () {
        currentLeadId = leadSel.value ? Number(leadSel.value) : null;
        refreshPreview();
        refreshHistory();
      });
      if (leadSel.value) currentLeadId = Number(leadSel.value);
    }

    var copyBtn = document.getElementById('btnCopy');
    if (copyBtn) copyBtn.addEventListener('click', function () { copyLetter(copyBtn); });
    var mailtoBtn = document.getElementById('btnMailto');
    if (mailtoBtn) mailtoBtn.addEventListener('click', openMailto);
    var markBtn = document.getElementById('btnMarkSent');
    if (markBtn) markBtn.addEventListener('click', function () { markSent(markBtn); });

    refreshTemplates();
    refreshHistory();
  });
})();
