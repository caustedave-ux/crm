'use strict';
// ============ 行业简报页面：素材源、月度 B 类客户、草稿审核 ============
const { esc } = require('../util');
const { page } = require('./layout');
const { card, pageHead, emptyRow } = require('./ui');
const briefings = require('../briefings');

function shortDate(value) { return value ? String(value).slice(0, 16) : '-'; }
function statusBadge(status) {
  if (status === 'sent') return '<span class="badge text-bg-success">已发送</span>';
  if (status === 'draft') return '<span class="badge text-bg-warning">待审核</span>';
  return '<span class="badge text-bg-light border">未生成</span>';
}
function languageOptions(selected) {
  return Object.entries(briefings.LANGUAGES).map(([code, label]) =>
    `<option value="${code}" ${code === (selected || 'en') ? 'selected' : ''}>${esc(label)}</option>`).join('');
}
function defaultLanguage(country) {
  const c = String(country || '').toLowerCase();
  if (/沙特|阿联酋|卡塔尔|科威特|阿曼|巴林|埃及|阿尔及利亚|摩洛哥|突尼斯|arab|saudi|emirat|qatar|kuwait|oman|bahrain|egypt|algeria|morocco|tunisia/.test(c)) return 'ar';
  if (/法国|比利时|瑞士|加拿大|喀麦隆|科特迪瓦|塞内加尔|马里|france|belg|swiss|canada|cameroon|ivory|senegal|mali/.test(c)) return 'fr';
  if (/西班牙|墨西哥|哥伦比亚|秘鲁|智利|阿根廷|spain|mexico|colombia|peru|chile|argentina/.test(c)) return 'es';
  if (/俄罗斯|哈萨克|白俄|russia|kazakh|belarus/.test(c)) return 'ru';
  if (/中国|china|香港|台湾|hong kong|taiwan/.test(c)) return 'zh';
  return 'en';
}

function briefingsPage(ctx) {
  const filter = ['pending', 'draft', 'sent'].includes(String(ctx.query.status || '')) ? String(ctx.query.status) : 'all';
  let data;
  let error = '';
  try { data = briefings.briefingDashboard(ctx.user.id, filter); }
  catch (e) {
    error = e.message;
    data = { period: briefings.PERIOD(), counts: { customers: 0, generated: 0, sent: 0 }, rows: [], sources: [] };
  }
  const counts = data.counts;
  const filterLink = (value, label, count) => {
    const active = filter === value;
    return `<a class="btn btn-sm ${active ? 'btn-dark' : 'btn-outline-secondary'}" href="/briefings${value === 'all' ? '' : '?status=' + value}">${label} <span class="badge text-bg-light border ms-1">${count}</span></a>`;
  };
  const sourceRows = data.sources.map(s => `<tr>
    <td><div class="fw-semibold">${esc(s.name)}</div><div class="small text-muted">${s.kind === 'manual' ? '手工素材' : 'RSS / Atom'}${s.category ? ' · ' + esc(s.category) : ''}</div></td>
    <td class="small">${s.kind === 'manual' ? '人工维护' : `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="text-truncate d-inline-block" style="max-width:300px">${esc(s.url)}</a>`}
      ${s.last_error ? `<div class="text-danger mt-1">${esc(s.last_error)}</div>` : s.last_fetch_at ? `<div class="text-muted mt-1">最近读取 ${esc(shortDate(s.last_fetch_at))}</div>` : ''}</td>
    <td>${s.active ? '<span class="badge text-bg-success">启用</span>' : '<span class="badge text-bg-secondary">停用</span>'}</td>
    <td class="text-end text-nowrap">
      <form method="post" action="/briefings/sources/${s.id}/toggle" class="d-inline"><button class="btn btn-sm btn-outline-secondary">${s.active ? '停用' : '启用'}</button></form>
      <form method="post" action="/briefings/sources/${s.id}/delete" class="d-inline" onsubmit="return confirm('删除这个素材源？历史简报中的来源快照不会删除。')"><button class="btn btn-sm btn-outline-danger">删除</button></form>
    </td></tr>`).join('') || emptyRow(4, '还没有素材源，请先添加官方 RSS 或手工素材');

  const rows = data.rows.map(({ customer: c, briefing: b }) => {
    const lang = b ? b.language : defaultLanguage(c.country);
    const action = b
      ? `<a class="btn btn-sm btn-primary" href="/briefings/${b.id}"><i class="bi bi-pencil-square"></i> ${b.status === 'sent' ? '查看' : '审核 / 发送'}</a>`
      : `<form method="post" action="/briefings/generate" class="d-flex justify-content-end gap-1 brief-generate-form">
          <input type="hidden" name="customer_id" value="${c.id}">
          <select class="form-select form-select-sm" name="language" style="width:110px" aria-label="简报语言">${languageOptions(lang)}</select>
          <button class="btn btn-sm btn-outline-primary"><i class="bi bi-stars"></i> 生成本月</button>
        </form>`;
    return `<tr>
      <td><a class="fw-semibold text-decoration-none" href="/customers/${c.id}">${esc(c.company_name)}</a>
        <div class="small text-muted">${esc(c.name_en || '')}${c.name_en ? ' · ' : ''}${esc(c.country || '未填国家')}</div></td>
      <td class="small">${esc(c.industry || '未填行业')}<div class="text-muted">贡献值 ${Number(c.tier_score || 0).toFixed(1)}</div></td>
      <td>${statusBadge(b && b.status)}${b ? `<div class="small text-muted mt-1">${esc(shortDate(b.generated_at || b.updated_at))}</div>` : ''}</td>
      <td class="small">${b ? `<div class="fw-semibold">${esc(b.subject)}</div><div class="text-muted">${b.article_count || 0} 条素材 · ${esc(briefings.LANGUAGES[b.language] || b.language)}</div>` : '<span class="text-muted">按客户国家和历史报价产品生成</span>'}</td>
      <td class="text-end">${action}</td>
    </tr>`;
  }).join('') || emptyRow(5, '当前筛选下没有 B 类客户');

  const content = `<div class="container-fluid px-0">
    ${pageHead('行业简报', '把官方资讯与客户历史报价结合，先生成草稿，再人工审核通过 WhatsApp 或邮件发送', `<a class="btn btn-outline-primary" href="/customer-tiers?tier=B"><i class="bi bi-people"></i> B类客户</a>`)}
    ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
    <div class="row g-3 mb-4">
      <div class="col-6 col-xl-3"><div class="card border-0 shadow-sm h-100"><div class="card-body"><div class="text-muted small">本月 B 类客户</div><div class="display-6 fw-bold mt-1">${counts.customers}</div></div></div></div>
      <div class="col-6 col-xl-3"><div class="card border-0 shadow-sm h-100"><div class="card-body"><div class="text-muted small">已生成草稿</div><div class="display-6 fw-bold mt-1 text-warning">${counts.generated}</div></div></div></div>
      <div class="col-6 col-xl-3"><div class="card border-0 shadow-sm h-100"><div class="card-body"><div class="text-muted small">本月已发送</div><div class="display-6 fw-bold mt-1 text-success">${counts.sent}</div></div></div></div>
      <div class="col-6 col-xl-3"><div class="card border-0 shadow-sm h-100"><div class="card-body"><div class="text-muted small">启用素材源</div><div class="display-6 fw-bold mt-1">${data.sources.filter(s => s.active).length}</div></div></div></div>
    </div>
    <div class="row g-3 mb-4"><div class="col-12">${card({ title: '简报构建原则', body: `
      <div class="row g-3 small">
        <div class="col-lg-7"><div class="fw-semibold mb-1">生成逻辑</div><div class="text-muted">读取当前账号启用的 RSS/Atom 和手工素材，按照客户国家、行业、历史报价产品筛选最多 10 条素材，再由 DeepSeek 生成客户语言正文和中文内部提示。未配置 DeepSeek Key 时不能生成。</div></div>
        <div class="col-lg-5"><div class="fw-semibold mb-1">发送护栏</div><ul class="mb-0 text-muted"><li>只允许 B 类、非禁联、本人私有客户。</li><li>AI 只出草稿，必须人工审核后才能发送。</li><li>正文必须引用素材；无可靠资料时明确提示，不编造数据。</li><li>发送后自动完成本月 B 类跟进并保留原记录。</li></ul></div>
      </div>` })}</div></div>
    <div class="row g-3 mb-4"><div class="col-12">${card({ title: '素材源', body: `
      <form method="post" action="/briefings/sources" class="row g-2 align-items-end mb-3" id="briefSourceForm">
        <div class="col-md-2"><label class="form-label small">类型</label><select class="form-select" name="kind" id="briefSourceKind"><option value="rss">RSS / Atom</option><option value="manual">手工素材</option></select></div>
        <div class="col-md-3"><label class="form-label small">名称</label><input class="form-control" name="name" placeholder="例如：某国海关公告" required></div>
        <div class="col-md-4" id="briefUrlWrap"><label class="form-label small">RSS / Atom 地址</label><input class="form-control" name="url" id="briefSourceUrl" placeholder="https://..."></div>
        <div class="col-md-3"><label class="form-label small">分类 / 关键词</label><input class="form-control" name="keywords" placeholder="door hardware tariff"></div>
        <div class="col-12 d-none" id="briefContentWrap"><label class="form-label small">手工素材正文</label><textarea class="form-control" name="content" id="briefSourceContent" rows="5" placeholder="粘贴官方公告、协会报告摘要或已核实的行业资料。AI 只会基于这里的内容总结。"></textarea></div>
        <div class="col-12"><button class="btn btn-dark btn-sm"><i class="bi bi-plus-lg"></i> 添加素材源</button><span class="small text-muted ms-2">建议优先添加海关、行业协会、标准机构、展会主办方和目标国政府官网。</span></div>
      </form>
      <div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0"><thead><tr><th>素材源</th><th>地址 / 最近状态</th><th>状态</th><th class="text-end">操作</th></tr></thead><tbody>${sourceRows}</tbody></table></div>` })}</div></div>
    <div class="row g-3"><div class="col-12">${card({ body: `
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
        <div class="d-flex gap-1 flex-wrap">${filterLink('all', '全部', counts.customers)} ${filterLink('pending', '未生成', counts.customers - counts.generated)} ${filterLink('draft', '待审核', counts.generated - counts.sent)} ${filterLink('sent', '已发送', counts.sent)}</div>
        <span class="small text-muted">${esc(data.period)} · 共 ${counts.customers} 家 B 类客户</span>
      </div>
      <div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>客户</th><th>行业 / 贡献</th><th>本月状态</th><th>简报</th><th class="text-end">操作</th></tr></thead><tbody>${rows}</tbody></table></div>` })}</div></div>
  </div>
  <script>
    (function () {
      var kind = document.getElementById('briefSourceKind');
      var urlWrap = document.getElementById('briefUrlWrap');
      var contentWrap = document.getElementById('briefContentWrap');
      function syncKind() {
        var manual = kind && kind.value === 'manual';
        if (urlWrap) urlWrap.classList.toggle('d-none', manual);
        if (contentWrap) contentWrap.classList.toggle('d-none', !manual);
      }
      if (kind) kind.addEventListener('change', syncKind);
      syncKind();
      Array.prototype.forEach.call(document.querySelectorAll('.brief-generate-form'), function (form) {
        form.addEventListener('submit', function () {
          var btn = form.querySelector('button');
          if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
        });
      });
    })();
  </script>`;
  return page({ title: '行业简报', active: 'briefings', user: ctx.user, content, flash: ctx.flash() });
}

function briefingDetailPage(ctx) {
  let b;
  try { b = briefings.getBriefing(ctx.user.id, ctx.params.id); } catch (e) { b = null; }
  if (!b) return page({ title: '简报不存在', active: 'briefings', user: ctx.user, content: '<div class="alert alert-danger">简报不存在或无权操作</div><a class="btn btn-outline-secondary" href="/briefings">返回行业简报</a>', flash: ctx.flash() });
  let sources = [];
  try { sources = JSON.parse(b.sources || '[]'); } catch (e) {}
  const readonly = b.status === 'sent';
  const sourceHtml = sources.length ? sources.map((s, i) => `<li class="mb-2">
    <div class="fw-semibold">[${i + 1}] ${esc(s.title || '未命名素材')}</div>
    <div class="small text-muted">${esc(s.source || '')}${s.publishedAt ? ' · ' + esc(String(s.publishedAt).slice(0, 10)) : ''}</div>
    ${s.url ? `<a class="small" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : '<span class="small text-muted">手工素材</span>'}
  </li>`).join('') : '<li class="text-muted">没有素材快照</li>';
  const content = `<div class="container-fluid px-0">
    ${pageHead('简报审核', `${b.company_name} · ${b.period_key}`, `<a class="btn btn-outline-secondary" href="/briefings"><i class="bi bi-arrow-left"></i> 返回列表</a>`)}
    <div class="row g-3">
      <div class="col-xl-8">
        <form method="post" action="/briefings/${b.id}" id="briefingEditor">
          <div class="card border-0 shadow-sm mb-3"><div class="card-body">
            <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
              <div>${statusBadge(b.status)} ${b.status === 'sent' ? `<span class="small text-muted ms-2">发送于 ${esc(shortDate(b.sent_at))}</span>` : '<span class="small text-muted ms-2">必须人工审核后再发送</span>'}</div>
              <div class="small text-muted">${esc(briefings.LANGUAGES[b.language] || b.language)} · ${b.article_count || 0} 条素材</div>
            </div>
            <div class="mb-3"><label class="form-label">简报主题</label><input class="form-control" name="subject" value="${esc(b.subject)}" ${readonly ? 'disabled' : 'required'}></div>
            <div class="mb-2 d-flex justify-content-between align-items-center"><label class="form-label mb-0">客户正文</label><span class="small text-muted"><span id="briefCharCount">${String(b.content || '').length}</span> / 3900</span></div>
            <textarea class="form-control font-monospace" id="briefContent" name="content" rows="20" maxlength="3900" ${readonly ? 'disabled' : 'required'}>${esc(b.content)}</textarea>
            <div class="form-text">客户语言为 ${esc(briefings.LANGUAGES[b.language] || b.language)}；更改语言请返回列表重新生成。来源链接会在正文末尾自动保留，可手工删改但需重新核对。</div>
            <div class="mt-3"><label class="form-label">中文内部提示</label><textarea class="form-control" name="content_zh" rows="5" ${readonly ? 'disabled' : ''}>${esc(b.content_zh || '')}</textarea><div class="form-text">仅供业务员审核，不会发送给客户。</div></div>
          </div></div>
          ${readonly ? '' : `<div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-primary" type="submit"><i class="bi bi-save"></i> 保存草稿</button>
            <div class="d-flex gap-2 flex-wrap">
              <button class="btn btn-outline-secondary" type="button" id="briefCopy"><i class="bi bi-clipboard"></i> 复制正文</button>
              <button class="btn btn-outline-success" type="button" id="briefEmail"><i class="bi bi-envelope"></i> 用邮件发送</button>
              <button class="btn btn-success" type="submit" formaction="/briefings/${b.id}/send" id="briefSend"><i class="bi bi-whatsapp"></i> 审核通过并发送 WhatsApp</button>
            </div>
          </div>`}
        </form>
        <div class="card border-0 shadow-sm mb-3"><div class="card-heading"><h2>客户正文预览</h2></div><div class="card-body"><div class="briefing-preview">${esc(b.content)}</div></div></div>
      </div>
      <div class="col-xl-4">
        <div class="card border-0 shadow-sm mb-3"><div class="card-heading"><h2>客户与跟进</h2></div><div class="card-body small">
          <div class="mb-2"><span class="text-muted">客户：</span><a href="/customers/${b.customer_id}" class="fw-semibold text-decoration-none">${esc(b.company_name)}</a></div>
          <div class="mb-2"><span class="text-muted">国家/地区：</span>${esc(b.country || '未填写')}</div>
          <div class="mb-2"><span class="text-muted">行业：</span>${esc(b.industry || '未填写')}</div>
          <div class="mb-2"><span class="text-muted">联系人：</span>${esc(b.contact_person || '未填写')}</div>
          <div class="mb-2"><span class="text-muted">邮箱：</span>${b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : '未填写'}</div>
          <div class="mb-2"><span class="text-muted">WhatsApp：</span>${esc(b.whatsapp || b.phone || '未填写')}</div>
          <div class="alert alert-light border small mt-3 mb-0">发送成功后，本月 B 类周期跟进会自动标记完成；原跟进内容只追加简报记录，不删除手工文字。</div>
        </div></div>
        <div class="card border-0 shadow-sm"><div class="card-heading"><h2>素材来源</h2></div><div class="card-body"><ol class="list-unstyled mb-0 small">${sourceHtml}</ol></div></div>
      </div>
    </div>
  </div>
  <script>
    (function () {
      var area = document.getElementById('briefContent');
      var subject = document.querySelector('#briefingEditor input[name="subject"]');
      var count = document.getElementById('briefCharCount');
      var copy = document.getElementById('briefCopy');
      var email = document.getElementById('briefEmail');
      var send = document.getElementById('briefSend');
      function textareaValue() { return area ? area.value : ''; }
      if (area && count) area.addEventListener('input', function () { count.textContent = area.value.length; });
      if (copy) copy.addEventListener('click', function () {
        var text = textareaValue();
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { copy.textContent = '已复制'; setTimeout(function () { copy.innerHTML = '<i class="bi bi-clipboard"></i> 复制正文'; }, 1400); });
        else { area.select(); document.execCommand('copy'); }
      });
      if (email) email.addEventListener('click', function () {
        var to = ${JSON.stringify(String(b.email || ''))};
        if (!to) { alert('客户没有填写邮箱'); return; }
        var sub = subject ? subject.value : '';
        window.location.href = 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(sub) + '&body=' + encodeURIComponent(textareaValue());
      });
      if (send) send.addEventListener('click', function (e) {
        if (!confirm('确认已人工审核，并通过 WhatsApp 发送给 ' + ${JSON.stringify(String(b.company_name || ''))} + '？发送后本月简报不能再次修改。')) e.preventDefault();
      });
    })();
  </script>`;
  return page({ title: '行业简报审核', active: 'briefings', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { briefingsPage, briefingDetailPage };
