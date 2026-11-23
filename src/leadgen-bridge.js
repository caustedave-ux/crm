'use strict';
// ============ 获客工作台系统集成桥 ============
// 主 CRM 通过它探测 / 拉起独立的 suite 服务（默认 5101），
// 并把局域网客户端正确导向同一台主机的获客端口。不侵入 suite 代码。
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.LEADGEN_PORT || '5101', 10);
const LG_DIR = path.join(__dirname, '..', 'suite');
const ENTRY = path.join(LG_DIR, 'server.js');

// 探测端口是否已监听（连接即算在线，随后立即断开）。
function portOpen(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: host || '127.0.0.1', port: port || PORT });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(1500, () => finish(false));
  });
}

function isOnline() { return portOpen(PORT); }

// 确保获客服务在线：已在线则直接返回；否则拉起并最多等待约 4 秒。
async function ensureLeadGen() {
  if (await portOpen(PORT)) return { ok: true, action: 'already' };
  if (!fs.existsSync(ENTRY)) return { ok: false, reason: '未找到 suite/server.js' };

  let logFd = 'ignore';
  try { logFd = fs.openSync(path.join(LG_DIR, 'autostart.log'), 'a'); } catch (e) {}
  try {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: LG_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: Object.assign({}, process.env, {
        LEADGEN_HOST: process.env.LEADGEN_HOST || '0.0.0.0',
        CRM_PORT: String(parseInt(process.env.PORT || '5000', 10)),
      }),
    });
    child.unref();
    if (typeof logFd === 'number') { try { fs.closeSync(logFd); } catch (e) {} }
    console.log('[获客工作台] 已拉起独立服务，PID ' + child.pid + '，端口 ' + PORT);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await portOpen(PORT)) return { ok: true, action: 'started' };
  }
  return { ok: false, reason: '服务已启动但端口尚未就绪，请稍后重试' };
}

// 根据访问请求的 Host 头算出获客系统地址（保留主机名，替换端口为 5101）。
function targetFromReq(req) {
  const host = String((req && req.headers && req.headers.host) || ('127.0.0.1:' + PORT));
  let hostname;
  const ipv6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6) return 'http://[' + ipv6[1] + ']:' + PORT;
  hostname = host.split(':')[0] || '127.0.0.1';
  return 'http://' + hostname + ':' + PORT;
}

module.exports = { PORT, isOnline, ensureLeadGen, targetFromReq };
