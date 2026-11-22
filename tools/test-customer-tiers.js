'use strict';
// 客户分层测试：使用 D 盘临时数据库，不触碰 data/crm.db
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { todayStr, nowStr, addDays } = require('../src/util');

const TMP_DIR = 'D:/Codex/tmp';
fs.mkdirSync(TMP_DIR, { recursive: true });
const dbPath = path.join(TMP_DIR, 'crm-tier-test-' + process.pid + '.db');
try { fs.unlinkSync(dbPath); } catch (e) {}
process.env.CRM_DB = dbPath;

const dbx = require('../src/db');
const { db, run, get, all, seedBase } = dbx;
const tiers = require('../src/customerTiers');

seedBase();
// 清掉演示业务数据，只保留账号，构造可重复的测试夹具。
run('DELETE FROM payment_records');
run('DELETE FROM documents');
run('DELETE FROM activities');
run('DELETE FROM contacts');
run('DELETE FROM customers');
run('DELETE FROM website_inquiries');

const admin = get("SELECT * FROM users WHERE username='admin'");
const sales = get("SELECT * FROM users WHERE username='sales'");
assert(admin && sales, '种子账号存在');

function insertCustomer(userId, name, options) {
  const o = options || {};
  const stamp = o.createdAt || nowStr();
  const r = run(`INSERT INTO customers(user_id,company_name,country,industry,status,level,tier_override,do_not_contact,in_pool,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, userId, name, o.country || '尼日利亚 Nigeria', o.industry || 'Door Hardware',
    o.status || '潜在客户', '普通', o.override || '', o.doNotContact ? 1 : 0, o.inPool ? 1 : 0, stamp, stamp);
  return Number(r.lastInsertRowid);
}
function insertDoc(userId, customerId, no, amount, currency, status) {
  const stamp = nowStr();
  const r = run(`INSERT INTO documents(user_id,doc_no,doc_type,customer_id,title,issue_date,currency,status,total_amount,items,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, userId, no, 'pi', customerId, no, todayStr(), currency || 'CNY',
    status || '已确认', amount, '[]', stamp, stamp);
  return Number(r.lastInsertRowid);
}
function insertPayment(docId, amount) {
  run(`INSERT INTO payment_records(doc_id,amount,paid_at,note,created_by,created_at) VALUES(?,?,?,?,?,?)`,
    docId, amount, nowStr(), '测试回款', 'test', nowStr());
}

const old = addDays(todayStr(), -400) + ' 00:00:00';
const aId = insertCustomer(admin.id, 'A Customer');
insertPayment(insertDoc(admin.id, aId, 'T-A', 26000, 'CNY'), 26000);
const bId = insertCustomer(admin.id, 'B Customer');
insertPayment(insertDoc(admin.id, bId, 'T-B', 5000, 'CNY'), 5000);
const cId = insertCustomer(admin.id, 'C Customer');
const dId = insertCustomer(admin.id, 'D Customer', { createdAt: old });
const manualId = insertCustomer(admin.id, 'Manual C Customer', { override: 'C' });
insertPayment(insertDoc(admin.id, manualId, 'T-M', 50000, 'CNY'), 50000);
const blockedId = insertCustomer(admin.id, 'Blocked Customer', { override: 'A', doNotContact: true });
const poolId = insertCustomer(admin.id, 'Pool Customer', { inPool: true });
insertPayment(insertDoc(admin.id, poolId, 'T-P', 100000, 'CNY'), 100000);
const unpaidId = insertCustomer(admin.id, 'Unpaid PI Customer');
insertDoc(admin.id, unpaidId, 'T-U', 900000, 'CNY');
const otherId = insertCustomer(sales.id, 'Other User Customer');
insertPayment(insertDoc(sales.id, otherId, 'T-O', 30000, 'CNY'), 30000);

tiers.refreshTiers(admin.id, { force: true });
const rows = tiers.calculateForUser(admin.id, new Date());
const byName = Object.fromEntries(rows.map(row => [row.customer.company_name, row]));
assert.equal(byName['A Customer'].tier, 'A', '已回款 2.6 万应为 A');
assert.equal(byName['B Customer'].tier, 'B', '已回款但未到 A 门槛应为 B');
assert.equal(byName['C Customer'].tier, 'C', '新客户无贡献应为 C');
assert.equal(byName['D Customer'].tier, 'D', '400 天无触点应为 D');
assert.equal(byName['Manual C Customer'].tier, 'C', '人工覆盖优先于自动贡献值');
assert.equal(byName['Blocked Customer'].tier, 'D', '禁止主动联系必须落为 D');
assert.equal(byName['Pool Customer'], undefined, '公共池客户不参与个人分层');
assert.equal(byName['Other User Customer'], undefined, '不同账号客户必须隔离');
assert.notEqual(byName['Unpaid PI Customer'].tier, 'A', '未付款 PI 总额不能直接算成 A');
assert(byName['Unpaid PI Customer'].metrics.paidCny === 0, '未付款 PI 不计回款');

const run1 = tiers.ensureTierActions(admin.id);
assert(run1.created >= 2, 'A/B 客户应生成周期动作');
const weekly = all("SELECT * FROM tier_actions WHERE user_id=? AND customer_id=? AND action_type='weekly_contact'", admin.id, aId);
const monthly = all("SELECT * FROM tier_actions WHERE user_id=? AND customer_id=? AND action_type='monthly_brief'", admin.id, bId);
assert.equal(weekly.length, 1, 'A 类生成每周沟通任务');
assert.equal(monthly.length, 1, 'B 类生成每月简报任务');
const before = get('SELECT COUNT(*) c FROM tier_actions').c;
tiers.ensureTierActions(admin.id);
const after = get('SELECT COUNT(*) c FROM tier_actions').c;
assert.equal(after, before, '同一周期重复刷新不能重复生成任务');
assert.equal(all("SELECT id FROM tier_actions WHERE user_id=? AND customer_id=?", admin.id, dId).length, 0, 'D 类不生成自动动作');

const overrideResult = tiers.setTierOverride(admin.id, bId, 'D', false);
assert(overrideResult.cancelled >= 1, '改为 D 类后应关闭原 B 类自动任务');
const bAfter = get('SELECT * FROM customers WHERE id=?', bId);
assert.equal(bAfter.customer_tier, 'D', '人工改 D 应持久化');
const cancelled = get("SELECT * FROM tier_actions WHERE customer_id=? AND action_type='monthly_brief' ORDER BY id DESC LIMIT 1", bId);
assert.equal(cancelled.status, 'cancelled', 'B 类自动任务应标记取消');

const rec = tiers.campaignRecipients(admin.id, [aId, cId, dId, manualId, blockedId]);
assert.deepEqual(rec.map(x => Number(x.id)).sort((a, b) => a - b), [cId, manualId].sort((a, b) => a - b), '群发只允许 C 类、未禁联、本人客户');

tiers.logCampaign(admin.id, 'test message', 1, 1, 0, [{ ok: true }]);
assert.equal(get('SELECT COUNT(*) c FROM tier_campaigns WHERE user_id=?', admin.id).c, 1, '群发记录可审计');

console.log('customer tiers: all tests passed');
db.close();
try { fs.unlinkSync(dbPath); } catch (e) {}
