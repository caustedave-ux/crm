'use strict';
// 探针：连上后用代理跑 100 秒，观察二维码 ref 是否按 ~20s 节奏持续下发
// 用法：node tools/probe-qr.js [代理]
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const B = require('@whiskeysockets/baileys');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const proxy = process.argv[2] || 'http://127.0.0.1:7897';
  const agent = new HttpsProxyAgent(proxy);
  const dir = path.join(os.tmpdir(), 'wa-probe-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await B.useMultiFileAuthState(dir);
  const sock = B.default({
    auth: state, printQRInTerminal: false, browser: B.Browsers.macOS('Chrome'),
    syncFullHistory: false, markOnlineOnConnect: false,
    agent, fetchAgent: agent,
    getMessage: async () => ({ conversation: '' }),
  });
  sock.ev.on('creds.update', saveCreds);

  const t0 = Date.now();
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  let refs = 0;
  sock.ev.on('connection.update', (u) => {
    if (u.qr) { refs++; console.log(ts(), 'QR ref #' + refs); }
    if (u.connection === 'close') {
      const c = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output ? u.lastDisconnect.error.output.statusCode : 0;
      console.log(ts(), 'CLOSE code=' + c, u.lastDisconnect && u.lastDisconnect.error ? u.lastDisconnect.error.message : '');
    }
    if (u.connection === 'open') console.log(ts(), 'OPEN');
  });

  setInterval(() => {
    const ws = sock.ws;
    console.log(ts(), 'WS readyState=' + (ws ? ws.readyState : 'none'), 'isOpen=' + (ws && ws.isOpen ? ws.isOpen : '?'), 'refs=' + refs);
  }, 20000);

  setTimeout(() => {
    console.log('--- 结果：100 秒内收到 ' + refs + ' 张码（正常应 4-5 张）---');
    try { sock.end(undefined); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(0), 300);
  }, 100000);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
