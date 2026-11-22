'use strict';
// ============ 重启助手（独立进程）============
// 由 CRM 服务以 detached 方式拉起。职责：
//   1. 等待旧服务进程释放监听端口（旧进程从进程内优雅退出，期间已备份 WhatsApp 登录态）
//   2. 端口空闲后，以 detached 方式启动新的 server.js，使新服务脱离当前会话稳定存活
//   3. 校验新服务确实已监听端口；若没起来则再试一次，避免重启后半途死掉
// 只操作本 CRM 服务进程，不重启电脑、不触碰其他程序或 WhatsApp 登录态。

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT || '5000', 10);
const LOG = path.join(ROOT, 'restart-helper.log');

function log(msg) {
  try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) {}
}

// 端口是否被占用（连接成功=占用；拒绝/超时=空闲）
function portBusy() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: PORT });
    let done = false;
    const finish = (busy) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(busy); } };
    sock.setTimeout(800);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  // 清理大小写重复的代理变量，避免子进程环境异常
  const env = { ...process.env };
  delete env.http_proxy;
  delete env.https_proxy;

  // 日志句柄偶尔会被旧进程短暂占用（EBUSY），重试几次再放弃，避免新服务没日志可查
  let out, err;
  for (let i = 0; i < 10 && (!out || !err); i++) {
    try {
      out = out || fs.openSync(path.join(ROOT, 'server.log'), 'a');
      err = err || fs.openSync(path.join(ROOT, 'server.err.log'), 'a');
    } catch (e) {
      log('打开日志失败（第 ' + (i + 1) + ' 次）：' + e.message);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // 同步小睡 300ms
    }
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', out || 'ignore', err || 'ignore'],
  });
  child.on('exit', (code) => { log('新服务进程退出，code=' + code); });
  child.unref();
  log('新服务已拉起，PID ' + child.pid);
  try { if (out) fs.closeSync(out); if (err) fs.closeSync(err); } catch (e) {}
  return child.pid;
}

// 等端口重新被监听（最多约 30 秒）
async function waitUp(rounds) {
  for (let i = 0; i < rounds; i++) {
    await sleep(500);
    if (await portBusy()) return true;
  }
  return false;
}

(async () => {
  log(`助手启动，目标端口 ${PORT}，等待旧服务释放`);
  await sleep(1500); // 给旧进程一点时间开始优雅退出
  let freed = false;
  for (let i = 0; i < 120; i++) { // 最多等约 60 秒
    if (!(await portBusy())) { freed = true; break; }
    await sleep(500);
  }
  if (!freed) { log('等待端口释放超时，放弃启动（旧服务可能仍在运行）'); process.exit(1); }
  log('端口已释放，准备启动新服务');
  await sleep(400);

  startServer();
  if (await waitUp(60)) { log('重启完成，新服务已监听端口 ' + PORT); process.exit(0); }

  log('新服务 30 秒内未监听端口，尝试再次启动');
  startServer();
  if (await waitUp(30)) { log('重试后重启完成，端口 ' + PORT + ' 已监听'); process.exit(0); }

  log('重启失败：新服务仍未监听端口，请查看 server.err.log');
  process.exit(1);
})();
