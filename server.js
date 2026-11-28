'use strict';
// ============ HQ CRM 启动入口（局域网共享版） ============
const os = require('os');
const { createApp } = require('./src/web');
const { registerRoutes } = require('./src/routes');
const { seedBase, backupNow, run: dbRun } = require('./src/db');
const { seedSampleDocuments } = require('./src/documents');
const auth = require('./src/auth');
const { autoPoolStale } = require('./src/reminders');
const customerTiers = require('./src/customerTiers');
const wa = require('./src/wa');
const waSiteLink = require('./src/waSiteLink');
const systemRestart = require('./src/systemRestart');

const PORT = parseInt(process.env.PORT || '5000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// 兜底：未捕获的异步异常只记日志，不让整个 CRM 进程退出（局域网里可能有人正在用）
process.on('unhandledRejection', (e) => { console.error('[未捕获的 Promise 异常]', (e && e.stack) || e); });

// 优雅退出：先停收请求、备份 WhatsApp 登录态并断开 socket，再把数据库 WAL 落盘后退出
// （对照 Evolution/WAHA 的 graceful shutdown；Web 重启与 Ctrl+C 走同一套流程）
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  waSiteLink.stop();
  console.log('收到 ' + signal + '，正在退出…');
  // 1) 先停止接收新请求，避免退出瞬间还有人写入
  try { app.server.close(); } catch (e) {}
  // 2) 备份 WhatsApp 登录态 + 断开所有 socket（避免 creds 写一半导致下次要重新扫码）
  try { await wa.shutdown(); } catch (e) { console.error('WhatsApp 关闭失败：', (e && e.message) || e); }
  // 3) 数据库 WAL 落盘，确保新进程读到完整数据
  try { dbRun('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 系统设置里的「重启系统」：由 systemRestart 在拉起重启助手后直接调用本函数，
// 不再依赖信号（Windows 下 process.kill(SIGTERM) 为强制终止，来不及保存 WhatsApp 登录态）
systemRestart.setShutdownHandler(shutdown);

// 初始化数据库与演示数据（已有数据的库绝不会被演示数据覆盖或追加）
seedBase();
seedSampleDocuments();
const bkFile = backupNow();
if (bkFile) console.log('已自动备份数据库：' + bkFile);

// WhatsApp 存量客户补偿：今天已经聊过且已绑定客户的会话，自动补上“当天 +3 天”跟进。
try {
  const waFollowups = wa.ensureTodayWhatsAppFollowups();
  if (!waFollowups.skipped && waFollowups.count) {
    console.log('已为 ' + waFollowups.count + ' 家 WhatsApp 客户安排跟进：' + waFollowups.followDate);
  }
} catch (e) {
  console.error('WhatsApp 当日跟进补偿失败：', e.message);
}

// 跟进超期规则：启动时检查一次，之后每小时检查（满30天未跟进自动进入公共客户池）
try {
  const r0 = autoPoolStale();
  if (r0.pooled) console.log('已自动将 ' + r0.pooled + ' 家超过30天未跟进的客户移入公共客户池');
} catch (e) { console.error('自动入池检查失败：', e.message); }
try {
  let tierCreated = 0;
  for (const user of require('./src/db').all('SELECT id FROM users WHERE active=1')) {
    tierCreated += customerTiers.ensureTierActions(user.id).created;
  }
  if (tierCreated) console.log('已生成 ' + tierCreated + ' 条客户分层周期跟进');
} catch (e) { console.error('客户分层启动检查失败：', e.message); }
setInterval(function () {
  try { autoPoolStale(); } catch (e) {}
  try {
    const users = require('./src/db').all('SELECT id FROM users WHERE active=1');
    for (const user of users) customerTiers.ensureTierActions(user.id);
  } catch (e) {}
}, 60 * 60 * 1000).unref();

const app = createApp({
  before(ctx) {
    const p = ctx.url.pathname;
    // 公共路径
    if (p === '/login' || p === '/favicon.ico' || p.startsWith('/static/') || p.startsWith('/uploads/')) return true;
    // FOEVE 独立站询盘：只放行这一个签名接口，其他 CRM 页面/API 仍需登录
    if (ctx.method === 'POST' && p === '/api/public/website-inquiry') return true;
    // 其余一律需要登录
    auth.authUser(ctx.req, ctx.res);
    if (!ctx.req.user) {
      if (ctx.method === 'GET') ctx.res.redirect('/login?next=' + encodeURIComponent(p + ctx.url.search));
      else ctx.res.json(401, { error: '未登录或登录已过期' });
      return false;
    }
    ctx.user = ctx.req.user;
    ctx.sessionToken = ctx.req.sessionToken;
    return true;
  },
});

registerRoutes(app, app.router);

// 收集局域网 IP
function lanIPs() {
  const list = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) list.push({ name, address: ni.address });
    }
  }
  return list;
}

app.server.listen(PORT, HOST, () => {
  waSiteLink.start();
  const ips = lanIPs();
  console.log('');
  console.log('====================================================');
  console.log('   HQ CRM 系统已启动（局域网共享版）');
  console.log('====================================================');
  console.log('  本机访问:  http://127.0.0.1:' + PORT);
  for (const ip of ips) console.log('  局域网访问: http://' + ip.address + ':' + PORT + '   （网卡：' + ip.name + '）');
  if (!ips.length) console.log('  未检测到局域网 IP，请用本机 IP 访问');
  console.log('  默认账号:  admin / admin123');
  console.log('  按 Ctrl+C 停止服务');
  console.log('====================================================');
  console.log('');
  // 启动后自动恢复已登录的 WhatsApp 账号（未安装依赖时静默跳过）
  try { wa.resumeAll(6000); } catch (e) { console.error('WhatsApp 自动恢复跳过：', e.message); }
});

