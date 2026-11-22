'use strict';
// ASCII-only 校验，避免 PowerShell 传参时的中文编码问题
const fs = require('fs');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const qrImg = /src="data:image\/png;base64,/.test(html);
const waiting = html.includes('\u7b49\u5f85\u626b\u7801');      // 等待扫码
const spinner = html.includes('\u6b63\u5728\u548c WhatsApp \u5efa\u7acb\u8fde\u63a5'); // 正在和 WhatsApp 建立连接
console.log('qr image :', qrImg);
console.log('waiting  :', waiting);
console.log('spinner  :', spinner);
console.log('size     :', html.length);
process.exit(qrImg || spinner ? 0 : 1);
