'use strict';
// ============ 产品管理 × 知识库合并：数据迁移建议清单 ============
// 用法（在系统所在电脑上）：node tools/migrate-products.js
// 只做两件事，不写业务数据：
//   1. 按品名/型号关键词给现有产品预分分类，输出“建议分类清单”和“未分类清单”
//   2. 扫描 category='产品资料' 的文章，标题/正文命中某产品型号或品名即候选关联，输出“建议关联清单”
// 关联与分类只生成清单，人工确认后在产品管理 / 知识库页面里手工改，不要直接跑 SQL 写库。
// 注意：require('../src/db') 会先跑系统启动迁移（建新表、补列、删除服装示例文章），
//      运行前请确认 data/crm.db 已备份（系统启动时会自动备份到 data/backups/）。
const fs = require('fs');
const path = require('path');
const { db, all, get } = require('../src/db');

const CATEGORY_RULES = [
  { name: '锁体', keys: ['锁体', 'lock body', 'mortise'] },
  { name: '把手', keys: ['把手', '执手', '拉手', 'handle', 'lever'] },
  { name: '锁芯', keys: ['锁芯', '锁胆', 'cylinder'] },
  { name: '合页', keys: ['合页', '铰链', 'hinge'] },
  { name: '智能锁', keys: ['智能锁', '指纹锁', '密码锁', 'smart lock'] },
  { name: '门吸', keys: ['门吸', '插销', '门挡', 'bolt'] },
];

function suggestCategory(p) {
  const hay = [p.name, p.name_en, p.model].map(x => String(x || '').toLowerCase()).join(' ');
  for (const rule of CATEGORY_RULES) {
    const hit = rule.keys.find(k => hay.includes(k.toLowerCase()));
    if (hit) return { category: rule.name, evidence: '命中关键词「' + hit + '」' };
  }
  return null;
}

function main() {
  const categories = all('SELECT * FROM product_categories ORDER BY sort_order');
  const catByName = new Map(categories.map(c => [c.name, c.id]));
  const products = all('SELECT * FROM products ORDER BY id');
  const suggestions = [];
  const unclassified = [];
  for (const p of products) {
    const s = suggestCategory(p);
    if (s) suggestions.push({ id: p.id, name: p.name, model: p.model || '', category: s.category, evidence: s.evidence, categoryKnown: catByName.has(s.category) });
    else unclassified.push({ id: p.id, name: p.name, model: p.model || '' });
  }

  const articles = all("SELECT * FROM knowledge_articles WHERE category='产品资料' ORDER BY id");
  const linkSuggestions = [];
  const noMatch = [];
  for (const a of articles) {
    const hay = [a.title, a.tags, a.content].map(x => String(x || '')).join('\n');
    const hits = [];
    for (const p of products) {
      const model = String(p.model || '').trim();
      const name = String(p.name || '').trim();
      if (model && model.length >= 3 && hay.includes(model)) hits.push({ id: p.id, name: p.name, model, evidence: '正文/标题出现型号「' + model + '」' });
      else if (name && name.length >= 2 && hay.includes(name)) hits.push({ id: p.id, name: p.name, model: model || '', evidence: '正文/标题出现品名「' + name + '」' });
    }
    if (hits.length === 1) linkSuggestions.push({ articleId: a.id, title: a.title, product: hits[0] });
    else if (hits.length > 1) linkSuggestions.push({ articleId: a.id, title: a.title, product: null, multi: hits, note: '命中多个产品，需人工复核' });
    else noMatch.push({ articleId: a.id, title: a.title });
  }

  const lines = [];
  lines.push('# 产品分类预分 + 文章关联建议清单');
  lines.push('');
  lines.push('> 由 `node tools/migrate-products.js` 生成，仅供人工确认；不要直接按此文件写库。');
  lines.push('> 分类请在产品管理里逐个确认；文章关联请在知识库里逐篇确认。');
  lines.push('');
  lines.push('## 1. 产品分类建议（' + suggestions.length + ' 款）');
  lines.push('');
  lines.push('| 产品ID | 品名 | 型号 | 建议分类 | 依据 |');
  lines.push('|---|---|---|---|---|');
  for (const s of suggestions) lines.push(`| ${s.id} | ${s.name} | ${s.model || '-'} | ${s.category} | ${s.evidence} |`);
  if (!suggestions.length) lines.push('_（无）_');
  lines.push('');
  lines.push('## 2. 未分类产品（' + unclassified.length + ' 款，需人工分）');
  lines.push('');
  for (const p of unclassified) lines.push(`- 产品 #${p.id} ${p.name}${p.model ? '（' + p.model + '）' : ''}`);
  if (!unclassified.length) lines.push('_（无）_');
  lines.push('');
  lines.push('## 3. 文章—产品关联建议（' + linkSuggestions.length + ' 篇）');
  lines.push('');
  for (const s of linkSuggestions) {
    if (s.product) lines.push(`- 文章 #${s.articleId}《${s.title}》→ 产品 #${s.product.id} ${s.product.name}（${s.product.model || '无型号'}），${s.product.evidence}`);
    else lines.push(`- 文章 #${s.articleId}《${s.title}》→ ${s.note}：${s.multi.map(m => '#' + m.id + ' ' + m.name + '（' + m.evidence + '）').join('；')}`);
  }
  if (!linkSuggestions.length) lines.push('_（无）_');
  lines.push('');
  lines.push('## 4. 未匹配到产品的文章（' + noMatch.length + ' 篇，需人工处理）');
  lines.push('');
  for (const a of noMatch) lines.push(`- 文章 #${a.articleId}《${a.title}》`);
  if (!noMatch.length) lines.push('_（无）_');
  lines.push('');

  const outPath = path.join(__dirname, '..', 'data', 'product-migration-suggestions.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('产品总数：' + products.length + '，建议分类：' + suggestions.length + '，未分类：' + unclassified.length);
  console.log('产品资料文章：' + articles.length + ' 篇，建议关联：' + linkSuggestions.length + '，未匹配：' + noMatch.length);
  console.log('清单已写入：' + outPath);
  console.log('注意：清单只供人工确认，关联与分类请在页面里手工改，不要直接跑 SQL 写库。');
}

try {
  main();
} finally {
  try { db.close(); } catch (e) {}
}
