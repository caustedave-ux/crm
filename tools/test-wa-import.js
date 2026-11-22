'use strict';
// 自测：node tools/test-wa-import.js
// 用独立测试库（系统临时目录），不碰 data/crm.db
process.env.CRM_DB = process.env.CRM_DB || require('path').join(require('os').tmpdir(), 'crm-wa-test.db');

const wa = require('../src/waImport');
const { run, get, all } = require('../src/db');
const { nowStr } = require('../src/util');

const IOS_CN = `[2026/10/15, 09:12:33] Tom Smith: Hi, quote for 5000pcs tumbler?
[2026/10/15, 09:20:01] You: Sure, let me check with factory.
[2026/10/15, 09:21:00] Tom Smith: <Media omitted>
[2026/10/15, 09:22:10] Tom Smith: This model please
second line of the same message
[2026/10/16, 10:02:00] You: FOB 3.2 USD/pc, MOQ 3000.
[2026/10/16, 10:05:00] Tom Smith: 价格: can you do 3.0?
[2026/10/16, 10:06:00] ‎Messages and calls are end-to-end encrypted.`;

const ANDROID_EU = `15/10/2026, 09:12 - Tom: Hallo, Preis?
15/10/2026, 09:30 - You: 3.2 USD
16/10/2026, 11:00 - Tom: <image omitted>
16/10/2026, 11:01 - Tom: ok, send PI`;

const ANDROID_US = `10/15/26, 9:12 AM - Tom: Hi
10/15/26, 9:13 AM - You: Hello
10/15/26, 9:14 PM - Tom: 12 USD?`;

const TIME_FIRST_CN = `[上午8:55, 2026/10/15] 客户: 早上好
[下午12:30, 2026/10/15] 我方: 您好，报价已发
[下午3:05, 2026/10/15] 客户: 收到`;

let bad = 0;
function eq(actual, expect, name) {
  if (String(actual) !== String(expect)) { bad++; console.log('  ✗ ' + name + '：期望 ' + expect + '，实际 ' + actual); }
  else console.log('  ✓ ' + name + ' = ' + actual);
}

console.log('=== 1. iOS 中文导出 ===');
const r1 = wa.parseChatText(IOS_CN);
console.log('  order=' + r1.dateOrder, 'real=' + r1.realCount, 'system=' + r1.systemCount, 'media=' + r1.mediaCount, 'range=' + r1.firstTs + ' → ' + r1.lastTs);
r1.messages.forEach(m => console.log('   ', m.ts, '|', m.fromMe ? '我' : m.sender, '|', m.kind, '|', JSON.stringify(m.text).slice(0, 60)));
eq(r1.realCount, 6, '有效消息数（含媒体占位）');
eq(r1.messages[0].date, '2026-10-15', '首条日期');
eq(r1.messages[0].time, '09:12', '首条时间');
eq(r1.messages[1].fromMe, true, 'You → 我方');
eq(r1.messages[2].kind, 'media', '媒体识别');
eq(r1.messages[3].text.split('\n').length, 2, '续行合并为两行');
eq(r1.messages[5].sender, 'Tom Smith', '正文里的冒号不误判发送方');

console.log('\n=== 2. Android 欧式 ===');
const r2 = wa.parseChatText(ANDROID_EU);
eq(r2.realCount, 4, '消息数');
eq(r2.messages[0].date, '2026-10-15', '15/10 解析为 10 月 15 日');
eq(r2.dateOrder, 'dmy', '顺序识别为日先');

console.log('\n=== 3. Android 美式 12 小时制 ===');
const r3 = wa.parseChatText(ANDROID_US);
eq(r3.realCount, 3, '消息数');
eq(r3.messages[0].date, '2026-10-15', '10/15 解析');
eq(r3.messages[2].time, '21:14', 'PM → 21:14');
eq(r3.dateOrder, 'mdy', '顺序识别为月先');

console.log('\n=== 4. 中文时段 + 时间在前 ===');
const r4 = wa.parseChatText(TIME_FIRST_CN);
r4.messages.forEach(m => console.log('   ', m.ts, '|', m.fromMe ? '我' : m.sender, '|', m.text));
eq(r4.realCount, 3, '消息数');
eq(r4.messages[0].time, '08:55', '上午 8:55');
eq(r4.messages[1].time, '12:30', '下午 12:30');
eq(r4.messages[2].time, '15:05', '下午 3:05 → 15:05');

console.log('\n=== 5. 按天幂等导入 ===');
run('DELETE FROM activities WHERE customer_id=9999');
run('DELETE FROM wa_imports WHERE customer_id=9999');
run('DELETE FROM customers WHERE id=9999');
const t = nowStr();
run('INSERT INTO customers(id,user_id,company_name,whatsapp,created_at,updated_at) VALUES(9999,1,?,?,?,?)', 'TEST WhatsApp Co', '+86 138 0013 8000', t, t);
const user = { id: 1, username: 'admin', display_name: '测试员' };

let res = wa.importMessages({ customerId: 9999, messages: r1.messages, user, source: 'test' });
console.log('  第一次：', JSON.stringify({ inserted: res.inserted, updated: res.updated, days: res.days, messages: res.messages }));
eq(res.days, 2, '两天各一条');
eq(res.inserted, 2, '新增 2 条');
eq(res.updated, 0, '改写 0 条');

const before = all('SELECT id, subject, activity_date FROM activities WHERE customer_id=9999 ORDER BY activity_date');
before.forEach(a => console.log('    ', a.activity_date, '—', a.subject));
eq(before[0].activity_date.slice(0, 10), '2026-10-15', '第一条日期');

res = wa.importMessages({ customerId: 9999, messages: r1.messages, user, source: 'test' });
console.log('  重导：', JSON.stringify({ inserted: res.inserted, updated: res.updated }));
eq(res.inserted, 0, '重导不新增');
eq(res.updated, 2, '重导改写 2 条');

const cnt = get('SELECT COUNT(*) c FROM activities WHERE customer_id=9999').c;
eq(cnt, 2, '库里仍然只有 2 条跟进');

const imp = all('SELECT * FROM wa_imports WHERE customer_id=9999 ORDER BY day');
console.log('  台账：', imp.map(i => i.day + '/' + i.msg_count + '条').join('  '));
eq(imp.length, 2, '台账 2 行');

const one = get('SELECT content FROM activities WHERE customer_id=9999 AND activity_date LIKE ?', '2026-10-15%');
console.log('  10-15 正文示例：\n' + String(one.content).split('\n').map(l => '      ' + l).join('\n'));

console.log('\n' + (bad === 0 ? '全部通过 ✅' : bad + ' 项不通过 ❌'));
process.exit(bad === 0 ? 0 : 1);
