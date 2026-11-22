// 通用脚本：提示自动消失 + 产品图片点击放大预览
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.alert-dismissible').forEach(function (el) {
    setTimeout(function () {
      try {
        var inst = bootstrap.Alert.getOrCreateInstance(el);
        if (inst) inst.close();
      } catch (e) {}
    }, 5000);
  });

  var activeNav = document.querySelector('.sidebar-nav .nav-link.active');
  if (activeNav && typeof activeNav.scrollIntoView === 'function') {
    setTimeout(function () { activeNav.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 0);
  }

  var mask = document.getElementById('lightboxMask');
  if (!mask) return;
  var img = document.getElementById('lightboxImg');
  var cap = document.getElementById('lightboxCap');
  function open(src, title) {
    img.src = src;
    cap.textContent = title || '';
    mask.classList.add('show');
  }
  function close() {
    mask.classList.remove('show');
    img.src = '';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('img');
    if (!t || !t.src) return;
    // 已上传的小缩略图（或显式标记 .img-preview）点击放大
    var w = t.getBoundingClientRect().width;
    var isThumb = t.classList.contains('img-preview') || (w > 0 && w <= 160 && t.src.indexOf('/uploads/') >= 0);
    if (isThumb) {
      e.preventDefault();
      open(t.src, t.getAttribute('data-title') || t.alt || '');
    }
  });
  document.getElementById('lightboxClose').addEventListener('click', close);
  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
});


