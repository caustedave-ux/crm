'use strict';
// 代理到 WhatsApp 的稳定性测试：连续 TLS 握手 N 次，看成功率
// 用法：node tools/test-wa-net.js [代理地址] [次数]
const tls = require('tls');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxy = process.argv[2] || 'http://127.0.0.1:7897';
const times = parseInt(process.argv[3], 10) || 10;
const hosts = ['web.whatsapp.com', 'g.whatsapp.com', 'static.whatsapp.net'];

function once(host) {
  return new Promise((resolve) => {
    const agent = new HttpsProxyAgent(proxy);
    const started = Date.now();
    const sock = tls.connect({ host, port: 443, servername: host, agent, timeout: 8000 }, () => {
      const ms = Date.now() - started;
      sock.end();
      resolve({ ok: true, ms });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, ms: Date.now() - started, err: 'timeout' }); });
    sock.on('error', (e) => resolve({ ok: false, ms: Date.now() - started, err: e.message.slice(0, 60) }));
  });
}

(async () => {
  console.log('proxy =', proxy, ' attempts/host =', times);
  for (const host of hosts) {
    let ok = 0;
    const samples = [];
    for (let i = 0; i < times; i++) {
      const r = await once(host);
      if (r.ok) { ok++; samples.push(r.ms + 'ms'); } else samples.push('X:' + r.err);
    }
    console.log(host.padEnd(22), ok + '/' + times, samples.join(' '));
  }
})();
