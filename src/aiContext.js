'use strict';
// ============ AI 助理：把 CRM 数据库整理成上下文 ============
const { get, all } = require('./db');
const { nowStr } = require('./util');
const knowledgeBase = require('./knowledgeBase');

function money(n) { return String(Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
function typeCn(k) {
  const map = { quotation: '报价单', pi: '形式发票', so: '销售合同', ci: '商业发票', pl: '装箱单', po: '采购单' };
  return map[k] || k;
}

function buildContext(user, question, knowledgeMatches) {
  const uid = parseInt(user && user.id, 10) || 0;
  const L = [];
  const cus = all('SELECT * FROM customers WHERE user_id=? ORDER BY id', uid);
  const prods = all('SELECT * FROM products ORDER BY id');
  const supps = all('SELECT * FROM suppliers ORDER BY id');
  const sps = all('SELECT * FROM supplier_products ORDER BY id');
  const docs = all('SELECT * FROM documents WHERE user_id=? ORDER BY id DESC', uid);
  const acts = all('SELECT * FROM activities WHERE user_id=? ORDER BY id DESC', uid);
  const quotes = all('SELECT * FROM quote_history WHERE user_id=? ORDER BY id DESC LIMIT 100', uid);
  const pay = get("SELECT COALESCE(SUM(p.paid),0) paid, COALESCE(SUM(d.total_amount),0) total FROM document_payments p JOIN documents d ON d.id=p.doc_id WHERE d.user_id=?", uid);
  const low = all('SELECT name, stock, stock_alert FROM products WHERE stock <= stock_alert');

  L.push(`【CRM 数据总览（截至 ${nowStr()}）】客户 ${cus.length} 家、供应商 ${supps.length} 家、产品 ${prods.length} 款、单据 ${docs.length} 张、跟进记录 ${acts.length} 条、历史报价 ${quotes.length} 条。已登记收款合计：${money(pay ? pay.paid : 0)}；单据金额合计：${money(pay ? pay.total : 0)}。`);
  const matchedKnowledge = Array.isArray(knowledgeMatches) ? knowledgeMatches : knowledgeBase.relevantArticles(question, 4);
  if (matchedKnowledge.length) {
    L.push('【知识库参考】' + matchedKnowledge.map(article => `${article.category}｜${article.title}\n${String(article.content || '').slice(0, 5000)}`).join('\n\n'));
  }

  if (cus.length) {
    L.push('【客户】' + cus.slice(0, 200).map(c => `${c.company_name}（${c.country || '-'}，状态${c.status || '-'}，分层${c.customer_tier || '待计算'}，贡献值${c.tier_score || 0}，分层原因${c.tier_reason || '-'}，联系人${c.contact_person || '-'}，电话${c.phone || '-'}，邮箱${c.email || '-'}）`).join('；'));
  }
  if (prods.length) {
    L.push('【产品】' + prods.slice(0, 200).map(p => `${p.name}（货号${p.model || '-'}，单价${p.currency || 'USD'}${money(p.price)}，库存${Number(p.stock) || 0}${p.unit || ''}，进货价${money(p.cost_price)}，库存预警${Number(p.stock_alert) || 0}）`).join('；'));
  }
  if (low.length) L.push('【库存偏低/缺货】' + low.map(p => `${p.name}：现有 ${Number(p.stock) || 0}，预警 ${Number(p.stock_alert) || 0}`).join('；'));
  if (supps.length) L.push('【供应商】' + supps.map(s => `${s.name}（主营：${s.main_products || '见供应产品'}，付款${s.payment_terms || '-'}）`).join('；'));
  if (sps.length) L.push('【供应商供应产品】' + sps.map(s => `${s.name} ${money(s.price)}${s.currency || ''}`).join('；'));
  if (docs.length) {
    const partyMap = {};
    for (const c of cus) partyMap[c.id] = c.company_name;
    const supMap = {}; for (const s of supps) supMap[s.id] = s.name;
    L.push('【单据（最近50张）】' + docs.slice(0, 50).map(d => {
      const party = d.doc_type === 'po' ? (supMap[d.supplier_id] || '') : (partyMap[d.customer_id] || '');
      return `${d.doc_no}（${typeCn(d.doc_type)}，${party || '-'}，${money(d.total_amount)}${d.currency || 'USD'}，状态${d.status || '-'}，日期${d.issue_date || '-'}）`;
    }).join('；'));
  }
  if (quotes.length) L.push('【历史报价】' + quotes.map(q => `${q.quote_no}（${q.product_name || '-'}，${q.quantity || 0}${q.unit || ''}，${q.currency || 'USD'}${money(q.amount)}，${q.status || '-'}，${q.quote_date || '-'}）`).join('；'));
  if (acts.length) L.push('【最近跟进】' + acts.slice(0, 50).map(a => `${a.subject || ''}（客户ID${a.customer_id}，${a.type || ''}，下次${a.next_follow_date || '-'}）`).join('；'));
  L.push('【规则】对用户问题请优先引用以上数据回答；数据不足时明确说明“数据库里没有找到”。数字带币种请照抄单据币种。回答用简体中文，简明。');
  return L.join('\n');
}

module.exports = { buildContext };






