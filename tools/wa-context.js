'use strict';
// 打印日志里的事件类型统计 + 指定关键词附近的上下文
// 用法：node tools/wa-context.js 账号已连接
const fs = require('fs');
const file = process.argv[2] || 'server.log';
const kw = process.argv[3] || '';
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

const msgCount = {};
for (const l of lines) {
  const m = /"msg":"([^"]+)"/.exec(l);
  if (m) msgCount[m[1]] = (msgCount[m[1]] || 0) + 1;
}
const top = Object.entries(msgCount).sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('=== msg 分布 ===');
for (const [k, v] of top) console.log(String(v).padStart(6), k);

if (kw) {
  const idx = lines.map((l, i) => (l.includes(kw) ? i : -1)).filter((i) => i >= 0);
  console.log('\n=== 命中 ' + kw + '：' + idx.length + ' 处，最后 3 处上下文 ===');
  for (const i of idx.slice(-3)) {
    for (let j = Math.max(0, i - 6); j <= Math.min(lines.length - 1, i + 6); j++) {
      const mark = j === i ? '>>' : '  ';
      console.log(mark, lines[j].slice(0, 210));
    }
    console.log('---');
  }
}
