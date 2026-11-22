'use strict';
// ============ 单据模板渲染引擎 ============
// 支持占位符 {{a.b.c}} 与明细循环区 <!-- ITEMS:BEGIN --> ... <!-- ITEMS:END -->
// ctx 中所有值应为“可直接嵌入 HTML 的安全字符串”（调用方负责转义/格式化）

function lookupPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
const ITEMS_RE = /<!--\s*ITEMS:BEGIN\s*-->([\s\S]*?)<!--\s*ITEMS:END\s*-->/g;

function replaceTokens(text, ctx) {
  return text.replace(TOKEN_RE, (m, path) => {
    const v = lookupPath(ctx, path);
    return (v === null || v === undefined) ? '' : String(v);
  });
}

function renderTemplate(content, ctx) {
  if (!content) return '';
  let html = content;
  // 明细循环
  html = html.replace(ITEMS_RE, (whole, rowTpl) => {
    const items = (ctx.items && Array.isArray(ctx.items)) ? ctx.items : [];
    if (!items.length) return '';
    return items.map(it => {
      const merged = Object.assign({}, ctx, { item: it });
      return replaceTokens(rowTpl, merged);
    }).join('\n');
  });
  // 其余占位符
  html = replaceTokens(html, ctx);
  return html;
}

module.exports = { renderTemplate, replaceTokens };
