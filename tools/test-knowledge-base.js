'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tempBase = path.join('D:\\Codex', 'tmp');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'crm-knowledge-test-'));
process.env.CRM_DB = path.join(tempRoot, 'knowledge.db');

const { db, run } = require('../src/db');
const knowledge = require('../src/knowledgeBase');

try {
  assert.deepStrictEqual(knowledge.CATEGORIES, ['选型指南', '产品资料', '报价政策', '工厂资料', '外贸术语', '历史经验', '问答']);
  assert.strictEqual(knowledge.categoryCounts()['产品资料'], 0);

  const stamp = '2026-11-21 10:00:00';
  const articleId = Number(run(`INSERT INTO knowledge_articles(title,category,tags,content,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`, 'Door Lock Quotation Guide', '报价政策', 'door lock, FOB, MOQ',
  '# Door lock quotation\n\nMOQ is 500 pcs. Use FOB Shenzhen unless the buyer requests another term.\n\n<script>alert(1)</script>', 1, stamp, stamp).lastInsertRowid);
  run(`INSERT INTO knowledge_articles(title,category,tags,content,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`, 'Factory Packing Notes', '工厂资料', 'carton, packing',
  'Carton size should be confirmed before booking.', 1, stamp, stamp);

  assert.strictEqual(knowledge.listArticles({ query: 'door FOB', category: '报价政策' }).length, 1);
  assert.strictEqual(knowledge.listArticles({ query: 'door FOB', category: '工厂资料' }).length, 0);
  assert.strictEqual(Number(knowledge.getArticle(articleId).id), articleId);
  assert.strictEqual(knowledge.categoryCounts()['报价政策'], 1);
  assert.strictEqual(knowledge.canEditArticle({ created_by: 9 }, { id: 9, role: 'staff' }), true);
  assert.strictEqual(knowledge.canEditArticle({ created_by: 9 }, { id: 10, role: 'staff' }), false);
  assert.strictEqual(knowledge.canEditArticle({ created_by: 9 }, { id: 10, role: 'admin' }), true);

  const rendered = knowledge.renderMarkdown(knowledge.getArticle(articleId).content);
  assert(rendered.includes('<h1>Door lock quotation</h1>'));
  assert(rendered.includes('<script>') === false, 'raw HTML is escaped/disabled');
  assert(rendered.includes('&lt;script&gt;'));
  assert(knowledge.renderMarkdown('![remote](https://example.com/a.jpg)').includes('kb-image-omitted'));
  assert(knowledge.renderMarkdown('![local](/uploads/knowledge/door.jpg)').includes('<img'));

  const matches = knowledge.relevantArticles('What is MOQ and FOB for door lock?');
  assert(matches.some(row => Number(row.id) === articleId), 'AI retrieval finds relevant article');
  assert(knowledge.contextForQuestion('door lock MOQ').includes('MOQ is 500 pcs'));
  assert.strictEqual(knowledge.contextForQuestion('unrelated astronomy galaxy'), '');
  console.log('知识库测试全部通过');
} finally {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
