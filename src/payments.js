'use strict';

const { db, get, all, run } = require('./db');
const { nowStr } = require('./util');

const SALE_TYPES = ['so', 'pi', 'ci'];
const CURRENCIES = {
  NGN: '尼日利亚奈拉', CNY: '人民币', GBP: '英镑', EUR: '欧元',
  USD: '美元', JPY: '日元', AUD: '澳元',
};
const saleWhere = "d.doc_type IN ('so','pi','ci') AND COALESCE(d.status,'')<>'已作废'";

function currencyCode(value) {
  const code = String(value || 'USD').trim().toUpperCase() || 'USD';
  return code === 'RMB' ? 'CNY' : code;
}

function currencyOptions(existing) {
  const code = currencyCode(existing);
  return [...new Set([...Object.keys(CURRENCIES), code])]
    .map(v => ({ v, l: CURRENCIES[v] ? v + ' · ' + CURRENCIES[v] : v }));
}

function cents(value) {
  return Math.round((Number(value) || 0) * 100);
}

function parseAmount(value) {
  const raw = String(value ?? '').trim();
  const amount = cents(raw);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isSafeInteger(amount) || amount > 1e14) {
    throw new Error('金额必须为有效数字，最多保留两位小数。');
  }
  return amount;
}

function findPayableDoc(id, userId) {
  return get('SELECT d.* FROM documents d WHERE d.id=? AND d.user_id=? AND ' + saleWhere, id, userId);
}

function hasReceipts(id) {
  return !!get('SELECT 1 AS present WHERE EXISTS (SELECT 1 FROM payment_records WHERE doc_id=?) ' +
    'OR EXISTS (SELECT 1 FROM document_payments WHERE doc_id=? AND (paid>0 OR deposit>0))', id, id);
}

function readRecords(doc) {
  const currency = currencyCode(doc.currency);
  return all('SELECT * FROM payment_records WHERE doc_id=? ORDER BY paid_at DESC,id DESC', doc.id)
    .map(record => ({
      ...record,
      received_currency: currencyCode(record.received_currency || currency),
      received_amount: record.received_amount ?? record.amount,
    }));
}

function listDocuments(userId, customerId = 0) {
  const params = customerId ? [userId, customerId] : [userId];
  return all('SELECT d.id,d.doc_no,d.doc_type,d.issue_date,d.currency,d.total_amount,d.customer_id, ' +
    'c.company_name,c.user_id AS customer_owner,c.in_pool, p.deposit,COALESCE(r.paid,p.paid,0) AS paid_amt ' +
    'FROM documents d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN document_payments p ON p.doc_id=d.id ' +
    'LEFT JOIN (SELECT doc_id,SUM(amount) AS paid FROM payment_records GROUP BY doc_id) r ON r.doc_id=d.id ' +
    'WHERE d.user_id=? AND ' + saleWhere + (customerId ? ' AND d.customer_id=?' : '') +
    ' ORDER BY d.issue_date DESC,d.id DESC', ...params);
}

function receiptTotals(userId, customerId = 0) {
  const params = customerId ? [userId, customerId] : [userId];
  return all('SELECT COALESCE(NULLIF(r.received_currency,\'\'),d.currency) AS currency,' +
    'SUM(COALESCE(r.received_amount,r.amount,p.paid,0)) AS amount ' +
    'FROM documents d LEFT JOIN payment_records r ON r.doc_id=d.id LEFT JOIN document_payments p ON p.doc_id=d.id ' +
    'WHERE d.user_id=? AND ' + saleWhere + (customerId ? ' AND d.customer_id=?' : '') +
    ' AND (r.id IS NOT NULL OR p.paid>0) GROUP BY 1', ...params);
}

function savePayments(doc, body, user) {
  const currency = currencyCode(doc.currency);
  if ((Object.hasOwn(body, 'document_currency') && currencyCode(body.document_currency) !== currency)
    || (Object.hasOwn(body, 'document_total') && cents(body.document_total) !== cents(doc.total_amount))) {
    throw new Error('单据已修改，请刷新后重试。');
  }
  const deposit = parseAmount(body.deposit || '0');
  if (deposit > cents(doc.total_amount)) throw new Error('已收定金不能超过单据金额。');
  const remark = String(body.remark || '').trim();
  if (remark.length > 2000) throw new Error('收款备注最多 2000 字。');
  let submitted = null;
  if (Object.hasOwn(body, 'records')) {
    try { submitted = JSON.parse(body.records); } catch { /* handled below */ }
    if (!Array.isArray(submitted)) throw new Error('无法读取分笔收款，请刷新后重试。');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const freshDoc = findPayableDoc(doc.id, user.id);
    if (!freshDoc || currencyCode(freshDoc.currency) !== currency || cents(freshDoc.total_amount) !== cents(doc.total_amount)) {
      throw new Error('单据已修改，请刷新后重试。');
    }
    const current = get('SELECT * FROM document_payments WHERE doc_id=?', doc.id);
    if (Object.hasOwn(body, 'revision') && String(body.revision) !== (current?.updated_at || '')) {
      throw new Error('这笔货款已在别处更新，请刷新后重试。');
    }
    const existing = new Map(readRecords(freshDoc).map(record => [record.id, record]));
    if (submitted !== null && !Object.hasOwn(body, 'revision')
      && [...existing.values()].some(row => row.received_currency !== currency)) {
      throw new Error('请刷新以载入跨币种收款记录。');
    }
    let sum = cents(current?.paid);
    if (submitted !== null) {
      sum = 0;
      const remaining = new Set(existing.keys());
      for (const row of submitted) {
        const id = Number(row?.id || 0);
        if (id && !remaining.delete(id)) throw new Error('收款记录已变化，请刷新后重试。');
        const receivedCurrency = currencyCode(row?.received_currency || currency);
        if (!Object.hasOwn(CURRENCIES, receivedCurrency) && receivedCurrency !== currency
          && existing.get(id)?.received_currency !== receivedCurrency) throw new Error('请选择有效的实收币种。');
        const received = parseAmount(row?.received_amount ?? row?.amount);
        const credit = receivedCurrency === currency ? received : parseAmount(row?.amount);
        if (received <= 0 || credit <= 0) throw new Error('实收和冲抵金额都必须大于零。');
        const paidAt = String(row?.paid_at || '').trim().replace('T', ' ');
        const date = new Date(paidAt.replace(' ', 'T') + ':00Z');
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(paidAt) || !Number.isFinite(date.getTime())
          || date.toISOString().slice(0, 16).replace('T', ' ') !== paidAt) throw new Error('请填写每笔收款的有效时间。');
        const note = String(row?.note || '').trim();
        if (note.length > 1000) throw new Error('单笔备注最多 1000 字。');
        sum += credit;
        if (!Number.isSafeInteger(sum)) throw new Error('累计收款金额过大。');
        if (id) {
          run('UPDATE payment_records SET amount=?,received_currency=?,received_amount=?,paid_at=?,note=? WHERE id=? AND doc_id=?',
            credit / 100, receivedCurrency, received / 100, paidAt, note, id, doc.id);
        } else {
          run('INSERT INTO payment_records(doc_id,amount,received_currency,received_amount,paid_at,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
            doc.id, credit / 100, receivedCurrency, received / 100, paidAt, note, user.display_name || user.username || '', nowStr());
        }
      }
      for (const id of remaining) run('DELETE FROM payment_records WHERE id=? AND doc_id=?', id, doc.id);
    } else if (existing.size) {
      sum = [...existing.values()].reduce((total, row) => total + cents(row.amount), 0);
    }
    const revision = new Date().toISOString();
    run('INSERT INTO document_payments(doc_id,deposit,paid,remark,created_at,updated_at) VALUES(?,?,?,?,?,?) ' +
      'ON CONFLICT(doc_id) DO UPDATE SET deposit=excluded.deposit,paid=excluded.paid,remark=excluded.remark,updated_at=excluded.updated_at',
    doc.id, deposit / 100, sum / 100, remark, nowStr(), revision);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { SALE_TYPES, CURRENCIES, currencyCode, currencyOptions, cents, findPayableDoc, hasReceipts, readRecords, listDocuments, receiptTotals, savePayments };
