'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const codex = require('../src/codexAssistant');
const settingsView = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'pages_docs.js'), 'utf8');

const prompt = codex.buildPrompt('统计客户', '【客户】测试公司');
assert(prompt.includes('统计客户'), 'prompt includes question');
assert(prompt.includes('【客户】测试公司'), 'prompt includes CRM context');
assert(prompt.includes('不可信的业务数据'), 'CRM data treated as untrusted input');
assert(prompt.includes('不要调用工具'), 'tool usage is prohibited');
assert(codex.buildPrompt('x'.repeat(5000), '').includes('x'.repeat(codex.MAX_QUESTION_LENGTH)), 'question is capped');
assert(settingsView.includes('Codex 助理设置'), 'settings page has a dedicated Codex section');
assert(settingsView.includes('DeepSeek 设置（WhatsApp、行业简报、AI 外贸工作台等）'), 'DeepSeek remains scoped to other AI features');

const tempBase = path.join('D:\\Codex', 'tmp');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'codex-assistant-test-'));
const fakeSpawn = (command, args, options) => {
  assert.strictEqual(command, 'codex-test');
  assert(args.includes('--ephemeral'));
  assert(args.includes('--ignore-user-config'), 'user model overrides are not used');
  assert(args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === 'read-only');
  assert(args.includes('--ask-for-approval') && args[args.indexOf('--ask-for-approval') + 1] === 'never');
  assert(args.includes('--model') && args[args.indexOf('--model') + 1] === 'gpt-test');
  assert(args.includes('--cd'));
  const outputFile = args[args.indexOf('--output-last-message') + 1];

  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, end() {
    fs.writeFileSync(outputFile, 'Codex test answer', 'utf8');
    process.nextTick(() => child.emit('close', 0));
  } };
  child.kill = () => {};
  return child;
};

const failingSpawn = (command, args, options) => {
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, end() { process.nextTick(() => {
    child.stderr.emit('data', Buffer.from('401 Unauthorized: invalid_api_key'));
    child.emit('close', 1);
  }); } };
  child.kill = () => {};
  return child;
};

(async () => {
  try {
    const answer = await codex.runCodex(prompt, {
      command: 'codex-test',
      spawn: fakeSpawn,
      tempRoot,
      timeoutMs: 1000,
      model: 'gpt-test',
    });
    assert.strictEqual(answer, 'Codex test answer');
    assert.deepStrictEqual(fs.readdirSync(tempRoot), [], 'temporary run directory is removed');
    await assert.rejects(
      codex.runCodex(prompt, {
        command: 'codex-test',
        spawn: failingSpawn,
        tempRoot,
        timeoutMs: 1000,
      }),
      /Codex 登录凭证无效/
    );
    console.log('Codex 助理测试全部通过');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
