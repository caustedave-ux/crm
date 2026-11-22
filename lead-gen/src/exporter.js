'use strict';
/**
 * Excel 报告导出：从 lead-gen 独立库读取数据，生成多 sheet 画像报告
 * 依赖 exceljs（复用主系统 node_modules，独立目录无需 npm install）
 */
const path = require('node:path');
const fs = require('node:fs');
let ExcelJS;
try {
  ExcelJS = require(path.join(__dirname, '..', '..', 'node_modules', 'exceljs'));
} catch { try { ExcelJS = require('exceljs'); } catch { ExcelJS = null; } }

const { all, get, DATA_DIR } = require('./db');

function parseResult(row) {
  try { return JSON.parse(row.result_json || '{}'); } catch { return {}; }
}

const STAGE_CN = { candidate: '候选池', approved: '审批通过', rejected: '已驳回' };

/** 导出线索画像报告，返回文件路径 */
async function exportReport(opts = {}) {
  if (!ExcelJS) throw new Error('exceljs 不可用，请确认主系统 node_modules/exceljs 存在');
  const ids = opts.ids;
  const where = [];
  const params = [];
  if (opts.stage) { where.push("COALESCE(stage,'candidate')=?"); params.push(opts.stage); }
  if (ids && ids.length) { where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  const sql = 'SELECT * FROM leads' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY COALESCE(recommend_score,0) DESC, overall_score DESC, id DESC';
  const rows = all(sql, ...params);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'lead-gen 获客核验系统';
  wb.created = new Date();

  // Sheet 1: 线索总览
  const ws = wb.addWorksheet('线索总览', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'ID', key: 'id', width: 7 },
    { header: '公司名称', key: 'company', width: 26 },
    { header: '国家', key: 'country', width: 10 },
    { header: '官网', key: 'website', width: 24 },
    { header: '一级行业', key: 'sector', width: 16 },
    { header: '细分行业', key: 'sub', width: 18 },
    { header: '规模档', key: 'size', width: 16 },
    { header: '员工估算', key: 'emp', width: 11 },
    { header: '社媒粉丝', key: 'followers', width: 12 },
    { header: '成立年份', key: 'founded', width: 10 },
    { header: '社媒平台', key: 'social', width: 26 },
    { header: '可信分', key: 'score', width: 9 },
    { header: '推荐分', key: 'recommend', width: 9 },
    { header: '推荐等级', key: 'recommend_level', width: 11 },
    { header: '审批状态', key: 'stage', width: 14 },
    { header: '等级', key: 'level', width: 7 },
    { header: '核验状态', key: 'status', width: 11 },
    { header: '冲突数', key: 'conflicts', width: 8 },
    { header: '证据数', key: 'evidence', width: 8 },
    { header: '线索来源', key: 'source', width: 14 },
    { header: '备注', key: 'notes', width: 20 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };

  for (const lead of rows) {
    const ver = get('SELECT * FROM verifications WHERE lead_id=? ORDER BY id DESC LIMIT 1', lead.id);
    const r = ver ? parseResult(ver) : {};
    const s = r.summary || {};
    ws.addRow({
      id: lead.id, company: lead.company_name, country: lead.country, website: lead.website,
      sector: s.industry_sector || '', sub: s.industry_sub || '', size: s.size_bucket || '',
      emp: s.employees_est || '', followers: s.followers || '', founded: s.founded || '',
      social: (s.social_platforms || []).join('、'),
      score: ver ? ver.overall_score : 0, level: r.level || '',
      recommend: lead.recommend_score || 0,
      recommend_level: (r.recommendation || {}).level || '',
      stage: STAGE_CN[lead.stage || 'candidate'] || lead.stage || '候选池',
      status: ver ? (r.suggested_status === 'verified' ? '已验证' : r.suggested_status === 'review' ? '待复核' : '信息不足') : '未核验',
      conflicts: ver ? ver.conflict_count : 0, evidence: r.evidence_count || 0,
      source: lead.source || '', notes: lead.notes || '',
    });
  }
  // 分数条件着色
  ws.getColumn('score').eachCell((cell, rn) => {
    if (rn === 1) return;
    const v = cell.value;
    if (v >= 75) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
    else if (v >= 45) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
    else cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBAD' } };
  });
  ws.getColumn('recommend').eachCell((cell, rn) => {
    if (rn === 1) return;
    const v = cell.value;
    if (v >= 80) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
    else if (v >= 60) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
  });
  ws.autoFilter = { from: 'A1', to: `U${Math.max(rows.length + 1, 1)}` };

  // Sheet 2: 字段级验证明细
  const ws2 = wb.addWorksheet('字段验证明细', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws2.columns = [
    { header: '线索ID', key: 'lid', width: 9 },
    { header: '公司名称', key: 'company', width: 24 },
    { header: '字段', key: 'field', width: 12 },
    { header: '结论值', key: 'value', width: 30 },
    { header: '置信度', key: 'conf', width: 10 },
    { header: '状态', key: 'status', width: 10 },
    { header: '证据数', key: 'evc', width: 9 },
  ];
  ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
  const FIELD_CN = { industry: '行业', size: '规模', country: '国家', website: '官网', social: '社媒', founded: '成立年份', followers: '粉丝数', email: '邮箱', phone: '电话', description: '描述' };
  const STATUS_CN = { confirmed: '已确认', weak: '证据弱', conflict: '冲突', missing: '缺失' };
  for (const lead of rows) {
    const ver = get('SELECT * FROM verifications WHERE lead_id=? ORDER BY id DESC LIMIT 1', lead.id);
    if (!ver) continue;
    const frs = all('SELECT * FROM field_results WHERE verification_id=?', ver.id);
    for (const fr of frs) {
      ws2.addRow({
        lid: lead.id, company: lead.company_name, field: FIELD_CN[fr.field] || fr.field,
        value: fr.value || '', conf: fr.confidence ? Math.round(fr.confidence * 100) + '%' : '',
        status: STATUS_CN[fr.status] || fr.status, evc: fr.evidence_count,
      });
    }
  }

  // Sheet 3: 证据链
  const ws3 = wb.addWorksheet('证据链', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws3.columns = [
    { header: '线索ID', key: 'lid', width: 9 },
    { header: '公司名称', key: 'company', width: 22 },
    { header: '来源', key: 'source', width: 16 },
    { header: '字段', key: 'field', width: 11 },
    { header: '归一化值', key: 'value', width: 20 },
    { header: '原文片段', key: 'snippet', width: 60 },
    { header: '来源URL', key: 'url', width: 46 },
    { header: '来源权重', key: 'conf', width: 10 },
    { header: '采集时间', key: 'at', width: 22 },
  ];
  ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
  const SOURCE_CN = { website: '官网', bing: 'Bing搜索', linkedin_search: 'LinkedIn搜索', facebook_search: 'Facebook搜索', instagram_search: 'Instagram搜索', linkedin_page: 'LinkedIn主页', facebook_page: 'Facebook主页', instagram_page: 'Instagram主页', google_cse: 'Google', serpapi: 'SerpAPI', manual: '手工录入' };
  for (const lead of rows) {
    const evs = all('SELECT * FROM evidence WHERE lead_id=? ORDER BY id', lead.id);
    for (const ev of evs) {
      ws3.addRow({
        lid: lead.id, company: lead.company_name, source: SOURCE_CN[ev.source] || ev.source,
        field: FIELD_CN[ev.field] || ev.field, value: ev.value || '',
        snippet: (ev.snippet || '').slice(0, 300), url: ev.url || '',
        conf: ev.confidence ? Math.round(ev.confidence * 100) + '%' : '', at: ev.captured_at || '',
      });
    }
  }
  // URL 列加超链接
  ws3.getColumn('url').eachCell((cell, rn) => {
    if (rn === 1 || !cell.value) return;
    try { cell.value = { text: String(cell.value).slice(0, 80), hyperlink: String(cell.value) }; cell.font = { color: { argb: 'FF0563C1'}, underline: true }; } catch {}
  });

  const outDir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = opts.filename || path.join(outDir, `线索画像报告_${ts}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

module.exports = { exportReport };
