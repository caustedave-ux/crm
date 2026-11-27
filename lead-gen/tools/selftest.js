'use strict';
/** 自测：解析 / 归一化 / 验证 / 去重 核心逻辑，不依赖网络 */
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

const norm = require('../src/normalize');
const importer = require('../src/importer');
const verifier = require('../src/verify');
const { parseBing } = require('../src/sources');

console.log('\n[1] 归一化 - 行业');
ok(norm.classifyIndustry('door hardware and locks manufacturer').sub === '门窗与安防五金', '英文行业识别');
ok(norm.classifyIndustry('太阳能光伏逆变器').sub === '太阳能与新能源', '中文行业识别');
ok(norm.classifyIndustry('auto parts supplier').sector === '汽车与交通', '汽车行业一级分类');
ok(norm.classifyIndustry('random text xyz') === null, '无关文本不误判');

console.log('\n[2] 归一化 - 规模');
ok(norm.parseEmployees('51-200 employees').bucket === '51-200', '区间员工数');
ok(norm.parseEmployees('over 1000 employees').count === 1000, '1000+ 不溢出');
ok(norm.parseEmployees('About 20 people').bucket === '11-50', '约数解析');
ok(norm.parseEmployees('no data').bucket === null, '无数据返回空');

console.log('\n[3] 归一化 - 域名/公司名/国家');
ok(norm.normalizeDomain('https://www.Example.com/about') === 'example.com', '域名规范化');
ok(norm.normalizeCompanyName('ABC Hardware Co., Ltd.') === 'abchardware', '公司名去重键');
ok(norm.normalizeCountry('Germany') === 'DE', '国家归一化');
ok(norm.normalizeCountry('', 'example.co.uk') === 'UK', 'ccTLD 推断国家');

console.log('\n[4] 导入解析与去重');
const rows = importer.parseRows('公司名称,网址,国家,行业\nA公司,a.com,USA,hardware\nB公司,b.com,Germany,electronics');
ok(rows.length === 2 && rows[0].company_name === 'A公司', 'CSV 列名识别');
const rows2 = importer.parseRows('A公司\tb.com\nC公司\tc.com');
ok(rows2[0].company_name === 'A公司' && rows2[0].website === 'b.com', '无表头 TSV 解析');
const rows3 = importer.parseRows('Demo Hardware\nSample Access Ltd.');
ok(rows3.length === 2 && rows3[0].company_name === 'Demo Hardware', '每行一个公司名');

console.log('\n[5] Bing 结果解析与相关性过滤');
const fakeHtml = `<li class="b_algo"><h2><a href="https://demo-hardware.com">Demo Hardware official</a></h2><p>Demo Hardware door hardware</p></li>
<li class="b_algo"><h2><a href="http://gold.com">黄金价格</a></h2><p>今日金价</p></li>`;
const parsed = parseBing(fakeHtml);
ok(parsed.length === 2 && parsed[0].url === 'https://demo-hardware.com', 'Bing 块解析');

console.log('\n[6] 交叉验证评分');
const lead = { company_name: 'Demo Hardware', country: 'Germany', industry_hint: 'door hardware' };
const ev = [
  { source:'website', field:'industry', raw_value:'access control manufacturer', snippet:'', confidence:0.85 },
  { source:'website', field:'description', raw_value:'smart access solutions for doors', snippet:'', confidence:0.8, url:'https://demo-hardware.com' },
  { source:'website', field:'social', value:'LinkedIn', raw_value:'LinkedIn', snippet:'', confidence:0.75, url:'https://linkedin.com/company/demo-hardware' },
  { source:'website', field:'social', value:'Facebook', raw_value:'Facebook', snippet:'', confidence:0.75, url:'https://facebook.com/demo-hardware' },
];
const r = verifier.verifyLead(lead, ev);
ok(r.summary.industry_sub === '门窗与安防五金', '验证引擎识别行业');
ok(r.summary.social_platforms.length === 2, '社媒多值合并不算冲突');
ok(r.overall_score > 0 && r.conflict_count === 0, '无冲突时正常打分');
ok(r.fields.some(f => f.field === 'size' && f.status === 'missing'), '无规模证据时标记缺失而非编造');

console.log('\n[7] 社媒页面解析');
const sr = require('../src/socialReader');
const liText = `Title: demo-hardware | LinkedIn
# demo-hardware
## Wholesale Building Materials
### Rümlang, Zürich  131,508 followers
 Industry  Wholesale Building Materials
 Company size  10,001+ employees
 Headquarters  Rümlang, Zürich
 View all 9,647 employees
 Founded  1962`;
const liFacts = sr.parseLinkedIn(liText, 'https://www.linkedin.com/company/demo-hardware');
ok(liFacts.some(f => f.field === 'employees' && f.value === '5000+'), 'LinkedIn 公司规模解析');
ok(liFacts.some(f => f.field === 'followers' && f.value.includes('131508')), 'LinkedIn 粉丝数解析');
ok(liFacts.some(f => f.field === 'founded' && f.value === '1962'), 'LinkedIn 成立年份解析');
const fbText = `Title: demo-hardware
# demo-hardware
**3.5K** followers
## Intro
We make access in life smart and secure
**Page** · Industrial Company
Hofwisenstrasse 24, Zürich, Switzerland, 8153
Address
digital.ch@demo-hardware.com Email`;
const fbFacts = sr.parseFacebook(fbText, 'https://www.facebook.com/demo-hardware');
ok(fbFacts.some(f => f.field === 'followers' && f.value.includes('3500')), 'Facebook 粉丝数解析');
ok(fbFacts.some(f => f.field === 'email' && f.value === 'digital.ch@demo-hardware.com'), 'Facebook 邮箱解析');
ok(!fbFacts.some(f => f.field === 'country' && /posts|about/i.test(String(f.raw_value))), 'Facebook 导航词不误判为地址');
ok(sr.parseCount('3.5K') === 3500 && sr.parseCount('131,508') === 131508, 'K缩写与千分位解析');

console.log('\n[8] 联系方式抽取与可解释推荐分（借鉴 GoodJob）');
const lead2 = { company_name: 'Approval Test Co', country: 'Germany', industry_hint: 'door hardware' };
const ev2 = [
  { source: 'website', field: 'industry', raw_value: 'door hardware manufacturer', snippet: '', confidence: 0.85, url: 'https://approval.test' },
  { source: 'website', field: 'description', raw_value: 'We export smart locks. Sales: sales@approval.test', snippet: '', confidence: 0.8, url: 'https://approval.test' },
  { source: 'facebook_page', field: 'email', raw_value: 'sales@approval.test', value: 'sales@approval.test', confidence: 0.6, url: 'https://facebook.com/approvaltest' },
  { source: 'facebook_page', field: 'phone', raw_value: '+49 30 12345678', value: '', confidence: 0.6, url: 'https://facebook.com/approvaltest' },
  { source: 'linkedin_page', field: 'employees', raw_value: '201-500 employees', value: '201-500', confidence: 0.9, url: 'https://linkedin.com/company/approvaltest' },
];
const r2 = verifier.verifyLead(lead2, ev2);
ok(r2.summary.emails.includes('sales@approval.test'), '邮箱只从证据中抽取并进入画像');
ok(r2.summary.phones.some(p => /12345678/.test(p)), '电话只从证据中抽取并进入画像');
ok(r2.recommendation && r2.recommendation.score > r2.overall_score, '联系方式带来推荐分加成');
ok(r2.recommendation.components.some(c => c.label === '联系方式'), '推荐分给出可解释明细');
ok(r2.recommendation.reasons.length >= 2, '推荐分原因可展示');

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
