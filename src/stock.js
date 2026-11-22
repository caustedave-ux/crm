'use strict';
// ============ 库存管理 V1.01 ============
// 规则：销售合同“已确认”=客户采购扣库存（允许扣成负数，超卖保留提醒）
// 若扣减前该产品库存为 0 或负数（超卖/欠货），在“发货-标记完成发货”后自动回补本次扣减数量；
// 扣减前库存为正的产品，完成发货后数量不再回补。
// 采购单到货（已完成）增加库存；手动出入库随时可调整。
const { get, all, run } = require('./db');
const { nowStr } = require('./util');

const SO_TYPES = new Set(['so']);
const PO_TYPES = new Set(['po']);
const APPLY_STATUSES = new Set(['已确认', '已完成']);
const ARRIVED_STATUS = '已完成';

function parseItems(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function neededBy(items) {
  const map = new Map();
  for (const it of items || []) {
    const pid = it.product_id ? Number(it.product_id) : 0;
    if (!pid) continue;
    map.set(pid, (map.get(pid) || 0) + (Number(it.qty) || 0));
  }
  return map;
}
function partyOf(doc) {
  if (doc.doc_type === 'po') {
    const s = doc.supplier_id ? get('SELECT * FROM suppliers WHERE id=?', doc.supplier_id) : null;
    return s ? s.name : '供应商';
  }
  const c = doc.customer_id ? get('SELECT * FROM customers WHERE id=?', doc.customer_id) : null;
  return c ? c.company_name : '客户';
}
function logMove(productId, doc, delta, remark, by) {
  const p = get('SELECT * FROM products WHERE id=?', productId);
  if (!p) return;
  run('INSERT INTO stock_movements(product_id,product_name,doc_id,doc_no,doc_type,party,change,balance_after,remark,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    p.id, p.name, doc.id, doc.doc_no, doc.doc_type, partyOf(doc), delta, Number(p.stock), remark, by || '系统', nowStr());
}
function applyChanges(doc, items, sign, reason, by) {
  for (const [pid, qty] of neededBy(items)) {
    if (sign > 0) run('UPDATE products SET stock=stock+? WHERE id=?', qty, pid);
    else run('UPDATE products SET stock=stock-? WHERE id=?', qty, pid);
    logMove(pid, doc, sign > 0 ? qty : -qty, reason, by);
  }
}
function loadBackorder(doc) {
  try { const a = JSON.parse(doc.stock_backorder || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
// 记录超卖提醒（保留原“库存不足提醒”功能）
function remindNegative(doc, items) {
  const party = partyOf(doc);
  for (const [pid, qty] of neededBy(items)) {
    const p = get('SELECT * FROM products WHERE id=?', pid);
    if (!p) continue;
    const now = Number(p.stock) || 0;
    if (now < 0) {
      const ex = get("SELECT * FROM stock_reminders WHERE doc_id=? AND product_id=? AND status='待处理'", doc.id, pid);
      if (ex) run('UPDATE stock_reminders SET need_qty=?, have_qty=?, shortage=?, created_at=? WHERE id=?', qty, now, Math.abs(now), nowStr(), ex.id);
      else run('INSERT INTO stock_reminders(doc_id,doc_no,doc_type,party,product_id,product_name,need_qty,have_qty,shortage,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        doc.id, doc.doc_no, doc.doc_type, party, pid, p.name, qty, now, Math.abs(now), '待处理', nowStr());
    }
  }
}
function clearRemindersForProducts(docId, productIds) {
  if (!productIds.length) return;
  for (const pid of productIds) run("UPDATE stock_reminders SET status='已处理', handled_at=? WHERE doc_id=? AND product_id=?", nowStr(), docId, pid);
}
// 撤销单据扣减：若已发货回补，欠货部分已净回补，只回补“正库存”部分
function releaseSoEffects(doc) {
  const items = parseItems(doc.items);
  const back = Number(doc.stock_restored) === 1 ? loadBackorder(doc) : [];
  const skip = new Set(back.map(b => Number(b.product_id)));
  const toAdd = items.filter(it => !skip.has(Number(it.product_id)));
  if (toAdd.length) applyChanges(doc, toAdd, 1, '回补：单据取消/删除（' + doc.doc_no + '）', '系统');
  run('UPDATE documents SET stock_applied=0, stock_restored=0, stock_backorder=? WHERE id=?', '', doc.id);
}
function releasePoEffects(doc) {
  applyChanges(doc, parseItems(doc.items), -1, '撤销采购入库（' + doc.doc_no + '）', '系统');
  run('UPDATE documents SET stock_in_applied=0 WHERE id=?', doc.id);
}

function syncByStatus(docId, newStatus) {
  const d = get('SELECT * FROM documents WHERE id=?', docId);
  if (!d) return { ok: false, msg: '单据不存在' };
  const items = parseItems(d.items);
  const wasApplied = Number(d.stock_applied) === 1;
  const wasIn = Number(d.stock_in_applied) === 1;
  const wasRestored = Number(d.stock_restored) === 1;
  const isSo = SO_TYPES.has(d.doc_type);
  const isPo = PO_TYPES.has(d.doc_type);
  const targetApply = isSo && APPLY_STATUSES.has(newStatus);
  const targetIn = isPo && newStatus === ARRIVED_STATUS;

  // 采购单撤销入库
  if (wasIn && !targetIn) {
    releasePoEffects(d);
    run('UPDATE documents SET status=?, updated_at=? WHERE id=?', newStatus, nowStr(), docId);
    return { ok: true, msg: '已撤销采购入库，状态更新为「' + newStatus + '」' };
  }
  // 销售扣减撤销（草稿/作废/回退），含已发货回补的净额处理
  if (wasApplied && !targetApply) {
    releaseSoEffects(d);
    run('UPDATE documents SET status=?, updated_at=? WHERE id=?', newStatus, nowStr(), docId);
    return { ok: true, msg: wasRestored ? '已按 V1.01 规则结算并回退，状态更新为「' + newStatus + '」' : '库存已回补，状态更新为「' + newStatus + '」' };
  }
  // 销售确认（客户采购扣库存；允许扣成负数）
  if (!wasApplied && targetApply) {
    const pre = {};
    for (const [pid] of neededBy(items)) { const p = get('SELECT * FROM products WHERE id=?', pid); pre[pid] = p ? Number(p.stock) || 0 : 0; }
    applyChanges(d, items, -1, '客户采购扣减（客户：' + partyOf(d) + '）', '系统');
    const back = items.filter(it => it.product_id && pre[it.product_id] !== undefined && pre[it.product_id] <= 0)
      .map(it => ({ product_id: it.product_id, qty: Number(it.qty) || 0 }));
    run('UPDATE documents SET stock_applied=1, stock_backorder=? WHERE id=?', JSON.stringify(back), docId);
    remindNegative(d, items);
    run('UPDATE documents SET status=?, updated_at=? WHERE id=?', newStatus, nowStr(), docId);
    return { ok: true, msg: '库存已扣减（V1.01：0/负库存允许继续下单，扣成负数将在完成发货后自动回补）' };
  }
  // 销售 已确认 <-> 已完成：库存动作由“发货-标记完成发货”触发
  if (isSo && APPLY_STATUSES.has(newStatus)) {
    run('UPDATE documents SET status=?, updated_at=? WHERE id=?', newStatus, nowStr(), docId);
    return { ok: true, msg: '状态更新为「' + newStatus + '」（如需按 V1.01 回补，请在“发货”里标记完成发货）' };
  }
  // 采购到货入库
  if (!wasIn && targetIn) {
    applyChanges(d, items, 1, '采购入库（供应商：' + partyOf(d) + '）', '系统');
    run('UPDATE documents SET stock_in_applied=1, status=?, updated_at=? WHERE id=?', newStatus, nowStr(), docId);
    return { ok: true, msg: '货物已入库，库存增加（供应商：' + partyOf(d) + '）' };
  }
  // 其余（报价/PI/CI/PL 等）
  run('UPDATE documents SET status=?, updated_at=? WHERE id=?', newStatus, nowStr(), docId);
  return { ok: true, msg: '状态已更新为「' + newStatus + '」' };
}

// 发货-标记完成发货：回补“扣减前为0/负库存”的欠货数量
function completeShipment(docId) {
  const d = get('SELECT * FROM documents WHERE id=?', docId);
  if (!d) return { ok: false, msg: '单据不存在' };
  if (!SO_TYPES.has(d.doc_type)) return { ok: false, msg: '仅销售订单支持完成发货回补' };
  if (Number(d.stock_applied) !== 1) return { ok: false, msg: '该单据尚未确认扣减库存，无需回补' };
  if (Number(d.stock_restored) === 1) return { ok: true, msg: '该单据已完成发货回补，无需重复操作' };
  const back = loadBackorder(d);
  if (!back.length) {
    run('UPDATE documents SET stock_restored=1 WHERE id=?', docId);
    return { ok: true, msg: '该订单为正常库存销售，完成发货后数量不变（V1.01）' };
  }
  const sum = new Map();
  for (const b of back) sum.set(Number(b.product_id), (sum.get(Number(b.product_id)) || 0) + (Number(b.qty) || 0));
  const list = [];
  for (const [pid, qty] of sum) list.push({ product_id: pid, qty });
  applyChanges(d, list, 1, '完成发货自动回补（零/负库存订单，单号：' + d.doc_no + '）', '系统');
  run('UPDATE documents SET stock_restored=1 WHERE id=?', docId);
  clearRemindersForProducts(docId, Array.from(sum.keys()));
  return { ok: true, msg: '已完成发货回补：为欠货产品自动增加了 ' + list.length + ' 项数量（V1.01）' };
}

// 编辑保存后同步（简化为：旧效果回退后按新状态重新核算）
function syncAfterEdit(oldDoc, newStatus, newItems) {
  if (!oldDoc) return { ok: true, msg: '' };
  if (Number(oldDoc.stock_applied) === 1) releaseSoEffects(oldDoc);
  if (Number(oldDoc.stock_in_applied) === 1) releasePoEffects(oldDoc);
  const fresh = Object.assign({}, oldDoc, { items: JSON.stringify(newItems || []), status: newStatus });
  const isSo = SO_TYPES.has(fresh.doc_type);
  const isPo = PO_TYPES.has(fresh.doc_type);
  if (isSo && APPLY_STATUSES.has(newStatus)) {
    const pre = {};
    for (const [pid] of neededBy(newItems)) { const p = get('SELECT * FROM products WHERE id=?', pid); pre[pid] = p ? Number(p.stock) || 0 : 0; }
    applyChanges(fresh, newItems, -1, '客户采购扣减（客户：' + partyOf(fresh) + '）', '系统');
    const back = newItems.filter(it => it.product_id && pre[it.product_id] !== undefined && pre[it.product_id] <= 0)
      .map(it => ({ product_id: it.product_id, qty: Number(it.qty) || 0 }));
    run('UPDATE documents SET stock_applied=1, stock_backorder=? WHERE id=?', JSON.stringify(back), oldDoc.id);
    remindNegative(fresh, newItems);
    return { ok: true, msg: '已按新明细更新库存（V1.01）' };
  }
  if (isPo && newStatus === ARRIVED_STATUS) {
    applyChanges(fresh, newItems, 1, '采购入库（供应商：' + partyOf(fresh) + '）', '系统');
    run('UPDATE documents SET stock_in_applied=1 WHERE id=?', oldDoc.id);
    return { ok: true, msg: '已按新明细更新库存（采购入库）' };
  }
  return { ok: true, msg: '' };
}
function releaseOnDelete(docId) {
  const d = get('SELECT * FROM documents WHERE id=?', docId);
  if (!d) return;
  if (Number(d.stock_applied) === 1) releaseSoEffects(d);
  if (Number(d.stock_in_applied) === 1) releasePoEffects(d);
  clearRemindersForProducts(docId, parseItems(d.items).filter(x => x.product_id).map(x => Number(x.product_id)));
}
function openReminders() { return all("SELECT * FROM stock_reminders WHERE status='待处理' ORDER BY created_at DESC"); }
function markReminderHandled(id) { run('UPDATE stock_reminders SET status=?, handled_at=? WHERE id=?', '已处理', nowStr(), id); }
function checkStock(items) {
  const out = [];
  for (const [pid, need] of neededBy(items)) { const p = get('SELECT * FROM products WHERE id=?', pid); if (p && Number(p.stock) < need) out.push({ product_id: pid, name: p.name, need, have: Number(p.stock) }); }
  return out;
}

module.exports = { SO_TYPES, PO_TYPES, APPLY_STATUSES, checkStock, syncByStatus, completeShipment, syncAfterEdit, releaseOnDelete, parseItems, neededBy, openReminders, markReminderHandled };
