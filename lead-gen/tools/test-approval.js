'use strict';
/** 审批闭环自测：用临时库，不碰 lead-gen/data/leads.db */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmp = path.join(os.tmpdir(), `leadgen-approval-${process.pid}.db`);
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.LEADGEN_DB = tmp;

const { db, run, get, now } = require('../src/db');
const { setStage, approveRecommended } = require('../src/workflow');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

const t = now();
const r = run("INSERT INTO leads(company_name,status,dedup_key,created_at,updated_at) VALUES('审批测试公司','new','d:approval.test',?,?)", t, t);
const id = Number(r.lastInsertRowid);
run("INSERT INTO verifications(lead_id,engine_version,overall_score,conflict_count,result_json,created_at) VALUES(?, '1.2.0', 80, 0, '{}', ?)", id, t);
run('UPDATE leads SET recommend_score=85 WHERE id=?', id);

console.log('\n[1] 人工审批流转');
ok(setStage([id], 'approved', '电话已核实').ok, '审批通过接口成功');
ok(get('SELECT stage FROM leads WHERE id=?', id).stage === 'approved', '阶段写入 approved');
ok(get('SELECT review_note FROM leads WHERE id=?', id).review_note === '电话已核实', '审批备注已保存');
ok(!!get('SELECT reviewed_at FROM leads WHERE id=?', id).reviewed_at, '审批时间已记录');
ok(setStage([id], 'rejected').ok, '驳回接口成功');
ok(get('SELECT stage FROM leads WHERE id=?', id).stage === 'rejected', '阶段写入 rejected');
ok(setStage([id], 'candidate').ok, '退回候选接口成功');

console.log('\n[2] 推荐分达标一键勾选');
const picked = approveRecommended(70);
ok(picked.ok && picked.changed === 1, '推荐分达标候选被勾选');
ok(get('SELECT stage FROM leads WHERE id=?', id).stage === 'approved', '勾选后阶段为 approved');
ok(approveRecommended(70).changed === 0, '已审批线索不会被重复勾选');

console.log('\n[3] 参数校验');
ok(setStage([], 'approved').ok === false, '未指定线索时拒绝操作');
ok(setStage([id], 'unknown').ok === false, '未知阶段被拒绝');

db.close();
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
