'use strict';
// ============ Codex 助理（基于 CRM 数据问答） ============
const { esc } = require('../util');
const { page } = require('./layout');
const { pageHead } = require('./ui');
const knowledgeBase = require('../knowledgeBase');

function assistantPage(ctx) {
  const chips = [
    '本月单据金额总共多少？',
    '哪些产品库存偏低或缺货？',
    '客户都分布在哪些国家？',
    '最近的销售订单有哪些？',
    '哪个客户名下有最多单据？',
    '帮我汇总货款：已付和未付大概多少？',
  ];
  const chipHtml = chips.map(c => `<button type="button" class="btn btn-sm btn-outline-secondary chip">${esc(c)}</button>`).join(' ');
  const categoryCounts = knowledgeBase.categoryCounts();
  const knowledgeCount = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
  const content = `
    ${pageHead('Codex 助理', '基于当前账号可见的 CRM 数据与共享知识库回答', '')}
    <div class="crm-ai-workspace">
      <aside class="crm-ai-pane crm-ai-questions">
        <div class="crm-ai-pane-title"><i class="bi bi-lightning-charge"></i><span>快速提问</span></div>
        <div class="crm-ai-chip-list">${chipHtml}</div>
      </aside>
      <section class="crm-ai-pane crm-ai-chat">
        <div class="crm-ai-pane-title"><i class="bi bi-chat-square-text"></i><span>数据问答</span></div>
        <div id="chatBox" class="crm-ai-messages">
          <div class="crm-ai-welcome"><i class="bi bi-robot"></i><span>询问客户、产品、报价、单据、库存、货款或跟进数据。</span></div>
        </div>
        <div class="crm-ai-composer">
          <textarea id="qInput" class="form-control" rows="2" placeholder="输入问题，按 Enter 发送"></textarea>
          <button id="sendBtn" class="btn btn-primary" type="button" aria-label="发送问题" title="发送问题"><i class="bi bi-send"></i></button>
        </div>
        <div class="crm-ai-footnote">答案根据当前账号可见的 CRM 数据与匹配知识条目生成。</div>
      </section>
      <aside class="crm-ai-pane crm-ai-context">
        <div class="crm-ai-pane-title"><i class="bi bi-database-check"></i><span>数据来源</span></div>
        <div class="crm-ai-source-row"><i class="bi bi-person-lines-fill"></i><span>当前账号 CRM 数据</span></div>
        <div class="crm-ai-kb-summary">
          <div class="d-flex justify-content-between align-items-center"><strong>知识库</strong><span class="badge text-bg-primary">${knowledgeCount} 条</span></div>
          <div class="crm-ai-kb-categories">${knowledgeBase.CATEGORIES.map(name => `<span>${esc(name)} <b>${categoryCounts[name] || 0}</b></span>`).join('')}</div>
          <a class="btn btn-sm btn-outline-primary w-100 mt-3" href="/knowledge"><i class="bi bi-journal-richtext me-1"></i>打开知识库</a>
        </div>
        <div class="crm-ai-pane-title mt-4"><i class="bi bi-cpu"></i><span>Codex 连接</span></div>
        <p class="small text-muted mb-2">通过 CRM 主机已安装并登录的 Codex CLI 生成回答，运行在只读沙箱中。</p>
        <a class="small" href="/settings">查看助理设置 <i class="bi bi-arrow-up-right"></i></a>
      </aside>
    </div>
    <script>
      var chatBox = document.getElementById('chatBox');
      function addMsg(role, text) {
        var row = document.createElement('div');
        row.className = 'mb-2 d-flex ' + (role === 'user' ? 'justify-content-end' : 'justify-content-start');
        var bubble = document.createElement('div');
        bubble.className = role === 'user' ? 'bg-primary text-white p-2 rounded-3' : 'bg-white border p-2 rounded-3';
        bubble.style.maxWidth = '85%'; bubble.style.whiteSpace = 'pre-wrap';
        bubble.textContent = text;
        row.appendChild(bubble); chatBox.appendChild(row); chatBox.scrollTop = chatBox.scrollHeight;
        return row;
      }
      function addSources(row, sources) {
        if (!row || !Array.isArray(sources) || !sources.length) return;
        var box = document.createElement('div');
        box.className = 'crm-ai-sources';
        var label = document.createElement('span'); label.textContent = '知识库来源'; box.appendChild(label);
        sources.forEach(function (source) {
          var link = document.createElement('a');
          link.href = '/knowledge?article=' + encodeURIComponent(source.id);
          link.textContent = (source.category ? source.category + ' · ' : '') + (source.title || '知识条目');
          box.appendChild(link);
        });
        row.appendChild(box);
      }
      function sending() {
        var row = document.createElement('div');
        row.className = 'mb-2 d-flex'; row.id = 'typingRow';
        row.innerHTML = '<div class="bg-white border p-2 rounded-3 text-muted"><span class="spinner-border spinner-border-sm me-1"></span>AI 思考中…</div>';
        chatBox.appendChild(row); chatBox.scrollTop = chatBox.scrollHeight;
      }
      function removeTyping() { var t = document.getElementById('typingRow'); if (t) t.remove(); }
      async function ask(q) {
        q = (q || '').trim();
        if (!q) return;
        addMsg('user', q);
        document.getElementById('qInput').value = '';
        sending();
        try {
          var r = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
          var data = await r.json();
          removeTyping();
          if (!data.ok) {
            addMsg('ai', 'Codex 回复失败：' + (data.error || '未知错误'));
            return;
          }
          var answerRow = addMsg('ai', data.answer || '（无回复）');
          addSources(answerRow, data.sources);
        } catch (e) {
          removeTyping();
          addMsg('ai', '请求失败：' + e.message);
        }
      }
      document.getElementById('sendBtn').addEventListener('click', function () { ask(document.getElementById('qInput').value); });
      document.getElementById('qInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(this.value); } });
      document.querySelectorAll('.chip').forEach(function (b) { b.addEventListener('click', function () { ask(b.textContent); }); });
    </script>`;
  return page({ title: 'Codex 助理', active: 'ai', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { assistantPage };
