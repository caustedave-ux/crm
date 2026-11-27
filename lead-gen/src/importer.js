'use strict';
/**
 * 线索导入：支持 CSV / 粘贴文本（TSV、逗号、每行一条公司名）
 * 智能识别列名中英文别名，自动去重（域名优先，其次规范化公司名）
 */
const fs = require('node:fs');
const norm = require('./normalize');
const { run, get, all, now, log } = require('./db');

// 列名别名映射
const COL_ALIASES = {
  company_name: ['公司名称', '公司', 'company', 'company name', '企业名称', '名称', 'name', '客户名称'],
  website: ['网址', '网站', '官网', 'website', 'web', 'url', 'site', '域名', 'domain'],
  country: ['国家', '国家地区', '地区', 'country', 'country/region', 'market', '市场'],
  industry_hint: ['行业', '行业分类', '主营产品', '产品', 'industry', 'product', 'category', '业务'],
  size_hint: ['规模', '公司规模', 'size', 'company size', '员工规模'],
  employee_hint: ['员工数', '员工人数', 'employees', 'employee', 'headcount'],
  source: ['来源', 'source', '渠道', '获客渠道'],
  notes: ['备注', '说明', 'notes', 'note', 'remark'],
};

function matchColumn(header) {
  const h = String(header || '').trim().toLowerCase().replace(/[\s_\-]/g, '');
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    for (const a of aliases) {
      if (h === a.toLowerCase().replace(/[\s_\-]/g, '')) return field;
    }
  }
  return null;
}

/** 解析 CSV 行（处理引号内逗号） */
function parseCsvLine(line, delim = ',') {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === delim && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/**
 * 解析原始文本为行对象数组
 */
function parseRows(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  // 判断分隔符：优先 tab，其次逗号，否则「每行一个公司名」
  const first = lines[0];
  let delim = null;
  if (first.includes('\t')) delim = '\t';
  else if (first.includes(',')) delim = ',';
  if (!delim) {
    return lines.map(l => ({ company_name: l.trim() }));
  }
  let headers = parseCsvLine(first, delim).map(matchColumn);
  const hasHeader = headers.some(Boolean);
  if (!hasHeader) {
    return lines.map(l => {
      const cols = parseCsvLine(l, delim);
      return { company_name: cols[0] || '', website: cols[1] || '', country: cols[2] || '' };
    });
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line, delim);
    const obj = {};
    headers.forEach((h, i) => { if (h && cols[i] !== undefined) obj[h] = cols[i]; });
    if (obj.company_name) rows.push(obj);
  }
  return rows;
}

/**
 * 导入线索，返回 { inserted, duplicates, total, ids }
 */
function importLeads(rows, opts = {}) {
  const batchName = opts.batch_name || '';
  const source = opts.source || 'manual';
  const t = now();
  const b = run('INSERT INTO batches(filename,source,note,row_count,created_at) VALUES(?,?,?,?,?)',
    batchName, source, opts.note || '', rows.length, t);
  const batchId = Number(b.lastInsertRowid);

  let inserted = 0, duplicates = 0;
  const ids = [];
  for (const row of rows) {
    const company = String(row.company_name || '').trim();
    if (!company) continue;
    const domain = norm.normalizeDomain(row.website || '');
    const dedupKey = domain ? `d:${domain}` : `n:${norm.normalizeCompanyName(company)}`;
    const exists = get('SELECT id FROM leads WHERE dedup_key=?', dedupKey);
    if (exists) {
      duplicates++;
      ids.push(exists.id);
      continue;
    }
    const r = run(`INSERT INTO leads
      (batch_id,company_name,website,domain,country,industry_hint,size_hint,employee_hint,source,status,dedup_key,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'new',?,?,?,?)`,
      batchId, company, row.website || '', domain, row.country || '', row.industry_hint || '',
      row.size_hint || '', row.employee_hint || '', row.source || source, dedupKey, row.notes || '', t, t);
    ids.push(Number(r.lastInsertRowid));
    inserted++;
  }
  log('info', `导入线索：总计 ${rows.length}，新增 ${inserted}，重复 ${duplicates}`);
  return { batch_id: batchId, inserted, duplicates, total: rows.length, ids };
}

module.exports = { parseRows, importLeads, matchColumn, COL_ALIASES };
