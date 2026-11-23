'use strict';
/** 获客工作台线索页交互：详情页状态切换。
 * 旧核验引擎已去掉：本文件不再调 /api/verify、/api/leads/stage、/api/export。 */
(function(){
  async function post(url, data){
    const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data||{})});
    return r.json();
  }
  document.addEventListener('DOMContentLoaded', ()=>{
    // 详情页：状态切换按钮（data-lead-status），如页面有则接线。
    document.querySelectorAll('[data-lead-status]').forEach(b=>b.addEventListener('click', async()=>{
      const id = b.dataset.leadId;
      const status = b.dataset.leadStatus;
      b.disabled = true;
      const r = await post('/api/lead/' + id + '/status', { status });
      if (r.ok) location.reload(); else { alert(r.error || '操作失败'); b.disabled = false; }
    }));
  });
})();
