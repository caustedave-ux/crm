'use strict';

const MarkdownIt = require('markdown-it');
const { all, get } = require('./db');

const CATEGORIES = Object.freeze([
  '产品资料',
  '报价政策',
  '工厂资料',
  '外贸术语',
  '历史经验',
  '问答',
]);

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const defaultLinkOpen = markdown.renderer.rules.link_open || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = String(token.attrGet('href') || '');
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

const defaultImage = markdown.renderer.rules.image || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const src = String(token.attrGet('src') || '');
  if (!/^\/(?:uploads|static)\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|gif|webp)$/i.test(src) || src.split('/').includes('..')) {
    return `<span class="kb-image-omitted">${markdown.utils.escapeHtml(token.content || '外部图片未显示')}</span>`;
  }
  return defaultImage(tokens, index, options, env, self);
};

function renderMarkdown(source) {
  return markdown.render(String(source || ''));
}

function listArticles(options) {
  const opts = options || {};
  const query = String(opts.query || '').trim().slice(0, 120);
  const category = CATEGORIES.includes(String(opts.category || '')) ? String(opts.category) : '';
  const productId = parseInt(opts.product_id, 10) || 0;
  const where = [];
  const params = [];
  if (category) {
    where.push('a.category=?');
    params.push(category);
  }
  if (productId) {
    where.push('a.product_id=?');
    params.push(productId);
  }
  if (query) {
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);
    where.push('(' + terms.map(() => "(a.title LIKE ? ESCAPE '\\' OR a.tags LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\')").join(' AND ') + ')');
    for (const term of terms) {
      const like = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
      params.push(like, like, like);
    }
  }
  return all(`SELECT a.*,u.display_name AS author_name,p.name AS product_name,p.model AS product_model
    FROM knowledge_articles a LEFT JOIN users u ON u.id=a.created_by
    LEFT JOIN products p ON p.id=a.product_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.updated_at DESC,a.id DESC LIMIT 300`, ...params);
}

function getArticle(id) {
  return get(`SELECT a.*,u.display_name AS author_name,p.name AS product_name,p.model AS product_model
    FROM knowledge_articles a LEFT JOIN users u ON u.id=a.created_by
    LEFT JOIN products p ON p.id=a.product_id WHERE a.id=?`, id) || null;
}

function canEditArticle(article, user) {
  return !!article && !!user && (String(user.role) === 'admin' || Number(article.created_by) === Number(user.id));
}

function categoryCounts() {
  const counts = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  for (const row of all('SELECT category,COUNT(*) AS count FROM knowledge_articles GROUP BY category')) {
    if (Object.prototype.hasOwnProperty.call(counts, row.category)) counts[row.category] = Number(row.count) || 0;
  }
  return counts;
}

function questionTerms(question) {
  const q = String(question || '').toLowerCase();
  const terms = new Set((q.match(/[a-z0-9][a-z0-9._-]{1,}/g) || []).filter(x => x.length <= 32));
  for (const run of q.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let size = 2; size <= Math.min(4, run.length); size++) {
      for (let i = 0; i <= run.length - size; i++) terms.add(run.slice(i, i + size));
    }
  }
  const stop = new Set(['什么', '怎么', '如何', '可以', '帮我', '请问', '我们', '你们', '这个', '那个', '产品', '客户', '资料', '多少', '是否', '有关', '如果', '以及']);
  return [...terms].filter(term => !stop.has(term)).slice(0, 36);
}

function relevantArticles(question, limit) {
  const terms = questionTerms(question);
  if (!terms.length) return [];
  const rows = all(`SELECT id,title,category,tags,content,product_id,updated_at
    FROM knowledge_articles ORDER BY updated_at DESC,id DESC LIMIT 1000`);
  const ranked = rows.map(article => {
    const title = String(article.title || '').toLowerCase();
    const tags = String(article.tags || '').toLowerCase();
    const content = String(article.content || '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += term.length > 2 ? 8 : 4;
      if (tags.includes(term)) score += term.length > 2 ? 6 : 3;
      if (content.includes(term)) score += term.length > 2 ? 2 : 1;
    }
    // 已关联产品的“产品资料”降权一半：价格/MOQ/交期以 products 表为准，文章只作补充，
    // 避免 AI 复述文章里的旧价；未关联的报价政策/工厂资料等不受影响。
    if (score > 0 && article.category === '产品资料' && article.product_id) score *= 0.5;
    return { article, score };
  }).filter(item => item.score > 0);
  ranked.sort((a, b) => b.score - a.score || String(b.article.updated_at || '').localeCompare(String(a.article.updated_at || '')));
  return ranked.slice(0, Math.max(1, Math.min(8, Number(limit) || 4))).map(item => item.article);
}

function contextForQuestion(question, limit) {
  return relevantArticles(question, limit).map(article => {
    const content = String(article.content || '').trim().slice(0, 5000);
    const linkedNote = article.product_id ? '（已关联产品，价格/MOQ/交期以产品信息为准）' : '';
    return `【${article.category}｜${article.title}】${linkedNote}\n${content}`;
  }).join('\n\n');
}

module.exports = {
  CATEGORIES,
  canEditArticle,
  categoryCounts,
  contextForQuestion,
  getArticle,
  listArticles,
  relevantArticles,
  renderMarkdown,
};
