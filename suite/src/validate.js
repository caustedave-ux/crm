'use strict';
/**
 * 获客工作台输入校验（M5）：POST 接口白名单。
 * 独立成模块是为了让自测直接测校验逻辑（server.js 的路由只调这里）。
 */

// 线索状态白名单：与 leads 表注释一致（new / queued / verifying / verified / review / failed）。
const LEAD_STATUS_VALUES = ['new', 'queued', 'verifying', 'verified', 'review', 'failed'];

function isValidLeadStatus(status) {
  return typeof status === 'string' && LEAD_STATUS_VALUES.includes(status);
}

// 设置项白名单：只接受这几个键，其他键一律拒绝（不入库）。
// 已下线的旧核验设置项（google_cse_key、serpapi_key、jina_*、
// max_results_per_query、approval_min_score）不在白名单里。
const SETTING_KEYS = [
  'google_places_key',
  'request_delay_ms',
  'request_timeout_ms',
  'enabled_sources',
  'proxy_url',
];

/**
 * 校验 POST /api/settings 的 body。
 * 返回 { ok: true, settings } 或 { ok: false, error }。
 * - 未知键：整单拒绝，不写任何项；
 * - 已知键的值只接受字符串或数字（转成字符串再存），对象/数组/null 拒绝。
 */
function validateSettingsBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '设置数据格式不正确。' };
  }
  const settings = {};
  for (const [k, v] of Object.entries(body)) {
    if (!SETTING_KEYS.includes(k)) {
      return { ok: false, error: '未知的设置项：' + k + '（已拒绝，未写入任何设置）。' };
    }
    if (typeof v !== 'string' && typeof v !== 'number') {
      return { ok: false, error: '设置项 ' + k + ' 的值格式不正确。' };
    }
    settings[k] = String(v);
  }
  return { ok: true, settings };
}

module.exports = { LEAD_STATUS_VALUES, isValidLeadStatus, SETTING_KEYS, validateSettingsBody };
