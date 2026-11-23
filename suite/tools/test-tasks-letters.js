'use strict';
/**
 * 任务流 + 开发信自测（mock global.fetch，不联网；只用 /tmp 临时库）
 *
 * 用法：SUITE_DB 会由本文件自己设为 /tmp 下的临时库（不碰 suite/data/ 与
 * lead-gen/data/ 下的任何文件）。直接跑：
 *   node suite/tools/test-tasks-letters.js
 *
 * 注意：suite/src/db.js 在 require 时打开库（并在目标库不存在时尝试从旧库
 * 迁移），所以必须先设 process.env.SUITE_DB 再 require；同时把
 * SUITE_LEGACY_DB 指到一个不存在的路径，跳过旧库迁移，避免把真实旧库
 * 复制进临时库。
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmp = path.join(os.tmpdir(), `suite-tasks-letters-${process.pid}.db`);
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.SUITE_DB = tmp;
process.env.SUITE_LEGACY_DB = path.join(os.tmpdir(), `suite-tasks-letters-${process.pid}-no-legacy.db`);

const { run, get, all, setSetting, now } = require('../src/db');
const tasks = require('../src/tasks');
const letters = require('../src/letters');
const places = require('../src/places');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}
async function throwsAsync(fn, match, name) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(err && (!match || match.test(String(err.message || ''))), name + (err ? '' : '（未抛错）'));
}
function throwsSync(fn, match, name) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(err && (!match || match.test(String(err.message || ''))), name + (err ? '' : '（未抛错）'));
}

/* ---------- mock global.fetch：按场景返回 Google 各端点 ---------- */
let scenario = 'success'; // success | no-types-furniture | fail-search

function jsonRes(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function searchPlace(id, name, address) {
  return { id: 'places/' + id, displayName: { text: name }, formattedAddress: address, location: { latitude: 6.45, longitude: 3.39 } };
}
function searchPlaces() {
  if (scenario === 'no-types-furniture') {
    return [searchPlace('ChIJFUR004', 'Kano Furniture Hub', '10 Furniture Ave, Kano')];
  }
  return [
    searchPlace('ChIJDUP001', 'Lagos Lock & Key Ltd', '1 Marina Rd, Lagos'),
    searchPlace('ChIJNEW002', 'Abuja Hardware Store', '5 Market St, Abuja'),
    searchPlace('ChIJNEW003', 'Ikeja Home Goods', '9 Allen Ave, Ikeja'),
  ];
}
function detailsFor(placeId) {
  const base = {
    ChIJDUP001: {
      displayName: { text: 'Lagos Lock & Key Ltd' }, formattedAddress: '1 Marina Rd, Lagos',
      internationalPhoneNumber: '+234 800 111 001', websiteUri: 'https://lagos-lock.example.com',
      rating: 4.6, userRatingCount: 23, businessStatus: 'OPERATIONAL', types: ['locksmith'],
    },
    ChIJNEW002: {
      displayName: { text: 'Abuja Hardware Store' }, formattedAddress: '5 Market St, Abuja',
      internationalPhoneNumber: '+234 800 222 002', websiteUri: 'https://abuja-hardware.example.com',
      rating: 4.2, userRatingCount: 8, businessStatus: 'OPERATIONAL', types: ['hardware_store'],
    },
    ChIJNEW003: {
      displayName: { text: 'Ikeja Home Goods' }, formattedAddress: '9 Allen Ave, Ikeja',
      internationalPhoneNumber: '', websiteUri: '',
      rating: null, userRatingCount: null, businessStatus: 'OPERATIONAL', types: ['home_goods_store'],
    },
    ChIJFUR004: {
      displayName: { text: 'Kano Furniture Hub' }, formattedAddress: '10 Furniture Ave, Kano',
      internationalPhoneNumber: '+234 800 444 004', websiteUri: 'https://kano-furniture.example.com',
      rating: 4.0, userRatingCount: 5, businessStatus: 'OPERATIONAL',
      // 注意：no-types-furniture 场景故意不带 types，测 keyword 回退映射
    },
  };
  const d = base[placeId] || {};
  return { id: 'places/' + placeId, ...d };
}
global.fetch = async (url) => {
  const u = String(url);
  if (scenario === 'fail-search' && u.includes(':searchText')) throw new Error('boom-network');
  if (u.includes('maps.googleapis.com/maps/api/geocode')) {
    return jsonRes(200, { status: 'OK', results: [{ geometry: { location: { lat: 6.45, lng: 3.39 } } }] });
  }
  if (u.includes(':searchText')) return jsonRes(200, { places: searchPlaces() });
  if (u.includes('/v1/places/')) {
    const pid = decodeURIComponent(u.split('/v1/places/')[1]);
    return jsonRes(200, detailsFor(pid));
  }
  throw new Error('unexpected url ' + u);
};

function leadByName(name) {
  return get('SELECT * FROM leads WHERE company_name=?', name);
}
function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('等待超时'));
      setTimeout(check, 100);
    })();
  });
}

(async () => {
  setSetting('google_places_key', 'FAKE-KEY-FOR-TEST');
  setSetting('request_delay_ms', '0');
  setSetting('request_timeout_ms', '5000');

  console.log('\n[1] createTask 校验与基本读写');
  throwsSync(() => tasks.createTask({ keyword: '  ' }), /关键词/, '空关键词抛中文错');
  throwsSync(() => tasks.createTask({ keyword: 'locksmith', radiusKm: 99 }), /半径/, '半径超 50 抛中文错');
  const t1 = tasks.createTask({ keyword: 'locksmith', location: 'Lagos, Nigeria', radiusKm: 10, maxResults: 20 });
  ok(t1 && t1.status === 'queued' && t1.total === 0 && t1.done === 0, '新建任务为 queued，total/done 为 0');
  ok(t1.radius_km === 10 && t1.max_results === 20, '半径与条数按原值存');
  const tDefault = tasks.createTask({ keyword: 'hardware' });
  ok(tDefault.max_results === 20 && tDefault.radius_km == null && tDefault.location === '', '缺省 maxResults=20、radius/location 为空');
  ok(tasks.getTask(t1.id).keyword === 'locksmith', 'getTask 按 id 取行');
  ok(tasks.getTask(999999) === null, 'getTask 不存在返回 null');
  ok(tasks.listTasks(10).some(t => t.id === t1.id), 'listTasks 含新建任务');

  console.log('\n[2] runTask 全流程：3 家，1 家重复去重');
  const t = now();
  run("INSERT INTO leads(company_name,website,domain,country,dedup_key,notes,status,created_at,updated_at) VALUES('Lagos Lock & Key Ltd','https://lagos-lock.example.com','lagos-lock.example.com','Lagos, Nigeria','d:lagos-lock.example.com','已有线索','new',?,?)", t, t);
  const dupLeadId = leadByName('Lagos Lock & Key Ltd').id;
  scenario = 'success';
  const done1 = await tasks.runTask(t1.id);
  ok(done1.status === 'done' && done1.total === 3 && done1.done === 3, '状态 done，total=3，done=3（重复的也整理计数）');
  ok(!!done1.batch_id && !!done1.started_at && !!done1.finished_at, 'batch_id/started_at/finished_at 已写');
  ok(get('SELECT COUNT(*) c FROM leads').c === 3, '线索共 3 条：预置 1 条 + 新增 2 条，重复未重复入库');
  ok(get('SELECT source FROM batches WHERE id=?', done1.batch_id).source === 'google_places', '批次来源为 google_places');
  const lagos = leadByName('Lagos Lock & Key Ltd');
  ok(lagos.id === dupLeadId && lagos.industry_hint === '门窗与安防五金', '重复线索被整理：行业 locksmith→门窗与安防五金');
  ok(lagos.notes.includes('已有线索') && lagos.notes.includes('Lagos Lock & Key Ltd · 门窗与安防五金 · Lagos, Nigeria · 评分 4.6（23 条评价）· 电话 +234 800 111 001'),
    '重复线索画像追加不覆盖：保留已有 notes + 一句话画像');
  const abuja = leadByName('Abuja Hardware Store');
  // collectLeads 的 results 带 types：按每家店的真实类型映射行业
  // （locksmith→门窗与安防五金、hardware_store→五金零售、home_goods_store→家居五金）。
  ok(abuja && abuja.industry_hint === '五金零售', '新增线索行业：按 types 映射 hardware_store→五金零售');
  ok(abuja.notes.includes('Google Places: places/ChIJNEW002')
    && abuja.notes.includes('Abuja Hardware Store · 五金零售 · Lagos, Nigeria · 评分 4.2（8 条评价）· 电话 +234 800 222 002'),
    '新增线索画像追加在导入备注之后，格式正确');
  const ikeja = leadByName('Ikeja Home Goods');
  ok(ikeja && ikeja.industry_hint === '家居五金', '新增线索行业：按 types 映射 home_goods_store→家居五金');
  ok(ikeja.notes.includes('Ikeja Home Goods · 家居五金 · Lagos, Nigeria · 评分 未公开 · 电话 未公开'),
    '无评分无电话时画像写“评分 未公开 / 电话 未公开”');
  const stored = JSON.parse(tasks.getTask(t1.id).results_json || '[]');
  ok(stored.length === 3 && stored[0].types[0] === 'locksmith' && stored[0].lat === 6.45 && stored[0].lng === 3.39
    && stored[1].types[0] === 'hardware_store' && stored[2].types[0] === 'home_goods_store',
    '任务存了 results_json：含 types 与坐标，供地图打点');
  ok(get("SELECT COUNT(*) c FROM evidence WHERE lead_id=? AND field='website'", abuja.id).c >= 1, '新增线索写了 website 证据');
  ok(get("SELECT COUNT(*) c FROM evidence WHERE lead_id=? AND field='phone'", abuja.id).c >= 1, '新增线索写了 phone 证据');
  await throwsAsync(() => tasks.runTask(t1.id), /只有排队中/, '已完成任务再次 runTask 抛错（非幂等，需走重试）');

  console.log('\n[3] 整理映射：types 映射 + 无 types 时 keyword 回退');
  ok(tasks.mapIndustry(['hardware_store'], 'locksmith') === '五金零售', 'types 优先于 keyword');
  ok(tasks.mapIndustry(['locksmith'], 'hardware') === '门窗与安防五金', 'locksmith→门窗与安防五金');
  ok(tasks.mapIndustry(['store', 'point_of_interest'], 'locksmith') === '门窗与安防五金', '通用类型跳过后用 keyword 回退');
  ok(tasks.mapIndustry([], 'hardware') === '五金零售', '无 types 时 keyword 回退：hardware→五金零售');
  ok(tasks.mapIndustry([], 'qqq-no-match') === '综合五金', '映射不到写“综合五金”');
  ok(tasks.mapIndustry(['home_goods_store'], '') === '家居五金', 'home_goods_store→家居五金');
  ok(tasks.buildProfile({ name: 'A', industry: '五金零售', country: 'NG', rating: 4.5, userRatingCount: 10, phone: '+1' })
    === 'A · 五金零售 · NG · 评分 4.5（10 条评价）· 电话 +1', 'buildProfile 格式');
  scenario = 'no-types-furniture';
  const t2 = tasks.createTask({ keyword: 'furniture', location: 'Kano, Nigeria' });
  const done2 = await tasks.runTask(t2.id);
  const kano = leadByName('Kano Furniture Hub');
  ok(done2.status === 'done' && kano && kano.industry_hint === '家具五金',
    '端到端：详情无 types 时按 keyword 回退 furniture→家具五金');
  scenario = 'success';

  console.log('\n[4] 失败重试：mock fetch 抛错 → failed → retryTask → queued');
  scenario = 'fail-search';
  const t3 = tasks.createTask({ keyword: 'locksmith', location: 'Lagos, Nigeria' });
  let runErr = null;
  try { await tasks.runTask(t3.id); } catch (e) { runErr = e; }
  const failed = tasks.getTask(t3.id);
  ok(!!runErr && failed.status === 'failed', '采集失败后 runTask 抛错且任务为 failed');
  ok(failed.error && /连接 Google 失败/.test(failed.error), 'error 为中文友好信息');
  ok(failed.error && !failed.error.includes('FAKE-KEY-FOR-TEST'), 'error 里不含 Key');
  ok(!!failed.finished_at, '失败也记 finished_at');
  const retried = tasks.retryTask(t3.id);
  ok(retried.status === 'queued' && retried.done === 0 && retried.total === 0 && retried.error == null && retried.batch_id == null,
    'retryTask：failed→queued，done/total/error/batch_id 清空');
  throwsSync(() => tasks.retryTask(t3.id), /只有失败/, '非 failed 任务重试抛错');
  scenario = 'success';

  console.log('\n[5] startRunner：500ms 轮询，串行跑完排队任务');
  const t4 = tasks.createTask({ keyword: 'locksmith', location: 'Lagos, Nigeria', radiusKm: 10 });
  const t5 = tasks.createTask({ keyword: 'hardware', location: 'Abuja, Nigeria' });
  const stop1 = tasks.startRunner();
  const stop2 = tasks.startRunner();
  ok(stop1 === stop2, '重复调用 startRunner 不起第二个定时器');
  await waitFor(() => {
    const s = [t3.id, t4.id, t5.id].map(id => tasks.getTask(id).status);
    return s.every(x => x === 'done') || null;
  });
  ok([t3.id, t4.id, t5.id].every(id => tasks.getTask(id).status === 'done'), '排队中的 3 个任务被 runner 串行跑完');
  ok(tasks.getTask(t4.id).done === 3 && tasks.getTask(t5.id).done === 3, 'runner 跑出的任务 done 计数正确');
  tasks.stopRunner();
  ok(tasks.listTasks(100).every(x => x.status !== 'queued' && x.status !== 'running'), '无遗留排队/进行中任务');

  console.log('\n[6] estimateCalls 直接 re-export places.js');
  ok(tasks.estimateCalls === places.estimateCalls, 'tasks.estimateCalls 就是 places.estimateCalls（同一函数）');
  const est = tasks.estimateCalls({ maxResults: 20, radiusKm: 10, location: 'Lagos' });
  ok(est.geocode === 1 && est.search === 1 && est.details === 20 && est.total === 22, '预估：定位 1 + 搜索 1 + 详情 20 = 22');
  const est2 = tasks.estimateCalls({ maxResults: 20 });
  ok(est2.geocode === 0 && est2.total === 21, '无半径/城市时不计定位');

  console.log('\n[7] 开发信：模板增删改查');
  const defaults = letters.ensureDefaults();
  ok(defaults.length === 2, 'ensureDefaults 写入 2 条默认模板');
  const enTpl = defaults.find(x => x.lang === 'en');
  const frTpl = defaults.find(x => x.lang === 'fr');
  ok(enTpl && enTpl.subject === 'Door Hardware Supply from China — {{公司名}}', '英文默认模板主题正确');
  ok(frTpl && frTpl.subject === 'Quincaillerie de porte depuis la Chine — {{公司名}}', '法文默认模板主题正确');
  ok(letters.ensureDefaults().length === 2, 'ensureDefaults 第二次调用不重复写入');
  const custom = letters.saveTemplate({ name: '测试模板', lang: 'de', subject: 'Hi {{公司名}}', body: 'Body {{国家}} {{产品}}' });
  ok(custom.lang === 'en', '非法 lang 按 en 存');
  ok(letters.getTemplate(custom.id).name === '测试模板', 'getTemplate 取到新建模板');
  const updated = letters.saveTemplate({ id: custom.id, name: '测试模板', lang: 'fr', subject: 'Salut {{公司名}}', body: 'Body {{国家}}' });
  ok(updated.subject === 'Salut {{公司名}}' && updated.lang === 'fr', 'saveTemplate 更新主题与语言');
  throwsSync(() => letters.saveTemplate({ name: '', lang: 'en', subject: 'x', body: 'y' }), /模板名称/, '空 name 抛中文错');
  throwsSync(() => letters.saveTemplate({ name: 'x', lang: 'en', subject: ' ', body: 'y' }), /邮件主题/, '空 subject 抛中文错');
  throwsSync(() => letters.saveTemplate({ name: 'x', lang: 'en', subject: 's', body: '' }), /邮件正文/, '空 body 抛中文错');
  throwsSync(() => letters.saveTemplate({ id: 999999, name: 'x', lang: 'en', subject: 's', body: 'b' }), /模板不存在/, '更新不存在的模板抛错');

  console.log('\n[8] 开发信：占位符渲染');
  const rEn = letters.renderTemplate(enTpl, { company_name: 'Test Co Ltd', country: 'Nigeria' });
  ok(rEn.subject === 'Door Hardware Supply from China — Test Co Ltd', '英文主题 {{公司名}} 替换正确');
  ok(rEn.body.includes('door locks and hardware') && !rEn.body.includes('{{'), '英文默认模板正文直接写产品范围，无残留占位符');
  const rFr = letters.renderTemplate(frTpl, { company_name: 'Test Co Ltd', country: 'Nigeria' });
  ok(rFr.body.includes('quincaillerie de porte') && !rFr.body.includes('{{'), '法文默认模板正文直接写法文产品范围，无残留占位符');
  const rProd = letters.renderTemplate(enTpl, { company_name: 'X', country: 'France', product: 'mortise locks' });
  ok(rProd.body.includes('mortise locks'), 'lead 自带 product 时优先用它');
  const allPh = letters.saveTemplate({
    name: '全占位符', lang: 'en', subject: '{{公司名}}|{{国家}}|{{产品}}|{{联系人}}|{{电话}}|{{网址}}',
    body: '{{公司名}}|{{国家}}|{{产品}}|{{联系人}}|{{电话}}|{{网址}}',
  });
  const rAll = letters.renderTemplate(allPh, {
    company_name: 'Acme', country: 'Kenya', product: 'handles',
    contact_name: 'Ann', phone: '+254 1', website: 'https://acme.example.com',
  });
  ok(rAll.body === 'Acme|Kenya|handles|Ann|+254 1|https://acme.example.com', '6 个占位符全部替换');
  const rMissing = letters.renderTemplate(allPh, { company_name: 'Acme' });
  ok(rMissing.body === 'Acme|||Acme||', 'lead 里没有的字段取 \'\'（{{产品}} 不再取默认值；{{联系人}} 没有时用公司名）');
  const rContact = letters.renderTemplate(allPh, { company_name: 'Acme', contact_name: 'Ann' });
  ok(rContact.body.split('|')[3] === 'Ann', '有联系人时 {{联系人}} 用联系人');
  const rFrMissing = letters.renderTemplate(frTpl, {});
  ok(!rFrMissing.body.includes('{{'), '法文模板无线索时也无残留占位符（{{联系人}} 没有时用法文 Bonjour 兜底）');

  console.log('\n[9] 开发信：联系方式与发送记录');
  run("INSERT INTO evidence(lead_id,source,field,raw_value,value,url,snippet,confidence,captured_at) VALUES(?,?,?,?,?,?,?,?,?)",
    abuja.id, 'manual', 'email', 'sales@abuja-hardware.example.com', 'sales@abuja-hardware.example.com', '', '', 0.9, now());
  const contact = letters.getLeadContact(abuja.id);
  ok(contact.email === 'sales@abuja-hardware.example.com', 'getLeadContact 读到 email 证据');
  ok(contact.phone === '+234 800 222 002', 'getLeadContact 读到 phone 证据');
  ok(contact.website === 'https://abuja-hardware.example.com', 'getLeadContact 读到 website 证据');
  const noContact = letters.getLeadContact(999999);
  ok(noContact.phone === '' && noContact.website === '' && noContact.email === '', '无证据时联系方式全为空串');
  const rec = letters.recordSend({ leadId: abuja.id, templateId: enTpl.id, channel: 'email', subject: rEn.subject, body: rEn.body });
  ok(rec.status === 'sent' && rec.lead_id === abuja.id && rec.channel === 'email', 'recordSend 默认 status=sent');
  const recWa = letters.recordSend({ leadId: abuja.id, templateId: enTpl.id, channel: 'whatsapp', subject: 's', body: 'b' });
  ok(recWa.channel === 'whatsapp', 'recordSend 支持 whatsapp 渠道');
  throwsSync(() => letters.recordSend({ leadId: abuja.id, templateId: enTpl.id, channel: 'email', subject: rEn.subject, body: rEn.body }), /无需重复标记/, 'M1：5 分钟内重复标记同一内容抛错');
  const recDiff = letters.recordSend({ leadId: abuja.id, templateId: enTpl.id, channel: 'email', subject: '另一主题', body: 'b' });
  ok(!!recDiff && recDiff.subject === '另一主题', 'M1：不同主题的标记不受去重影响');
  const recs = letters.listSendRecords(abuja.id);
  ok(recs.length === 3 && recs[0].id === recDiff.id, 'listSendRecords 按 id 倒序返回');
  throwsSync(() => letters.recordSend({ leadId: abuja.id, templateId: enTpl.id, channel: 'sms', subject: 's', body: 'b' }), /email.*whatsapp|whatsapp/, '非法 channel 抛中文错');
  throwsSync(() => letters.recordSend({ leadId: 999999, templateId: enTpl.id, channel: 'email', subject: 's', body: 'b' }), /线索不存在/, '不存在的线索记发送抛错');

  console.log('\n[10] 开发信：删除模板');
  ok(letters.deleteTemplate(allPh.id) === true, 'deleteTemplate 删掉返回 true');
  ok(letters.getTemplate(allPh.id) === null, '删除后查不到');
  ok(letters.deleteTemplate(allPh.id) === false, '重复删除返回 false');
  ok(letters.listTemplates().length === 3, '删后剩余 3 条模板（2 默认 + 1 测试）');

  console.log('\n[11] L1 崩溃认领 + L3 任务中心坐标');
  const t6 = tasks.createTask({ keyword: 'locksmith', location: 'Lagos, Nigeria', radiusKm: 10 });
  run("UPDATE tasks SET status='running', started_at=? WHERE id=?", now(), t6.id);
  ok(tasks.reclaimStaleTasks() === 1, 'L1：认领把 1 个卡在 running 的任务放回 queued');
  ok(tasks.getTask(t6.id).status === 'queued' && tasks.getTask(t6.id).started_at == null, 'L1：认领后状态为 queued，started_at 清空');
  ok(tasks.reclaimStaleTasks() === 0, 'L1：没有 running 任务时认领返回 0');
  // L3：runTask 带半径时把服务端定位的中心坐标存进任务行（mock geocode 返回 6.45/3.39）。
  scenario = 'success';
  const done6 = await tasks.runTask(t6.id);
  ok(done6.status === 'done', 'L3：认领回来的任务能正常跑完');
  ok(tasks.getTask(t6.id).center_lat === 6.45 && tasks.getTask(t6.id).center_lng === 3.39, 'L3：任务存了服务端定位的中心坐标（供地图页直接用）');

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('\n自测异常退出：', e && e.stack ? e.stack : e);
  try { tasks.stopRunner(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exitCode = 1;
});
