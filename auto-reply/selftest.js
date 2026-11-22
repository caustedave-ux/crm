'use strict';
// ============ 纯逻辑自测：不连数据库、不发消息、不调 AI ============
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('./logic');

let pass = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' → ' + e.message); process.exitCode = 1; }
}

console.log('== 置顶判断 ==');
t('pinned_at 非空 → 置顶', () => assert.strictEqual(L.isPinned({ pinned_at: '2026-11-16 10:00:00' }), true));
t('pinned_at 为空 → 未置顶', () => assert.strictEqual(L.isPinned({ pinned_at: '' }), false));
t('pinned_at 缺失 → 未置顶', () => assert.strictEqual(L.isPinned({}), false));
t('pinned_at 只有空格 → 未置顶', () => assert.strictEqual(L.isPinned({ pinned_at: '   ' }), false));

console.log('== 人工已回复判断 ==');
t('from_me=1 → 人工已回', () => assert.strictEqual(L.humanReplied({ from_me: 1 }), true));
t('from_me=0 → 客户发的', () => assert.strictEqual(L.humanReplied({ from_me: 0 }), false));
t('无消息 → 未回', () => assert.strictEqual(L.humanReplied(null), false));

console.log('== 敏感词 ==');
t('英文敏感词命中', () => assert.deepStrictEqual(L.isSensitive('what is your best price?', ['price', '合同']), ['price']));
t('中文敏感词命中', () => assert.deepStrictEqual(L.isSensitive('请问报价多少', ['报价', '价格']), ['报价']));
t('无命中返回空数组', () => assert.deepStrictEqual(L.isSensitive('do you have this in stock', ['price']), []));
t('空词表不误伤', () => assert.deepStrictEqual(L.isSensitive('price', []), []));

console.log('== 冷却窗口 ==');
const now = Date.parse('2026-11-16T20:00:00');
t('5分钟前回复 + 冷却10分钟 → 冷却中', () => assert.strictEqual(L.isCoolingDown('2026-11-16 19:55:00', now, 10), true));
t('15分钟前回复 + 冷却10分钟 → 已过冷却', () => assert.strictEqual(L.isCoolingDown('2026-11-16 19:45:00', now, 10), false));
t('从未回复 → 不在冷却', () => assert.strictEqual(L.isCoolingDown('', now, 10), false));

console.log('== 每日额度 ==');
t('已发40 + 上限40 → 超限', () => assert.strictEqual(L.quotaExceeded(40, 40), true));
t('已发39 + 上限40 → 未超', () => assert.strictEqual(L.quotaExceeded(39, 40), false));
t('上限0 → 不限制', () => assert.strictEqual(L.quotaExceeded(999, 0), false));

console.log('== 综合决策（优先级）==');
t('置顶优先于一切 → skip', () => {
  const d = L.chooseDecision({ pinned: true, human: true, cooling: true, quota: true, sensitive: ['price'] });
  assert.strictEqual(d.action, 'skip');
});
t('人工已回 → skip', () => {
  const d = L.chooseDecision({ pinned: false, human: true, cooling: false, quota: false, sensitive: [] });
  assert.strictEqual(d.action, 'skip');
});
t('敏感词 → hold 待人工', () => {
  const d = L.chooseDecision({ pinned: false, human: false, cooling: false, quota: false, sensitive: ['价格'] });
  assert.strictEqual(d.action, 'hold');
  assert.ok(d.reason.includes('价格'));
});
t('全部放行 → send', () => {
  const d = L.chooseDecision({ pinned: false, human: false, cooling: false, quota: false, sensitive: [] });
  assert.strictEqual(d.action, 'send');
});
t('额度超限 + 敏感词 → skip 优先于 hold', () => {
  const d = L.chooseDecision({ pinned: false, human: false, cooling: false, quota: true, sensitive: ['price'] });
  assert.strictEqual(d.action, 'skip');
});

console.log('== v2 精准度归一化 ==');
t('中文"精准" → high', () => assert.strictEqual(L.normalizePrecision('精准'), 'high'));
t('英文 high/qualified → high', () => assert.strictEqual(L.normalizePrecision('qualified'), 'high'));
t('"不精准/low" → low', () => assert.strictEqual(L.normalizePrecision('low'), 'low'));
t('"可能无法判断" → unknown', () => assert.strictEqual(L.normalizePrecision('maybe'), 'unknown'));

const cfg2 = { maxQualifyRounds: 2, minHighConfidence: 0.82, minLowConfidence: 0.85 };
console.log('== v2.1 置信度与风险 ==');
t('置信度 85 → 0.85', () => assert.strictEqual(L.normalizeConfidence(85), 0.85));
t('中文投诉 → complaint', () => assert.deepStrictEqual(L.normalizeRiskFlags(['客户投诉质量']), ['complaint']));
t('退款 + 律师 → 双风险', () => assert.deepStrictEqual(L.normalizeRiskFlags(['refund','lawyer']), ['refund','lawyer']));
t('投诉硬拦截', () => assert.strictEqual(L.HARD_STOP_RE.test('我要投诉并找律师'), true));
t('高置信度精准 → send_material', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'quote', confidence: 0.91 }, null, cfg2);
  assert.strictEqual(d.action, 'send_material');
});
t('高精准但置信度不足 → 追问', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'quote', confidence: 0.6 }, null, cfg2);
  assert.strictEqual(d.action, 'ask');
});
t('低精准但无明确排除证据 → 人工复核', () => {
  const d = L.decideQualification({ precision: 'low', purpose: 'other', confidence: 0.95, riskFlags: [] }, null, cfg2);
  assert.strictEqual(d.action, 'hold');
  assert.strictEqual(d.status, 'review');
});
t('低精准但有垃圾信息证据 → 放弃', () => {
  const d = L.decideQualification({ precision: 'low', purpose: 'other', confidence: 0.95, riskFlags: ['spam'] }, null, cfg2);
  assert.strictEqual(d.action, 'unqualified');
});
t('投诉风险即使精准也转人工', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'quote', confidence: 0.95, riskFlags: ['complaint'] }, null, cfg2);
  assert.strictEqual(d.action, 'hold');
});
t('第一次进口但需求具体可以精准', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'quote', confidence: 0.86, riskFlags: [], signals: { purchaseIntent: 'clear', productSpecific: true, quantityGiven: true } }, null, cfg2);
  assert.strictEqual(d.action, 'send_material');
});
t('强信号数量计算', () => {
  assert.strictEqual(L.strongSignalCount({ productSpecific: true, quantityGiven: true, destinationGiven: true }), 3);
});
t('三个强信号自动纠正 unknown 为精准', () => {
  const d = L.decideQualification({
    precision: 'unknown', purpose: 'quote', confidence: 0.55, riskFlags: [],
    signals: { purchaseIntent: 'clear', productSpecific: true, quantityGiven: true, destinationGiven: true, importExperience: 'unknown' },
  }, null, cfg2);
  assert.strictEqual(d.action, 'send_material');
  assert.strictEqual(d.precision, 'high');
});
t('强信号仍不能绕过投诉风险', () => {
  const d = L.decideQualification({
    precision: 'unknown', purpose: 'quote', confidence: 0.8, riskFlags: ['complaint'],
    signals: { purchaseIntent: 'clear', productSpecific: true, quantityGiven: true, destinationGiven: true },
  }, null, cfg2);
  assert.strictEqual(d.action, 'hold');
});

console.log('== v2 目的归一化 ==');
t('报价 → quote', () => assert.strictEqual(L.normalizePurpose('客户想要 quotation'), 'quote'));
t('画册 → catalog', () => assert.strictEqual(L.normalizePurpose('catalog'), 'catalog'));
t('现货 → stock', () => assert.strictEqual(L.normalizePurpose('in stock'), 'stock'));
t('无关 → other', () => assert.strictEqual(L.normalizePurpose('hello'), 'other'));

console.log('== v2 资格状态机 ==');
t('判定不精准 → unqualified 放弃', () => {
  const d = L.decideQualification({ precision: 'low', purpose: 'other', confidence: 0.95, riskFlags: ['spam'] }, null, cfg2);
  assert.strictEqual(d.action, 'unqualified');
  assert.strictEqual(d.status, 'done');
});
t('判定精准 → send_material', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'quote', confidence: 0.9 }, null, cfg2);
  assert.strictEqual(d.action, 'send_material');
  assert.strictEqual(d.status, 'qualified');
  assert.strictEqual(d.purpose, 'quote');
});
t('信息不足第1轮 → ask，轮次=1', () => {
  const d = L.decideQualification({ precision: 'unknown', purpose: 'other', confidence: 0.25 }, null, cfg2);
  assert.strictEqual(d.action, 'ask');
  assert.strictEqual(d.status, 'pending');
  assert.strictEqual(d.ask_rounds, 1);
});
t('第2轮仍不足 → ask，轮次=2', () => {
  const d = L.decideQualification({ precision: 'unknown', purpose: 'other', confidence: 0.25 }, { ask_rounds: 1 }, cfg2);
  assert.strictEqual(d.action, 'ask');
  assert.strictEqual(d.ask_rounds, 2);
});
t('达到上限仍不足 → hold 转人工', () => {
  const d = L.decideQualification({ precision: 'unknown', purpose: 'other', confidence: 0.25 }, { ask_rounds: 2 }, cfg2);
  assert.strictEqual(d.action, 'hold');
  assert.strictEqual(d.status, 'review');
});
t('精准优先于轮次（已追问2轮仍判精准→发素材）', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'stock', confidence: 0.9 }, { ask_rounds: 2 }, cfg2);
  assert.strictEqual(d.action, 'send_material');
});
t('isQualified 只对 qualified 为真', () => {
  assert.strictEqual(L.isQualified({ status: 'qualified' }), true);
  assert.strictEqual(L.isQualified({ status: 'pending' }), false);
  assert.strictEqual(L.isQualified(null), false);
});

console.log('== v2 AI 结果解析 ==');
t('解析纯 JSON', () => {
  const v = L.parseVerdict('{"language":"en","precision":"high","purpose":"quote"}');
  assert.strictEqual(v.precision, 'high');
});
t('解析 ```json 代码块', () => {
  const v = L.parseVerdict('```json\n{"precision":"low"}\n```');
  assert.strictEqual(v.precision, 'low');
});
t('解析带前后杂字', () => {
  const v = L.parseVerdict('好的，结果如下：{"precision":"unknown"} 以上。');
  assert.strictEqual(v.precision, 'unknown');
});
t('非法文本 → null', () => assert.strictEqual(L.parseVerdict('不是JSON'), null));

console.log('== 静默时长与拒接识别 ==');
t('静默 30 小时', () => assert.strictEqual(L.silenceHours('2026-11-16 14:00:00', Date.parse('2026-11-17T20:00:00')), 30));
t('时间戳非法 → null', () => assert.strictEqual(L.silenceHours('不是时间', Date.now()), null));
t('空时间戳 → null', () => assert.strictEqual(L.silenceHours('', Date.now()), null));
t('中文不感兴趣 → 拒接', () => assert.strictEqual(L.isRefusal('不感兴趣，谢谢'), true));
t('英文 not interested → 拒接', () => assert.strictEqual(L.isRefusal('Not interested, thanks'), true));
t('普通问价不是拒接', () => assert.strictEqual(L.isRefusal('请问这个多少钱'), false));

console.log('== 跟进判定 followupDue ==');
const fcfg = { minSilenceHours: 24, maxSilenceHours: 72, maxFollowups: 2, sendClosing: true };
t('静默 30 小时首跟 → due', () => {
  const d = L.followupDue({ followupsSent: 0, closingSent: false, silenceHours: 30, silenceSinceFollowupHours: null }, fcfg);
  assert.strictEqual(d.due, true); assert.strictEqual(d.kind, 'followup');
});
t('静默 5 小时 → 不催', () => {
  const d = L.followupDue({ followupsSent: 0, closingSent: false, silenceHours: 5, silenceSinceFollowupHours: null }, fcfg);
  assert.strictEqual(d.due, false);
});
t('静默 100 小时 → 不翻旧账', () => {
  const d = L.followupDue({ followupsSent: 0, closingSent: false, silenceHours: 100, silenceSinceFollowupHours: null }, fcfg);
  assert.strictEqual(d.due, false);
});
t('第 1 次跟进后 5 小时 → 不催', () => {
  const d = L.followupDue({ followupsSent: 1, closingSent: false, silenceHours: 40, silenceSinceFollowupHours: 5 }, fcfg);
  assert.strictEqual(d.due, false);
});
t('第 1 次跟进后 30 小时 → 第 2 次', () => {
  const d = L.followupDue({ followupsSent: 1, closingSent: false, silenceHours: 60, silenceSinceFollowupHours: 30 }, fcfg);
  assert.strictEqual(d.due, true); assert.strictEqual(d.kind, 'followup');
});
t('跟进 2 次后 → 发收尾', () => {
  const d = L.followupDue({ followupsSent: 2, closingSent: false, silenceHours: 90, silenceSinceFollowupHours: 30 }, fcfg);
  assert.strictEqual(d.due, true); assert.strictEqual(d.kind, 'closing');
});
t('收尾已发 → 不再打扰', () => {
  const d = L.followupDue({ followupsSent: 2, closingSent: true, silenceHours: 90, silenceSinceFollowupHours: 30 }, fcfg);
  assert.strictEqual(d.due, false);
});
t('收尾开关关闭 → 满次数就停', () => {
  const d = L.followupDue({ followupsSent: 2, closingSent: false, silenceHours: 90, silenceSinceFollowupHours: 30 }, { ...fcfg, sendClosing: false });
  assert.strictEqual(d.due, false);
});

console.log('== v2.3 目录规则：不直接发全套、老客户直给、报量转人工 ==');
t('要目录的新客户判精准 → 追问，不发全套', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'catalog', confidence: 0.9, signals: { existingCustomer: false } }, null, cfg2);
  assert.strictEqual(d.action, 'ask');
});
t('要目录的老客户判精准 → 直接发素材', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'catalog', confidence: 0.9, signals: { existingCustomer: true } }, null, cfg2);
  assert.strictEqual(d.action, 'send_material');
});
t('要目录的老客户信息不足 → 也不追问，直接发素材', () => {
  const d = L.decideQualification({ precision: 'unknown', purpose: 'catalog', confidence: 0.3, signals: { existingCustomer: true } }, null, cfg2);
  assert.strictEqual(d.action, 'send_material');
});
t('要目录的新客户报了采购量 → 转人工', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'catalog', confidence: 0.9, signals: { quantityGiven: true } }, null, cfg2);
  assert.strictEqual(d.action, 'hold'); assert.strictEqual(d.status, 'review');
});
t('要目录的新客户答了 2 轮 → 转人工', () => {
  const d = L.decideQualification({ precision: 'unknown', purpose: 'catalog', confidence: 0.3, signals: {} }, { ask_rounds: 2 }, cfg2);
  assert.strictEqual(d.action, 'hold'); assert.strictEqual(d.status, 'review');
});
t('要样品/视频看厂 → 转人工', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'catalog', confidence: 0.9, signals: { wantsSampleOrTour: true } }, null, cfg2);
  assert.strictEqual(d.action, 'hold'); assert.strictEqual(d.status, 'review');
});
t('报价客户报了采购量 → 仍按原来发素材（目录规则只管 catalog）', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'quote', confidence: 0.91, signals: { quantityGiven: true } }, null, cfg2);
  assert.strictEqual(d.action, 'send_material');
});
t('现货高精准追问 2 轮 → 仍发素材', () => {
  const d = L.decideQualification({ precision: 'high', purpose: 'stock', confidence: 0.9, signals: {} }, { ask_rounds: 2 }, cfg2);
  assert.strictEqual(d.action, 'send_material');
});

console.log('== WhatsApp 总开关与置顶硬规则 ==');
const waPage = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'pages_wa.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
const qualify = fs.readFileSync(path.join(__dirname, 'qualify.js'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
t('WhatsApp 页面包含自动回复总开关', () => assert(waPage.includes('/whatsapp/auto-reply/toggle') && waPage.includes('自动回复总开关')));
t('总开关仅管理员可操作', () => assert(routes.includes("ctx.user.role !== 'admin'") && routes.includes('只有管理员可以修改自动回复总开关')));
t('发送前再次检查置顶', () => assert(worker.includes('发送前被置顶，放弃') && worker.includes('logic.isPinned(freshChat)')));
t('现货图片默认全部发送', () => assert.strictEqual(Number(cfg.qualify.maxStockImages), 0));
t('现货目录优先发送 PDF', () => assert.strictEqual(cfg.qualify.stockPreferPdf, true));
t('仅现货 PDF 时不再混发图片', () => assert(worker.includes('pdfs.length ? pdfs : pdfs.concat(images)')));
t('每日自动批次上限 150', () => assert.strictEqual(Number(cfg.dailyLimit), 150));
t('每日唯一客户上限 120', () => assert.strictEqual(Number(cfg.dailyUniqueCustomers), 120));
t('每日素材包上限 20', () => assert.strictEqual(Number(cfg.qualify.dailyMaterialPackages), 20));
t('每日文件上限 300', () => assert.strictEqual(Number(cfg.qualify.dailyFiles), 300));
t('每日唯一客户按 chat_key 去重', () => assert(worker.includes('COUNT(DISTINCT chat_key)')));
t('文件发送数量按成功文件累计', () => assert(worker.includes('file_count') && worker.includes('sentFiles++')));
t('DeepSeek 网络错误至少重试 3 次', () => assert.strictEqual(Number(cfg.qualify.aiRetries), 3));
t('AI 调用包含重试循环', () => assert(qualify.includes('for (let attempt = 1; attempt <= attempts; attempt++)') && qualify.includes('lastError')));
t('追问规则禁止重复已知信息', () => assert(qualify.includes('已知信息不要重复询问')));
t('中国采购经验可构成高精准证据', () => assert(qualify.includes('明确或可可靠推断从中国采购过')));
t('资格追问最多 3 轮', () => assert.strictEqual(Number(cfg.qualify.maxQualifyRounds), 3));
t('回复采用自然 WhatsApp 销售口吻', () => assert(qualify.includes('像真实外贸业务员在 WhatsApp 上聊天') && qualify.includes('每次只问 1 个最关键的问题')));
t('回复禁止模板式连续确认', () => assert(qualify.includes('不要写“为了准确报价请确认以下内容”')));

console.log('== v2.9 置顶保护补漏 + 跟进轮次 + 破冰打法 ==');
const icebreakers = fs.readFileSync(path.join(__dirname, 'icebreakers.md'), 'utf8');
t('发送只走 deliver 一个出口', () => {
  const calls = (worker.match(/await send(Text|File)\(/g) || []).length;
  assert.strictEqual(calls, 4); // 初次 + 限速重试，各在 deliver 循环里 1 处
  assert(worker.includes('唯一发送出口'));
});
t('素材包逐条发送前重新查置顶', () => assert(worker.includes('素材包发送中被置顶') && worker.includes('logic.isPinned(recheck)')));
t('跟进轮次只扫描 pending/qualified 且未置顶', () => assert(worker.includes("status IN ('pending','qualified')") && worker.includes('置顶客户绝不跟进')));
t('跟进前判断人工是否接手', () => assert(worker.includes('humanTookOver(chat, chatKey)')));
t('跟进与回复共用冷却和每天限额', () => assert(worker.includes('与回复共用同一套冷却和每天限额')));
t('客户新消息重置跟进轮次', () => assert(worker.includes('resetFollowupEpisode(chatKey)')));
t('明确拒接 14 天内不再跟进', () => assert(worker.includes('setNotInterested(chatKey, 14)')));
t('跟进状态表存在', () => assert(worker.includes('CREATE TABLE IF NOT EXISTS followup')));
t('跟进配置项齐全', () => {
  assert.strictEqual(cfg.followup.enabled, true);
  assert.strictEqual(Number(cfg.followup.minSilenceHours), 24);
  assert.strictEqual(Number(cfg.followup.maxSilenceHours), 72);
  assert.strictEqual(Number(cfg.followup.maxFollowups), 2);
  assert.strictEqual(cfg.followup.sendClosing, true);
});
t('破冰打法文件有场景标签行', () => assert(/^- \[catalog\] /m.test(icebreakers) && /^- \[followup\] /m.test(icebreakers) && /^- \[closing\] /m.test(icebreakers)));
t('挑款按 positioning 字段，不按材质推断', () => {
  assert(icebreakers.includes('positioning') && icebreakers.includes('高端款') && icebreakers.includes('高流通款'));
  assert(!icebreakers.includes('不锈钢、铜') && !icebreakers.includes('锌合金、走量款'));
  assert(qualify.includes('positioning'));
});
t('qualify 接入破冰打法并能生成跟进', () => assert(qualify.includes('icebreakers.md') && qualify.includes('generateFollowup') && qualify.includes('icebreakerLines')));
t('判定提示词按场景只取 1–2 条打法', () => assert(qualify.includes('icebreakerLines(sceneOfText(ctx.customerText), 2)')));

if (!process.exitCode) console.log('\n全部 ' + pass + ' 项通过 ✓');
