'use strict';
// ============ 每日自动回复统计（只读 state.db） ============
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { todayStr } = require('./util');
const autoReplyControl = require('./autoReplyControl');

const STATE_PATH = path.join(__dirname, '..', 'auto-reply', 'state.db');

function emptyStats(status) {
  return {
    status,
    actions: {}, sentBatches: 0, customers: 0, messages: 0, files: 0, asks: 0, materialPackages: 0,
    skips: 0, holds: 0, unqualified: 0, errors: 0, dry: 0,
    qualified: 0, pending: 0, review: 0, done: 0, precisionHigh: 0, precisionUnknown: 0, precisionLow: 0,
    recent: [], limits: { batches: 150, customers: 120, materials: 20, files: 300 },
  };
}

function todayStats() {
  const status = autoReplyControl.status();
  const out = emptyStats(status);
  try {
    const config = autoReplyControl.readConfig();
    out.limits = {
      batches: Number(config.dailyLimit) || 0,
      customers: Number(config.dailyUniqueCustomers) || 0,
      materials: Number(config.qualify && config.qualify.dailyMaterialPackages) || 0,
      files: Number(config.qualify && config.qualify.dailyFiles) || 0,
    };
  } catch (e) {}
  if (!fs.existsSync(STATE_PATH)) return out;
  let db;
  try {
    db = new DatabaseSync(STATE_PATH, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1500');
    const day = todayStr();
    const actions = db.prepare("SELECT action, COUNT(*) n FROM sent_log WHERE substr(at,1,10)=? GROUP BY action").all(day);
    for (const row of actions) out.actions[row.action] = Number(row.n) || 0;
    const sent = db.prepare(`SELECT COUNT(*) batches, COUNT(DISTINCT chat_key) customers,
      COALESCE(SUM(message_count),0) messages, COALESCE(SUM(file_count),0) files
      FROM sent_log WHERE action='sent' AND substr(at,1,10)=?`).get(day) || {};
    out.sentBatches = Number(sent.batches) || 0;
    out.customers = Number(sent.customers) || 0;
    out.messages = Number(sent.messages) || 0;
    out.files = Number(sent.files) || 0;
    const tags = db.prepare(`SELECT
      SUM(CASE WHEN reason LIKE '%qualify_ask%' THEN 1 ELSE 0 END) asks,
      SUM(CASE WHEN reason LIKE '%material:%' THEN 1 ELSE 0 END) materials
      FROM sent_log WHERE action='sent' AND substr(at,1,10)=?`).get(day) || {};
    out.asks = Number(tags.asks) || 0;
    out.materialPackages = Number(tags.materials) || 0;
    out.skips = Number(out.actions.skip) || 0;
    out.holds = Number(out.actions.hold) || 0;
    out.unqualified = Number(out.actions.unqualified) || 0;
    out.errors = Number(out.actions.error) || 0;
    out.dry = Number(out.actions.dry) || 0;
    const qual = db.prepare(`SELECT status, precision, COUNT(*) n FROM qualification
      WHERE substr(COALESCE(updated_at,''),1,10)=? GROUP BY status, precision`).all(day);
    for (const row of qual) {
      const n = Number(row.n) || 0;
      if (row.status === 'qualified') out.qualified += n;
      else if (row.status === 'pending') out.pending += n;
      else if (row.status === 'review') out.review += n;
      else if (row.status === 'done') out.done += n;
      if (row.precision === 'high') out.precisionHigh += n;
      else if (row.precision === 'low') out.precisionLow += n;
      else out.precisionUnknown += n;
    }
    out.recent = db.prepare(`SELECT chat_name, action, reason, draft, message_count, file_count, at
      FROM sent_log WHERE substr(at,1,10)=? ORDER BY id DESC LIMIT 10`).all(day);
  } catch (e) {
    out.error = e.message;
  } finally {
    try { if (db) db.close(); } catch (e) {}
  }
  return out;
}

module.exports = { todayStats };
