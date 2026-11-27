'use strict';
(function(){
  async function post(url, data){
    const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data||{})});
    return r.json();
  }
  document.addEventListener('DOMContentLoaded', ()=>{
    const form = document.getElementById('importForm');
    const raw = document.getElementById('rawInput');
    const fileInput = document.getElementById('csvFile');
    const result = document.getElementById('importResult');

    if(fileInput) fileInput.addEventListener('change', ()=>{
      const f = fileInput.files[0]; if(!f) return;
      const reader = new FileReader();
      reader.onload = e => { raw.value = e.target.result; };
      reader.readAsText(f, 'UTF-8');
    });

    document.getElementById('btnPreview').addEventListener('click', async()=>{
      const r = await post('/api/import/preview', {raw: raw.value});
      if(!r.ok || !r.rows.length) { result.innerHTML='<div class="alert alert-warning">未解析到有效行</div>'; return; }
      const rows = r.rows;
      const cols = Object.keys(rows[0]);
      result.innerHTML = `<div class="alert alert-info small"><b>预览：解析 ${r.total} 行</b>（显示前 ${rows.length} 行）<div class="table-responsive mt-2"><table class="table table-sm table-bordered mb-0"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(x=>`<tr>${cols.map(c=>`<td>${(x[c]||'').toString().slice(0,40)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
    });

    form.addEventListener('submit', async e=>{
      e.preventDefault();
      const fd = new FormData(form);
      const r = await post('/api/import', {raw: fd.get('raw')||'', source: fd.get('source')||'', note: fd.get('note')||''});
      if(r.ok){
        result.innerHTML = `<div class="alert alert-success"><i class="bi bi-check-circle"></i> 导入完成：新增 <b>${r.inserted}</b> 条，重复跳过 <b>${r.duplicates}</b> 条。<a href="/leads" class="alert-link">前往线索库 →</a></div>`;
      } else {
        result.innerHTML = `<div class="alert alert-danger">${r.error||'导入失败'}</div>`;
      }
    });
  });
})();
