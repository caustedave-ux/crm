'use strict';
// ============ WhatsApp 导出文件 → 客户匹配 ============
// WhatsApp 导出的文件名形如：
//   WhatsApp Chat with +971 50 123 4567.txt
//   WhatsApp Chat with Tom Smith.txt
//   WhatsApp 聊天记录与 王先生.txt
// 优先用号码精确匹配，其次用名称模糊匹配；匹配不到返回 null，由用户手动选。
const { all } = require('./db');

function digits(s) { return String(s || '').replace(/\D/g, ''); }

/** 从文件名里抠出「对方是谁」：号码或名字。 */
function parseExportName(filename) {
  let base = String(filename || '').replace(/\.(txt|zip)$/i, '').trim();
  // 去掉前缀：WhatsApp Chat with / WhatsApp 聊天记录与 / 与
  base = base.replace(/^whatsapp\s*(chat)?\s*(with)?\s*/i, '')
    .replace(/^whatsapp\s*聊天记录\s*(与)?\s*/i, '')
    .replace(/^与\s*/, '')
    .trim();
  const phone = digits(base);
  // 号码至少 7 位才算号码；否则当名字
  if (phone.length >= 7) return { phone, name: '' };
  return { phone: '', name: base };
}

/**
 * 在某个业务员自己的客户里找匹配。
 * @returns {{customerId:number, how:string}|null}
 */
function matchCustomer(userId, { phone, name }) {
  const uid = Number(userId) || 0;
  const p = digits(phone);
  if (p.length >= 7) {
    // 1) 客户 WhatsApp / 电话精确匹配
    let hit = all(`SELECT id FROM customers WHERE user_id=? AND (
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(whatsapp,''),' ',''),'-',''),'+',''),'(',''),')','') = ?
        OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),' ',''),'-',''),'+',''),'(',''),')','') = ?
        OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(contact_phone,''),' ',''),'-',''),'+',''),'(',''),')','') = ?
      ) LIMIT 2`, uid, p, p, p);
    if (hit.length === 1) return { customerId: hit[0].id, how: '号码精确匹配' };
    if (hit.length > 1) return null;   // 多个客户撞号，交给人工
    // 2) 联系人手机精确匹配
    hit = all(`SELECT DISTINCT cu.id FROM contacts ct JOIN customers cu ON cu.id=ct.customer_id
      WHERE cu.user_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(ct.mobile,''),' ',''),'-',''),'+',''),'(','') = ? LIMIT 2`, uid, p);
    if (hit.length === 1) return { customerId: hit[0].id, how: '联系人手机匹配' };
    if (hit.length > 1) return null;
    // 3) 后缀 9 位唯一匹配（处理国家码 / 0 前缀差异）
    if (p.length > 9) {
      const tail = p.slice(-9);
      hit = all(`SELECT id FROM customers WHERE user_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(whatsapp,''),' ',''),'-',''),'+',''),'(','') LIKE ?`, uid, '%' + tail);
      if (hit.length === 1) return { customerId: hit[0].id, how: '号码后缀匹配' };
    }
    return null;
  }
  const n = String(name || '').trim();
  if (n.length < 2) return null;
  const like = '%' + n + '%';
  const hit = all(`SELECT id FROM customers WHERE user_id=? AND (
      company_name LIKE ? OR COALESCE(name_en,'') LIKE ? OR COALESCE(contact_person,'') LIKE ?
    ) LIMIT 2`, uid, like, like, like);
  if (hit.length === 1) return { customerId: hit[0].id, how: '名称匹配' };
  if (hit.length > 1) {
    // 名字命中多个：再用联系人姓名收窄
    const ct = all(`SELECT DISTINCT customer_id AS id FROM contacts WHERE name LIKE ? LIMIT 2`, like);
    if (ct.length === 1) return { customerId: ct[0].id, how: '联系人姓名匹配' };
  }
  return null;
}

module.exports = { parseExportName, matchCustomer, digits };
