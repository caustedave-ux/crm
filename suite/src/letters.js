'use strict';
/**
 * 开发信引擎（获客工作台 · 开发信）
 *
 * 单发流程口径（V1，不直连 SMTP）：
 * 主 CRM 代码里没有任何现成发信能力（无 nodemailer、无 SMTP 配置），且本项目
 * 不允许新增 npm 依赖，所以 V1 不做直连 SMTP 发送。单发的方式是：
 *   选模板 + 选线索 → 渲染预览 → 复制全文 / 打开 mailto:（收件人取线索的
 *   邮箱证据，若无邮箱则只复制）→ 用户在自己邮箱发完后点「标记已发送」调
 *   recordSend 写一条 send_records。
 * 也就是说：本模块只负责“模板管理 + 占位符渲染 + 读联系方式 + 记发送记录”，
 * 真正的发出动作发生在用户自己的邮箱客户端里。如后续要直连发送，需另接
 * SMTP 服务（发件箱配置 + nodemailer 或等价依赖），不在本模块范围内。
 *
 * 占位符：{{公司名}} {{国家}} {{产品}} {{联系人}} {{电话}} {{网址}}
 * - {{产品}} 默认取 'door locks & hardware'（法文模板默认取法文 'serrures et
 *   quincaillerie de porte'）；lead 自带 product / product_hint 字段时优先用它。
 * - {{联系人}} 取 lead.contact_name，lead 里没有取 ''。
 * - 模板或 lead 也可传 id（数字），模块内部会查库；传对象时直接取字段。
 *
 * 表结构约定（suite/src/db.js 建表）：
 * - letter_templates(id, name, lang, subject, body, created_at, updated_at)
 * - send_records(id, lead_id, template_id, channel, subject, body, status, created_at)
 * - evidence(lead_id, source, field, value)：联系方式从这里读，field 为
 *   phone / website / email（email 由后续邮箱挖掘补证据，没有则 ''）。
 * Key 只存 settings 表，绝不写进代码、日志或错误信息。
 */
const { run, get, all } = require('./db');

function now() { return new Date().toISOString(); }

const DEFAULT_PRODUCT_EN = 'door locks & hardware';
const DEFAULT_PRODUCT_FR = 'serrures et quincaillerie de porte';

/** 默认模板：首次调用 ensureDefaults() 且表为空时写入。落款留公司名/电话占位。 */
const DEFAULT_TEMPLATES = [
  {
    name: '英文通用开发信',
    lang: 'en',
    subject: 'Door Hardware Supply from China — {{公司名}}',
    body: 'Hi {{公司名}} team,\n'
      + '\n'
      + 'We are a door lock and hardware manufacturer from China with 12 years of OEM experience. '
      + 'We supply {{产品}} to distributors and hardware retailers in {{国家}} and worldwide — '
      + 'including mortise locks, handles, cylinders and hinges.\n'
      + '\n'
      + 'Could you share your main product lines and typical order quantity? '
      + 'We will send you our catalogue with best prices for your market.\n'
      + '\n'
      + 'Best regards,\n'
      + '[Your Company Name]\n'
      + 'WhatsApp: [Your WhatsApp Number]',
  },
  {
    name: '法文通用开发信',
    lang: 'fr',
    subject: 'Quincaillerie de porte depuis la Chine — {{公司名}}',
    body: 'Bonjour, équipe {{公司名}},\n'
      + '\n'
      + 'Nous sommes un fabricant chinois de serrures et de quincaillerie de porte, '
      + 'avec 12 ans d\u2019expérience OEM. Nous fournissons {{产品}} aux distributeurs '
      + 'et aux quincailleries en {{国家}} et dans le monde entier — serrures à mortaiser, '
      + 'poignées, cylindres et charnières.\n'
      + '\n'
      + 'Pourriez-vous nous indiquer vos gammes principales et vos quantités habituelles ? '
      + 'Nous vous enverrons notre catalogue avec nos meilleurs prix pour votre marché.\n'
      + '\n'
      + 'Cordialement,\n'
      + '[Your Company Name]\n'
      + 'WhatsApp : [Your WhatsApp Number]',
  },
];

function listTemplates() {
  return all('SELECT * FROM letter_templates ORDER BY id ASC');
}

function getTemplate(id) {
  if (id == null) return null;
  const row = get('SELECT * FROM letter_templates WHERE id=?', Number(id));
  return row || null;
}

function normalizeLang(lang) {
  return lang === 'fr' ? 'fr' : 'en'; // 只允许 en/fr，其他值按 en 存
}

function requireText(value, label) {
  const s = value == null ? '' : String(value).trim();
  if (!s) throw new Error(label + '不能为空。');
  return s;
}

/**
 * 新建或更新模板：id 为空新建（写 created_at/updated_at），有 id 则更新
 * （刷新 updated_at；id 不存在时抛错）。返回保存后的模板行。
 */
function saveTemplate({ id, name, lang, subject, body }) {
  const n = requireText(name, '模板名称');
  const s = requireText(subject, '邮件主题');
  const b = requireText(body, '邮件正文');
  const l = normalizeLang(lang);
  const t = now();
  if (id != null && id !== '') {
    const existing = getTemplate(id);
    if (!existing) throw new Error('模板不存在，无法更新。');
    run('UPDATE letter_templates SET name=?, lang=?, subject=?, body=?, updated_at=? WHERE id=?',
      n, l, s, b, t, Number(id));
    return getTemplate(id);
  }
  const r = run('INSERT INTO letter_templates(name,lang,subject,body,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    n, l, s, b, t, t);
  return getTemplate(Number(r.lastInsertRowid));
}

function deleteTemplate(id) {
  const r = run('DELETE FROM letter_templates WHERE id=?', Number(id));
  return r.changes > 0;
}

/** 首次调用时若表为空，写入两条默认模板（英文 + 法文通用开发信）；幂等，返回全量模板。 */
function ensureDefaults() {
  const count = get('SELECT COUNT(*) c FROM letter_templates').c;
  if (Number(count) === 0) {
    for (const t of DEFAULT_TEMPLATES) {
      const ts = now();
      run('INSERT INTO letter_templates(name,lang,subject,body,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        t.name, t.lang, t.subject, t.body, ts, ts);
    }
  }
  return listTemplates();
}

function resolveTemplate(template) {
  if (template == null) throw new Error('模板不存在。');
  if (typeof template === 'number' || typeof template === 'string') {
    const row = getTemplate(template);
    if (!row) throw new Error('模板不存在。');
    return row;
  }
  return template;
}

function resolveLead(lead) {
  if (lead == null) return {};
  if (typeof lead === 'number' || typeof lead === 'string') {
    const row = get('SELECT * FROM leads WHERE id=?', Number(lead));
    if (!row) return {};
    const contact = getLeadContact(Number(lead));
    return { ...row, phone: row.phone || contact.phone, website: row.website || contact.website };
  }
  return lead;
}

function fillPlaceholders(text, values) {
  let out = String(text == null ? '' : text);
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp('\\{\\{\\s*' + key + '\\s*\\}\\}', 'g');
    out = out.replace(re, value);
  }
  return out;
}

/**
 * 渲染模板：把 {{公司名}} {{国家}} {{产品}} {{联系人}} {{电话}} {{网址}}
 * 替换为 lead 字段（lead 里没有的取 ''；{{产品}} 默认取 'door locks & hardware'，
 * 法文模板默认取 'serrures et quincaillerie de porte'）。
 * 返回 { subject, body }。
 */
function renderTemplate(template, lead) {
  const tpl = resolveTemplate(template);
  const ld = resolveLead(lead);
  const isFr = String(tpl.lang || 'en').toLowerCase() === 'fr';
  const values = {
    '公司名': ld.company_name ? String(ld.company_name) : '',
    '国家': ld.country ? String(ld.country) : '',
    '产品': ld.product || ld.product_hint
      ? String(ld.product || ld.product_hint)
      : (isFr ? DEFAULT_PRODUCT_FR : DEFAULT_PRODUCT_EN),
    '联系人': ld.contact_name ? String(ld.contact_name) : '',
    '电话': ld.phone ? String(ld.phone) : '',
    '网址': ld.website ? String(ld.website) : '',
  };
  return {
    subject: fillPlaceholders(tpl.subject || '', values),
    body: fillPlaceholders(tpl.body || '', values),
  };
}

/**
 * 读线索联系方式：读 evidence 表，返回 { phone, website, email }。
 * email 证据 field='email' 若有则取最新一条；没有则 ''。
 */
function getLeadContact(leadId) {
  const out = { phone: '', website: '', email: '' };
  if (leadId == null) return out;
  const rows = all(
    "SELECT field, value FROM evidence WHERE lead_id=? AND field IN ('phone','website','email') ORDER BY id DESC",
    Number(leadId)
  );
  for (const r of rows) {
    const field = String(r.field || '');
    if (field in out && !out[field] && r.value != null && String(r.value).trim() !== '') {
      out[field] = String(r.value);
    }
  }
  return out;
}

/**
 * 写一条发送记录（“标记已发送”调这个）。channel 只允许 'email'/'whatsapp'，
 * status 默认 'sent'。返回写入的记录行。
 */
function recordSend({ leadId, templateId, channel, subject, body, status }) {
  if (leadId == null || leadId === '') throw new Error('线索不存在，无法记录发送。');
  const lead = get('SELECT id FROM leads WHERE id=?', Number(leadId));
  if (!lead) throw new Error('线索不存在，无法记录发送。');
  const ch = String(channel || '').trim().toLowerCase();
  if (ch !== 'email' && ch !== 'whatsapp') {
    throw new Error('发送渠道只支持 email 或 whatsapp。');
  }
  const st = status == null || String(status).trim() === '' ? 'sent' : String(status).trim();
  const r = run(
    'INSERT INTO send_records(lead_id,template_id,channel,subject,body,status,created_at) VALUES(?,?,?,?,?,?,?)',
    Number(leadId), templateId != null && templateId !== '' ? Number(templateId) : null,
    ch, subject == null ? '' : String(subject), body == null ? '' : String(body), st, now()
  );
  return get('SELECT * FROM send_records WHERE id=?', Number(r.lastInsertRowid));
}

function listSendRecords(leadId, limit = 20) {
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  if (leadId == null || leadId === '') {
    return all('SELECT * FROM send_records ORDER BY id DESC LIMIT ?', n);
  }
  return all('SELECT * FROM send_records WHERE lead_id=? ORDER BY id DESC LIMIT ?', Number(leadId), n);
}

module.exports = {
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  ensureDefaults,
  renderTemplate,
  getLeadContact,
  recordSend,
  listSendRecords,
  DEFAULT_TEMPLATES,
};
