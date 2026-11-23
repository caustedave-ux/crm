'use strict';
// 自测：WhatsApp 收件箱未读、客户匹配、跟进同步和手工记录保护。
process.env.CRM_DB = process.env.CRM_DB || require('path').join(require('os').tmpdir(), 'crm-wa-inbox-test.db');

const { run, get, all } = require('../src/db');
const { nowStr, todayStr, addDays } = require('../src/util');
const wa = require('../src/wa');
const pagesWa = require('../src/views/pages_wa');

let bad = 0;
function eq(actual, expect, name) {
  if (String(actual) !== String(expect)) { bad++; console.log('  ✗ ' + name + '：期望 ' + expect + '，实际 ' + actual); }
  else console.log('  ✓ ' + name + ' = ' + actual);
}

let user = get("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1") || get('SELECT * FROM users ORDER BY id LIMIT 1');
if (!user) {
  run("INSERT INTO users(id,username,password_hash,display_name,role,active,created_at) VALUES(9001,'wa-test','x','WA Test','admin',1,?)", nowStr());
  user = get('SELECT * FROM users WHERE id=9001');
}
const acc = wa.ensureAccount(user.id);
const phone = '2348099998877';
const jid = phone + '@s.whatsapp.net';
const t = nowStr();

console.log('=== 0. 会话列表未读优先 ===');
const inboxOrder = [
  { id: 1, unread: 0, last_msg_at: '2026-11-19 12:00:00' },
  { id: 2, unread: 2, last_msg_at: '2026-11-19 09:00:00' },
  { id: 3, unread: 1, last_msg_at: '2026-11-19 11:00:00' },
  { id: 4, unread: 0, last_msg_at: '2026-11-19 13:00:00' }
].sort(pagesWa.compareInboxChats);
eq(inboxOrder.map(row => row.id).join(','), '3,2,4,1', '未读在前，未读内按最新消息排序');

for (const id of [9994, 9995, 9996, 9997, 9998]) {
  run('DELETE FROM activities WHERE customer_id=?', id);
  run('DELETE FROM wa_imports WHERE customer_id=?', id);
  run('DELETE FROM contacts WHERE customer_id=?', id);
  run('DELETE FROM customers WHERE id=?', id);
}
run('DELETE FROM wa_messages WHERE account_id=? AND chat_jid=?', acc.id, jid);
run('DELETE FROM wa_chats WHERE account_id=? AND jid=?', acc.id, jid);
run("DELETE FROM settings WHERE key='wa_auto_followup_day'");
run('INSERT INTO customers(id,user_id,company_name,country,whatsapp,phone,created_at,updated_at) VALUES(9998,?,?,?,?,?,?,?)',
  user.id, 'WA Inbox Test Co', '尼日利亚 Nigeria', '+' + phone, '+' + phone, t, t);

const msg = {
  key: { remoteJid: jid, id: 'wa-inbox-live-1', fromMe: false },
  message: { conversation: 'Please quote 3000 pcs' },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'WA Tester',
};

console.log('=== 1. 实时消息与未读 ===');
const mid = wa.storeMessage(acc.id, msg, { live: true, markUnread: true, autoTranslate: false });
eq(!!mid, true, '消息已落库');
let chat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, jid);
eq(chat.unread, 1, '未读 +1');
eq(chat.customer_id, 9998, '按号码自动绑定客户');

wa.storeMessage(acc.id, msg, { live: true, markUnread: true, autoTranslate: false });
chat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, jid);
eq(chat.unread, 1, '重复消息不重复计未读');

console.log('\n=== 2. 打开会话清除未读 ===');
wa.markChatRead(chat.id);
eq(get('SELECT unread FROM wa_chats WHERE id=?', chat.id).unread, 0, '打开后未读归零');

console.log('\n=== 3. 自动同步跟进且不删手工记录 ===');
const manualId = Number(run("INSERT INTO activities(customer_id,type,subject,content,activity_date,images,created_by,user_id,created_at,priority,outcome) VALUES(?,?,?,?,?,'[]',?,?,?,?,?)",
  9998, '电话', '手工记录', '不能丢', t, user.username, user.id, t, '中', '').lastInsertRowid);
const synced = wa.syncChatFollowup(chat.id, true);
eq(synced.ok, true, '同步成功');
eq(synced.followupScheduled, true, '当天有聊天已触发自动跟进');
const acts = all('SELECT id,type,subject FROM activities WHERE customer_id=9998 ORDER BY id');
eq(synced.mergedToday, true, '当天聊天已覆盖当天手工记录');
eq(acts.length, 1, '不再额外生成重复的 WhatsApp 跟进');
eq(acts.some(a => Number(a.id) === manualId), true, '手工记录本身仍然存在');
const mergedManual = get('SELECT * FROM activities WHERE id=?', manualId);
eq(mergedManual.subject.indexOf('WhatsApp 聊天记录') === 0, true, '手工记录已更新为当天实际聊天');
eq(mergedManual.content.includes('不能丢'), true, '原手工记录内容仍被保留');
eq(mergedManual.next_follow_date, addDays(todayStr(), 3), '覆盖后的跟进自动安排3天后');
eq(mergedManual.outcome, '当天已通过 WhatsApp 沟通', '覆盖后的跟进标记当天已沟通');

console.log('\n=== 4. 本人发送清除未读 ===');
run('UPDATE wa_chats SET unread=3 WHERE id=?', chat.id);
wa.storeMessage(acc.id, {
  key: { remoteJid: jid, id: 'wa-inbox-out-1', fromMe: true },
  message: { conversation: 'Sure, checking now' },
  messageTimestamp: Math.floor(Date.now() / 1000) + 1,
}, { live: true, autoTranslate: false });
eq(get('SELECT unread FROM wa_chats WHERE id=?', chat.id).unread, 0, '发送后未读归零');

console.log('\n=== 5. 客户自动绑定隔离 ===');
run("INSERT INTO users(id,username,password_hash,display_name,role,active,created_at) VALUES(9002,'wa-test-other','x','WA Other','staff',1,?) ON CONFLICT(username) DO NOTHING", t);
const otherUser = get('SELECT * FROM users WHERE id=9002 OR username=? ORDER BY CASE WHEN id=9002 THEN 0 ELSE 1 END LIMIT 1', 'wa-test-other');
const privatePhone = '2348011112222';
const privateJid = privatePhone + '@s.whatsapp.net';
run('DELETE FROM wa_messages WHERE account_id=? AND chat_jid=?', acc.id, privateJid);
run('DELETE FROM wa_chats WHERE account_id=? AND jid=?', acc.id, privateJid);
run('INSERT INTO customers(id,user_id,company_name,country,whatsapp,phone,created_at,updated_at) VALUES(9997,?,?,?,?,?,?,?)',
  otherUser.id, 'Other User Private Co', '尼日利亚 Nigeria', '+' + privatePhone, '+' + privatePhone, t, t);
wa.storeMessage(acc.id, {
  key: { remoteJid: privateJid, id: 'wa-inbox-private-1', fromMe: false },
  message: { conversation: 'Private customer test' },
  messageTimestamp: Math.floor(Date.now() / 1000) + 2,
  pushName: 'Private Tester',
}, { live: true, markUnread: true, autoTranslate: false });
const privateChat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, privateJid);
eq(privateChat.customer_id, null, '不会绑定其他业务员的私有客户');

const poolPhone = '2348022223333';
const poolJid = poolPhone + '@s.whatsapp.net';
run('DELETE FROM wa_messages WHERE account_id=? AND chat_jid=?', acc.id, poolJid);
run('DELETE FROM wa_chats WHERE account_id=? AND jid=?', acc.id, poolJid);
run('INSERT INTO customers(id,user_id,company_name,country,whatsapp,phone,in_pool,pool_at,created_at,updated_at) VALUES(9996,?,?,?,?,?,1,?,?,?)',
  otherUser.id, 'Public Pool Co', '尼日利亚 Nigeria', '+' + poolPhone, '+' + poolPhone, t, t, t);
wa.storeMessage(acc.id, {
  key: { remoteJid: poolJid, id: 'wa-inbox-pool-1', fromMe: false },
  message: { conversation: 'Public pool customer test' },
  messageTimestamp: Math.floor(Date.now() / 1000) + 3,
  pushName: 'Pool Tester',
}, { live: true, markUnread: true, autoTranslate: false });
const poolChat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, poolJid);
eq(poolChat.customer_id, 9996, '公共池客户仍可按号码匹配');

console.log('\n=== 6. WhatsApp 当天聊天统一第3天跟进 ===');
run('INSERT INTO customers(id,user_id,company_name,country,whatsapp,phone,created_at,updated_at) VALUES(9995,?,?,?,?,?,?,?)',
  user.id, 'WA Followup Test Co', '尼日利亚 Nigeria', '+2348000000000', '+2348000000000', t, t);
const scheduled = wa.scheduleWhatsAppFollowup(9995, 'Follow Tester', user, 3);
eq(scheduled.ok, true, '自动跟进已创建');
eq(scheduled.followDate, addDays(todayStr(), 3), '跟进日期为当天加3天');
let scheduledRow = get("SELECT * FROM activities WHERE customer_id=9995 AND type='WhatsApp' AND subject='WhatsApp 会话跟进'");
eq(scheduledRow.next_follow_date, addDays(todayStr(), 3), '跟进表保存第3天日期');
eq(scheduledRow.archived, 0, '自动跟进未归档');
eq(scheduledRow.user_id, user.id, '自动跟进归属当前账号');
run('UPDATE activities SET next_follow_date=? WHERE id=?', '2030-01-01', scheduledRow.id);
const scheduledAgain = wa.scheduleWhatsAppFollowup(9995, 'Follow Tester', user, 3);
eq(scheduledAgain.created, false, '再次聊天复用同一条未完成跟进');
eq(get('SELECT COUNT(*) AS n FROM activities WHERE customer_id=9995').n, 1, '同一客户只有一条未完成自动跟进');
eq(get('SELECT next_follow_date FROM activities WHERE customer_id=9995').next_follow_date, addDays(todayStr(), 3), '再次聊天重新设为当天加3天');
const backfilled = wa.ensureTodayWhatsAppFollowups();
eq(backfilled.ok, true, '存量客户补偿执行成功');
const backfilledMerge = get("SELECT * FROM activities WHERE customer_id=9998 AND archived=0 AND subject LIKE 'WhatsApp 聊天记录%' ORDER BY id DESC LIMIT 1");
eq(backfilledMerge.next_follow_date, addDays(todayStr(), 3), '存量当天聊天客户已通过覆盖规则补第3天跟进');
eq(backfilledMerge.outcome, '当天已通过 WhatsApp 沟通', '存量合并记录已标记当天沟通');

console.log('\n=== 7. 图片/文件引用 ===');
const quotePhone = '2348033334444';
const quoteJid = quotePhone + '@s.whatsapp.net';
run('DELETE FROM wa_messages WHERE account_id=? AND chat_jid=?', acc.id, quoteJid);
run('DELETE FROM wa_chats WHERE account_id=? AND jid=?', acc.id, quoteJid);

const imageId = 'wa-quote-original-image';
const imageRowId = wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: imageId, fromMe: false },
  message: { imageMessage: { caption: 'Reference photo', mimetype: 'image/jpeg' } },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'Quote Tester',
}, { live: true, autoTranslate: false });
run("UPDATE wa_messages SET media_mime='image/jpeg', media_path='/uploads/wa/test-quote-image.jpg' WHERE id=?", imageRowId);
const imageRow = get('SELECT * FROM wa_messages WHERE id=?', imageRowId);
eq(imageRow.kind, 'image', '图片原消息已保存');

const imageQuoteRowId = wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: 'wa-quote-image-reply', fromMe: false },
  message: { extendedTextMessage: {
    text: 'Use this image please',
    contextInfo: {
      stanzaId: imageId,
      participant: quoteJid,
      quotedMessage: { imageMessage: { caption: 'Reference photo', mimetype: 'image/jpeg' } },
    },
  } },
  messageTimestamp: Math.floor(Date.now() / 1000) + 1,
  pushName: 'Quote Tester',
}, { live: true, autoTranslate: false });
const imageQuoteRow = get('SELECT * FROM wa_messages WHERE id=?', imageQuoteRowId);
eq(imageQuoteRow.quoted_msg_id, imageId, '客户引用图片的关系已保存');
eq(JSON.parse(imageQuoteRow.quoted_preview).kind, 'image', '图片引用预览类型正确');
const builtImage = wa.buildQuotedMessage(imageRow);
eq(builtImage.message.imageMessage.mimetype, 'image/jpeg', '图片引用可还原为 WhatsApp 原生对象');

const fileId = 'wa-quote-original-file';
const fileRowId = wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: fileId, fromMe: false },
  message: { documentMessage: { fileName: 'price-list.pdf', mimetype: 'application/pdf' } },
  messageTimestamp: Math.floor(Date.now() / 1000) + 2,
  pushName: 'Quote Tester',
}, { live: true, autoTranslate: false });
run("UPDATE wa_messages SET media_mime='application/pdf' WHERE id=?", fileRowId);
const fileRow = get('SELECT * FROM wa_messages WHERE id=?', fileRowId);
const fileQuoteRowId = wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: 'wa-quote-file-reply', fromMe: false },
  message: { imageMessage: {
    caption: 'Quote this price list',
    mimetype: 'image/jpeg',
    contextInfo: {
      stanzaId: fileId,
      participant: quoteJid,
      quotedMessage: { documentMessage: { fileName: 'price-list.pdf', mimetype: 'application/pdf' } },
    },
  } },
  messageTimestamp: Math.floor(Date.now() / 1000) + 3,
  pushName: 'Quote Tester',
}, { live: true, autoTranslate: false });
const fileQuoteRow = get('SELECT * FROM wa_messages WHERE id=?', fileQuoteRowId);
eq(fileQuoteRow.quoted_msg_id, fileId, '客户引用文件的关系已保存');
eq(JSON.parse(fileQuoteRow.quoted_preview).mediaName, 'price-list.pdf', '文件引用预览保留文件名');
const builtFile = wa.buildQuotedMessage(fileRow);
eq(builtFile.message.documentMessage.fileName, 'price-list.pdf', '文件引用可还原为 WhatsApp 原生对象');

const builtText = wa.buildQuotedMessage({
  msg_id: 'text-row', chat_jid: quoteJid, from_me: 0, kind: 'text', text: 'Original text',
  sender_jid: quoteJid, sender_name: 'Quote Tester', ts: nowStr(),
});
eq(builtText.message.conversation, 'Original text', '文本引用仍可正常还原');

console.log('\n=== 8. 会话页引用入口 ===');
const { sessionPage, classifyWaChat } = require('../src/views/pages_wa');
const overdueDate = addDays(todayStr(), -4);
const plannedDate = addDays(todayStr(), 3);
run(`INSERT INTO activities(customer_id,type,subject,content,activity_date,next_follow_date,created_by,user_id,created_at,priority,archived)
  VALUES(?,?,?,?,?,?,?,?,?,?,0)`, 9998, 'WhatsApp', '测试逾期提醒', '', t, overdueDate, user.username, user.id, t, '中');
run(`INSERT INTO activities(customer_id,type,subject,content,activity_date,next_follow_date,created_by,user_id,created_at,priority,archived)
  VALUES(?,?,?,?,?,?,?,?,?,?,0)`, 9998, 'WhatsApp', '测试未来计划', '', t, plannedDate, user.username, user.id, t, '中');
const html = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(html.includes('<span>下次跟进</span><b class="">' + plannedDate + '</b>'), true, '侧栏优先显示未来跟进计划，不让较早逾期项冒充下次计划');
eq(get("SELECT next_follow_date FROM activities WHERE customer_id=9998 AND subject='测试逾期提醒'").next_follow_date, overdueDate, '修正显示时保留逾期跟进数据');
const sideDocId = Number(run(`INSERT INTO documents(user_id,doc_no,doc_type,customer_id,title,issue_date,currency,total_amount,status,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`, user.id, 'PI-WA-SIDEBAR-TEST', 'pi', 9998, 'Sidebar Test PI', todayStr(), 'USD', 123.45, '草稿', t, t).lastInsertRowid);
const sideDocHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(sideDocHtml.includes('/documents/' + sideDocId) && sideDocHtml.includes('PI-WA-SIDEBAR-TEST'), true, '客户侧栏显示并链接客户单据');
eq(sideDocHtml.includes('自动同步按天幂等写入'), false, '客户侧栏移除自动同步规则说明');
run('DELETE FROM documents WHERE id=?', sideDocId);
eq(html.includes('wa-quote-btn'), true, '每条消息渲染引用按钮');
eq(html.includes('id="waQuoteBar"'), true, '输入区渲染引用预览条');
eq(html.includes('name="quote_id"'), true, '发送表单携带引用消息 ID');
eq(html.includes("closest('.wa-quote-btn')"), true, '点击委托已绑定图片/文件引用');
eq(html.includes('id="waAttachmentPreview"'), true, '输入区渲染待发送附件预览');
eq(html.includes('id="waAttachment"') && html.includes('multiple>'), true, '附件选择器支持多选');
eq(html.includes('attachmentFiles') && html.includes('MAX_ATTACHMENTS'), true, '前端维护多附件队列与数量上限');
eq(html.includes("addEventListener('paste'") && html.includes('clipboardFiles'), true, '输入框支持一次粘贴多个文件');
eq(html.includes('data-attachment-remove'), true, '每个附件可单独移除');
eq(html.includes('pendingPastedFile'), false, '旧版单附件状态已移除');
eq(html.includes("payload.append('attachment'"), true, '多个附件使用 multipart 批量提交');
eq(html.includes('makeAttachmentBatches') && html.includes('/whatsapp/send-batch'), true, '多附件按安全大小分批并发发送');
const unboundHtml = sessionPage({ query: { chat: String(privateChat.id) }, user, flash: () => [] });
eq(unboundHtml.includes('创建当天加 3 天'), true, '新建客户表单提示第3天跟进规则');
eq(html.includes('remainingFiles') && html.includes('remainingFiles = files.filter'), true, '失败后按实际结果仅保留尚未发送的附件');
eq(html.includes('captureChatScroll') && html.includes('restoreChatScroll'), true, '切换会话时保存并恢复滚动位置');
eq(html.includes('keepActiveChatVisible') && html.includes('list.scrollTop = state.listTop'), true, '当前点击的会话保持在列表可视区域');
eq(html.includes('data-inbox-last-id='), true, '收件箱带有全局消息游标');
eq(html.includes('inbox_changed') && html.includes('visibilitychange'), true, '全收件箱轮询并支持切回页面立即刷新');
eq(html.includes('/api/wa/poll?inbox_after='), true, '没有选中会话时也会检查新消息');
eq(html.includes('messagesAtBottom') && html.includes('preserveMessages && !state.messagesAtBottom'), true, '聊天内容刷新时保持历史阅读位置且底部继续跟随新消息');
const fs = require('fs');
const sourcePath = require('path').join(__dirname, '..');
const waSource = fs.readFileSync(require('path').join(sourcePath, 'src/wa.js'), 'utf8');
const waPageSource = fs.readFileSync(require('path').join(sourcePath, 'src/views/pages_wa.js'), 'utf8');
eq(waSource.includes('liveCustomerMessage') && waSource.includes("eventType === 'notify'") && waSource.includes('ownCopy'), true, '只统计实时客户消息的解密失败');
eq(waPageSource.includes('if (receiveBroken)') && waPageSource.includes('无需重新扫码'), true, '已有成功来信时不显示退出登录告警');
eq(waPageSource.includes('receiveBroken || Number(v.decryptFailures || 0) > 0'), false, '已移除任何单次失败都触发重新扫码的旧逻辑');
const quoteChat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, quoteJid);
const quotedHtml = sessionPage({ query: { chat: String(quoteChat.id) }, user, flash: () => [] });
eq(quotedHtml.includes('class="wa-quote-jump"'), true, '引用卡片可点击跳转');
eq(quotedHtml.includes('data-quote-target-id="' + imageRowId + '"'), true, '引用卡片携带原消息定位标识');
eq(quotedHtml.includes('id="wa-msg-' + imageRowId + '"'), true, '原消息渲染独立定位锚点');
eq(quotedHtml.includes('href="/uploads/wa/test-quote-image.jpg"'), true, '引用图片链接指向原图');
eq(quotedHtml.includes('class="wa-quote-media-open"'), true, '引用图片保留独立打开入口');
eq(quotedHtml.includes('target="_blank"'), true, '原图在新窗口打开');
eq(quotedHtml.includes('jumpToQuotedMessage') && quotedHtml.includes("closest('.wa-quote-jump')"), true, '点击引用自动滚动到原消息');
eq(quotedHtml.includes('wa-message-jump-flash'), true, '跳转后原消息短暂高亮');

console.log('\n=== 9. WhatsApp 分类入口移除 ===');
run("UPDATE wa_chats SET manual_category='新询盘', manual_category_at=? WHERE id=?", t, chat.id);
const categoryHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(categoryHtml.includes('wa-filter-new'), false, '不再显示新询盘分类筛选');
eq(categoryHtml.includes('wa-filter-following'), false, '不再显示跟进中分类筛选');
eq(categoryHtml.includes('wa-filter-won'), false, '不再显示已成交分类筛选');
eq(categoryHtml.includes('wa-filter-lost'), false, '不再显示已流失分类筛选');
eq(categoryHtml.includes('class="wa-category-tag"'), false, '会话列表不再显示分类标签');
eq(categoryHtml.includes('action="/whatsapp/chat/' + chat.id + '/category"'), false, '会话侧栏不再显示分类编辑器');
const cssSource = fs.readFileSync(require('path').join(sourcePath, 'static/css/style.css'), 'utf8');
console.log('\n=== 9a. WhatsApp 工作台真实三栏布局 ===');
eq(quotedHtml.includes('wa-workbench-metrics') && quotedHtml.includes('今日客户消息'), true, '工作台顶部指标从当前 CRM / WhatsApp 数据生成');
eq(quotedHtml.includes('data-wa-main-tab="chat"') && quotedHtml.includes('data-wa-main-tab="customer"') && quotedHtml.includes('data-wa-main-tab="followups"') && quotedHtml.includes('data-wa-main-tab="files"') && quotedHtml.includes('data-wa-main-tab="orders"'), true, '中间会话区提供真实业务标签');
eq(quotedHtml.includes('data-wa-ai-tab="reply"') && quotedHtml.includes('data-wa-ai-tab="knowledge"') && !quotedHtml.includes('data-wa-ai-tab="translate"') && !quotedHtml.includes('data-wa-ai-tab="phrases"'), true, '右侧 AI 助手只留智能回复和知识检索两个标签');
eq(quotedHtml.includes('id="waComposeTranslateBtn"') && quotedHtml.includes('id="waComposePhrasesBtn"') && quotedHtml.includes('id="waComposeTranslatePanel"') && quotedHtml.includes('id="waComposePhrasesPanel"'), true, '翻译和快捷短语已搬到输入区附件边上');
eq((quotedHtml.match(/id="waAiDraft"/g) || []).length, 1, 'AI 起草按钮只保留一份并连接现有 API');
eq((quotedHtml.match(/id="waAiTranslate"/g) || []).length, 1, 'AI 翻译按钮只保留一份并连接现有 API');
eq(quotedHtml.includes('role="tab" aria-selected="true" class="active" data-wa-ai-tab="reply"') && quotedHtml.includes('role="tabpanel" data-wa-ai-panel="knowledge" hidden'), true, 'AI 工具页签具备初始选中和面板可访问状态');
eq(quotedHtml.includes('提供款式 2 和 3 的工艺细节'), false, '移除截图里的虚构客户示例');
eq(quotedHtml.includes('AI 回复建议（英文）'), false, '移除截图里的静态 AI 回复示例');
eq(cssSource.includes('.wa-inbox.wa-3col{display:grid;grid-template-columns:'), true, '桌面 WhatsApp 工作台使用固定三栏网格');
eq(cssSource.includes('grid-template-columns:minmax(245px,.22fr) minmax(430px,.43fr) minmax(330px,.35fr)'), true, '三栏按截图扩大右侧 AI 助手的可用宽度');
eq(cssSource.includes('body.page-wa .wa-inbox.wa-3col { grid-template-columns:'), true, '桌面三栏比例覆盖通用工作台断点规则');
eq(cssSource.includes('.wa-compose .d-flex.align-items-end>button{flex:0 0 auto;white-space:nowrap;}'), true, '聊天发送按钮保持横向完整显示');
const waKnowledgeId = Number(run(`INSERT INTO knowledge_articles(title,category,tags,content,created_by,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`, 'Door lock MOQ reference', '报价政策', 'door lock, MOQ, FOB', 'MOQ depends on model; confirm the target quantity.', user.id, t, t).lastInsertRowid);
wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: 'wa-ai-kb-match', fromMe: false },
  message: { conversation: 'Please quote door lock FOB for MOQ 500.' },
  messageTimestamp: Math.floor(Date.now() / 1000) + 30,
  pushName: 'Quote Tester',
}, { live: true, autoTranslate: false });
const aiKnowledgeHtml = sessionPage({ query: { chat: String(quoteChat.id) }, user, flash: () => [] });
eq(aiKnowledgeHtml.includes('data-wa-ai-panel="knowledge"') && aiKnowledgeHtml.includes('/knowledge?article=' + waKnowledgeId), true, '知识检索展示匹配文章并链接来源');
eq(aiKnowledgeHtml.includes('class="wa-ai-inline-knowledge"') && aiKnowledgeHtml.includes('/knowledge?article=' + waKnowledgeId), true, '智能回复页同时展示真实知识来源');
run("UPDATE wa_chats SET manual_category='', manual_category_at='' WHERE id=?", chat.id);

console.log('\n=== 10. 图片下载完成后自动刷新 ===');
const pendingImageId = wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: 'wa-pending-image', fromMe: false },
  message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
  messageTimestamp: Math.floor(Date.now() / 1000) + 10,
  pushName: 'Quote Tester',
}, { autoTranslate: false });
eq(!!pendingImageId, true, '缺图消息正常落库');
const pendingHtml = sessionPage({ query: { chat: String(quoteChat.id) }, user, flash: () => [] });
eq(pendingHtml.includes('图片正在保存，完成后会自动显示'), true, '下载中显示等待提示而不是要求客户重发');
eq(pendingHtml.includes('data-media-saved="1"'), true, '页面记录已保存媒体数量');
eq(pendingHtml.includes('&media_saved=') && pendingHtml.includes('d.media_changed'), true, '前端轮询媒体保存状态');
const routesSource = fs.readFileSync(require('path').join(sourcePath, 'src/routes.js'), 'utf8');
eq(routesSource.includes('media_changed: !!chat && hasMediaCursor && mediaSaved !== mediaSavedAfter'), true, '轮询接口检测媒体落盘变化');

console.log('\n=== 11. 会话置顶 ===');
run("UPDATE wa_chats SET pinned_at='' WHERE account_id=?", acc.id);
run('UPDATE wa_chats SET pinned_at=? WHERE id=?', t, chat.id);
run('UPDATE wa_chats SET pinned_at=? WHERE id=?', '2026-01-01 00:00:00', quoteChat.id);
run('UPDATE wa_chats SET unread=2 WHERE id IN (?,?,?)', chat.id, quoteChat.id, privateChat.id);
const unreadWithoutPinned = sessionPage({ query: { filter: 'unread' }, user, flash: () => [] });
eq(unreadWithoutPinned.includes('data-chat-id="' + chat.id + '"'), false, '未读筛选排除置顶会话');
eq(unreadWithoutPinned.includes('data-chat-id="' + quoteChat.id + '"'), false, '未读筛选排除其他置顶会话');
eq(unreadWithoutPinned.includes('data-chat-id="' + privateChat.id + '"'), true, '未读筛选仍显示未置顶会话');
eq(get('SELECT pinned_at FROM wa_chats WHERE id=?', chat.id).pinned_at, t, '置顶时间写入数据库');
eq(get('SELECT pinned_at FROM wa_chats WHERE id=?', quoteChat.id).pinned_at, '2026-01-01 00:00:00', '第二个会话也能独立置顶');
const pinHtml = sessionPage({ query: { chat: String(chat.id), filter: 'pinned' }, user, flash: () => [] });
eq((pinHtml.match(/class="wa-chat-item [^"]*is-pinned/g) || []).length >= 2, true, '多个置顶会话同时打上置顶标记');
eq(pinHtml.includes('class="wa-pin-group-label"') && pinHtml.includes('置顶会话'), true, '置顶会话独立分组显示');
eq(pinHtml.includes('class="wa-pin-badge"'), true, '置顶会话显示明确标签');
eq(pinHtml.includes('action="/whatsapp/chat/' + chat.id + '/pin"'), true, '列表提供置顶开关');
eq(pinHtml.includes('name="pin" value="0"'), true, '已置顶时按钮提交取消置顶');
eq(pinHtml.includes('title="取消置顶"') && pinHtml.includes('已置顶'), true, '会话头部显示已置顶状态');
const pinPos = pinHtml.indexOf('/whatsapp/session?chat=' + chat.id + '&amp;filter=pinned');
const otherPinPos = pinHtml.indexOf('/whatsapp/session?chat=' + quoteChat.id + '&amp;filter=pinned');
eq(pinPos >= 0 && otherPinPos >= 0 && pinPos < otherPinPos, true, '置顶栏按置顶时间排列多个置顶会话');
const allWithPinnedHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq((allWithPinnedHtml.match(/class="wa-chat-item [^"]*is-pinned/g) || []).length, 0, '全部筛选不显示置顶会话');
eq(allWithPinnedHtml.includes('class="wa-chat-item '), true, '全部筛选仍显示普通会话');

const pinnedOnly = sessionPage({ query: { filter: 'pinned' }, user, flash: () => [] });
eq((pinnedOnly.match(/class="wa-chat-item [^"]*is-pinned/g) || []).length, 2, '置顶筛选显示全部置顶会话');
eq(pinnedOnly.includes('置顶 2'), true, '筛选标签显示多个置顶数量');
run("UPDATE wa_chats SET pinned_at='' WHERE account_id=?", acc.id);
const unpinnedHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(unpinnedHtml.includes('is-pinned'), false, '取消置顶后移除置顶标记');
eq(unpinnedHtml.includes('name="pin" value="1"'), true, '未置顶时按钮提交置顶');
eq(routesSource.includes("router.post('/whatsapp/chat/:id/pin'"), true, '置顶路由已注册');

console.log('\n=== 12. WhatsApp 会话备注 ===');
const remarkText = '客户只接受 T/T，下次联系发送门锁报价';
run('UPDATE wa_chats SET remark=?, remark_updated_at=? WHERE id=?', remarkText, t, chat.id);
const remarkHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(get('SELECT remark FROM wa_chats WHERE id=?', chat.id).remark, remarkText, '会话备注写入数据库');
eq(remarkHtml.includes(remarkText), true, '聊天窗口显示会话备注');
eq(remarkHtml.includes('class="wa-note-strip has-note"'), true, '有备注时显示高亮备注栏');
eq(remarkHtml.includes('class="wa-note-tag"'), true, '左侧会话列表显示备注摘要');
eq(remarkHtml.includes('action="/whatsapp/chat/' + chat.id + '/remark"'), true, '会话窗口提供备注保存入口');
eq(remarkHtml.includes('name="remark"') && remarkHtml.includes('maxlength="2000"'), true, '备注编辑器限制最大长度');
eq(routesSource.includes("router.post('/whatsapp/chat/:id/remark'"), true, '会话备注路由已注册');
const remarkSearchHtml = sessionPage({ query: { q: '门锁报价' }, user, flash: () => [] });
eq(remarkSearchHtml.includes('/whatsapp/session?chat=' + chat.id), true, '会话备注内容支持搜索');
run("UPDATE wa_chats SET remark='', remark_updated_at='' WHERE id=?", chat.id);

console.log('\n=== 13. WhatsApp 会话左滑删除 ===');
const swipeHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(swipeHtml.includes('class="wa-chat-swipe"'), true, '会话行支持左滑容器');
eq(swipeHtml.includes('class="wa-swipe-delete"'), true, '左滑后提供删除操作');
eq(swipeHtml.includes('action="/whatsapp/chat/' + chat.id + '/delete"'), true, '删除按钮指向对应会话');
eq(swipeHtml.includes("addEventListener('pointerdown'") && swipeHtml.includes("addEventListener('pointermove'"), true, '前端绑定触摸和鼠标滑动事件');
eq(swipeHtml.includes('swipe-open') && swipeHtml.includes('SWIPE_DELETE_WIDTH'), true, '左滑超过阈值后展开删除按钮');
eq(swipeHtml.includes('手机 WhatsApp、客户档案、跟进记录和单据不会被删除'), true, '删除前明确提示不影响手机 WhatsApp和CRM记录');
eq(routesSource.includes("router.post('/whatsapp/chat/:id/delete'"), true, '会话删除路由已注册');
eq(routesSource.includes('DELETE FROM wa_messages WHERE account_id=? AND chat_jid=?'), true, '删除会话时清除本地聊天消息');
eq(routesSource.includes('DELETE FROM wa_chats WHERE id=?'), true, '删除会话时清除收件箱会话');

console.log('\n=== 14. 回复后保持当前会话筛选 ===');
const unreadChatHtml = sessionPage({ query: { chat: String(chat.id), filter: 'unread' }, user, flash: () => [] });
eq(unreadChatHtml.includes('loadChat(window.location.href, { push: false, saveDraft: false })'), true,
  '发送成功后沿用当前地址，保留未读筛选和搜索条件');
eq(unreadChatHtml.includes("loadChat('/whatsapp/session?chat=' + chatId, { push: false, saveDraft: false })"), false,
  '不再使用会重置筛选的固定会话地址');

console.log('\n=== 15. 铺满网页功能已取消 ===');
const fullscreenHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(fullscreenHtml.includes('document.documentElement.requestFullscreen'), false, '不再请求浏览器原生全屏');
eq(fullscreenHtml.includes('fullscreenchange'), false, '不再依赖原生全屏事件');
eq(fullscreenHtml.includes("document.body.classList.toggle('wa-focus-mode'"), false, '不再切换铺满布局');
eq(fullscreenHtml.includes("localStorage.getItem('crm_wa_fullscreen')"), false, '不再恢复铺满状态');
eq(fullscreenHtml.includes('waFullscreenBtn'), false, '页头不再有铺满网页按钮');
eq(fullscreenHtml.includes('铺满网页'), false, '页面上不再出现铺满网页字样');
eq(cssSource.includes('.wa-focus-bar'), false, '样式里不再有铺满横幅规则');
eq(cssSource.includes('wa-focus-mode'), false, '样式里不再有铺满模式规则');
eq(cssSource.includes('@media (min-width:992px)'), true, '桌面宽度下三栏使用铺满布局断点');
eq(cssSource.includes('.wa-inbox > div:first-child{flex:0 0 clamp(240px,17vw,340px)'), true, '会话栏按屏幕宽度自适应');
eq(cssSource.includes('.wa-inbox > #waCustomerPanel{flex:0 0 clamp(280px,20vw,380px)'), true, '客户与跟进栏按屏幕宽度自适应');
eq(cssSource.includes('.wa-inbox > div{margin-top:0;padding:0;}'), true, '三栏移除 Bootstrap 顶部间距并铺满高度');

console.log('\n=== 16. WhatsApp 新消息静默刷新 ===');
eq(html.includes('refreshInboxFromPoll') && html.includes('silent: true'), true, '新消息轮询使用静默刷新');
eq(html.includes('if (!options.silent) setLoading(true)'), true, '后台刷新不触发整区透明度闪烁');
eq(html.includes('composerOrFormBusy') && html.includes('deferredPollRefresh'), true, '输入或选择附件时延迟自动刷新');
eq(html.includes('restoreChatScroll(scrollState, next, preserveMessages, options.silent !== true)'), true, '静默刷新不强制跳动到当前会话');
eq(cssSource.includes('font-variant-numeric:tabular-nums'), true, '分类数量使用等宽数字避免宽度跳动');

console.log('\n=== 17. WhatsApp 语音播放器 ===');
const audioRowId = wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: 'wa-audio-card-test', fromMe: false },
  message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 12 } },
  messageTimestamp: Math.floor(Date.now() / 1000) + 20,
  pushName: 'Audio Tester',
}, { live: true, autoTranslate: false });
run("UPDATE wa_messages SET media_path='/uploads/wa/test-audio.ogg',media_mime='audio/ogg; codecs=opus' WHERE id=?", audioRowId);
const audioHtml = sessionPage({ query: { chat: String(quoteChat.id) }, user, flash: () => [] });
eq(audioHtml.includes('class="wa-voice-card"'), true, '语音消息渲染独立播放卡片');
eq(audioHtml.includes('class="wa-voice-audio"') && audioHtml.includes('/api/wa/media/' + audioRowId), true, '语音卡片包含可播放媒体地址');
eq(audioHtml.includes('下载语音'), true, '语音卡片提供下载备用入口');
const missingAudioId = wa.storeMessage(acc.id, {
  key: { remoteJid: quoteJid, id: 'wa-audio-missing-test', fromMe: false },
  message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 6 } },
  messageTimestamp: Math.floor(Date.now() / 1000) + 21,
  pushName: 'Audio Tester',
}, { live: true, autoTranslate: false });
const missingAudioHtml = sessionPage({ query: { chat: String(quoteChat.id) }, user, flash: () => [] });
eq(missingAudioHtml.includes('语音正在下载，完成后会自动显示播放器'), true, '未保存语音显示明确等待状态');

console.log('\n=== 18. WhatsApp 未读跳动提示 ===');
run('UPDATE wa_chats SET unread=0 WHERE account_id=?', acc.id);
run('UPDATE wa_chats SET unread=3 WHERE id=?', chat.id);
const bounceHtml = sessionPage({ query: { filter: 'unread' }, user, flash: () => [] });
eq(bounceHtml.includes('wa-chat-row') && bounceHtml.includes('unread-bounce'), true, '未读会话行显示跳动提示');
eq(bounceHtml.includes('未读 3') && bounceHtml.includes('unread-bounce'), true, '顶部未读筛选同步跳动');
eq(cssSource.includes('@keyframes waUnreadBounce'), true, '未读跳动动画已定义');
const readBounceHtml = sessionPage({ query: { chat: String(chat.id), filter: 'unread' }, user, flash: () => [] });
eq(get('SELECT unread FROM wa_chats WHERE id=?', chat.id).unread, 0, '打开会话后未读归零');
eq(readBounceHtml.includes('unread-bounce'), false, '已读后取消会话和顶部跳动');
eq(readBounceHtml.includes('未读 0'), true, '已读后顶部未读数量同步归零');

console.log('\n=== 19. WhatsApp 新消息声音提醒已移到系统设置 ===');
eq(html.includes('id="waSoundToggle"'), false, 'WhatsApp 页右上角不再放声音提醒按钮');
eq(html.includes('window.AudioContext') && html.includes('playWaNotification'), true, '使用浏览器音频生成提示音');
eq(html.includes('maybeNotifyIncoming') && html.includes('inboxLatestIncomingId'), true, '仅对新的客户来信触发声音');
eq(html.includes("localStorage.getItem('crm_wa_sound')"), true, 'WhatsApp 页只读声音开关状态');
eq(html.includes("localStorage.setItem('crm_wa_sound'"), false, 'WhatsApp 页不再写声音开关状态');
const waSettingsHtml = pagesWa.waSettingsCards({ user, flash: () => [] }).join('');
eq(waSettingsHtml.includes('id="waSoundSetting"'), true, '系统设置里有声音提醒开关');
eq(waSettingsHtml.includes("localStorage.setItem('crm_wa_sound'"), true, '系统设置开关拨动即保存');
eq(routesSource.includes('m.from_me=0') && routesSource.includes('inbox_incoming_changed'), true, '轮询接口区分客户来信和自己发送');

console.log('\n=== 20. 我方消息客户已读回执 ===');
eq(all('PRAGMA table_info(wa_messages)').some(col => col.name === 'receipt_status'), true, '消息表包含回执状态字段');
eq(all('PRAGMA table_info(wa_messages)').some(col => col.name === 'read_at'), true, '消息表包含客户读取时间字段');
const receiptMsgWaId = 'wa-customer-receipt-test-' + Date.now();
const receiptMsgRowId = wa.storeMessage(acc.id, {
  key: { remoteJid: jid, id: receiptMsgWaId, fromMe: true },
  message: { conversation: 'Please check this quotation' },
  messageTimestamp: Math.floor(Date.now() / 1000),
}, { live: true, autoTranslate: false });
const receiptBefore = get('SELECT * FROM wa_messages WHERE id=?', receiptMsgRowId);
eq(receiptBefore.from_me, 1, '测试消息识别为我方发送');
eq(receiptBefore.receipt_status, 1, '刚发送的消息初始为未读状态');
const receiptUnreadHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(receiptUnreadHtml.includes('wa-msg-receipt is-unread'), true, '我方消息显示客户未读状态');
eq(receiptUnreadHtml.includes('data-receipt-status="1"'), true, '未读状态带有消息级回执标记');
eq(wa.updateMessageReceipt(acc.id, receiptMsgWaId, 4, '', true) > 0, true, '客户已读事件可更新对应消息');
let receiptAfter = get('SELECT * FROM wa_messages WHERE id=?', receiptMsgRowId);
eq(receiptAfter.receipt_status, 4, '客户读取后回执状态升级为已读');
eq(!!receiptAfter.read_at, true, '客户读取后保存读取时间');
const receiptReadHtml = sessionPage({ query: { chat: String(chat.id) }, user, flash: () => [] });
eq(receiptReadHtml.includes('wa-msg-receipt is-read'), true, '我方消息显示客户已读状态');
eq(receiptReadHtml.includes('客户已读 ' + receiptAfter.read_at.slice(5, 16)), true, '已读状态显示客户读取时间');
wa.updateMessageReceipt(acc.id, receiptMsgWaId, 3, '', true);
receiptAfter = get('SELECT * FROM wa_messages WHERE id=?', receiptMsgRowId);
eq(receiptAfter.receipt_status, 4, '延迟到达的送达回执不会把已读降级');
eq(waSource.includes("sock.ev.on('messages.update'") && waSource.includes("sock.ev.on('message-receipt.update'"), true, '单聊和群聊回执事件均已接入');
eq(routesSource.includes('receipt_changed') && routesSource.includes('receipt_state'), true, '消息轮询会检测客户回执变化');
eq(cssSource.includes('.wa-msg-receipt.is-read') && cssSource.includes('.wa-msg-receipt.is-unread'), true, '已读和未读回执有独立样式');
eq(routesSource.includes("router.post('/whatsapp/chat/:id/read'"), false, '已移除错误的会话手动已读接口');

console.log('\n=== 21. WhatsApp 客户头像 ===');
eq(all('PRAGMA table_info(wa_chats)').some(col => col.name === 'avatar_path'), true, '会话表包含头像缓存字段');
eq(html.includes('class="wa-avatar-initials"') && html.includes('/api/wa/avatar/'), true, '会话列表和聊天头部加载客户头像');
eq(routesSource.includes("router.get('/api/wa/avatar/:id'"), true, '头像缓存接口已注册');
eq(waSource.includes("profilePictureUrl(chat.jid, 'image')") && waSource.includes('getChatAvatarPath'), true, '通过 WhatsApp 接口获取并缓存真实头像');

console.log('\n=== 22. 附件选择不触发原生全屏 ===');
eq(html.includes('markFullscreenFilePicker') || html.includes('restoreWaFullscreenAfterFilePicker'), false, '选择附件不再处理原生全屏');
eq(html.includes("attach.addEventListener('change'"), true, '附件输入保留普通选择事件');

console.log('\n=== 23. 附件发送速度优化 ===');
eq(html.includes('optimizeImageForWhatsApp') && html.includes("canvas.toBlob"), true, '大图片发送前在浏览器内压缩');
eq(html.includes('prepareAttachmentsForSend') && html.includes('IMAGE_MAX_EDGE = 2048'), true, '图片按合适尺寸批量准备');
eq(html.includes("postMessage(payload, '/whatsapp/send-batch')"), true, '多个附件使用批量发送接口');
eq(routesSource.includes("router.post('/whatsapp/send-batch'"), true, '服务端提供批量附件发送接口');
eq(waSource.includes('sendMediaBatch') && waSource.includes('MEDIA_SEND_CONCURRENCY = 3'), true, '服务端最多三路并发上传媒体');
eq(waSource.includes('MEDIA_SEND_GAP_MIN = 350'), true, '媒体发送时隙缩短且保持防连发保护');
eq(waSource.includes('await waitForMediaSendSlot(uid)'), true, '附件发送自动等待可用时隙');

console.log('\n=== 24. 跟进中心直接发 WhatsApp ===');
const { followupsPage } = require('../src/views/pages_core');
const followupHtml = followupsPage({ query: {}, user, flash: () => [] });
eq(followupHtml.includes('openFollowupWa(this)'), true, '每条跟进记录提供 WhatsApp 发送入口');
eq(followupHtml.includes('id="fuWaModal"'), true, '跟进中心渲染 WhatsApp 编辑弹窗');
eq(followupHtml.includes('/whatsapp/send'), true, '前端调用跟进 WhatsApp 发送接口');
eq(followupHtml.includes('data-phone="+2348099998877"'), true, '客户 WhatsApp 号码自动带入弹窗');
eq(routesSource.includes("router.post('/api/activities/:id/whatsapp/send'"), true, '跟进 WhatsApp 发送路由已注册');
eq(routesSource.includes('AND customer_id=? AND COALESCE(is_group,0)=0'), true, '优先复用客户已绑定的 WhatsApp 会话');
eq(routesSource.includes('await wa.sendText(ctx.user.id, jid, text)'), true, '通过当前账号的 WhatsApp 通道发送');

console.log('\n=== 25. 当天聊天覆盖当天计划跟进 ===');
const mergeCustomerId = 9994;
const mergePhone = '2348099944444';
const mergeJid = mergePhone + '@s.whatsapp.net';
const t24 = nowStr();
run('DELETE FROM activities WHERE customer_id=?', mergeCustomerId);
run('DELETE FROM wa_imports WHERE customer_id=?', mergeCustomerId);
run('DELETE FROM contacts WHERE customer_id=?', mergeCustomerId);
run('DELETE FROM wa_messages WHERE account_id=? AND chat_jid=?', acc.id, mergeJid);
run('DELETE FROM wa_chats WHERE account_id=? AND jid=?', acc.id, mergeJid);
run('DELETE FROM customers WHERE id=?', mergeCustomerId);
run('INSERT INTO customers(id,user_id,company_name,country,whatsapp,phone,contact_person,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
  mergeCustomerId, user.id, 'WA Merge Followup Co', '尼日利亚 Nigeria', '+' + mergePhone, '+' + mergePhone, 'Merge Tester', t24, t24);
const mergeTargetId = Number(run(`INSERT INTO activities(customer_id,type,subject,content,contact_person,activity_date,next_follow_date,next_follow_notes,images,created_by,user_id,created_at,priority,outcome,archived)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  mergeCustomerId, '电话', '确认包装要求', '原计划：向客户确认新包装。', 'Merge Tester', t24, todayStr(),
  '客户回复包装细节', '["/uploads/wa/old-followup.jpg"]', user.username, user.id, t24, '高', '', 0).lastInsertRowid);
wa.storeMessage(acc.id, {
  key: { remoteJid: mergeJid, id: 'wa-merge-followup-1', fromMe: false },
  message: { conversation: 'Please confirm the new packing details.' },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'Merge Tester',
}, {});
const mergeChat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, mergeJid);
eq(!!mergeChat, true, '测试会话已创建');
eq(mergeChat.customer_id, mergeCustomerId, '测试会话已绑定客户');
const mergedResult = wa.syncChatFollowup(mergeChat.id, true);
eq(mergedResult.ok, true, '当天聊天同步成功');
eq(mergedResult.mergedToday, true, '识别并覆盖当天计划跟进');
let mergedTarget = get('SELECT * FROM activities WHERE id=?', mergeTargetId);
eq(mergedTarget.subject.indexOf('WhatsApp 聊天记录') === 0, true, '计划跟进已更新为当天 WhatsApp 记录');
eq(mergedTarget.content.includes('Please confirm the new packing details.'), true, '当天聊天正文已写入跟进');
eq(mergedTarget.content.includes('原计划：向客户确认新包装。'), true, '原手工跟进内容被保留');
eq(mergedTarget.next_follow_date, addDays(todayStr(), 3), '覆盖后的跟进自动安排3天后');
eq(mergedTarget.outcome, '当天已通过 WhatsApp 沟通', '标记当天已通过WhatsApp沟通');
eq(mergedTarget.priority, '高', '原跟进优先级保持不变');
eq(mergedTarget.images.includes('/uploads/wa/old-followup.jpg'), true, '原跟进图片未丢失');
eq(get('SELECT COUNT(*) n FROM activities WHERE customer_id=?', mergeCustomerId).n, 1, '没有额外生成重复聊天记录');
const mergedAgain = wa.syncChatFollowup(mergeChat.id, true);
eq(mergedAgain.mergedToday, true, '再次同步仍然复用同一条跟进');
mergedTarget = get('SELECT * FROM activities WHERE id=?', mergeTargetId);
eq((mergedTarget.content.match(/【原跟进记录】/g) || []).length, 1, '重复同步不会重复叠加原跟进');
eq(get('SELECT COUNT(*) n FROM activities WHERE customer_id=?', mergeCustomerId).n, 1, '重复同步不新增记录');

// WhatsApp 广告归因：CTWA externalAdReply -> 消息/会话/客户首触
const adPhone = '2348099997777';
const adJid = adPhone + '@s.whatsapp.net';
run('DELETE FROM wa_messages WHERE account_id=? AND chat_jid=?', acc.id, adJid);
run('DELETE FROM wa_chats WHERE account_id=? AND jid=?', acc.id, adJid);
run('DELETE FROM customers WHERE company_name=?', 'WA Ad Attribution Co');
const adCustomerId = Number(run('INSERT INTO customers(user_id,company_name,country,whatsapp,phone,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  user.id, 'WA Ad Attribution Co', '尼日利亚 Nigeria', '+' + adPhone, '+' + adPhone, t, t).lastInsertRowid);
const adMessage = {
  key: { remoteJid: adJid, id: 'wa-ad-test-1', fromMe: false },
  message: { extendedTextMessage: { text: 'I saw your door lock ad', contextInfo: { externalAdReply: {
    title: 'Heavy Duty Door Lock', body: 'Factory direct wholesale', sourceType: 'ad', sourceId: 'meta-ad-1001',
    sourceUrl: 'https://example.com/door-lock', ctwaClid: 'ctwa-click-abc', ref: 'nigeria_lock_black',
    mediaType: 'IMAGE', thumbnailUrl: 'https://example.com/ad.jpg', sourceApp: 'facebook',
  } } } },
  messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Ad Buyer',
};
const adInfo = wa.adInfoOf(adMessage.message);
eq(adInfo.has, true, '识别 WhatsApp 广告回传');
eq(adInfo.sourceId, 'meta-ad-1001', '广告 ID 已提取');
eq(adInfo.ctwaClid, 'ctwa-click-abc', '广告点击 ID 已提取');
const adMsgId = wa.storeMessage(acc.id, adMessage, { live: true, markUnread: true });
eq(!!adMsgId, true, '广告询盘消息已落库');
let adMessageRow = get('SELECT * FROM wa_messages WHERE id=?', adMsgId);
eq(adMessageRow.ad_source_id, 'meta-ad-1001', '消息保存广告 ID');
let adChat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, adJid);
eq(adChat.ad_source_id, 'meta-ad-1001', '会话保存首次广告来源');
eq(adChat.customer_id, adCustomerId, '广告客户按手机号自动绑定');
let adCustomer = get('SELECT * FROM customers WHERE id=?', adCustomerId);
eq(adCustomer.ad_source_id, 'meta-ad-1001', '客户档案保存广告 ID');
eq(adCustomer.ad_ref, 'nigeria_lock_black', '客户档案保存广告 ref');
const secondAd = Object.assign({}, adMessage, {
  key: { remoteJid: adJid, id: 'wa-ad-test-2', fromMe: false },
  message: { extendedTextMessage: { text: 'Second click', contextInfo: { externalAdReply: {
    title: 'Another Ad', sourceType: 'ad', sourceId: 'meta-ad-2002', sourceUrl: 'https://example.com/other',
  } } } },
});
wa.storeMessage(acc.id, secondAd, { live: true });
adChat = get('SELECT * FROM wa_chats WHERE account_id=? AND jid=?', acc.id, adJid);
eq(adChat.ad_source_id, 'meta-ad-1001', '同一会话保留第一次广告来源，不被后续广告覆盖');
adCustomer = get('SELECT * FROM customers WHERE id=?', adCustomerId);
eq(adCustomer.ad_source_id, 'meta-ad-1001', '客户保留首次广告来源');

console.log('\n=== 谷歌免费机翻 ===');
eq(wa.parseGoogleTranslation([[['您好', 'Hello'], ['谢谢', 'Thanks']]]), '您好谢谢', '多段译文按原顺序拼接');
eq(wa.parseGoogleTranslation({ error: 'bad' }), '', '异常响应不产生译文');

// 旧 AI 翻译的拒答识别保留兼容，谷歌机翻不会返回这类文本
eq(wa.isTranslationRefusal('抱歉，我无法识别这段文本的含义。请提供需要翻译的外贸内容。'), true, '旧翻译拒答可被识别');
eq(wa.isTranslationRefusal('抱歉，无法判断这段文本的语种'), true, '语种拒答可被识别');
eq(wa.isTranslationRefusal('价格，兄弟'), false, '正常口语译文不会被误判为拒答');
eq(wa.isTranslationRefusal('不，兄弟。'), false, '正常短句译文不会被误判为拒答');
(async () => {
  let localServer = null;
  const originalSendText = wa.sendText;
  try {
    const originalFetch = global.fetch;
    try {
      let seenUrl = '';
      global.fetch = async (url) => {
        seenUrl = String(url);
        return { ok: true, json: async () => [[['已翻译', 'source'], ['译文二', 'second']]] };
      };
      const viaGoogle = await wa.callTranslate('translate stub source', 'en');
      eq(viaGoogle.ok, true, '翻译接口调用成功');
      eq(viaGoogle.text, '已翻译译文二', '译文按段拼接返回');
      eq(seenUrl.indexOf('translate.googleapis.com/translate_a/single') >= 0, true, '请求谷歌免费端点');
      eq(seenUrl.indexOf('client=gtx') >= 0 && seenUrl.indexOf('key=') < 0, true, '免费端点无需 API Key');
    } catch (e) {
      bad++;
      console.log('  ✗ 谷歌翻译自测异常：' + e.message);
    } finally {
      global.fetch = originalFetch;
    }

    const { createApp } = require('../src/web');
    const { registerRoutes } = require('../src/routes');
    const auth = require('../src/auth');
    const app = createApp({
      before(ctx) {
        auth.authUser(ctx.req, ctx.res);
        if (!ctx.req.user) { ctx.res.json(401, { error: '未登录' }); return false; }
        ctx.user = ctx.req.user;
        ctx.sessionToken = ctx.req.sessionToken;
        return true;
      },
    });
    registerRoutes(app, app.router);
    const token = auth.createSession(user.id);
    let sentJid = '';
    let sentText = '';
    wa.sendText = async (uid, targetJid, text) => {
      eq(uid, user.id, '接口使用当前登录账号发送');
      sentJid = targetJid;
      sentText = text;
      return { ok: true };
    };
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    localServer = app.server;
    const port = localServer.address().port;
    const response = await fetch('http://127.0.0.1:' + port + '/api/activities/' + manualId + '/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Cookie: 'crm_sid=' + token },
      body: new URLSearchParams({ phone: '+2348099998877', text: 'Hello from follow-up center' }),
    });
    const payload = await response.json();
    eq(response.status, 200, '跟进中心 WhatsApp 接口返回成功');
    eq(payload.ok, true, '接口返回 ok');
    eq(sentJid, jid, '已绑定会话直接复用原 WhatsApp JID');
    eq(sentText, 'Hello from follow-up center', '接口按用户输入发送原文');
    eq(payload.chat_url, '/whatsapp/session?chat=' + chat.id, '发送成功后返回对应会话链接');

    const adLabelResponse = await fetch('http://127.0.0.1:' + port + '/whatsapp/chat/' + adChat.id + '/ad-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Cookie: 'crm_sid=' + token },
      body: new URLSearchParams({ display_name: '尼日利亚门锁广告', campaign_name: 'Nigeria Locks', ad_set_name: 'Door Hardware Buyers', notes: '黑色款主推', back: '/whatsapp/session?chat=' + adChat.id }),
    });
    eq(adLabelResponse.status, 200, '广告名称映射接口返回成功');
    await adLabelResponse.text();
    const adMapping = get('SELECT * FROM wa_ad_sources WHERE user_id=? AND source_id=?', user.id, 'meta-ad-1001');
    eq(adMapping.display_name, '尼日利亚门锁广告', '广告名称映射已保存');
    eq(adMapping.campaign_name, 'Nigeria Locks', '广告系列名称已保存');
  } catch (e) {
    bad++;
    console.log('  ✗ 跟进 WhatsApp 接口测试异常：' + e.message);
  } finally {
    wa.sendText = originalSendText;
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (localServer) { try { if (localServer.closeAllConnections) localServer.closeAllConnections(); } catch (e) {} await new Promise((resolve) => localServer.close(resolve)); }
    console.log('\n' + (bad === 0 ? '全部通过 ✅' : bad + ' 项不通过 ❌'));
    process.exit(bad === 0 ? 0 : 1);
  }
})();




