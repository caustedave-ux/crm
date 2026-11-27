'use strict';
// ============ 路由冒烟测试 ============
// 用法：node tools/check-routes.js
//
// 做四件事：
//   1. 复制一份数据库到临时文件（绝不碰 data/crm.db）
//   2. 用这份库起一个临时服务（默认 5099），造一个测试会话
//   3. 把 src/routes.js 里所有 router.get(...) 挨个请求一遍
//   4. 报告：200 正常 / 302 需要看跳去哪 / 404 挂了（比如路由被注释掉）
//
// 退出码：0 全过，1 有失败。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.CHECK_PORT || '5099', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'smoke-' + Date.now().toString(36);
const SRC_DB = path.join(ROOT, 'data', 'crm.db');
const TMP_DB = path.join(os.tmpdir(), 'crm-smoke-' + Date.now() + '.db');

if (!fs.existsSync(SRC_DB)) {
  console.error('找不到 data/crm.db，无法做冒烟测试');
  process.exit(1);
}
fs.copyFileSync(SRC_DB, TMP_DB);

process.env.CRM_DB = TMP_DB;
const { get, all, run } = require(path.join(ROOT, 'src', 'db'));

// 测试用账号：优先管理员
const user = get("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1") || get('SELECT * FROM users ORDER BY id LIMIT 1');
if (!user) { console.error('库里没有用户'); process.exit(1); }
run('DELETE FROM sessions WHERE token=?', TOKEN);
run('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)', TOKEN, user.id, '2099-01-01 00:00:00', '2000-01-01 00:00:00');

// 造一份临时简报，确保 /briefings/:id 详情页也进入冒烟测试。
const smokeCustomer = get('SELECT id FROM customers WHERE user_id=? ORDER BY id LIMIT 1', user.id);
if (smokeCustomer) {
  const period = 'month:' + new Date().toISOString().slice(0, 7);
  run('DELETE FROM briefings WHERE user_id=? AND customer_id=? AND period_key=?', user.id, smokeCustomer.id, period);
  run('INSERT INTO briefings(user_id,customer_id,period_key,title,subject,language,status,content,content_zh,sources,article_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', user.id, smokeCustomer.id, period, 'Smoke Briefing', 'Smoke Subject', 'en', 'draft', 'Smoke customer content [1].', '冒烟测试', '[]', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00');
}
run('INSERT INTO knowledge_articles(title,category,tags,content,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  'Smoke Knowledge ' + Date.now(), '产品资料', 'smoke', 'Route smoke article.', user.id, '2026-01-01 00:00:00', '2026-01-01 00:00:00');

// 参数取值表：:id 之类按路径段猜表
const ID_SOURCES = {
  customers: ['customers', 'id', 'user_id'],
  inquiries: ['website_inquiries', 'id', null],
  contacts: ['contacts', 'id', null],
  documents: ['documents', 'id', 'user_id'],
  suppliers: ['suppliers', 'id', null],
  products: ['products', 'id', null],
  logistics: ['logistics_shipments', 'id', 'user_id'],
  activities: ['activities', 'id', 'user_id'],
  templates: ['doc_templates', 'id', null],
  users: ['users', 'id', null],
  quotes: ['quote_history', 'id', 'user_id'],
  briefings: ['briefings', 'id', 'user_id'],
  knowledge: ['knowledge_articles', 'id', null],
};

function pickId(segment) {
  const cfg = ID_SOURCES[segment];
  if (!cfg) return '';
  const [table, col, ownerCol] = cfg;
  try {
    const row = ownerCol
      ? get(`SELECT ${col} FROM ${table} WHERE ${ownerCol}=? ORDER BY ${col} DESC LIMIT 1`, user.id)
      : get(`SELECT ${col} FROM ${table} ORDER BY ${col} DESC LIMIT 1`);
    return row ? String(row[col]) : '';
  } catch (e) { return ''; }
}

/** 从 routes.js 里抠出所有 GET 路径（连被注释掉的也抠——它们正好该测出来） */
function collectRoutes() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
  const out = new Set();
  const re = /router\.get\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out].sort();
}

function concretize(route) {
  const parts = route.split('/').filter(Boolean);
  let skipped = '';
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith(':')) continue;
    const owner = parts[i - 1] || '';
    const id = pickId(owner);
    if (!id) { skipped = '库里没有 ' + owner + ' 数据'; break; }
    parts[i] = id;
  }
  return { path: '/' + parts.join('/'), skipped };
}

async function waitReady(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(BASE + '/login');
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), CRM_DB: TMP_DB }),
    stdio: 'ignore',
  });

  const cleanup = () => {
    try { child.kill(); } catch (e) {}
    try { fs.unlinkSync(TMP_DB); } catch (e) {}
    try { fs.unlinkSync(TMP_DB + '-wal'); } catch (e) {}
    try { fs.unlinkSync(TMP_DB + '-shm'); } catch (e) {}
  };

  try {
    if (!(await waitReady(25000))) {
      console.error('服务没能在 25 秒内起来（端口 ' + PORT + ' 可能被占用）');
      cleanup();
      process.exit(1);
    }

    const routes = collectRoutes();
    const rows = [];
    for (const route of routes) {
      const { path: url, skipped } = concretize(route);
      if (skipped) { rows.push({ route, status: 'SKIP', note: skipped }); continue; }
      let status = 0, loc = '', note = '';
      try {
        const res = await fetch(BASE + url, { headers: { Cookie: 'crm_sid=' + TOKEN }, redirect: 'manual' });
        status = res.status;
        loc = res.headers.get('location') || '';
        if (status === 302 && /\/login/.test(loc)) { status = 'AUTH'; note = '被踢回登录'; }
        else if (status === 404) note = '页面不存在';
        else if (status >= 500) note = '服务端报错';
        else if (status === 302) note = '→ ' + loc;
      } catch (e) {
        status = 'ERR'; note = e.message;
      }
      rows.push({ route, status, note });
    }

    const kbTitle = 'Knowledge CRUD Smoke ' + Date.now();
    // “产品资料”类文章必须关联产品：取库里第一个产品，空库时造一个冒烟产品
    let kbProduct = get('SELECT id FROM products ORDER BY id LIMIT 1');
    if (!kbProduct) {
      run('INSERT INTO products(name,model,status,created_at,updated_at) VALUES(?,?,?,?,?)', 'Smoke Product', 'SMOKE-1', '在售', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
      kbProduct = get('SELECT id FROM products WHERE model=?', 'SMOKE-1');
    }
    const kbCreate = await fetch(BASE + '/knowledge', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: 'crm_sid=' + TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: kbTitle, category: '产品资料', tags: 'smoke', content: '# Internal test article', product_id: String(kbProduct.id) }),
    });
    const kbCreateLocation = kbCreate.headers.get('location') || '';
    const kbArticle = get('SELECT * FROM knowledge_articles WHERE title=?', kbTitle);
    rows.push({ route: 'POST /knowledge', status: kbCreate.status === 302 && kbArticle ? 200 : 'ERR', note: kbCreateLocation || '知识条目未创建' });
    if (kbArticle) {
      const kbUpdate = await fetch(BASE + '/knowledge/' + kbArticle.id, {
        method: 'POST', redirect: 'manual',
        headers: { Cookie: 'crm_sid=' + TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: kbTitle + ' Updated', category: '报价政策', tags: 'updated', content: 'Updated test content' }),
      });
      const savedArticle = get('SELECT * FROM knowledge_articles WHERE id=?', kbArticle.id);
      rows.push({ route: 'POST /knowledge/:id', status: kbUpdate.status === 302 && savedArticle && savedArticle.title === kbTitle + ' Updated' ? 200 : 'ERR', note: kbUpdate.headers.get('location') || '知识条目未更新' });

      let otherUser = get("SELECT * FROM users WHERE role='staff' AND id<>? ORDER BY id LIMIT 1", user.id);
      if (!otherUser) {
        run("INSERT INTO users(username,password_hash,display_name,role,active,created_at) VALUES(?,?,?,?,1,?)", 'knowledge-smoke-' + Date.now(), 'x', 'KB Smoke Staff', 'staff', '2000-01-01 00:00:00');
        otherUser = get("SELECT * FROM users WHERE role='staff' AND display_name='KB Smoke Staff' ORDER BY id DESC LIMIT 1");
      }
      if (otherUser) {
        const otherToken = TOKEN + '-kb-other';
        run('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)', otherToken, otherUser.id, '2099-01-01 00:00:00', '2000-01-01 00:00:00');
        const forbiddenEdit = await fetch(BASE + '/knowledge/' + kbArticle.id, {
          method: 'POST', redirect: 'manual',
          headers: { Cookie: 'crm_sid=' + otherToken, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ title: 'Unauthorized edit', category: '产品资料', tags: '', content: 'Should not be saved' }),
        });
        const unchanged = get('SELECT title FROM knowledge_articles WHERE id=?', kbArticle.id);
        rows.push({ route: 'POST /knowledge/:id ownership', status: forbiddenEdit.status === 302 && unchanged.title === kbTitle + ' Updated' ? 200 : 'ERR', note: '他人文章拒绝编辑' });
      }
    }
    for (const p of ['/', '/customers', '/settings']) { try { const res = await fetch(BASE + p, { redirect: 'manual' }); const loc = res.headers.get('location') || ''; const ok = (res.status === 302 && /\/login(\?|$)/.test(loc)) || res.status === 401 || res.status === 403; rows.push({ route: 'UNAUTH ' + p, status: ok ? res.status : 'ERR', note: ok ? (res.status === 302 ? '→ ' + loc : '已拦截') : ('未拦截未登录访问: ' + res.status + (loc ? ' → ' + loc : '')) }); } catch (e) { rows.push({ route: 'UNAUTH ' + p, status: 'ERR', note: e.message }); } }
    try { const res = await fetch(BASE + '/login', { redirect: 'manual' }); rows.push({ route: 'UNAUTH /login', status: res.status === 200 ? 200 : 'ERR', note: res.status === 200 ? '' : ('预期 200，实际 ' + res.status) }); } catch (e) { rows.push({ route: 'UNAUTH /login', status: 'ERR', note: e.message }); }
    const bad = rows.filter(r => r.status === 404 || r.status === 'ERR' || r.status === 'AUTH' || (typeof r.status === 'number' && r.status >= 500));
    const width = Math.max(...rows.map(r => r.route.length)) + 2;
    console.log('');
    console.log('路由冒烟测试（' + rows.length + ' 条）');
    console.log('='.repeat(60));
    for (const r of rows) {
      const mark = bad.includes(r) ? '✗' : (r.status === 'SKIP' ? '·' : '✓');
      console.log(mark + ' ' + r.route.padEnd(width) + String(r.status).padEnd(6) + (r.note || ''));
    }
    console.log('='.repeat(60));
    console.log(bad.length ? ('失败 ' + bad.length + ' 条：' + bad.map(b => b.route).join(', ')) : '全部通过 ✅');
    cleanup();
    process.exit(bad.length ? 1 : 0);
  } catch (e) {
    console.error('测试异常：', e.message);
    cleanup();
    process.exit(1);
  }
})();


