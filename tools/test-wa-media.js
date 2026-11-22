'use strict';
// 自测：带媒体的 WhatsApp zip 导出 → 解析 → 匹配客户 → 导入（图片进跟进记录）
// 用法：node tools/test-wa-media.js
process.env.CRM_DB = process.env.CRM_DB || require('path').join(require('os').tmpdir(), 'crm-wa-media.db');

const fs = require('fs');
const path = require('path');
const wa = require('../src/waImport');
const waMatch = require('../src/waMatch');
const { run, get, all } = require('../src/db');
const { nowStr } = require('../src/util');

// --- 手搓一个 stored(不压缩) zip ---
function zipStored(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(0, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const CHAT = [
  '[2026/10/20, 09:12:33] Ahmed: Hi, this model',
  '[2026/10/20, 09:12:40] Ahmed: <attached: IMG-20261020-WA0001.jpg>',
  '[2026/10/20, 09:13:02] You: Noted, checking price',
  '[2026/10/20, 09:20:00] Ahmed: 图片收到了吗 <attached: IMG-20261020-WA0002.jpg>',
  '[2026/10/20, 09:21:00] Ahmed: PTT-20261020-WA0003.opus (file attached)',
  '[2026/10/21, 10:00:00] You: 价格 3.2 USD',
].join('\n');

const jpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]); // 最小 jpeg
const opus = Buffer.from('OggS-fake-audio');

const zip = zipStored([
  { name: 'WhatsApp Chat with +971 50 123 4567/_chat.txt', data: CHAT },
  { name: 'WhatsApp Chat with +971 50 123 4567/IMG-20261020-WA0001.jpg', data: jpg },
  { name: 'WhatsApp Chat with +971 50 123 4567/IMG-20261020-WA0002.jpg', data: jpg },
  { name: 'WhatsApp Chat with +971 50 123 4567/PTT-20261020-WA0003.opus', data: opus },
]);

let bad = 0;
function eq(a, e, name) {
  if (String(a) !== String(e)) { bad++; console.log('  ✗ ' + name + '：期望 ' + e + '，实际 ' + a); }
  else console.log('  ✓ ' + name + ' = ' + a);
}

console.log('=== 1. 解包 ===');
const z = wa.extractZip(zip);
const text = z.text ? wa.decodeBuffer(z.text) : '';
eq(text.includes('Ahmed'), true, 'zip 里找到聊天正文');
eq(z.files.length, 3, '解出 3 个媒体文件');
console.log('   ', z.files.map(f => f.name).join(', '));

console.log('\n=== 2. 解析（识别附件）===');
const names = new Set(z.files.map(f => f.name));
const parsed = wa.parseChatText(text, { mediaNames: names });
console.log('   ', parsed.messages.filter(m => m.mediaName).map(m => m.mediaName + ' → ' + m.text).join(' | '));
eq(parsed.messages.filter(m => m.mediaName).length, 3, '认出 3 条附件消息');

console.log('\n=== 3. 文件名 → 客户匹配 ===');
const hint = waMatch.parseExportName('WhatsApp Chat with +971 50 123 4567.txt');
eq(hint.phone, '971501234567', '文件名抠出号码');
const t = nowStr();
run('DELETE FROM activities WHERE customer_id=9999');
run('DELETE FROM wa_imports WHERE customer_id=9999');
run('DELETE FROM customers WHERE id=9999');
run('INSERT INTO customers(id,user_id,company_name,whatsapp,created_at,updated_at) VALUES(9999,1,?,?,?,?)', 'ZZ Media Co', '+971 50 123 4567', t, t);
const m = waMatch.matchCustomer(1, hint);
eq(m && m.how, '号码精确匹配', '匹配方式');
eq(m && m.customerId, 9999, '匹配到客户');
const byName = waMatch.parseExportName('WhatsApp Chat with ZZ Media.txt');
eq(waMatch.matchCustomer(1, byName).customerId, 9999, '按公司名也能匹配');

console.log('\n=== 4. 媒体落盘 + 导入 ===');
const mediaMap = wa.saveMediaFiles(z.files);
eq(Object.keys(mediaMap).length, 3, '媒体已存到 uploads');
const one = mediaMap[z.files[0].name];
eq(one.indexOf('/uploads/wa-media/'), 0, '返回可用路径');
const abs = path.join(__dirname, '..', one.replace('/uploads/', 'uploads/'));
eq(fs.existsSync(abs), true, '磁盘上确实存在');

const r = wa.importMessages({ customerId: 9999, messages: parsed.messages, user: { id: 1, display_name: '测试' }, source: 'test', mediaMap });
eq(r.ok, true, '导入成功');
const acts = all('SELECT id, activity_date, images FROM activities WHERE customer_id=9999 ORDER BY activity_date');
eq(acts.length, 2, '按天生成 2 条');
const imgs = JSON.parse(acts[0].images || '[]');
console.log('    第一条记录挂的图片:', imgs.length, '个');
eq(imgs.length >= 2, true, '10-20 那天挂了至少 2 个附件');

console.log('\n' + (bad === 0 ? '全部通过 ✅' : bad + ' 项不通过 ❌'));
process.exit(bad === 0 ? 0 : 1);
