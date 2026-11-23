'use strict';

const { esc } = require('../util');
const { page } = require('./layout');
const { pageHead } = require('./ui');
const { all } = require('../db');
const knowledge = require('../knowledgeBase');

function knowledgePage(ctx) {
  const query = String(ctx.query.search || '').trim();
  const category = knowledge.CATEGORIES.includes(String(ctx.query.category || '')) ? String(ctx.query.category) : '';
  const productFilter = parseInt(ctx.query.product_id || '', 10) || 0;
  const rows = knowledge.listArticles({ query, category, product_id: productFilter });
  const requestedId = parseInt(ctx.query.article || '', 10) || 0;
  const selected = rows.find(row => Number(row.id) === requestedId) || (requestedId ? knowledge.getArticle(requestedId) : rows[0]) || null;
  const counts = knowledge.categoryCounts();
  const filterUrl = value => '/knowledge?' + [query ? 'search=' + encodeURIComponent(query) : '', value ? 'category=' + encodeURIComponent(value) : '', productFilter ? 'product_id=' + productFilter : ''].filter(Boolean).join('&');
  const articleUrl = id => '/knowledge?' + [query ? 'search=' + encodeURIComponent(query) : '', category ? 'category=' + encodeURIComponent(category) : '', productFilter ? 'product_id=' + productFilter : '', 'article=' + id].filter(Boolean).join('&');
  const linkedProducts = all('SELECT p.id, p.name, p.model FROM products p WHERE EXISTS (SELECT 1 FROM knowledge_articles a WHERE a.product_id=p.id) ORDER BY p.name');
  const productFilterHtml = linkedProducts.length ? `<form method="get" action="/knowledge" class="d-flex gap-2 mb-2"><input type="hidden" name="category" value="${esc(category)}"><select class="form-select form-select-sm" name="product_id" onchange="this.form.submit()" aria-label="按关联产品筛选"><option value="">全部产品</option>${linkedProducts.map(pr => `<option value="${pr.id}" ${productFilter === pr.id ? 'selected' : ''}>${esc(pr.name)}${pr.model ? ' · ' + esc(pr.model) : ''}</option>`).join('')}</select></form>` : '';
  const categoriesHtml = knowledge.CATEGORIES.map(item => `<a class="kb-category-link${category === item ? ' active' : ''}" href="${esc(filterUrl(category === item ? '' : item))}">
      <span><i class="bi bi-folder2 me-2"></i>${esc(item)}</span><span class="kb-count">${counts[item] || 0}</span>
    </a>`).join('');
  const rowsHtml = rows.map(article => `<a class="kb-article-link${selected && Number(selected.id) === Number(article.id) ? ' active' : ''}" href="${esc(articleUrl(article.id))}">
      <div class="kb-article-title">${esc(article.title)}</div>
      <div class="kb-article-meta">${esc(article.category)} · ${esc(String(article.updated_at || '').slice(0, 10))}</div>
      ${article.product_id ? `<div class="kb-article-product"><span class="badge text-bg-primary"><i class="bi bi-box-seam me-1"></i>${esc(article.product_name || '产品')}${article.product_model ? ' · ' + esc(article.product_model) : ''}</span></div>` : ''}
      ${article.tags ? `<div class="kb-article-tags">${esc(article.tags)}</div>` : ''}
    </a>`).join('') || `<div class="kb-empty-list">${query || category ? '没有匹配的知识条目' : '知识库还没有条目'}</div>`;
  let articleHtml = `<div class="kb-empty-state"><i class="bi bi-journal-richtext"></i><strong>选择一条知识内容</strong><span>或者新建第一篇业务资料</span><a class="btn btn-primary btn-sm" href="/knowledge/new"><i class="bi bi-plus-lg me-1"></i>新建条目</a></div>`;
  if (selected) {
    const canEdit = ctx.user.role === 'admin' || Number(selected.created_by) === Number(ctx.user.id);
    articleHtml = `<article class="kb-article-view">
      <header class="kb-article-header">
        <div class="kb-article-kicker">${esc(selected.category)}${selected.tags ? ' · ' + esc(selected.tags) : ''}</div>
        <h2>${esc(selected.title)}</h2>
        <div class="kb-article-byline">更新于 ${esc(String(selected.updated_at || '').slice(0, 16))} · ${esc(selected.author_name || 'CRM 用户')}</div>
        ${selected.product_id ? `<div class="mt-2"><a class="badge text-bg-primary text-decoration-none" href="/products/${selected.product_id}"><i class="bi bi-box-seam me-1"></i>关联产品：${esc(selected.product_name || '')}${selected.product_model ? ' · ' + esc(selected.product_model) : ''}</a></div>` : ''}
        ${canEdit ? `<a class="btn btn-sm btn-outline-secondary" href="/knowledge/${selected.id}/edit"><i class="bi bi-pencil me-1"></i>编辑</a>` : ''}
      </header>
      <div class="kb-markdown">${knowledge.renderMarkdown(selected.content)}</div>
    </article>`;
  }

  const content = `
    ${pageHead('知识库与 AI 助手', '基于 Obsidian 知识库 · 产品资料 · 报价政策 · 工厂资料 · 外贸经验，为外贸业务提供专业答案与执行建议', `<a class="btn btn-primary" href="/knowledge/new"><i class="bi bi-plus-lg me-1"></i>新建条目</a>`)}
    <div class="kb-2col workbench-2" style="margin-bottom:14px">
      <div class="ai-panel" aria-label="AI 助手对话">
        <h3 class="ai-panel-title"><i class="bi bi-robot"></i> AI 助手对话</h3>
        <div class="small"><b>提问：</b>执手锁 LS-8801，如果出口到美国市场，MOQ、单价、交期大概是多少？需要注意哪些合规要求？</div>
        <div class="small" style="margin-top:8px"><b>AI 综合建议：</b>根据知识库中的产品资料、报价政策和出口合规经验：<br>1. 报价与起订量（参考）：执手锁 LS-8801，304 不锈钢拉丝，MOQ 500 PCS，单价、MOQ、交期以产品信息为准。<br>2. 交期：打样 5 天；大货 15 天。<br>3. 美国市场合规要点：锁具建议符合 ANSI/BHMA 等级要求；包装标注尺寸、毛重、净重及 “Made in China”。<br>4. 建议：新品测试可从 500 件起订，订单稳定后可谈阶梯价。</div>
        <div class="text-muted small mt-2">信息来源（Obsidian 知识库）：报价政策_MOQ与价格.md · 产品资料_执手锁 LS-8801.md · 出口合规_美国市场.md</div>
      </div>
      <div class="ai-panel" aria-label="知识检索结果与产品关键信息">
        <h3 class="ai-panel-title"><i class="bi bi-journal-richtext"></i> 知识检索结果</h3>
        <div class="small">为您检索到 3 条相关知识：报价政策_MOQ与价格.md（高度相关） · 产品资料_执手锁 LS-8801.md（高度相关） · 出口合规_美国市场.md（相关）</div>
        <div class="small" style="margin-top:8px"><b>产品关键信息 — 执手锁 LS-8801</b><br>材质：304 不锈钢 · 表面处理：拉丝 · 含安装螺丝包<br>MOQ：500 PCS · 生产交期：样品 5 天，大货 15 天<br>合规要求（美国）：ANSI/BHMA 等级 · 包装标注 Made in China<br>参考单价：以产品信息为准</div>
        <div class="small" style="margin-top:8px"><b>AI 判断与可信度 96%</b><br><span class="ai-check">✓</span> 答案基于知识库内容生成<br><span class="ai-check">✓</span> 已匹配报价政策与产品资料<br><span class="ai-check">✓</span> 包含出口合规建议（美国）</div>
      </div>
      <div class="small text-muted">左栏分类计数复用现有知识库分类统计；对话内容为图片里的示例问答，真实问答仍走现有 CRM 数据助理接口。</div>
    </div>
    <div class="kb-workspace">
      <aside class="kb-pane kb-category-pane">
        <div class="kb-pane-heading"><i class="bi bi-collection me-2"></i>知识分类</div>
        <a class="kb-category-link${!category ? ' active' : ''}" href="${esc(filterUrl(''))}"><span><i class="bi bi-grid me-2"></i>全部内容</span><span class="kb-count">${Object.values(counts).reduce((sum, value) => sum + value, 0)}</span></a>
        ${categoriesHtml}
      </aside>
      <section class="kb-pane kb-list-pane">
        <form method="get" action="/knowledge" class="kb-search">
          ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
          ${productFilter ? `<input type="hidden" name="product_id" value="${productFilter}">` : ''}
          <i class="bi bi-search"></i><input name="search" value="${esc(query)}" placeholder="搜索标题、标签或内容" aria-label="搜索知识库"><button class="btn btn-sm btn-outline-secondary">搜索</button>
        </form>
        ${productFilterHtml}
        <div class="kb-list-heading"><span>${category ? esc(category) : '全部内容'}</span><span>${rows.length} 条</span></div>
        <div class="kb-article-list">${rowsHtml}</div>
      </section>
      <section class="kb-pane kb-preview-pane">${articleHtml}</section>
    </div>`;
  return page({ title: '知识库', active: 'knowledge', user: ctx.user, content, flash: ctx.flash() });
}

function knowledgeFormPage(ctx) {
  const id = parseInt(ctx.params.id || '', 10) || 0;
  const article = id ? knowledge.getArticle(id) : null;
  if (id && !article) {
    return page({ title: '知识条目不存在', active: 'knowledge', user: ctx.user, content: '<div class="alert alert-warning">知识条目不存在</div>', flash: ctx.flash() });
  }
  const value = article || {};
  const action = article ? '/knowledge/' + article.id : '/knowledge';
  const presetCategory = knowledge.CATEGORIES.includes(String(ctx.query.category || '')) ? String(ctx.query.category) : '';
  const presetProductId = parseInt(ctx.query.product_id || '', 10) || 0;
  const defCategory = article ? article.category : (presetCategory || '产品资料');
  const curProductId = article ? (Number(article.product_id) || 0) : presetProductId;
  const categoryOptions = knowledge.CATEGORIES.map(item => `<option value="${esc(item)}" ${String(value.category || defCategory) === item ? 'selected' : ''}>${esc(item)}</option>`).join('');
  const productOptions = all('SELECT id,name,model FROM products ORDER BY name').map(pr => `<option value="${pr.id}" ${curProductId === pr.id ? 'selected' : ''}>${esc(pr.name)}${pr.model ? ' · ' + esc(pr.model) : ''}</option>`).join('');
  const content = `
    ${pageHead(article ? '编辑知识条目' : '新建知识条目', '内容保存到团队共享知识库', `<a class="btn btn-outline-secondary" href="/knowledge${article ? '?article=' + article.id : ''}"><i class="bi bi-arrow-left me-1"></i>返回知识库</a>`)}
    <section class="kb-editor-shell">
      <form method="post" action="${action}" class="kb-editor-form">
        <div class="kb-editor-fields">
          <label class="kb-field"><span>标题</span><input class="form-control" name="title" value="${esc(value.title || '')}" maxlength="180" required placeholder="输入清晰、便于搜索的标题"></label>
          <label class="kb-field"><span>分类</span><select class="form-select" name="category" required>${categoryOptions}</select></label>
          <label class="kb-field" id="kbProductField"><span>关联产品</span><select class="form-select" name="product_id" id="kbProductSelect"><option value="">— 请选择产品 —</option>${productOptions}</select><small class="text-muted">分类选“产品资料”时必须关联一个产品；价格、MOQ、交期以产品信息为准，不要写进文章。</small></label>
          <label class="kb-field kb-field-tags"><span>标签</span><input class="form-control" name="tags" value="${esc(value.tags || '')}" maxlength="500" placeholder="用逗号分隔，例如：门锁, FOB, MOQ"></label>
        </div>
        <label class="kb-field kb-content-field"><span>正文</span><textarea class="form-control kb-editor-text" name="content" maxlength="60000" rows="22" required placeholder="输入产品规格、报价政策、工厂资料或实际外贸经验。支持 Markdown 格式。">${esc(value.content || '')}</textarea></label>
        <div class="kb-editor-footer"><span class="text-muted small">原始 HTML 不会执行；图片只显示 CRM 本地上传目录中的文件。</span><div class="d-flex gap-2"><a class="btn btn-outline-secondary" href="/knowledge">取消</a><button class="btn btn-primary"><i class="bi bi-check-lg me-1"></i>保存条目</button></div></div>
      </form>
      <script>
        (function () {
          var cat = document.querySelector('select[name="category"]');
          var sel = document.getElementById('kbProductSelect');
          var field = document.getElementById('kbProductField');
          if (!cat || !sel || !field) return;
          function sync(clear) {
            var need = cat.value === '产品资料';
            sel.required = need;
            field.style.display = (need || sel.value) ? '' : 'none';
            if (!need && clear) sel.value = '';
          }
          cat.addEventListener('change', function () { sync(true); });
          sync(false);
        })();
      <\/script>
    </section>`;
  return page({ title: article ? '编辑知识条目' : '新建知识条目', active: 'knowledge', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { knowledgePage, knowledgeFormPage };
