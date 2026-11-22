'use strict';
// 分析 server.log 里的 WhatsApp 连接情况
// 用法：node tools/wa-log.js [日志文件]
const fs = require('fs');
const file = process.argv[2] || 'server.log';
const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);

const ts = (l) => {
  const m = /"time":"([^"]+)"/.exec(l);
  return m ? m[1] : '';
};
const pick = (kw) => lines.filter((l) => l.includes(kw));
const times = (arr) => arr.map(ts).filter(Boolean);

const connected = pick('connected to WA');
const tls = pick('disconnected before secure TLS');
const timeout = pick('Timed Out');
const opened = pick('账号已连接');
const history = pick('历史同步');
const qr = pick('"qr"').length ? [] : [];

console.log('日志行数        :', lines.length);
console.log('connected to WA :', connected.length, times(connected).slice(-1)[0] || '');
console.log('TLS 中断        :', tls.length, times(tls).slice(-1)[0] || '');
console.log('握手超时        :', timeout.length, times(timeout).slice(-1)[0] || '');
console.log('成功 open       :', opened.length);
opened.slice(-5).forEach((l) => console.log('   ', ts(l), l.slice(0, 120)));
console.log('历史同步        :', history.length);
console.log('最后一行时间    :', ts(lines[lines.length - 1]));

// 每小时的连接尝试次数，看是否还在风暴
const byHour = {};
for (const t of times(connected)) {
  const h = t.slice(0, 13);
  byHour[h] = (byHour[h] || 0) + 1;
}
console.log('按小时连接次数  :', JSON.stringify(byHour));
