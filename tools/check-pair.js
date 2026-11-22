'use strict';
// 检查会话页是否出现 8 位配对码
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const re = /letter-spacing:4px">([A-Z0-9]{4}-[A-Z0-9]{4})</;
const m = re.exec(html);
console.log(m ? '配对码: ' + m[1] : '页面上没有配对码');
const hasCountdown = html.includes('\u5269\u4f59\u7ea6'); // 剩余约
console.log('倒计时提示:', hasCountdown);
process.exit(m ? 0 : 1);
