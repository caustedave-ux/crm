'use strict';
// ============ 物流跟踪：常量 ============
// 只做记录 + 到点提醒。查询动作由业务员自己做（点一下复制单号即可）。

const DIRECTION = { in: '供应商发货', out: '客户出货' };
const STATUSES = ['已下单', '已发货', '运输中', '已到港', '已签收', '异常', '已取消'];
const STATUS_CLS = {
  '已下单': 'secondary', '已发货': 'info', '运输中': 'primary',
  '已到港': 'warning', '已签收': 'success', '异常': 'danger', '已取消': 'secondary',
};
const CLOSED = ['已签收', '已取消'];
const DEFAULT_CHECK_DAYS = 2;

function statusCls(s) { return STATUS_CLS[s] || 'secondary'; }
function isClosed(s) { return CLOSED.includes(String(s || '')); }

/** 到点该查了？ */
function dueForCheck(row, today) {
  if (isClosed(row.status)) return false;
  if (!row.next_check_at) return false;
  return String(row.next_check_at).slice(0, 10) <= today;
}

function addDays(ymd, n) {
  const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + Number(n || 0));
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

module.exports = { DIRECTION, STATUSES, STATUS_CLS, CLOSED, DEFAULT_CHECK_DAYS, statusCls, isClosed, dueForCheck, addDays };
