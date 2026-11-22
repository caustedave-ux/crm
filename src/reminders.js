'use strict';
// ============ 跟进超期规则：29天强提醒 / 30天自动入公共客户池 ============
const { all, run } = require('./db');
const { nowStr } = require('./util');

const WARN_DAYS = 29;
const POOL_DAYS = 30;

function parseTs(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0);
}
function daysSince(s) {
  const dt = parseTs(s);
  if (!dt) return 0;
  return Math.floor((Date.now() - dt.getTime()) / 86400000);
}

function staleCustomers(userId) {
  const uid = parseInt(userId, 10) || 0;
  const activityUser = uid ? 'AND a.user_id=?' : '';
  const customerUser = uid ? 'AND c.user_id=?' : '';
  const args = uid ? [uid, uid] : [];
  const rows = all(`SELECT c.id, c.company_name, c.country, c.phone, c.email, c.user_id, c.in_pool, c.created_at, c.pool_at,
      (SELECT MAX(a.activity_date) FROM activities a WHERE a.customer_id=c.id ${activityUser}) AS last_act
    FROM customers c WHERE COALESCE(c.in_pool,0)=0 ${customerUser}`, ...args);
  const warn = [], due = [];
  for (const r of rows) {
    if (!r.last_act) continue;
    const days = daysSince(r.last_act);
    const item = { id: r.id, company_name: r.company_name, country: r.country, phone: r.phone, email: r.email, last_follow: r.last_act, days, user_id: r.user_id };
    if (days >= POOL_DAYS) due.push(item);
    else if (days >= WARN_DAYS) warn.push(item);
  }
  warn.sort((a, b) => b.days - a.days);
  due.sort((a, b) => b.days - a.days);
  return { warn, due };
}

function autoPoolStale() {
  const owners = all("SELECT DISTINCT user_id FROM customers WHERE COALESCE(in_pool,0)=0 AND user_id IS NOT NULL");
  let pooled = 0;
  const ids = [];
  const ownerList = owners.length ? owners : [{ user_id: null }];
  for (const owner of ownerList) {
    const { due } = staleCustomers(owner.user_id);
    for (const d of due) {
      run("UPDATE customers SET in_pool=1, pool_at=?, pool_reason=?, updated_at=? WHERE id=? AND COALESCE(in_pool,0)=0",
        nowStr(), '超过30天未跟进，自动进入公共客户池', nowStr(), d.id);
      pooled++; ids.push(d.id);
    }
  }
  return { pooled, ids };
}

module.exports = { WARN_DAYS, POOL_DAYS, staleCustomers, autoPoolStale, daysSince };
