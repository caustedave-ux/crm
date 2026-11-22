'use strict';
(function(){
  document.addEventListener('DOMContentLoaded', ()=>{
    const form = document.getElementById('settingsForm');
    if(!form) return;
    const hidden = document.getElementById('enabledSources');
    const toggles = [...document.querySelectorAll('.source-toggle')];
    function syncSources(){
      if(hidden) hidden.value = toggles.filter(x=>x.checked).map(x=>x.dataset.source).join(',');
    }
    toggles.forEach(x=>x.addEventListener('change', syncSources));
    form.addEventListener('submit', async e=>{
      e.preventDefault();
      syncSources();
      const fd = new FormData(form);
      const data = {}; fd.forEach((v,k)=>data[k]=v);
      const r = await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(x=>x.json());
      const btn = form.querySelector('button[type=submit]');
      const old = btn.innerHTML;
      btn.innerHTML = r.ok ? '<i class="bi bi-check2"></i> 已保存' : '保存失败';
      btn.className = 'btn '+(r.ok?'btn-success':'btn-danger')+' mt-3';
      setTimeout(()=>{btn.innerHTML=old; btn.className='btn btn-primary mt-3';}, 2000);
    });
  });
})();
