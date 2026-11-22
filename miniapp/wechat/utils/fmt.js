// ============ 格式化工具 ============

const DOC_TYPES = [
  { key: 'quotation', name: '报价单' },
  { key: 'pi', name: '形式发票 PI' },
  { key: 'so', name: '销售合同/订单' },
  { key: 'ci', name: '商业发票 CI' },
  { key: 'pl', name: '装箱单' },
  { key: 'po', name: '采购单' },
];

function docTypeName(key) {
  const t = DOC_TYPES.find(function (x) { return x.key === key; });
  return t ? t.name : (key || '单据');
}

function money(n, currency) {
  if (n === null || n === undefined || isNaN(Number(n))) n = 0;
  var s = Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (currency || 'USD') + ' ' + s;
}

function shortDate(s) {
  return s ? String(s).slice(0, 10) : '';
}

module.exports = { DOC_TYPES, docTypeName, money, shortDate };
