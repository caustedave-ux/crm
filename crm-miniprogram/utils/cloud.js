// ============ 云端客户端（唯一初始化点） ============
// endpoint 与 publishableKey 均来自云服务的 publicConfig，不要改写。
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram');
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics');

const PUBLIC_CONFIG = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_1hHj0Q74TfYdyMsSVONUUP_OpPmxETn3i2wfKhIH4GRIOAI6dQeeGQx',
};

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: PUBLIC_CONFIG.endpoint,
  publishableKey: PUBLIC_CONFIG.publishableKey,
  wx: createDiagnosticWx(wx),
});

module.exports = { cloud };
