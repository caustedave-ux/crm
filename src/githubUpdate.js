'use strict';
// ============ GitHub 应用内自动升级 ============
// 设计原则（数据安全第一）：
//  1. 只通过 GitHub REST API（api.github.com）读取仓库，不做 git pull / clone（本机代理下不稳定）。
//  2. 只覆盖「路径白名单」内的代码文件；data/、uploads/、node_modules/、.git/、数据库、登录态、
//     聊天记录、产品素材等一律禁止写入，从根上保证客户数据与 WhatsApp 记录零改动。
//  3. 本地被改过的文件（相对更新基线）默认跳过，避免覆盖用户在本机的定制（如设置搬迁）。
//  4. 覆盖前把原文件完整备份到 data/upgrade-backups/<时间戳>/，支持一键回滚。
//  5. 版本基准用 data/upgrade-state.json 记录，不依赖 git HEAD（本机有未提交改动）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ROOT 默认取项目根；GITHUB_UPDATE_ROOT 仅供隔离测试使用（生产环境不应设置）
const ROOT = process.env.GITHUB_UPDATE_ROOT ? path.resolve(process.env.GITHUB_UPDATE_ROOT) : path.join(__dirname, '..');
const OWNER = 'caustedave-ux';
const REPO = 'crm';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const STATE_FILE = path.join(ROOT, 'data', 'upgrade-state.json');
const BACKUP_ROOT = path.join(ROOT, 'data', 'upgrade-backups');
const VERSION_FILE = path.join(ROOT, 'package.json');

const REQUEST_TIMEOUT_MS = 30000;

// 允许升级覆盖的文件（相对仓库根）。这里是精确白名单，宁可少更新也不能误伤数据。
const ALLOWED_FILES = new Set([
  'README.md',
  'package.json',
  'src/routes.js',
  'src/aiAssistant.js',
  'src/views/layout.js',
  'src/views/pages_ai.js',
  'src/views/pages_core.js',
  'src/views/pages_docs.js',
  'src/views/pages_knowledge.js',
  'src/views/pages_logistics.js',
  'src/views/pages_pay.js',
  'src/views/pages_quotes.js',
  'src/views/pages_wa.js',
  'src/views/pages_workbench.js',
  'static/css/style.css',
  'docs/workbench-2.0.md',
  'docs/PRD-产品需求文档.md',
  'docs/opensource.md',
  'tools/test-ai-assistant.js',
  'tools/test-wa-inbox.js',
]);

// 允许「删除」的文件（远端 removed 时同步删除）。默认空：不自动删任何本地文件，
// 避免误删本地仍在引用的模块（如 codexAssistant）。需要时再显式加入。
const ALLOWED_DELETIONS = new Set([]);

function isAllowedFile(name) { return ALLOWED_FILES.has(String(name || '').replace(/\\/g, '/')); }

function safeName(name) {
  // 二次防御：即使白名单被误改，也拒绝任何数据/敏感路径特征
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.includes('..') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  if (/(^|\/)(data|uploads|node_modules|\.git|auto-reply|\.workbuddy|suite\/data)(\/|$)/i.test(n)) return false;
  if (/\.(db|db-wal|db-shm|sqlite|log|pem|key|env)$/i.test(n)) return false;
  return true;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { installedCommit: null, installedAt: null, appliedCommits: [], lastCheck: null }; }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function localVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).version || '未知'; }
  catch { return '未知'; }
}

// 通过 curl 调用 GitHub API。
// 本机在国内网络下直连 GitHub 常出现 TLS 握手失败（curl 35 schannel），所以优先走
// 「系统设置 → WhatsApp 连接」里已配置的代理，失败再回退直连，并对瞬时握手失败重试一次。
function resolveProxy() {
  let p = '';
  try { p = String(require('./db').getSetting('wa_proxy') || '').trim(); } catch (e) {}
  if (!p) p = String(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  if (!p) return '';
  p = p.replace(/^socks5h:\/\//i, 'socks5h://').replace(/^socks5:\/\//i, 'socks5h://').replace(/^socks:\/\//i, 'socks5h://');
  return /^(http|https|socks5h):\/\//i.test(p) ? p : 'http://' + p;
}

function shortErr(e) {
  const msg = String((e && e.message) || '网络错误');
  const lines = msg.split('\n').map(s => s.trim()).filter(Boolean);
  const tail = lines[lines.length - 1] || msg;
  return tail.slice(0, 220);
}

// 从本机 Git 凭据管理器读取已授权的 GitHub token（动态读取，绝不落盘、绝不写入代码库）。
// 匿名 API 每小时仅 60 次，很容易撞 rate limit；带 token 可达 5000 次/小时。
// GIT_TERMINAL_PROMPT=0 保证不会弹交互输入把服务卡住。
let _tokenCache = null;
let _tokenCacheAt = 0;
function githubToken() {
  const now = Date.now();
  if (_tokenCache && now - _tokenCacheAt < 10 * 60 * 1000) return _tokenCache; // 缓存 10 分钟
  try {
    const input = 'protocol=https\nhost=github.com\n\n';
    const out = execFileSync('git', ['credential', 'fill'], {
      input, encoding: 'utf8', timeout: 8000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const m = String(out).match(/^password=(.+)$/m);
    const token = m ? m[1].trim().replace(/\r/g, '') : '';
    if (token) { _tokenCache = token; _tokenCacheAt = now; return token; }
  } catch (e) { /* 取不到就回退匿名 */ }
  return '';
}

function curlOnce(url, proxy, token) {
  const args = [
    '-sSL', '--compressed', '--max-time', String(REQUEST_TIMEOUT_MS / 1000),
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: hq-crm-updater',
  ];
  // 认证头只在拿到 token 时附加，避免把 token 出现在命令行日志里；失败会自动回退匿名。
  if (token) args.push('-H', 'Authorization: Bearer ' + token);
  if (proxy) args.push('--proxy', proxy);
  else args.push('--noproxy', '*'); // 无代理时明确直连，避免继承到异常的环境代理变量
  args.push(url);
  return execFileSync('curl', args, { maxBuffer: 24 * 1024 * 1024, timeout: REQUEST_TIMEOUT_MS + 5000 }).toString('utf8');
}

function api(pathname, { raw = false } = {}) {
  const url = API + pathname;
  const proxy = resolveProxy();
  const token = githubToken();
  // 认证优先；token 不可用时回退匿名。每种凭据都试「代理优先、直连兜底」。
  const creds = token ? [token, ''] : [''];
  const errors = [];
  let text = null;
  let rateLimited = false;
  for (const cred of creds) {
    const routes = proxy ? [proxy, ''] : [''];
    for (const route of routes) {
      for (let attempt = 0; attempt < 2 && text === null; attempt++) {
        try {
          const t = curlOnce(url, route, cred);
          // 识别 API 级 rate limit（返回体是 JSON 但带 documentation_url）
          let parsed = null;
          try { parsed = JSON.parse(t); } catch (e) {}
          if (parsed && parsed.message && /rate limit/i.test(parsed.message) && parsed.documentation_url) {
            rateLimited = true;
            errors.push((cred ? '认证' : '匿名') + '达到速率限制');
            break;
          }
          text = t;
        } catch (e) {
          errors.push((cred ? '认证/' : '匿名/') + (route ? '代理' : '直连') + '：' + shortErr(e));
          if (attempt === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); // 瞬时失败等 400ms 再试
        }
      }
      if (text !== null) break;
    }
    if (text !== null) break;
  }
  if (text === null) {
    const hint = rateLimited ? '（GitHub API 速率限制，稍后再试或检查凭据）' : '（可在「系统设置 → WhatsApp 连接」检查代理是否可用）';
    throw new Error('连接 GitHub 失败：' + errors.join('；') + hint);
  }
  if (raw) return text;
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error('GitHub 返回格式异常：' + text.slice(0, 120)); }
  if (json.message && (text.startsWith('{') && json.documentation_url)) {
    throw new Error('GitHub API 错误：' + json.message);
  }
  return json;
}

// 获取某个文件在指定 commit 的内容（contents API 的 download_url 不走代理，改用 base64 content）
function fetchFile(name, ref) {
  const j = api(`/contents/${encodeURI(name)}?ref=${encodeURIComponent(ref)}`);
  if (!j.content || j.encoding !== 'base64') throw new Error('无法获取文件内容：' + name);
  return Buffer.from(j.content.replace(/\s/g, ''), 'base64');
}

function latestCommit() {
  const c = api(`/commits/${BRANCH}`);
  if (!c.sha) throw new Error('未获取到最新提交');
  return { sha: c.sha, message: String(c.commit && c.commit.message || '').split('\n')[0], date: c.commit && c.commit.committer && c.commit.committer.date || '' };
}

// 对比基准 commit 与最新 commit，得到变更文件清单
function compare(base, head) {
  const c = api(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  const files = (c.files || []).map(f => ({ name: String(f.filename || '').replace(/\\/g, '/'), status: f.status, additions: f.additions, deletions: f.deletions }));
  return { status: c.status, aheadBy: c.ahead_by, files };
}

// 判断本地文件是否被用户改过：用「基线提交里的远端文件内容」和本地文件做哈希比对。
// 不依赖本地 git（本机 git 里往往没有基线提交，旧实现会因此把所有文件都误判成“已修改”）。
function locallyModified(name, baseCommit) {
  if (!baseCommit) return false;
  const rel = String(name).replace(/\\/g, '/');
  const target = path.join(ROOT, rel);
  if (!fs.existsSync(target)) return false; // 本地没有该文件 → 视为新增，可直接写入
  let baseBuf;
  try { baseBuf = fetchFile(rel, baseCommit); }
  catch { return true; } // 拿不到基线内容（如文件过大），保守跳过
  try { return sha256(fs.readFileSync(target)) !== sha256(baseBuf); }
  catch { return true; }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 检查更新：返回版本信息 + 可升级文件清单（不修改任何文件）
function check() {
  const state = readState();
  const latest = latestCommit();
  const base = state.installedCommit || null;
  state.lastCheck = new Date().toISOString();
  writeState(state);

  let changes = { status: base ? 'unknown' : 'no-baseline', aheadBy: 0, files: [] };
  if (base && base !== latest.sha) {
    changes = compare(base, latest.sha);
  } else if (base === latest.sha) {
    changes.status = 'up-to-date';
  }

  const items = changes.files.map(f => {
    const allowed = isAllowedFile(f.name) && safeName(f.name) && (f.status !== 'removed' || ALLOWED_DELETIONS.has(f.name));
    let localModified = false;
    if (allowed && f.status !== 'removed') {
      try { localModified = locallyModified(f.name, base); } catch { localModified = true; }
    }
    return { ...f, allowed, localModified, willUpdate: allowed && !localModified && f.status !== 'removed' };
  });

  return {
    currentVersion: localVersion(),
    latestVersion: localVersion(), // 版本由本地 package.json 决定；远端版本在升级后从新 package.json 生效
    installedCommit: base,
    latestCommit: latest,
    status: changes.status,
    aheadBy: changes.aheadBy,
    items,
    hasUpdate: !!(base && base !== latest.sha && items.some(x => x.willUpdate)),
    needBaseline: !base,
  };
}

// 建立基线：把当前远端 commit 记为已安装（用于首次启用，避免把旧历史全量当更新）
function setBaseline() {
  const latest = latestCommit();
  const state = readState();
  state.installedCommit = latest.sha;
  state.installedAt = new Date().toISOString();
  state.appliedCommits.push({ sha: latest.sha, at: state.installedAt, action: 'baseline', files: [] });
  writeState(state);
  return latest;
}

// 执行升级：逐文件下载 → 备份 → 覆盖；本地改过的文件跳过；全程不碰数据目录
function apply({ force = false } = {}) {
  const state = readState();
  const base = state.installedCommit;
  const latest = latestCommit();
  if (!base) throw new Error('尚未建立升级基线，请先建立基线');
  if (base === latest.sha) return { updated: [], skipped: [], message: '已是最新版本', commit: latest.sha };

  const diff = compare(base, latest.sha);
  const backupDir = path.join(BACKUP_ROOT, timestamp() + '-' + latest.sha.slice(0, 7));
  const updated = [], skipped = [], failed = [];
  let backupCreated = false;
  const ensureBackup = () => {
    if (!backupCreated) { fs.mkdirSync(backupDir, { recursive: true }); backupCreated = true; }
  };

  for (const f of diff.files) {
    const name = f.name;
    if (!isAllowedFile(name) || !safeName(name)) {
      skipped.push({ name, reason: '不在更新白名单（数据/素材/未知文件受保护）' });
      continue;
    }
    if (f.status === 'removed') {
      if (!ALLOWED_DELETIONS.has(name)) { skipped.push({ name, reason: '远端已删除，本地保留（防止误删）' }); continue; }
      const target = path.join(ROOT, name);
      if (fs.existsSync(target)) {
        ensureBackup();
        fs.mkdirSync(path.dirname(path.join(backupDir, name)), { recursive: true });
        fs.copyFileSync(target, path.join(backupDir, name));
        fs.unlinkSync(target);
        updated.push({ name, status: 'deleted' });
      }
      continue;
    }
    let modified = false;
    try { modified = locallyModified(name, base); } catch { modified = true; }
    if (modified && !force) { skipped.push({ name, reason: '本地已修改（已跳过以保护本机定制）' }); continue; }

    let content;
    try { content = fetchFile(name, latest.sha); }
    catch (e) { failed.push({ name, reason: e.message }); continue; }

    const target = path.join(ROOT, name);
    ensureBackup();
    fs.mkdirSync(path.dirname(path.join(backupDir, name)), { recursive: true });
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(backupDir, name));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    updated.push({ name, status: modified ? 'overwritten-force' : 'updated', sha256: sha256(content) });
  }

  if (updated.length) {
    const at = new Date().toISOString();
    state.installedCommit = latest.sha;
    state.installedAt = at;
    state.lastBackupDir = path.relative(ROOT, backupDir).replace(/\\/g, '/');
    state.appliedCommits.push({ sha: latest.sha, at, action: 'apply', files: updated.map(x => x.name) });
    writeState(state);
  }

  return {
    commit: latest.sha,
    message: latest.message,
    updated,
    skipped,
    failed,
    backup: updated.length ? path.relative(ROOT, backupDir).replace(/\\/g, '/') : null,
    message2: `已更新 ${updated.length} 个文件，跳过 ${skipped.length} 个${failed.length ? '，失败 ' + failed.length + ' 个' : ''}`,
  };
}

// 回滚：从最近一次备份恢复文件
function rollback() {
  const state = readState();
  const rel = state.lastBackupDir;
  if (!rel) throw new Error('没有可回滚的备份');
  const backupDir = path.join(ROOT, rel);
  if (!fs.existsSync(backupDir)) throw new Error('备份目录不存在：' + rel);

  const restored = [];
  function walk(dir, prefix = '') {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? prefix + '/' + ent.name : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, relPath);
      else if (safeName(relPath) && isAllowedFile(relPath)) {
        const target = path.join(ROOT, relPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        restored.push(relPath);
      }
    }
  }
  walk(backupDir);

  // 回滚后基准退回上一个已应用 commit
  const applied = state.appliedCommits.filter(x => x.action === 'apply');
  const prev = applied.length >= 2 ? applied[applied.length - 2].sha : null;
  if (prev) state.installedCommit = prev;
  state.lastBackupDir = null;
  state.appliedCommits.push({ sha: prev || '', at: new Date().toISOString(), action: 'rollback', files: restored });
  writeState(state);
  return { restored, fallbackCommit: prev };
}

function status() {
  const state = readState();
  return {
    currentVersion: localVersion(),
    installedCommit: state.installedCommit,
    installedAt: state.installedAt,
    lastCheck: state.lastCheck,
    lastBackupDir: state.lastBackupDir,
    appliedCount: (state.appliedCommits || []).filter(x => x.action === 'apply').length,
    repo: `${OWNER}/${REPO}@${BRANCH}`,
  };
}

module.exports = { check, setBaseline, apply, rollback, status, localVersion, ALLOWED_FILES: [...ALLOWED_FILES] };
