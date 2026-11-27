'use strict';
(function(){
  async function post(url, data){
    const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data||{})});
    return r.json();
  }
  function pollStatus(){
    const s = setInterval(async()=>{
      const r = await fetch('/api/stats').then(x=>x.json());
      if(!r.verifying){ clearInterval(s); location.reload(); }
    }, 1500);
  }
  document.addEventListener('DOMContentLoaded', ()=>{
    const checkAll = document.getElementById('checkAll');
    if(checkAll) checkAll.addEventListener('change', ()=>{
      document.querySelectorAll('.lead-check').forEach(c=>c.checked=checkAll.checked);
      updateCount();
    });
    document.querySelectorAll('.lead-check').forEach(c=>c.addEventListener('change', updateCount));
    function updateCount(){
      const n = document.querySelectorAll('.lead-check:checked').length;
      const el = document.getElementById('selCount'); if(el) el.textContent = n;
    }
    document.querySelectorAll('.verify-one').forEach(b=>b.addEventListener('click', async()=>{
      const id = b.dataset.id;
      b.disabled = true; b.innerHTML='<span class="spinner-border spinner-border-sm"></span>';
      const r = await post('/api/verify', {id:Number(id)});
      if(r.ok) pollStatus(); else { alert(r.error||'核验失败'); b.disabled=false; }
    }));
    document.querySelectorAll('[data-verify-id]').forEach(b=>b.addEventListener('click', async()=>{
      b.disabled=true; const r = await post('/api/verify',{id:Number(b.dataset.verifyId)});
      if(r.ok){ b.innerHTML='<span class="spinner-border spinner-border-sm"></span> 核验中'; pollStatus(); }
    }));
    async function changeStage(ids, stage){
      if(!ids.length) return alert('请先选择线索');
      const label = stage==='approved' ? '审批通过' : stage==='rejected' ? '驳回' : '退回候选';
      if(!confirm('确认'+label+' '+ids.length+' 条线索？')) return;
      const r = await post('/api/leads/stage',{ids,stage});
      if(r.ok) location.reload(); else alert(r.error||'操作失败');
    }
    document.querySelectorAll('.stage-one').forEach(b=>b.addEventListener('click', ()=>changeStage([Number(b.dataset.id)], b.dataset.stage)));
    const btnApproveSel = document.getElementById('btnApproveSelected');
    if(btnApproveSel) btnApproveSel.addEventListener('click', ()=>{
      changeStage([...document.querySelectorAll('.lead-check:checked')].map(c=>Number(c.value)), 'approved');
    });
    const btnRejectSel = document.getElementById('btnRejectSelected');
    if(btnRejectSel) btnRejectSel.addEventListener('click', ()=>{
      changeStage([...document.querySelectorAll('.lead-check:checked')].map(c=>Number(c.value)), 'rejected');
    });
    const btnApproveRec = document.getElementById('btnApproveRecommended');
    if(btnApproveRec) btnApproveRec.addEventListener('click', async()=>{
      if(!confirm('把推荐分达标且无冲突的候选线索勾选为「可联系」？')) return;
      const r = await post('/api/leads/approve-recommended',{});
      if(r.ok){ alert('已勾选 '+r.changed+' 条'); location.reload(); } else alert(r.error||'操作失败');
    });
    const btnVerifySel = document.getElementById('btnVerifySelected');
    if(btnVerifySel) btnVerifySel.addEventListener('click', async()=>{
      const ids = [...document.querySelectorAll('.lead-check:checked')].map(c=>Number(c.value));
      if(!ids.length) return alert('请先选择线索');
      const r = await post('/api/verify',{ids});
      if(r.ok) pollStatus();
    });
    const btnExport = document.getElementById('btnExport');
    if(btnExport) btnExport.addEventListener('click', ()=>location.href='/api/export');
    const btnExportSel = document.getElementById('btnExportSel');
    if(btnExportSel) btnExportSel.addEventListener('click', ()=>{
      const ids = [...document.querySelectorAll('.lead-check:checked')].map(c=>c.value);
      location.href='/api/export'+(ids.length?'?ids='+ids.join(','):'');
    });
  });
})();
