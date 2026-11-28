'use strict';
// ============ 统一 AI 接入（豆包 / 火山方舟 优先，DeepSeek 备用）============
// 系统里所有 AI 能力（工作台对话、月度简报、跟进要点与话术）都走这里：
//   1. 设置了豆包 Key 且供应商为豆包 → 调火山方舟 OpenAI 兼容接口
//   2. 否则有 DeepSeek Key → 调 api.deepseek.com
//   3. 两个 Key 都没有 → 抛明确错误，提示去「系统设置 → AI 接入」填写
// 只读设置，不改任何业务数据。

const { getSetting } = require('./db');

const DOUBAO_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_DOUBAO_MODEL = 'doubao-seed-1-6-251015';

function trim(v) { return String(v || '').trim(); }

/** 当前实际会用哪个供应商（不联网，只看配置） */
function resolve() {
  const doubaoKey = trim(getSetting('doubao_api_key'));
  const deepseekKey = trim(getSetting('ai_api_key'));
  const prefer = trim(getSetting('ai_provider')) || 'doubao';
  const doubao = {
    provider: 'doubao', label: '豆包（火山方舟）', url: DOUBAO_URL, key: doubaoKey,
    model: trim(getSetting('doubao_model')) || DEFAULT_DOUBAO_MODEL,
  };
  const deepseek = {
    provider: 'deepseek', label: 'DeepSeek', url: DEEPSEEK_URL, key: deepseekKey,
    model: trim(getSetting('ai_model')) || 'deepseek-chat',
  };
  if (prefer === 'deepseek') return deepseekKey ? deepseek : (doubaoKey ? doubao : null);
  return doubaoKey ? doubao : (deepseekKey ? deepseek : null);
}

function status() {
  const r = resolve();
  return {
    ok: !!r,
    provider: r ? r.provider : '',
    label: r ? r.label : '',
    model: r ? r.model : '',
    doubaoConfigured: !!trim(getSetting('doubao_api_key')),
    deepseekConfigured: !!trim(getSetting('ai_api_key')),
    prefer: trim(getSetting('ai_provider')) || 'doubao',
  };
}

/**
 * 调一次对话补全，返回纯文本。
 * @param {object} opts { system, user, messages, maxTokens, temperature, json, timeoutMs }
 */
async function chat(opts) {
  const o = opts || {};
  const cfg = resolve();
  if (!cfg) throw new Error('未配置 AI Key：请到「系统设置 → AI 接入」填写豆包（火山方舟）或 DeepSeek 的 Key');
  const messages = Array.isArray(o.messages) && o.messages.length
    ? o.messages
    : [{ role: 'system', content: String(o.system || '') }, { role: 'user', content: String(o.user || '').slice(0, 28000) }];
  const body = {
    model: cfg.model,
    messages,
    temperature: typeof o.temperature === 'number' ? o.temperature : 0.3,
    stream: false,
  };
  if (o.maxTokens) body.max_tokens = o.maxTokens;
  if (o.json) body.response_format = { type: 'json_object' };
  const resp = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeoutMs || 120000),
  });
  if (!resp.ok) {
    let msg = cfg.label + ' 返回 HTTP ' + resp.status;
    try {
      const j = await resp.json();
      if (j && j.error && (j.error.message || j.error.code)) msg = cfg.label + '：' + (j.error.message || j.error.code);
    } catch (e) {}
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content;
  return String(text || '').trim();
}

module.exports = { chat, resolve, status, DEFAULT_DOUBAO_MODEL, DOUBAO_URL, DEEPSEEK_URL };
