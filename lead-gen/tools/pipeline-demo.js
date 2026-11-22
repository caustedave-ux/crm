'use strict';
/** 演示：导入 → 采集 → 核验 → 落库 → 导出 全流程 */
const importer = require('../src/importer');
const sources = require('../src/sources');
const verifier = require('../src/verify');
const { run, get, all, now, log } = require('../src/db');

async function verifyOne(leadId, opts = {}) {
  const lead = get('SELECT * FROM leads WHERE id=?', leadId);
  if (!lead) throw new Error('线索不存在: ' + leadId);
  const t0 = Date.now();
  run("UPDATE leads SET status='verifying',updated_at=? WHERE id=?", now(), leadId);

  const col = await sources.collect(lead, opts);
  // 证据落库
  for (const e of col.evidence) {
    run(`INSERT INTO evidence(lead_id,source,field,raw_value,value,url,snippet,confidence,captured_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      leadId, e.source, e.field, e.raw_value || '', e.value || '', e.url || '', e.snippet || '',
      e.confidence || 0.5, now());
  }
  const evidence = all('SELECT * FROM evidence WHERE lead_id=?', leadId);
  const result = verifier.verifyLead(lead, evidence);
  const dur = Date.now() - t0;

  const vr = run(`INSERT INTO verifications(lead_id,engine_version,overall_score,field_count,conflict_count,duration_ms,result_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)`,
    leadId, result.engine_version, result.overall_score, result.field_count, result.conflict_count, dur,
    JSON.stringify(result), now());
  const verificationId = Number(vr.lastInsertRowid);

  for (const fr of result.fields) {
    run(`INSERT INTO field_results(verification_id,lead_id,field,value,confidence,status,evidence_count,detail)
      VALUES(?,?,?,?,?,?,?,?)`,
      verificationId, leadId, fr.field, fr.value || '', fr.confidence, fr.status, fr.evidence_count,
      JSON.stringify(fr.detail || []));
  }
  run("UPDATE leads SET status=?,overall_score=?,recommend_score=?,updated_at=? WHERE id=?",
    result.suggested_status, result.overall_score, result.recommend_score || 0, now(), leadId);
  log('info', `核验完成：${lead.company_name}，可信分 ${result.overall_score}，推荐分 ${result.recommend_score || 0}（${(result.recommendation || {}).level || '—'}），证据 ${evidence.length} 条`, leadId);
  return { lead, result, log: col.log, errors: col.errors, duration_ms: dur };
}

module.exports = { verifyOne };

if (require.main === module) {
  (async () => {
    const sample = `公司名称,网址,国家,行业,来源
Demo Hardware,https://www.demo-hardware.com,Germany,door hardware,演示
Sample Access Ltd.,https://www.sample-access.com,Sweden,access control,演示`;
    const rows = importer.parseRows(sample);
    console.log('解析行数:', rows.length, rows[0]);
    const imp = importer.importLeads(rows, { batch_name: '演示批次', source: 'demo' });
    console.log('导入结果:', { inserted: imp.inserted, duplicates: imp.duplicates });
    for (const id of imp.ids) {
      const r = await verifyOne(id);
      console.log(`\n[${r.lead.company_name}] 分数=${r.result.overall_score} 等级=${r.result.level} 状态=${r.result.suggested_status} 耗时=${r.duration_ms}ms`);
      console.log('  行业:', r.result.summary.industry || '(未识别)');
      console.log('  规模:', r.result.summary.size || '(未识别)');
      console.log('  社媒:', r.result.summary.social_platforms.join('、') || '(未发现)');
      console.log('  日志:', r.log.join(' | '));
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
