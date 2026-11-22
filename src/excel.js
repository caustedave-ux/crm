'use strict';
// ============ Excel 导入 / 导出（基于 exceljs） ============
const ExcelJS = require('exceljs');

// 导出：sheets = [{ name, headers:[...], rows:[[...],...] }]
async function buildXlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.columns = s.headers.map(h => ({ header: h, width: Math.max(10, Math.min(32, String(h).length * 2 + 4)) }));
    const headRow = ws.getRow(1);
    headRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6FBB' } };
    headRow.alignment = { vertical: 'middle' };
    headRow.height = 20;
    for (const row of s.rows) ws.addRow(row);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
      });
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// 读取：返回 [{header:value}...]（首行为表头）
async function readRows(buf, sheetIndex) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[sheetIndex || 0];
  if (!ws) return [];
  const rows = [];
  let headers = null;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const vals = [];
    for (let i = 1; i <= row.cellCount; i++) {
      const c = row.getCell(i);
      let v = c.text;
      if (c.type === ExcelJS.ValueType.Number && typeof c.value === 'object') v = c.value.result !== undefined ? c.value.result : c.value;
      else if (c.type === ExcelJS.ValueType.Number) v = c.value;
      vals.push(v === null || v === undefined ? '' : String(v).trim());
    }
    if (n === 1) {
      headers = vals.map(x => String(x).replace(/\*/g, '').trim());
    } else {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] !== undefined ? vals[i] : ''); });
      if (Object.values(obj).some(v => v !== '')) rows.push(obj);
    }
  });
  return rows;
}

// 导出单据（两张表：单据列表 + 明细）
function docSheets(listRows, itemRows) {
  return [
    { name: '单据列表', headers: ['单号', '类型', '客户', '标题', '单据日期', '币种', '金额', '状态', '业务员', '备注'], rows: listRows },
    { name: '单据明细', headers: ['单号', '客户', '行号', '品名', '英文品名', '型号', '单位', '数量', '单价', '金额', '备注'], rows: itemRows },
  ];
}
function customerSheet(rows) {
  return [{ name: '客户', headers: ['公司名称', '英文名称', '国家/地区', '地址', '联系人姓名', '联系人手机', '行业', '状态', '级别', '联系电话', '传真', '邮箱', 'WhatsApp', '微信', '客户来源', '主要联系人', '联系人职位', '联系人电话', '联系人邮箱', '备注'], rows }];
}

// ============ 单张单据：按“预览版式”生成 Excel ============
const TYPE_NAME = { quotation: '报 价 单', pi: '形 式 发 票', so: '销 售 合 同', ci: '商 业 发 票', pl: '装 箱 单', po: '采 购 单' };
const TYPE_EN = { quotation: 'QUOTATION', pi: 'PROFORMA INVOICE', so: 'SALES CONTRACT', ci: 'COMMERCIAL INVOICE', pl: 'PACKING LIST', po: 'PURCHASE ORDER' };

function columnsFor(type) {
  if (type === 'pl') return [
    ['件数/每箱', 'it', 'per_ctn'], ['装箱数', 'it', 'ctn'], ['总数量', 'it', 'qty'],
    ['体积(m³)', 'it', 'volume'], ['总体积(m³)', 'fmt', 'total_volume'], ['重量(kg)', 'it', 'weight'], ['总重量(kg)', 'fmt', 'total_weight'], ['备注', 'it', 'remark']
  ];
  if (type === 'pi' || type === 'so') return [
    ['颜色', 'it', 'color'], ['装箱数', 'it', 'ctn'], ['件数/每箱', 'it', 'per_ctn'], ['总数量', 'it', 'qty'],
    ['单价', 'it', 'price'], ['金额', 'it', 'amount']
  ];
  // quotation / ci / po
  return [['规格型号', 'it', 'model'], ['单位', 'it', 'unit'], ['数量', 'it', 'qty'], ['单价', 'it', 'price'], ['金额', 'it', 'amount'], ['备注', 'it', 'remark']];
}

async function buildDocumentXlsx(doc, customer, supplier, contact, company, items) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('单据');
  const type = doc.doc_type;
  const isPL = type === 'pl';
  const partyName = type === 'po' ? (supplier ? supplier.name : '') : (customer ? customer.company_name : '');
  const party = type === 'po' ? (supplier || {}) : (customer || {});
  // 列：统一 A..P
  const colLetters = 'ABCDEFGHIJKLMNOP'.split('');
  const last = colLetters[isPL ? 7 : 7];
  const totalCols = isPL ? 8 : 8;
  for (let i = 0; i < 8; i++) ws.getColumn(colLetters[i]).width = isPL ? 12 : 13;
  ws.getColumn('A').width = 26;
  ws.getColumn('B').width = 30;
  let r = 1;
  const set = (cell, v, o) => { const c = ws.getCell(cell); c.value = v === null || v === undefined ? '' : v; if (o) { if (o.b) c.font = Object.assign({}, c.font, { bold: true }); if (o.s) c.font = Object.assign({}, c.font, { size: o.s }); if (o.wrap) c.alignment = Object.assign({}, c.alignment, { wrapText: true, vertical: 'top' }); if (o.center) c.alignment = Object.assign({}, c.alignment, { horizontal: 'center' }); if (o.left) c.alignment = Object.assign({}, c.alignment, { horizontal: 'left' }); } return c; };
  const merge = (a, b) => { ws.mergeCells(a + ':' + b); };
  ws.pageSetup.paperSize = 9; ws.pageSetup.fitToPage = true;
  // 抬头 + 标题
  merge('A' + r + ':' + last + r); set('A' + r, company.name || '', { b: true, s: 16 }); r++;
  merge('A' + r + ':' + last + r); set('A' + r, company.name_en || '', { s: 10 }); r++;
  merge('A' + r + ':' + last + r); set('A' + r, TYPE_NAME[type] || type, { b: true, s: 15, center: true }); r++;
  merge('A' + r + ':' + last + r); set('A' + r, TYPE_EN[type] || '', { center: true, s: 9 }); r++;
  // 单号/日期/币种/业务员
  const meta = [('单号: ' + (doc.doc_no || '')), ('日期: ' + (doc.issue_date || '')), ('币种: ' + (doc.currency || '')), ('业务员: ' + (doc.created_by || ''))];
  merge('A' + r + ':' + 'D' + r); set('A' + r, meta[0] + '   ' + meta[1]); merge('E' + r + ':' + last + r); set('E' + r, meta[2] + '   ' + meta[3]); r++;
  // 对方信息
  merge('A' + r + ':' + last + r); set('A' + r, (type === 'po' ? '供应商 Supplier：' : '客户 Buyer：') + (partyName || ''), { b: true }); r++;
  merge('A' + r + ':' + last + r); set('A' + r, '国家/地区: ' + (party.country || '') + '   地址: ' + (party.address || '')); r++;
  const attn = type === 'po' ? (party.contact_name || '') : (contact ? contact.name : '');
  const tel = type === 'po' ? (party.phone || '') : (contact ? (contact.mobile || contact.phone || '') : '');
  const em = type === 'po' ? (party.email || '') : (contact ? contact.email : '');
  merge('A' + r + ':' + last + r); set('A' + r, '联系人: ' + (attn || '') + '   电话: ' + (tel || '') + '   邮箱: ' + (em || '')); r++;
  r++;
  // 明细表头
  const headA = ['No.', 'Description', '规格/单位'].slice(0, isPL ? 2 : 2);
  const cols = isPL ? ['No.', '品名 Description', '型号 Model', '单位', '件数/每箱', '装箱数', '总数量', '体积(m³)', '总体积(m³)', '重量(kg)', '总重量(kg)', '备注']
    : ['No.', '品名 Description', '颜色', '装箱数', '件数/每箱', '总数量', '单价', '金额'];
  // 简化：两行头合并？直接一行
  const hstart = r;
  const hmap = [];
  cols.forEach(function (h, i) { hmap.push(h); set(colLetters[i] + r, h, { b: true, center: true, wrap: true }); });
  // 行高设置
  ws.getRow(r).height = 30;
  const hRow = r; r++;
  items.forEach(function (it, idx) {
    const vol = (Number(it.per_ctn) || 0) * (Number(it.volume) || 0);
    const wt = (Number(it.per_ctn) || 0) * (Number(it.weight) || 0);
    const vals = isPL
      ? [it.name, it.model || '', it.unit || '', it.per_ctn || 0, it.ctn || 0, it.qty || 0, it.volume || 0, Math.round(vol * 1000) / 1000, it.weight || 0, Math.round(wt * 1000) / 1000, it.remark || '']
      : [it.name, it.color || '', it.ctn || 0, it.per_ctn || 0, it.qty || 0, Number(it.price) || 0, Number(it.amount) || 0];
    vals.unshift(idx + 1);
    vals.forEach(function (v, i) { const cell = ws.getCell(colLetters[i] + r); cell.value = v; cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; cell.alignment = { vertical: 'middle', wrapText: true }; if (i === 0 || i === 1) cell.alignment.horizontal = 'left'; });
    ws.getRow(r).height = 26;
    r++;
  });
  // 表区域边框包裹（用开始行）
  for (let c = 0; c < cols.length; c++) {
    const cell = ws.getCell(colLetters[c] + hRow); cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    if (items.length) { const lastc = ws.getCell(colLetters[c] + (r - 1)); lastc.border = Object.assign({}, lastc.border, { bottom: { style: 'double' } }); }
  }
  // 合计 / 总计
  const sub = items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const tv = items.reduce((s, x) => s + (Number(x.per_ctn) || 0) * (Number(x.volume) || 0), 0);
  const tw = items.reduce((s, x) => s + (Number(x.per_ctn) || 0) * (Number(x.weight) || 0), 0);
  if (isPL) {
    merge('A' + r + ':' + 'D' + r); set('A' + r, '合计', { b: true });
    merge('E' + r + ':' + last + r); set('E' + r, '总体积 ' + (Math.round(tv * 1000) / 1000) + ' m³    总重量 ' + (Math.round(tw * 1000) / 1000) + ' kg', { b: true }); r++;
  } else {
    set('A' + r, '合计 Total'); set(colLetters[5] + r, ''); set(colLetters[6] + r, sub, { b: true }); r++;
  }
  // 条款
  const ctnTotal = Math.round(items.reduce((s, x) => s + (Number(x.ctn) || 0), 0) * 1000) / 1000;
  const termRows = (type === 'pi' ? [['总箱数 Total CTN', ctnTotal]] : []).concat([
    ['付款方式 Payment', doc.payment_terms], ['贸易条款 Trade', doc.trade_terms], ['交货期 Delivery', doc.delivery_date || ''],
    ['起运港 Loading', doc.port_loading], ['目的港 Destination', doc.port_destination], ['有效期 Validity', doc.valid_until || ''], ['备注 Remarks', doc.remarks]
  ]);
  termRows.forEach(function (t) { merge('A' + r + ':' + last + r); set('A' + r, t[0] + '：' + t[1], { wrap: true }); r++; });
  // 签章
  r++;
  const signCols = last;
  const half = Math.ceil(totalCols / 2);
  merge('A' + r + ':' + 'D' + r); set('A' + r, '卖方/公司：' + (company.name || '')); merge('E' + r + ':' + last + r); set('E' + r, '买方：' + (partyName || '')); r += 3;
  merge('A' + r + ':' + 'D' + r); set('A' + r, '签名 Signature'); merge('E' + r + ':' + last + r); set('E' + r, '签名/盖章 Signature & Stamp'); r++;
  return wb;
}


// 读取产品导入表：自动定位含“品名”表头的 sheet，返回每行对象（含 __row 行号、__images 该行图片）
async function readProductRows(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const hasNameHeader = (w) => {
    const first = w.getRow(1);
    for (let i = 1; i <= first.cellCount; i++) {
      const t = String(first.getCell(i).text || '').trim().replace(/\*/g, '');
      if (t === '品名' || t === '产品名称') return true;
    }
    return false;
  };
  const ws = wb.worksheets.find(hasNameHeader) || wb.worksheets.find((w) => /产品导入/.test(w.name)) || wb.worksheets[0];
  const rows = [];
  let headers = null;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const vals = [];
    for (let i = 1; i <= row.cellCount; i++) {
      const c = row.getCell(i);
      let v = c.text;
      if (c.type === ExcelJS.ValueType.Number && typeof c.value === 'object') v = c.value.result !== undefined ? c.value.result : c.value;
      else if (c.type === ExcelJS.ValueType.Number) v = c.value;
      vals.push(v === null || v === undefined ? '' : String(v).trim());
    }
    if (n === 1) {
      headers = vals.map((x) => String(x).replace(/\*/g, '').trim());
    } else {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] !== undefined ? vals[i] : ''); });
      if (Object.values(obj).some((v) => v !== '')) { obj.__row = n; obj.__images = []; rows.push(obj); }
    }
  });
  const media = wb.model.media || [];
  const imgs = (ws.getImages && ws.getImages()) || [];
  for (const im of imgs) {
    const mi = media[im.imageId];
    if (!mi || !mi.buffer) continue;
    const tl = im.range && im.range.tl;
    if (!tl || tl.row === null || tl.row === undefined) continue;
    const excelRow = Number(tl.row) + 1; // tl.row 为 0 基
    if (excelRow < 2) continue;
    // 只挂到图片所在行确实有产品行的那一行（L6）：空行上的图不再错挂到上一个产品
    const target = rows.find((o) => o.__row === excelRow);
    if (!target) {
      console.warn('产品导入：第 ' + excelRow + ' 行图片所在行为空行，未挂到任何产品，已跳过');
      continue;
    }
    target.__images.push({ buffer: mi.buffer, ext: String(mi.extension || 'png').toLowerCase() });
  }
  return rows;
}
module.exports = { buildXlsx, readRows, readProductRows, docSheets, customerSheet, buildDocumentXlsx, columnsFor };

