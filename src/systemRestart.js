'use strict';
// ============ 系统重启（Web 触发）============
// 安全重启流程：
//  1. 路由先返回 JSON 给浏览器（否则进程退出会导致连接中断、前端收到空响应）
//  2. 以 detached 方式拉起 tools/restart-helper.cjs（独立进程，不受本进程退出影响）
//  3. 本进程执行「进程内优雅退出」：停止接收请求 → 备份 WhatsApp 登录态并断开 socket
//     → 数据库 WAL 落盘 → 退出
//     注意：Windows 上 process.kill(SIGTERM) 是强制终止、不会触发 SIGTERM 回调，
//     所以这里绝不能靠发信号退出，必须直接调用注册进来的优雅退出函数。
//  4. 助手确认端口释放后启动新的 server.js，并校验新服务确实已监听端口
// 不重启电脑、不退出 WhatsApp 登录、不写入客户数据。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'tools', 'restart-helper.cjs');
const PORT = parseInt(process.env.PORT || '5000', 10);
const LOG = path.join(ROOT, 'restart-helper.log');
const GRACE_TIMEOUT_MS = 12000;

let restarting = false;
let shutdownHandler = null;

function log(msg) {
  try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isRestarting() { return restarting; }

/** server.js 启动时注册自己的优雅退出函数（备份 WhatsApp 登录态 + 关库） */
function setShutdownHandler(fn) {
  if (typeof fn === 'function') shutdownHandler = fn;
}

// 触发重启（响应已发出后再调用）。返回 false 表示已在重启中。
function scheduleRestart() {
  if (restarting) return false;
  restarting = true;
  log('收到重启请求，PID ' + process.pid);

  // 稍等片刻确保 HTTP 响应已 flush 到浏览器
  setTimeout(async () => {
    // 1) 先拉起独立助手：即使本进程意外退出，助手也会把服务拉回来
    try {
      const env = { ...process.env };
      delete env.http_proxy;
      delete env.https_proxy;
      const helper = spawn(process.execPath, [HELPER, String(PORT)], {
        cwd: ROOT,
        env,
        detached: true,
        stdio: 'ignore',
      });
      helper.unref();
      log('重启助手已启动，PID ' + helper.pid);
    } catch (e) {
      log('启动重启助手失败：' + e.message);
      restarting = false;
      return; // 助手没起来就不退出，保持服务可用
    }

    // 2) 给助手时间进入等待状态
    await sleep(1200);

    // 3) 进程内优雅退出
    try {
      if (shutdownHandler) {
        const guard = setTimeout(() => {
          log('优雅退出超时（' + GRACE_TIMEOUT_MS + 'ms），强制退出');
          process.exit(0);
        }, GRACE_TIMEOUT_MS);
        if (guard.unref) guard.unref();
        await shutdownHandler('restart');
      }
    } catch (e) {
      log('优雅退出出错：' + (e && e.message));
    }
    log('优雅退出流程结束，强制退出');
    process.exit(0);
  }, 800);

  return true;
}

module.exports = { scheduleRestart, isRestarting, setShutdownHandler };
