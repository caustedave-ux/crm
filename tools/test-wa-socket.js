'use strict';
// 冒烟测试：能否连上 WhatsApp、能否拿到二维码（不需要真的扫码）
// 用法：node tools/test-wa-socket.js
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const B = require('@whiskeysockets/baileys');
  const QR = require('qrcode');
  const proxy = process.argv[2] || process.env.WA_PROXY || '';
  let agent = null;
  if (proxy) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    agent = new HttpsProxyAgent(proxy);
    console.log('proxy:', proxy);
  }
  const dir = path.join(os.tmpdir(), 'wa-smoke-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  console.log('auth dir:', dir);

  const full = process.argv[3] === 'full' || process.env.WA_FULL === '1';
  console.log('syncFullHistory:', full);
  const { state, saveCreds } = await B.useMultiFileAuthState(dir);
  const sock = B.default({
    auth: state,
    printQRInTerminal: false,
    browser: B.Browsers.macOS('Desktop'),
    syncFullHistory: full,
    markOnlineOnConnect: false,
    ...(agent ? { agent, fetchAgent: agent } : {}),
    getMessage: async () => ({ conversation: '' }),
  });
  sock.ev.on('creds.update', saveCreds);

  let done = false;
  const finish = (code, msg) => {
    if (done) return;
    done = true;
    console.log(msg);
    try { sock.end(undefined); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(code), 300);
  };

  const timer = setTimeout(() => finish(2, '✗ 30 秒内没有拿到二维码（网络可能被挡）'), 30000);

  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u || {};
    if (qr) {
      try {
        const url = await QR.toDataURL(qr, { margin: 1, width: 320 });
        clearTimeout(timer);
        finish(0, '✓ 已拿到二维码：' + qr.length + ' 字符，图片 dataURL ' + url.length + ' 字节');
      } catch (e) {
        clearTimeout(timer);
        finish(3, '✗ 拿到二维码但生成图片失败：' + e.message);
      }
    }
    if (connection === 'open') finish(0, '✓ 已连接（这个 auth 目录之前登录过）');
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : 0;
      clearTimeout(timer);
      finish(4, '✗ 连接被关闭，code=' + code + '：' + (lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : ''));
    }
  });
})().catch(e => { console.error('✗ 异常：', e.message); process.exit(1); });
