'use strict';
// 行业简报测试：临时数据库 + 注入素材/AI/WhatsApp，不访问真实网络或账号
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TMP_DIR = 'D:/Codex/tmp';
fs.mkdirSync(TMP_DIR, { recursive: true });
const dbPath = path.join(TMP_DIR, 'crm-briefing-test-' + process.pid + '.db');
try { fs.unlinkSync(dbPath); } catch (e) {}
process.env.CRM_DB = dbPath;
const { db, run, get, all, seedBase } = require('../src/db');
const tiers = require('../src/customerTiers');
const briefings = require('../src/briefings');
seedBase();
for (const table of ['briefings', 'briefing_sources', 'tier_actions', 'activities', 'quote_history', 'contacts', 'customers', 'wa_accounts']) {
  try { run('DELETE FROM ' + table); } catch (e) {}
}
const admin = get('SELECT * FROM users ORDER BY id LIMIT 1');
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
const cr = run(`INSERT INTO customers(user_id,company_name,country,industry,status,level,tier_override,do_not_contact,in_pool,
  whatsapp,contact_person,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  admin.id, 'Briefing Test Buyer', 'Nigeria', 'Door Hardware', '合作客户', '重要', 'B', 0, 0,
  '2348012345678', 'Ada', 'Importer of locks and handles', stamp, stamp);
const customerId = Number(cr.lastInsertRowid);
const cr2 = run(`INSERT INTO customers(user_id,company_name,country,industry,status,level,tier_override,do_not_contact,in_pool,
  whatsapp,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  admin.id, 'C Tier Buyer', 'Nigeria', 'Door Hardware', '潜在客户', '普通', 'C', 0, 0, '2348099999999', stamp, stamp);
const cId = Number(cr2.lastInsertRowid);
run('INSERT INTO wa_accounts(user_id,label,status,created_at,updated_at) VALUES(?,?,?,?,?)', admin.id, 'Test WA', 'online', stamp, stamp);
tiers.refreshTiers(admin.id, { force: true });

(async () => {
assert.equal(briefings.isPrivateIp('127.0.0.1'), true);
assert.equal(briefings.isPrivateIp('192.168.1.2'), true);
assert.equal(briefings.isPrivateIp('8.8.8.8'), false);
assert.equal(briefings.parseAiJson('```json\n{"subject":"x","content":"y"}\n```').subject, 'x');
assert(briefings.stripHtml('<p>Hello &amp; world</p>').includes('Hello & world'));
const manualSourceId = briefings.addSource(admin.id, { name: 'Manual test source', kind: 'manual', content: 'Verified market note for door hardware.', keywords: 'door hardware' });
assert(manualSourceId > 0, '手工素材源可添加');
briefings.toggleSource(admin.id, manualSourceId);
assert.equal(get('SELECT active FROM briefing_sources WHERE id=?', manualSourceId).active, 0, '素材源可以停用');
briefings.removeSource(admin.id, manualSourceId);
assert.equal(get('SELECT id FROM briefing_sources WHERE id=?', manualSourceId), undefined, '素材源可以删除');


const articles = [{
  id: 'test:1', title: 'New door hardware standard announced', source: 'Official Test Source',
  url: 'https://example.com/news/1', publishedAt: '2026-11-01T00:00:00.000Z',
  summary: 'A public standard update relevant to door hardware importers.',
}];
let generatedOnce = false;
const result = await briefings.generateBriefing(admin.id, customerId, {
  language: 'en', articles,
  generate: async () => {
    generatedOnce = true;
    return { subject: 'Door Hardware Brief - November 2026',
      content: 'Hello Ada,\n\nThis month we reviewed the available source update [1].\n\nBest regards, HQ CRM',
      internal_notes: '来源 1 已核对；发送前请确认客户是否仍采购同类产品。' };
  },
});
assert(generatedOnce, '应调用注入的 AI 生成器');
assert.equal(result.customer_id, customerId);
assert.equal(result.status, 'draft');
assert(result.content.includes('Sources:'), '正文应自动附素材链接');
assert(result.content.includes('example.com/news/1'));
assert(result.content_zh.includes('来源 1'), '应保存中文内部提示');
assert(result.tier_action_id > 0, '草稿应关联 B 类月度任务');
assert.equal(get("SELECT COUNT(*) c FROM tier_actions WHERE customer_id=? AND action_type='monthly_brief'", customerId).c, 1, '本月任务不能重复');

let rejectedC = false;
try { await briefings.generateBriefing(admin.id, cId, { articles, generate: async () => ({ subject: 'x', content: 'y' }) }); }
catch (e) { rejectedC = /B 类/.test(e.message); }
assert(rejectedC, 'C 类客户不能生成 B 类简报');

const saved = briefings.saveBriefing(admin.id, result.id, {
  subject: 'Edited Subject', content: 'Edited customer content [1].', content_zh: '人工复核完成',
});
assert.equal(saved.subject, 'Edited Subject');
assert.equal(saved.content, 'Edited customer content [1].');

let sentTo = '';
const sent = await sendPromise();
async function sendPromise() {
  return briefings.sendBriefing(admin.id, result.id, {
    sendText: async (uid, jid, text) => { sentTo = jid; return { ok: true }; },
  });
}
assert.equal(sent.status, 'sent');
assert.equal(sentTo, '2348012345678@s.whatsapp.net');
const action = get("SELECT * FROM tier_actions WHERE customer_id=? AND action_type='monthly_brief'", customerId);
assert.equal(action.status, 'completed', '发送后应自动完成 B 类月度任务');
const activity = get('SELECT * FROM activities WHERE id=?', action.activity_id);
assert.equal(Number(activity.archived), 1);
assert(activity.content.includes('结合客户国家'), '原系统跟进内容不能被删除');
assert(activity.content.includes('【B类行业简报'), '应追加简报发送记录');
let duplicateBlocked = false;
try { await briefings.sendBriefing(admin.id, result.id, { sendText: async () => ({ ok: true }) }); }
catch (e) { duplicateBlocked = /已经发送/.test(e.message); }
assert(duplicateBlocked, '已发送简报不能重复发送');
const dashboard = briefings.briefingDashboard(admin.id, 'all');
assert.equal(dashboard.counts.customers >= 1, true);
assert.equal(dashboard.counts.sent, 1);
console.log('industry briefings: all tests passed');
db.close();
try { fs.unlinkSync(dbPath); } catch (e) {}
})().catch(e => { console.error(e); try { db.close(); } catch (e2) {} try { fs.unlinkSync(dbPath); } catch (e2) {} process.exit(1); });


