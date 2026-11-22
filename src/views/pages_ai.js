'use strict';
// ============ AI 助手（DeepSeek + 知识库问答） ============
const { esc } = require('../util');
const { page } = require('./layout');
const { pageHead } = require('./ui');
const { all } = require('../db');
const knowledgeBase = require('../knowledgeBase');

function assistantPage(ctx) {
  const products = all('SELECT id,name,model FROM products ORDER BY id LIMIT 200');
  const categories = knowledgeBase.CATEGORIES;
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
    ${pageHead('AI 助手（DeepSeek）', '基于当前账号可见的 CRM 数据与共享知识库回答；知识库内容优先，答不出来会说不知道', '')}
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
        <div class="crm-ai-pane-title mt-4"><i class="bi bi-cpu"></i><span>DeepSeek 连接</span></div>
        <p class="small text-muted mb-2">用系统设置里的 DeepSeek Key 生成回答；每次回答前先按问题关键词检索知识库，知识库内容优先。</p>
        <a class="small" href="/settings">查看 DeepSeek 设置 <i class="bi bi-arrow-up-right"></i></a>
      </aside>
    </div>
    <script>
      var chatBox = document.getElementById('chatBox');
      var kbProducts = ${JSON.stringify(products.map(p => ({ id: p.id, label: p.name + (p.model ? ' · ' + p.model : '') })))};
      var kbCategories = ${JSON.stringify(categories)};
      function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
      function addMsg(role, text) {
        var row = document.createElement('div');
        row.className = 'mb-2 d-flex flex-wrap ' + (role === 'user' ? 'justify-content-end' : 'justify-content-start');
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
        box.style.width = '100%';
        var label = document.createElement('span'); label.textContent = '知识库来源'; box.appendChild(label);
        sources.forEach(function (source) {
          var link = document.createElement('a');
          link.href = '/knowledge?article=' + encodeURIComponent(source.id);
          link.textContent = (source.category ? source.category + ' · ' : '') + (source.title || '知识条目');
          box.appendChild(link);
        });
        row.appendChild(box);
      }
      // 学习回路：每条 AI 回答下面挂一个“保存到知识库”按钮，点了才存，不自动存；
      // 存成知识库文章后，下次问类似问题检索就能引用到。
      function addSaveButton(row, q, answer, sources) {
        if (!row) return;
        var wrap = document.createElement('div');
        wrap.style.width = '100%';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-outline-primary mt-1';
        btn.textContent = '保存到知识库';
        btn.addEventListener('click', function () { showSaveForm(wrap, btn, q, answer, sources); });
        wrap.appendChild(btn);
        row.appendChild(wrap);
      }
      function showSaveForm(wrap, btn, q, answer, sources) {
        btn.remove();
        var form = document.createElement('div');
        form.className = 'mt-1 p-2 border rounded-3 bg-light text-dark';
        form.innerHTML = '<div class="small fw-semibold mb-2">保存这次问答到知识库（点确认才存，不自动存）</div>'
          + '<input class="form-control form-control-sm mb-2" placeholder="标题（默认用问题）" maxlength="120">'
          + '<div class="d-flex gap-2 mb-2"><select class="form-select form-select-sm" title="分类"></select>'
          + '<select class="form-select form-select-sm" title="关联产品（可选）"><option value="">不关联产品</option></select></div>'
          + '<div class="d-flex gap-2 align-items-center"><button type="button" class="btn btn-sm btn-primary">确认保存</button>'
          + '<button type="button" class="btn btn-sm btn-outline-secondary">取消</button>'
          + '<span class="small text-muted"></span></div>';
        var titleInput = form.querySelector('input');
        titleInput.value = String(q || '').slice(0, 80);
        var selects = form.querySelectorAll('select');
        var catSel = selects[0], prodSel = selects[1];
        kbCategories.forEach(function (c) {
          var o = document.createElement('option'); o.value = c; o.textContent = c;
          if (c === '问答') o.selected = true;
          catSel.appendChild(o);
        });
        kbProducts.forEach(function (p) {
          var o = document.createElement('option'); o.value = p.id; o.textContent = p.label;
          prodSel.appendChild(o);
        });
        var msg = form.querySelector('span');
        var btns = form.querySelectorAll('button');
        btns[1].addEventListener('click', function () { form.remove(); addSaveButton(wrap.parentNode, q, answer, sources); wrap.remove(); });
        btns[0].addEventListener('click', async function () {
          btns[0].disabled = true; msg.textContent = '保存中…';
          try {
            var r = await fetch('/api/ai/save-to-knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, answer: answer, title: titleInput.value, category: catSel.value, product_id: prodSel.value ? parseInt(prodSel.value, 10) : 0, sources: sources || [] }) });
            var d = await r.json();
            if (!d.ok) throw new Error(d.error || '保存失败');
            form.innerHTML = '<span class="small text-success">已保存到知识库：</span> <a class="small" href="/knowledge?article=' + encodeURIComponent(d.id) + '">' + escapeHtml(d.title || '查看文章') + '</a>';
          } catch (e) {
            msg.textContent = '保存失败：' + e.message;
            btns[0].disabled = false;
          }
        });
        wrap.appendChild(form);
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
            addMsg('ai', 'AI 回复失败：' + (data.error || '未知错误'));
            return;
          }
          var answerRow = addMsg('ai', data.answer || '（无回复）');
          addSources(answerRow, data.sources);
          addSaveButton(answerRow, q, data.answer, data.sources);
        } catch (e) {
          removeTyping();
          addMsg('ai', '请求失败：' + e.message);
        }
      }
      document.getElementById('sendBtn').addEventListener('click', function () { ask(document.getElementById('qInput').value); });
      document.getElementById('qInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(this.value); } });
      document.querySelectorAll('.chip').forEach(function (b) { b.addEventListener('click', function () { ask(b.textContent); }); });
    </script>`;
  return page({ title: 'AI 助手', active: 'ai', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { assistantPage };
