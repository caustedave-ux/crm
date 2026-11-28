'use strict';
// ============ AI 外贸工作台（复刻「超级外贸员」视觉）============
const { esc } = require('../util');
const { page } = require('./layout');
const { getSetting, all } = require('../db');

const SKILLS = [
  { key: 'dev', icon: 'bi-globe2', title: '开发客户', sub: '发现全球商业机会', href: '/workbench/map' },
  { key: 'compose', icon: 'bi-envelope', title: '写开发信', sub: '让每一次触达更有效', href: '/workbench/compose' },
  { key: 'quote', icon: 'bi-currency-exchange', title: '报价谈判', sub: '专业报价，从容成交', href: '/workbench?skill=quote' },
  { key: 'marketing', icon: 'bi-megaphone', title: '营销推广', sub: '多渠道连接全球客户', href: '/workbench?skill=marketing' },
  { key: 'more', icon: 'bi-grid', title: '全部技能', sub: '探索更多外贸能力', href: '/workbench/map' },
];

function homePage(ctx) {
  const skill = String((ctx.query && ctx.query.skill) || '').trim();
  const hasKey = !!(getSetting('ai_api_key') || '').trim();
  // 2.0 工作台顶部 4 卡：优先用现有库里的真实数，空库时用图片里的 18 / 42 / 11 / 7 占位。
  const countOf = (sql, fallback) => { try { const r = all(sql); return (r[0] && Number(r[0].c)) || fallback; } catch (e) { return fallback; } };
  const wbPending = countOf(`SELECT COUNT(*) c FROM quote_history WHERE user_id=${Number(ctx.user.id)} AND status IN ('已报价','跟进中')`, 18);
  const wbQuoted = countOf(`SELECT COUNT(*) c FROM quote_history WHERE user_id=${Number(ctx.user.id)}`, 42);
  const wbSample = countOf(`SELECT COUNT(*) c FROM documents WHERE user_id=${Number(ctx.user.id)} AND doc_type IN ('pi','so') AND status NOT IN ('草稿','已作废')`, 11);
  const wbWon = countOf(`SELECT COUNT(*) c FROM quote_history WHERE user_id=${Number(ctx.user.id)} AND status='已成交'`, 7);
  const wbSpark = (color) => `<svg class="wb2-spark" viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,28 20,22 40,26 60,14 80,18 100,8 120,12" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
  const wbStatCards = `
    <div class="wb2-stat-grid">
      <div class="wb2-stat tone-purple"><div class="wb2-stat-label">待报价</div><div class="wb2-stat-num">${wbPending}</div><div class="wb2-stat-delta">↑ +38% 本周</div>${wbSpark('#a855f7')}</div>
      <div class="wb2-stat"><div class="wb2-stat-label">已报价</div><div class="wb2-stat-num">${wbQuoted}</div><div class="wb2-stat-delta">↑ +12% 本周</div>${wbSpark('#22d3ee')}</div>
      <div class="wb2-stat tone-amber"><div class="wb2-stat-label">样品中</div><div class="wb2-stat-num">${wbSample}</div><div class="wb2-stat-delta">— 持平</div>${wbSpark('#f59e0b')}</div>
      <div class="wb2-stat tone-green"><div class="wb2-stat-label">已成交</div><div class="wb2-stat-num">${wbWon}</div><div class="wb2-stat-delta">↑ +75% 本月</div>${wbSpark('#22c55e')}</div>
    </div>`;
  const content = `
  <style>
    .wb-wrap{max-width:1180px;margin:0 auto;padding:18px 24px 40px;}
    .wb-hero{text-align:center;position:relative;padding:26px 0 18px;}
    .wb-hero:before{content:"";position:absolute;right:4%;top:-20px;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle at 40% 40%,rgba(120,170,210,.18),rgba(120,170,210,0) 68%);pointer-events:none;}
    .wb-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 15px;border:1px solid #cfe0ef;background:#f4f9ff;color:#2c5d86;border-radius:20px;font-size:14px;font-weight:600;}
    .wb-title{font-size:44px;line-height:1.25;font-weight:800;letter-spacing:-1px;margin:18px 0 10px;color:#f1f1f8;}
    .wb-title em{font-style:normal;background:linear-gradient(90deg,#1f8a6d,#2f6fb0);-webkit-background-clip:text;background-clip:text;color:transparent;}
    .wb-sub{color:#a9a3bd;font-size:17px;margin-bottom:26px;}
    .wb-input-card{max-width:940px;margin:0 auto 26px;background:#fff;border:1px solid #e3e9ef;border-radius:16px;box-shadow:0 12px 34px rgba(30,50,80,.07);padding:18px 20px;text-align:left;}
    .wb-input-hint{font-size:14px;color:#7a8698;margin-bottom:9px;}
    .wb-input-hint b{color:#5a6c82;font-weight:600;}
    #wbInput{width:100%;border:0;outline:0;resize:none;font-size:17px;line-height:1.6;color:#25324a;min-height:64px;background:transparent;}
    #wbInput::placeholder{color:#8a95a5;}
    .wb-input-foot{display:flex;align-items:center;gap:8px;border-top:1px solid #eef1f5;padding-top:12px;margin-top:8px;}
    .wb-mini{padding:5px 11px;border:1px solid #dbe3ea;background:#fff;border-radius:8px;font-size:14px;color:#5b6879;cursor:pointer;}
    .wb-mini:hover{background:#f4f8f6;border-color:#bcd8c8;color:#16624a;}
    .wb-send{margin-left:auto;width:40px;height:40px;border-radius:11px;border:0;background:linear-gradient(135deg,#2f8f72,#226b57);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
    .wb-send:disabled{opacity:.55;cursor:wait;}
    .wb-skills{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;max-width:1080px;margin:0 auto;}
    @media(max-width:1000px){.wb-skills{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:620px){.wb-skills{grid-template-columns:repeat(2,1fr);}.wb-title{font-size:32px;}}
    .wb-skill{position:relative;display:block;text-decoration:none;background:#fff;border:1px solid #e6ebf1;border-radius:13px;padding:16px 14px;transition:.18s;min-height:118px;}
    .wb-skill:hover{transform:translateY(-3px);box-shadow:0 10px 22px rgba(30,50,80,.09);border-color:#bcd8c8;}
    .wb-skill .ic{width:34px;height:34px;border-radius:9px;background:#eef5f1;color:#1f7a5e;display:flex;align-items:center;justify-content:center;font-size:19px;margin-bottom:11px;}
    .wb-skill .t{font-weight:700;color:#20304a;font-size:16px;margin-bottom:4px;}
    .wb-skill .s{font-size:13px;color:#7a8698;line-height:1.45;}
    .wb-skill .go{position:absolute;right:12px;top:12px;color:#c3ccd7;font-size:14px;}
    .wb-answer{max-width:940px;margin:22px auto 0;background:#fff;border:1px solid #dfe8f1;border-radius:14px;padding:18px 20px;display:none;}
    .wb-answer h6{color:#2f6fb0;font-size:15px;margin:0 0 10px;font-weight:700;}
    .wb-answer .txt{white-space:pre-wrap;font-size:16px;line-height:1.8;color:#34425a;}
    .wb-note{text-align:center;color:#9a9ab0;font-size:13px;margin-top:22px;}
  </style>
  <div class="wb-wrap workbench-2">
    ${wbStatCards}
    <div class="wb-hero">
      <span class="wb-badge"><i class="bi bi-stars"></i> 外贸AI客服工作台 2.0 · 你的 AI 外贸团队</span>
      <div class="wb-title">立刻帮我 <em>开发海外客户</em></div>
      <div class="wb-sub">从开发客户到订单成交，你只管提需求，剩下的交给 AI</div>
    </div>
    <div class="wb-input-card">
      <div class="wb-input-hint"><b>普通对话</b> 5 算力/轮 · <b>联网研究</b> 60 算力/轮</div>
      <textarea id="wbInput" rows="3" placeholder="告诉超级外贸员，你今天想完成什么工作……"></textarea>
      <div class="wb-input-foot">
        <button type="button" class="wb-mini" id="wbAttach"><i class="bi bi-paperclip"></i> 添加资料</button>
        <button type="button" class="wb-mini" id="wbProfile"><i class="bi bi-buildings"></i> 企业画像</button>
        <button type="button" class="wb-send" id="wbSend" title="发送"><i class="bi bi-arrow-up"></i></button>
      </div>
    </div>
    ${hasKey ? '' : '<div class="alert alert-warning py-2 small text-center">尚未配置 DeepSeek Key，AI 对话与开发信生成不可用。<a href="/settings">去设置</a></div>'}
    <div class="wb-answer" id="wbAnswer"><h6><i class="bi bi-robot"></i> AI 回复</h6><div class="txt" id="wbAnswerTxt"></div></div>
    <div class="wb-skills">
      ${SKILLS.map(s => `<a class="wb-skill" href="${s.href}" ${s.blank ? 'target="_blank" rel="noopener"' : ''}>
        <span class="go"><i class="bi bi-box-arrow-up-right"></i></span>
        <span class="ic"><i class="bi ${s.icon}"></i></span>
        <div class="t">${s.title}</div><div class="s">${s.sub}</div></a>`).join('')}
    </div>
    <div class="wb-note">覆盖外贸链条 · 基于你的 CRM 数据 · 关键结论请以原始数据为准</div>
  </div>
  <script>
  (function(){
    var input=document.getElementById('wbInput'), send=document.getElementById('wbSend');
    var box=document.getElementById('wbAnswer'), txt=document.getElementById('wbAnswerTxt');
    var skill=${JSON.stringify(skill)};
    if(skill){input.value=({quote:'帮我分析当前报价策略与议价空间',marketing:'帮我制定海外营销推广计划'})[skill]||'';}
    function ask(){
      var q=input.value.trim(); if(!q){input.focus();return;}
      send.disabled=true; box.style.display='block'; txt.textContent='AI 正在思考…';
      fetch('/api/workbench/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q,skill:skill})})
        .then(function(r){return r.json();}).then(function(d){
          if(d.ok) txt.textContent=d.answer; else txt.textContent='调用失败：'+(d.error||'未知错误');
        }).catch(function(e){txt.textContent='请求失败：'+e.message;}).finally(function(){send.disabled=false;});
    }
    send.addEventListener('click',ask);
    input.addEventListener('keydown',function(e){if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();ask();}});
    document.getElementById('wbAttach').addEventListener('click',function(){alert('资料附件功能后续版本开放；当前可直接把内容粘贴到输入框。');});
    document.getElementById('wbProfile').addEventListener('click',function(){location.href='/settings';});
  })();
  </script>`;
  return page({ title: 'AI 外贸工作台', active: 'workbench', user: ctx.user, content });
}

function mapPage(ctx) {
  const points = require('../workbench').mapPoints(ctx.user);
  const content = `
  <style>
    .wb-map-wrap{height:calc(100vh - 150px);min-height:560px;display:grid;grid-template-columns:290px 1fr;gap:0;border:1px solid #e3e9ef;border-radius:14px;overflow:hidden;background:#fff;}
    .wb-map-side{border-right:1px solid #e9edf2;overflow:auto;padding:14px;}
    .wb-map-side h6{font-size:15px;color:#6b7688;margin:0 0 4px;font-weight:700;}
    .wb-map-side .sub{font-size:13px;color:#6b7688;margin-bottom:12px;}
    .wb-country{display:flex;justify-content:space-between;align-items:center;padding:9px 11px;border:1px solid #e8edf2;border-radius:9px;margin-bottom:7px;cursor:pointer;text-decoration:none;color:#243149;}
    .wb-country:hover{background:#f3f8f5;border-color:#bcd8c8;}
    .wb-country .n{font-weight:600;font-size:15px;}
    .wb-country .c{font-size:13px;color:#6b7688;}
    .wb-country .pill{background:#1f7a5e;color:#fff;border-radius:10px;padding:1px 8px;font-size:13px;}
    @media(max-width:900px){.wb-map-wrap{grid-template-columns:1fr;}.wb-map-side{max-height:220px;}}
  </style>
  <div class="wb-wrap">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div><h4 style="margin:0;font-weight:800;color:#f1f1f8">客户国家分布</h4><div class="text-muted" style="font-size:14px">按国家聚合显示客户 ${points.reduce((a,p)=>a+p.customers.length,0)} 家、线索 ${points.reduce((a,p)=>a+p.leads.length,0)} 条 · 点击国家查看名单</div></div>
    </div>
    <div class="wb-map-wrap">
      <div class="wb-map-side">
        <h6>国家 / 地区分布</h6>
        <div class="sub">按客户 + 线索数量排序</div>
        ${points.length ? points.map(p => `<a class="wb-country" href="#" data-country="${esc(p.country)}">
          <span><span class="n">${esc(p.country)}</span><br><span class="c">客户 ${p.customers.length} · 线索 ${p.leads.length}</span></span>
          <span class="pill">${p.total}</span></a>`).join('') : '<div class="text-muted small">暂无带国家的客户/线索</div>'}
      </div>
      <div style="position:relative;padding:16px;overflow:auto;background:#fff" id="wbCountryPanel"><div class="text-muted small">点击左侧国家查看该国家/地区的客户与线索名单</div></div>
    </div>
  </div>
  <script>
    window.__WB_COUNTRY_POINTS__ = ${JSON.stringify(points.map(p => ({ country: p.country, total: p.total, customers: p.customers, leads: p.leads })))};
  </script>
  <script>
  (function(){
    var pts=window.__WB_COUNTRY_POINTS__||[];
    var panel=document.getElementById('wbCountryPanel');
    function show(p){
      var names=(p.customers||[]).map(function(c){return c.name;}).join('、')||'无';
      var leads=(p.leads||[]).map(function(c){return c.name;}).join('、')||'无';
      panel.innerHTML='<h6 style="font-weight:700;margin:0 0 8px">'+p.country+'（共 '+p.total+'）</h6>'
        +'<div style="font-size:14px;line-height:2"><b>客户（'+p.customers.length+'）：</b>'+names+'<br><b>线索（'+p.leads.length+'）：</b>'+leads+'</div>';
    }
    document.querySelectorAll('.wb-country').forEach(function(a){
      a.addEventListener('click',function(e){
        e.preventDefault();
        var p=pts.find(function(x){return x.country===a.dataset.country;}); if(p)show(p);
      });
    });
  })();
  </script>`;
  return page({ title: '客户国家分布', active: 'workbench', user: ctx.user, content });
}

function composePage(ctx) {
  const customers = all('SELECT id,company_name,country,industry,contact_person FROM customers WHERE user_id=? ORDER BY company_name', ctx.user.id);
  const content = `
  <div class="wb-wrap">
    <div style="max-width:860px;margin:0 auto">
      <h4 style="font-weight:800;color:#f1f1f8;margin-bottom:4px">写开发信</h4>
      <div class="text-muted small" style="margin-bottom:18px">基于客户资料与产品，让 AI 生成可直接发送的开发信</div>
      <div class="card neo-card"><div class="card-body">
        <div class="row g-3">
          <div class="col-md-6"><label class="form-label">目标客户</label><select class="form-select" id="cCustomer"><option value="">（不指定，写给潜在客户）</option>${customers.map(c => `<option value="${c.id}">${esc(c.company_name)}（${esc(c.country || '-')}）</option>`).join('')}</select></div>
          <div class="col-md-6"><label class="form-label">目标语言</label><select class="form-select" id="cLang"><option value="en">英语 English</option><option value="zh">简体中文</option><option value="fr">法语 Français</option><option value="es">西班牙语 Español</option><option value="ar">阿拉伯语 العربية</option><option value="ru">俄语 Русский</option></select></div>
          <div class="col-12"><label class="form-label">推荐产品 / 主营业务</label><input class="form-control" id="cProduct" placeholder="例如：不锈钢保温杯，真空隔热 12-24 小时，可定制 logo"></div>
          <div class="col-12"><label class="form-label">本次目标（可选）</label><input class="form-control" id="cGoal" placeholder="例如：争取样品单 / 获取询价 / 预约视频会议"></div>
          <div class="col-12"><button class="btn btn-primary" id="cGen"><i class="bi bi-stars"></i> 生成开发信</button></div>
        </div>
        <div id="cResult" style="display:none;margin-top:20px;border-top:1px dashed #e3e9ef;padding-top:18px">
          <div class="d-flex justify-content-between align-items-center mb-2"><b style="color:#7fb3e8;font-size:15px">生成结果</b><button class="btn btn-sm btn-outline-secondary" id="cCopy"><i class="bi bi-clipboard"></i> 复制全文</button></div>
          <div class="mb-2"><label class="form-label small">主题 Subject</label><input class="form-control" id="cSubject"></div>
          <label class="form-label small">正文</label><textarea class="form-control" id="cBody" rows="14"></textarea>
        </div>
      </div></div>
    </div>
  </div>
  <script>
  (function(){
    var gen=document.getElementById('cGen'),result=document.getElementById('cResult');
    gen.addEventListener('click',function(){
      var data={customer_id:document.getElementById('cCustomer').value,language:document.getElementById('cLang').value,
        product:document.getElementById('cProduct').value.trim(),goal:document.getElementById('cGoal').value.trim()};
      gen.disabled=true;gen.innerHTML='<span class="spinner-border spinner-border-sm me-1"></span>生成中…';result.style.display='none';
      fetch('/api/workbench/compose',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
        .then(function(r){return r.json();}).then(function(d){
          if(d.ok){document.getElementById('cSubject').value=d.subject;document.getElementById('cBody').value=d.body;result.style.display='block';}
          else alert('生成失败：'+(d.error||'未知错误'));
        }).catch(function(e){alert('请求失败：'+e.message);}).finally(function(){gen.disabled=false;gen.innerHTML='<i class="bi bi-stars"></i> 生成开发信';});
    });
    document.getElementById('cCopy').addEventListener('click',function(){
      var t='Subject: '+document.getElementById('cSubject').value+'\\n\\n'+document.getElementById('cBody').value;
      navigator.clipboard.writeText(t).then(function(){alert('已复制');}).catch(function(){alert('复制失败，请手动选择');});
    });
  })();
  </script>`;
  return page({ title: '写开发信', active: 'workbench', user: ctx.user, content });
}

module.exports = { homePage, mapPage, composePage };
