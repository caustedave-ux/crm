'use strict';
// ============ 自动回复工作台总开关控制 ============
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..', 'auto-reply');
const CONFIG_PATH = path.join(DIR, 'config.json');
const PID_PATH = path.join(DIR, 'worker.pid');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}
function pidAlive(pid) {
  const n = Number(pid) || 0;
  if (!n) return false;
  try { process.kill(n, 0); return true; } catch (e) { return false; }
}
function workerPid() {
  try {
    if (!fs.existsSync(PID_PATH)) return 0;
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim()) || 0;
    if (pid && pidAlive(pid)) return pid;
    try { fs.unlinkSync(PID_PATH); } catch (e) {}
  } catch (e) {}
  return 0;
}
function materialCount() {
  try {
    const stockDir = path.join(DIR, 'materials', 'stock');
    if (!fs.existsSync(stockDir)) return { images: 0, pdfs: 0 };
    const files = fs.readdirSync(stockDir);
    return {
      images: files.filter(f => /\.(jpe?g|png|webp)$/i.test(f)).length,
      pdfs: files.filter(f => /\.pdf$/i.test(f)).length,
    };
  } catch (e) { return { images: 0, pdfs: 0 }; }
}
function status() {
  let config = {};
  try { config = readConfig(); } catch (e) {}
  const pid = workerPid();
  const materials = materialCount();
  return {
    enabled: !!config.enabled,
    running: !!pid,
    pid,
    sessionCookieConfigured: !!(config.sessionCookie && String(config.sessionCookie).trim()),
    qualifyEnabled: !!(config.qualify && config.qualify.enabled),
    stockImages: materials.images,
    stockPdfs: materials.pdfs,
    stockPreferPdf: !!(config.qualify && config.qualify.stockPreferPdf !== false),
    stockSendAll: !!(config.qualify && Number(config.qualify.maxStockImages) === 0),
  };
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function stopWorker() {
  const pid = workerPid();
  if (!pid) return { stopped: false };
  try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    if (!pidAlive(pid)) break;
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    await sleep(150);
  }
  try {
    if (fs.existsSync(PID_PATH) && Number(fs.readFileSync(PID_PATH, 'utf8').trim()) === pid) fs.unlinkSync(PID_PATH);
  } catch (e) {}
  return { stopped: true, pid };
}
async function startWorker() {
  if (workerPid()) return { started: false, alreadyRunning: true };
  const child = spawn(process.execPath, ['worker.js'], {
    cwd: DIR,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (workerPid()) return { started: true, pid: workerPid() };
  }
  return { started: false, error: 'worker 未成功启动，请查看 auto-reply/auto-reply.log' };
}
async function setEnabled(userId, sessionToken, enabled) {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('找不到 auto-reply/config.json');
  if (enabled && !sessionToken) throw new Error('当前登录会话无效，请重新登录');
  const config = readConfig();
  config.enabled = !!enabled;
  if (enabled) {
    config.sessionCookie = String(sessionToken);
    config.botUserId = Number(userId) || 0;
    config.startFromNow = true;
  }
  writeConfig(config);
  await stopWorker();
  let start = null;
  if (enabled) start = await startWorker();
  if (start && start.error) {
    config.enabled = false;
    writeConfig(config);
    throw new Error(start.error);
  }
  return status();
}

module.exports = { status, setEnabled, startWorker, stopWorker, readConfig, writeConfig };
