'use strict';
// 观察配对码流程：取码后连接能活多久（判断 WhatsApp 是否立刻断开）
// 用法：node tools/test-wa-pair.js <代理> <手机号> [请求延迟ms]
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const B = require('@whiskeysockets/baileys');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const proxy = process.argv[2];
  const phone = (process.argv[3] || '').replace(/\D/g, '');
  const delay = parseInt(process.argv[4], 10) || 3000;
  if (!proxy || !phone) { console.log('用法: node tools/test-wa-pair.js http://127.0.0.1:7897 8613800138000 [延迟ms]'); process.exit(1); }
  const dir = path.join(os.tmpdir(), 'wa-pair-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await B.useMultiFileAuthState(dir);
  const sock = B.default({
    auth: state, printQRInTerminal: false, browser: B.Browsers.macOS('Desktop'),
    syncFullHistory: false, markOnlineOnConnect: false,
    agent: new HttpsProxyAgent(proxy), fetchAgent: new HttpsProxyAgent(proxy),
    getMessage: async () => ({ conversation: '' }),
  });
  sock.ev.on('creds.update', saveCreds);

  let codeAt = 0;
  sock.ev.on('connection.update', (u) => {
    const t = ((Date.now() - start) / 1000).toFixed(1);
    if (u.connection === 'close') {
      const c = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output ? u.lastDisconnect.error.output.statusCode : 0;
      console.log(t + 's close code=' + c, u.lastDisconnect && u.lastDisconnect.error ? u.lastDisconnect.error.message : '');
    }
    if (u.qr) console.log(t + 's qr');
    if (u.connection === 'open') console.log(t + 's OPEN');
  });

  const start = Date.now();
  setTimeout(async () => {
    try {
      const code = await sock.requestPairingCode(phone);
      codeAt = Date.now();
      console.log(((Date.now() - start) / 1000).toFixed(1) + 's 配对码 ' + code);
    } catch (e) {
      console.log(((Date.now() - start) / 1000).toFixed(1) + 's 取码失败 ' + e.message);
    }
  }, delay);

  setTimeout(() => {
    console.log('存活检查：' + (codeAt ? ((Date.now() - codeAt) / 1000).toFixed(1) : '0') + ' 秒（从取码起）');
    try { sock.end(undefined); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(0), 300);
  }, delay + 20000);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
