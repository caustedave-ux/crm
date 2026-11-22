// ============ 展示格式化 ============

function empty(v) {
  return v === null || v === undefined || String(v).trim() === '' ? '' : String(v);
}

// 取日期部分：'2026-10-01 10:22:33' -> '2026-10-01'
function dateOnly(v) {
  const s = empty(v);
  return s ? s.slice(0, 10) : '';
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function today() {
  return ymd(new Date());
}

function monthStart() {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

function daysAfter(n) {
  return ymd(new Date(Date.now() + n * 86400000));
}

// 'YYYY-MM-DD HH:mm:ss'
function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return ymd(d) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// 数量显示：去掉多余小数位，保留 3 位以内
function qty(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return String(Math.round(n * 1000) / 1000);
}

function amount(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0.00';
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function money(v, currency) {
  const sym = empty(currency) || 'USD';
  return sym + ' ' + amount(v);
}

// 客户名首字，用于头像
function initial(name) {
  const s = empty(name);
  return s ? s.trim().charAt(0).toUpperCase() : '#';
}

function statusTag(status) {
  const s = empty(status);
  if (s.indexOf('成交') >= 0 || s.indexOf('合作') >= 0) return 'tag tag-green';
  if (s.indexOf('跟进') >= 0 || s.indexOf('洽谈') >= 0) return 'tag tag-orange';
  if (s.indexOf('流失') >= 0 || s.indexOf('无效') >= 0) return 'tag tag-red';
  return 'tag';
}

module.exports = { empty, dateOnly, ymd, today, monthStart, daysAfter, nowStr, qty, amount, money, initial, statusTag };
