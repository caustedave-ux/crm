'use strict';
// ============ 表单 / 页面小组件（HQ CRM UI） ============
const { esc } = require('../util');

function labelCls() { return 'form-label'; }

function fld(o) {
  const id = o.id || ('f_' + (o.name || '') + '_' + Math.random().toString(36).slice(2, 7));
  const req = o.required ? 'required' : '';
  const readonly = o.readonly ? 'readonly aria-readonly="true"' : '';
  const val = (o.value === null || o.value === undefined) ? '' : String(o.value);
  let label = o.label ? `<label class="${labelCls()}" for="${id}">${esc(o.label)}${o.required ? ' <span class="text-danger">*</span>' : ''}</label>` : '';
  const help = o.help ? `<div class="form-text">${o.help}</div>` : '';
  let input = '';
  if (o.type === 'textarea') {
    input = `<textarea class="form-control" id="${id}" name="${esc(o.name)}" rows="${o.rows || 3}" ${req} ${o.placeholder ? 'placeholder="' + esc(o.placeholder) + '"' : ''}>${esc(val)}</textarea>`;
  } else if (o.type === 'select') {
    const opts = (o.options || []).map(op => `<option value="${esc(op.v)}" ${String(op.v) === val ? 'selected' : ''}>${esc(op.l)}</option>`).join('');
    input = `<select class="form-select" id="${id}" name="${esc(o.name)}" ${req}>${opts}</select>`;
  } else if (o.type === 'checkbox') {
    input = `<div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" id="${id}" name="${esc(o.name)}" value="1" ${o.checked ? 'checked' : ''}><label class="form-check-label" for="${id}">${esc(o.label2 || '')}</label></div>`;
    label = '';
  } else {
    const t = o.type || 'text';
    input = `<input type="${t}" class="form-control" id="${id}" name="${esc(o.name)}" value="${esc(val)}" ${req} ${readonly} ${o.placeholder ? 'placeholder="' + esc(o.placeholder) + '"' : ''} ${o.step ? 'step="' + o.step + '"' : ''} ${o.min !== undefined ? 'min="' + o.min + '"' : ''}>`;
  }
  const col = o.col ? `<div class="col-${o.col}">` : '';
  const end = o.col ? '</div>' : '';
  return `${col}${label}${input}${help}${end}`;
}

function card(opts) {
  const head = opts.title ? `<div class="card-header"><div class="card-head-row">
    <h2 class="card-heading">${opts.title}</h2><div class="card-actions">${opts.actions || ''}</div></div></div>` : '';
  return `<section class="card neo-card mb-4">${head}<div class="card-body ${opts.bodyClass || ''}">${opts.body}</div></section>`;
}

function pageHead(title, sub, actions) {
  return `<div class="page-heading">
    <div class="page-heading-copy">
      <div class="page-eyebrow">Trade Operations Workspace</div>
      <h1 class="page-title">${title}</h1>
      ${sub ? `<div class="page-subtitle">${sub}</div>` : ''}
    </div>
    <div class="page-actions">${actions || ''}</div>
  </div>`;
}

function badge(text) {
  const map = {
    '潜在客户': 'secondary', '意向客户': 'info', '报价中': 'primary', '合作客户': 'success', '流失客户': 'danger',
    '普通': 'secondary', '重要': 'warning', 'VIP': 'danger',
    'A': 'danger', 'B': 'warning', 'C': 'info', 'D': 'dark',
    'A类': 'danger', 'B类': 'warning', 'C类': 'info', 'D类': 'dark',
    '初步接触': 'secondary', '需求确认': 'info', '方案报价': 'primary', '样品确认': 'warning', '商务谈判': 'dark', '赢单': 'success', '丢单': 'danger',
    '草稿': 'secondary', '已发送': 'primary', '已确认': 'info', '已完成': 'success', '已作废': 'danger',
    '管理员': 'warning', '业务员': 'secondary',
  };
  const cls = map[text] || 'secondary';
  return `<span class="badge text-bg-${cls}">${esc(text)}</span>`;
}

function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="text-center text-muted py-5">${text || '暂无数据'}</td></tr>`;
}

module.exports = { fld, card, pageHead, badge, emptyRow, labelCls };

