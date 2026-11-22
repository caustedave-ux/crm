'use strict';
// ============ 客户世界地图：按国家着色，客户落在对应国家 ============
// 国家颜色深浅=客户数；点击国家弹出该国客户列表；右侧面板显示客户详情
const { esc } = require('../util');
const { page } = require('./layout');
const { pageHead } = require('./ui');

function starmapPage(ctx) {
  const content = `
    ${pageHead('统计', '客户世界地图 · 按国家分布', '')}
    <style>
      .starmap-wrap{position:relative;display:grid;grid-template-columns:1fr 340px;gap:14px;height:calc(100vh - 150px);min-height:560px;}
      .starmap-stage{position:relative;background:#0b1020;border-radius:14px;overflow:hidden;box-shadow:inset 0 0 40px rgba(0,0,0,.5);}
      #smChart{width:100%;height:100%;}
      .starmap-legend{position:absolute;left:12px;bottom:12px;background:rgba(8,12,24,.72);border:1px solid #2a3556;border-radius:8px;padding:6px 10px;font-size:11px;color:#9fb2d8;z-index:3;}
      .starmap-panel{background:#fff;border:1px solid #e7ebf0;border-radius:14px;overflow:auto;padding:16px;}
      .sm-empty{color:#9aa3b2;text-align:center;padding:40px 10px;font-size:13px;line-height:1.8;}
      .sm-cust-name{font-size:16px;font-weight:700;color:#1a2233;word-break:break-word;}
      .sm-cust-meta{font-size:12px;color:#7a8494;margin:4px 0 10px;}
      .sm-sec{border-top:1px dashed #e7ebf0;margin-top:10px;padding-top:10px;}
      .sm-sec-title{font-size:12px;color:#9aa3b2;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;}
      .sm-fu{font-size:13px;color:#3a4252;margin-bottom:8px;padding-left:8px;border-left:3px solid #6c8cff;}
      .sm-fu .d{font-size:11px;color:#9aa3b2;}
      .sm-doc{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:6px 8px;border-radius:6px;text-decoration:none;color:#1a2233;}
      .sm-doc:hover{background:#f4f6fa;}
      .sm-doc .t{color:#1a2233;word-break:break-all;}
      .sm-doc .s{color:#7a8494;font-size:11px;white-space:nowrap;margin-left:8px;}
      .sm-go{display:inline-block;margin-top:8px;}
      .sm-list-title{font-weight:700;font-size:15px;margin-bottom:2px;color:#1a2233;}
      .sm-list-sub{font-size:12px;color:#7a8494;margin-bottom:10px;}
      .sm-cust-row{display:block;padding:8px 10px;border:1px solid #e7ebf0;border-radius:8px;margin-bottom:6px;text-decoration:none;color:#1a2233;cursor:pointer;}
      .sm-cust-row:hover{background:#f4f6fa;border-color:#c9d4f0;}
      .sm-cust-row .n{font-weight:600;font-size:13px;word-break:break-word;}
      .sm-cust-row .m{font-size:11px;color:#7a8494;}
      .sm-back{width:100%;}
      @media(max-width:900px){.starmap-wrap{grid-template-columns:1fr;height:auto;}.starmap-stage{height:60vh;}}
    </style>
    <div class="starmap-wrap">
      <div class="starmap-stage">
        <div id="smChart"></div>
        <div class="starmap-legend">颜色越深 = 客户越多 · 点击国家查看客户</div>
      </div>
      <div class="starmap-panel" id="smPanel">
        <div class="sm-empty">点击地图上的国家<br>查看该国客户列表</div>
      </div>
    </div>
    <script src="/static/vendor/echarts/echarts.min.js"></script>
    <script>
    (function () {
      var CONFIG = { apiUrl: "/api/crm/starmap", fallbackDemo: false };
      var chartEl = document.getElementById('smChart');
      var panel = document.getElementById('smPanel');
      var customers = [];

      // 国家值 → 世界地图区域名（归一化脏数据）
      var COUNTRY_MAP = {
        '尼日利亚': 'Nigeria', 'nigeria': 'Nigeria',
        '斯里兰卡': 'Sri Lanka', 'sri lanka': 'Sri Lanka',
        '坦桑尼亚': 'Tanzania', 'tanzania': 'Tanzania',
        '莫桑比克': 'Mozambique', 'mozambique': 'Mozambique',
        '肯尼亚': 'Kenya', 'kenya': 'Kenya',
        '加纳': 'Ghana', 'ghana': 'Ghana',
        '刚果（金）': 'Dem. Rep. Congo', '刚果金': 'Dem. Rep. Congo', 'dr congo': 'Dem. Rep. Congo',
        '阿曼': 'Oman', 'oman': 'Oman',
        '科特迪瓦': "Côte d'Ivoire", 'ivory coast': "Côte d'Ivoire",
        '津巴布韦': 'Zimbabwe', 'zimbabwe': 'Zimbabwe',
        '柬埔寨': 'Cambodia', 'cambodia': 'Cambodia',
        '巴西': 'Brazil', 'brazil': 'Brazil',
        '巴基斯坦': 'Pakistan', 'pakistan': 'Pakistan',
        '印度': 'India', 'india': 'India',
        '俄罗斯': 'Russia', 'russia': 'Russia',
        '伊拉克': 'Iraq', 'iraq': 'Iraq',
        '也门': 'Yemen', 'yemen': 'Yemen',
        '乌兹别克斯坦': 'Uzbekistan', 'uzbekistan': 'Uzbekistan'
      };

      function normCountry (raw) {
        var s = String(raw || '').trim();
        if (!s) return '';
        var low = s.toLowerCase();
        if (COUNTRY_MAP[low] != null) return COUNTRY_MAP[low];
        // 含英文名的「中文 英文」写法：取末尾英文部分
        var m = s.match(/[a-z\u00c0-\u017f][a-z\u00c0-\u017f' .-]+$/i);
        if (m) {
          var en = m[0].trim();
          if (COUNTRY_MAP[en.toLowerCase()] != null) return COUNTRY_MAP[en.toLowerCase()];
          return en;
        }
        return s;
      }

      function escHtml (s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
        });
      }

      function fmtAmt (a) {
        if (!a) return '0';
        return Number(a).toLocaleString(undefined, { maximumFractionDigits: 0 });
      }

      function renderCountryList (country, arr) {
        var rows = arr.map(function (c) {
          var ws = c.weeksSince == null ? '无跟进' : (c.weeksSince === 0 ? '本周跟进' : c.weeksSince + ' 周未跟进');
          var tag = c.weeksSince != null && c.weeksSince >= 4 ? ' <span class="badge text-bg-danger" style="font-size:10px">超期</span>' : '';
          return '<div class="sm-cust-row" data-id="' + c.id + '">' +
            '<div class="n">' + escHtml(c.name || ('#' + c.id)) + tag + '</div>' +
            '<div class="m">累计成交 ' + fmtAmt(c.amount) + ' · ' + ws + '</div></div>';
        }).join('');
        panel.innerHTML =
          '<div class="sm-list-title">' + escHtml(country) + '</div>' +
          '<div class="sm-list-sub">共 ' + arr.length + ' 家客户</div>' +
          rows +
          '<button class="btn btn-sm btn-outline-secondary sm-back mt-2" type="button"><i class="bi bi-arrow-left"></i> 返回世界地图</button>';
        panel.querySelectorAll('.sm-cust-row').forEach(function (el) {
          el.addEventListener('click', function () {
            var c = customers.find(function (x) { return String(x.id) === el.getAttribute('data-id'); });
            if (c) renderDetail(c);
          });
        });
        panel.querySelector('.sm-back').addEventListener('click', function () {
          panel.innerHTML = '<div class="sm-empty">点击地图上的国家<br>查看该国客户列表</div>';
        });
      }

      function renderDetail (c) {
        var f = (c.followups || []).map(function (x) {
          return '<div class="sm-fu"><div>' + escHtml(x.text || '(无内容)') + '</div><div class="d">' + escHtml(x.date || '') + '</div></div>';
        }).join('') || '<div class="sm-empty">暂无跟进记录</div>';
        var d = (c.docs || []).map(function (x) {
          return '<a class="sm-doc" href="' + escHtml(x.url || '#') + '"><span class="t">' + escHtml(x.title || '单据') + '</span><span class="s">' + escHtml(x.summary || '') + '</span></a>';
        }).join('') || '<div class="sm-empty">暂无关联单据</div>';
        panel.innerHTML =
          '<button class="btn btn-sm btn-outline-secondary sm-back mb-2" type="button"><i class="bi bi-arrow-left"></i> 返回国家列表</button>' +
          '<div class="sm-cust-name">' + escHtml(c.name || ('#' + c.id)) + '</div>' +
          '<div class="sm-cust-meta">' + escHtml(c.country || '') + ' · 累计成交 ' + fmtAmt(c.amount) + ' · ' + (c.weeksSince == null ? '无跟进' : (c.weeksSince === 0 ? '本周跟进' : '距上次跟进 ' + c.weeksSince + ' 周')) + '</div>' +
          '<a class="btn btn-sm btn-outline-primary sm-go" href="/customers/' + c.id + '"><i class="bi bi-arrow-right-circle"></i> 客户档案</a>' +
          '<div class="sm-sec"><div class="sm-sec-title">最近跟进</div>' + f + '</div>' +
          '<div class="sm-sec"><div class="sm-sec-title">关联单据</div>' + d + '</div>';
        panel.querySelector('.sm-back').addEventListener('click', function () {
          renderCountryList(c._mapCountry, customers.filter(function (x) { return x._mapCountry === c._mapCountry; }));
        });
      }

      function render () {
        var byCountry = {}, order = [];
        customers.forEach(function (c) {
          c._mapCountry = normCountry(c.country);
          if (!c._mapCountry) return;
          if (!byCountry[c._mapCountry]) { byCountry[c._mapCountry] = []; order.push(c._mapCountry); }
          byCountry[c._mapCountry].push(c);
        });
        var data = order.map(function (co) {
          return { name: co, value: byCountry[co].length, _arr: byCountry[co] };
        });
        var unmatched = customers.filter(function (c) { return !c._mapCountry; }).length;

        var chart = echarts.init(chartEl);
        var maxV = data.length ? Math.max.apply(null, data.map(function (d) { return d.value; })) : 1;
        chart.setOption({
          tooltip: {
            trigger: 'item',
            formatter: function (p) {
              if (p.data && p.data._arr) return p.name + '：' + p.data.value + ' 家客户<br><span style="font-size:11px;color:#999">点击查看</span>';
              return p.name;
            }
          },
          visualMap: {
            min: 0, max: maxV, left: 12, bottom: 12, text: ['多', '少'],
            calculable: true, inRange: { color: ['#16213e', '#1a3a8f', '#2d6cdf', '#7db8ff'] }
          },
          series: [{
            type: 'map', map: 'world', roam: true,
            label: { show: false }, emphasis: { label: { show: true } },
            itemStyle: { borderColor: '#0b1020', borderWidth: 0.5, areaColor: '#16213e' },
            data: data
          }]
        });
        chart.off('click');
        chart.on('click', function (p) {
          if (p.data && p.data._arr && p.data._arr.length) {
            renderCountryList(p.name, p.data._arr);
          }
        });
        window.__chart = chart;
        if (unmatched > 0) console.warn('[世界地图] ' + unmatched + ' 家客户的国家无法匹配到地图');
      }

      window.addEventListener('resize', function () { if (window.__chart) window.__chart.resize(); });

      // 先加载 geo，再拉客户数据，最后渲染
      Promise.all([
        fetch('/static/vendor/geo/world.json').then(function (r) { return r.json(); }),
        fetch(CONFIG.apiUrl).then(function (r) { return r.json(); })
      ]).then(function (res) {
        echarts.registerMap('world', res[0]);
        customers = res[1].customers || [];
        if (!customers.length) {
          panel.innerHTML = '<div class="sm-empty">暂无客户数据</div>';
          return;
        }
        render();
      }).catch(function (e) {
        console.error(e);
        panel.innerHTML = '<div class="sm-empty">数据加载失败：' + escHtml(e && e.message) + '</div>';
      });
    })();
    </script>`;
  return page({ title: '统计', active: 'stats', user: ctx.user, content, flash: ctx.flash() });
}

module.exports = { starmapPage };
