'use strict';
(function(){
  async function post(url, data){
    const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data||{})});
    return r.json();
  }
  document.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.getElementById('btnVerifyAll');
    const box = document.getElementById('verifyProgress');
    const bar = document.getElementById('vpBar');
    const pct = document.getElementById('vpPct');
    const label = document.getElementById('vpLabel');
    let timer = null;
    btn.addEventListener('click', async()=>{
      const r = await post('/api/verify-all', {});
      if(!r.ok) return alert(r.error||'启动失败');
      btn.disabled = true; box.style.display='block';
      let wasRunning = false;
      timer = setInterval(async()=>{
        const s = await fetch('/api/stats').then(x=>x.json());
        if(s.verifying){ wasRunning = true; label.textContent='正在核验线索…'; return; }
        if(wasRunning || !s.queued){ clearInterval(timer); btn.disabled=false; location.reload(); }
      }, 1800);
    });
  });
})();
