'use strict';
/**
 * 借鉴 GoodJob 的候选 → 人工审批 → 可联系线索闭环。
 * 系统只给推荐分和建议，不会自动把候选变成可联系线索；所有变更都记操作日志。
 */
const { run, get, all, now, log } = require('./db');

const STAGES = {
  candidate: '候选池',
  approved: '审批通过（可联系）',
  rejected: '已驳回',
};

/** 把线索在候选池 / 审批通过 / 已驳回之间流转 */
function setStage(ids, stage, note = '') {
  if (!STAGES[stage]) return { ok: false, error: '未知审批状态' };
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  if (!list.length) return { ok: false, error: '未指定线索' };
  const t = now();
  let changed = 0;
  for (const id of list) {
    const lead = get('SELECT id, company_name FROM leads WHERE id=?', id);
    if (!lead) continue;
    run('UPDATE leads SET stage=?,reviewed_at=?,review_note=?,updated_at=? WHERE id=?',
      stage, t, String(note || '').slice(0, 300), t, id);
    log('info', `人工审批：${lead.company_name} → ${STAGES[stage]}${note ? '（' + note + '）' : ''}`, id);
    changed++;
  }
  return { ok: true, changed, stage };
}

/** 一键勾选「推荐分达标且无冲突」的候选，仍由人工点按钮触发 */
function approveRecommended(threshold) {
  const min = Number(threshold);
  const score = Number.isFinite(min) && min > 0 ? min : 70;
  const rows = all(`SELECT l.id FROM leads l
    JOIN verifications v ON v.id=(SELECT MAX(id) FROM verifications WHERE lead_id=l.id)
    WHERE COALESCE(l.stage,'candidate')='candidate' AND COALESCE(l.recommend_score,0)>=? AND v.conflict_count=0`, score);
  const ids = rows.map(r => r.id);
  if (!ids.length) return { ok: true, changed: 0, stage: 'approved' };
  return setStage(ids, 'approved', `推荐分≥${score} 且无冲突，人工确认通过`);
}

module.exports = { STAGES, setStage, approveRecommended };
