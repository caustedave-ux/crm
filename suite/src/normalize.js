'use strict';
/**
 * 归一化模块：把来自不同来源的自由文本，收敛到统一口径。
 * - 行业：中英文关键词 → 一级行业 + 细分行业（参考 NAICS / 外贸常用品类）
 * - 规模：员工数文本 → 标准区间档；营收文本 → 美元档
 * - 域名 / 国家 / 公司名规范化
 */

// ── 行业词典：{ 一级行业: { 细分: [中英文关键词...] } }
// 命中越靠前的细分优先级越高（数组顺序即优先级），做「最长/最具体优先」匹配。
const INDUSTRY_RULES = [
  { sector: '机械设备与制造', subs: [
    { name: '工业机械与设备', kw: ['industrial machinery','machine tools','cnc','manufacturing equipment','factory automation','industrial equipment','机械设备','机床','自动化设备','工业设备'] },
    { name: '建筑与工程机械', kw: ['construction machinery','excavator','bulldozer','crane','forklift','construction equipment','工程机械','挖掘机','起重机','叉车'] },
    { name: '农业机械', kw: ['agricultural machinery','tractor','harvester','farm equipment','农业机械','拖拉机','收割机'] },
    { name: '矿山机械', kw: ['mining machinery','crusher','conveyor','mining equipment','矿山机械','破碎机','输送机'] },
    { name: '包装机械', kw: ['packaging machine','packing machine','filling machine','包装机械','灌装机','封口机'] },
  ]},
  { sector: '五金与建材', subs: [
    { name: '门窗与安防五金', kw: ['door hardware','door & window','window hardware','security hardware','access control','access solution','door solution','door system','smart access','locks','hinges','door closer','entrance system','门控','门禁','安防','门窗','门锁','合页','闭门器','出入口'] },
    { name: '建筑材料', kw: ['building materials','construction materials','tiles','sanitary ware','ceramic','cement','建筑材料','瓷砖','卫浴','陶瓷','水泥'] },
    { name: '五金工具', kw: ['hardware tools','hand tools','power tools','fasteners','screws','五金工具','电动工具','紧固件','螺丝'] },
    { name: '家具与家居', kw: ['furniture','sofa','cabinet','home decor','家具','沙发','橱柜','家居'] },
  ]},
  { sector: '电子与电气', subs: [
    { name: '消费电子', kw: ['consumer electronics','mobile phone','tablet','earphone','smart watch','消费电子','手机','耳机','智能手表'] },
    { name: '电子元器件', kw: ['electronic components','semiconductor','pcb','connector','capacitor','电子元器件','半导体','线路板','连接器'] },
    { name: '电气与电力设备', kw: ['electrical equipment','power equipment','switchgear','transformer','cable','电气设备','电力设备','开关柜','变压器','线缆'] },
    { name: '照明', kw: ['lighting','led light','lamp','照明','灯具','LED'] },
    { name: '太阳能与新能源', kw: ['solar','photovoltaic','inverter','battery storage','renewable energy','太阳能','光伏','逆变器','储能','新能源'] },
  ]},
  { sector: '汽车与交通', subs: [
    { name: '汽车零部件', kw: ['auto parts','automotive parts','car accessories','brake','engine parts','汽车零部件','汽车配件','刹车','配件'] },
    { name: '整车与商用车', kw: ['vehicle manufacturer','automobile','truck','bus','commercial vehicle','汽车制造','卡车','客车','商用车'] },
    { name: '摩托车与配件', kw: ['motorcycle','riding','moto parts','摩托车','头盔'] },
  ]},
  { sector: '纺织服装', subs: [
    { name: '服装服饰', kw: ['apparel','garment','clothing','fashion','textile','服装','服饰','成衣','时装'] },
    { name: '面料与家纺', kw: ['fabric','textile','yarn','home textile','bedding','面料','纱线','家纺','床品'] },
    { name: '鞋帽箱包', kw: ['shoes','footwear','bags','hats','鞋','箱包','帽子'] },
  ]},
  { sector: '化工与塑料', subs: [
    { name: '化工原料', kw: ['chemical','chemicals','coating','paint','dye','化工','涂料','油漆','染料'] },
    { name: '塑料橡胶制品', kw: ['plastic','rubber','polyethylene','pvc','injection molding','塑料','橡胶','注塑'] },
    { name: '化妆品与日化', kw: ['cosmetics','personal care','skincare','beauty','化妆品','护肤','日化','美妆'] },
  ]},
  { sector: '食品与农业', subs: [
    { name: '食品饮料', kw: ['food','beverage','food processing','snack','drink','食品','饮料','食品加工'] },
    { name: '农产品与农资', kw: ['agriculture','agri','fertilizer','pesticide','grain','农产品','农资','化肥','农药','粮食'] },
  ]},
  { sector: '医药与健康', subs: [
    { name: '医药与生物', kw: ['pharmaceutical','pharma','biotech','medical','drug','医药','制药','生物','医疗'] },
    { name: '医疗器械', kw: ['medical device','medical equipment','surgical','diagnostic','医疗器械','医疗设备','耗材'] },
  ]},
  { sector: 'IT与软件', subs: [
    { name: '软件与信息服务', kw: ['software','saas','it services','information technology','app development','软件','信息技术','互联网','信息服务'] },
    { name: '电子产品制造', kw: ['electronics manufacturing','ems','assembly','电子制造','代工'] },
  ]},
  { sector: '贸易与流通', subs: [
    { name: '进出口贸易', kw: ['import export','import & export','trading company','wholesale','distributor','进出口','贸易','批发','分销'] },
    { name: '零售与电商', kw: ['retail','e-commerce','online store','amazon seller','零售','电商','跨境电商'] },
  ]},
  { sector: '服务与其他', subs: [
    { name: '物流运输', kw: ['logistics','shipping','freight','supply chain','物流','货运','供应链'] },
    { name: '建筑与工程服务', kw: ['construction','engineering','contractor','architecture','建筑','工程','装饰'] },
    { name: '咨询服务', kw: ['consulting','consultancy','business services','咨询','顾问'] },
  ]},
];

const SIZE_BUCKETS = [
  { key: '1-10',     label: '微型 (1-10人)',   min: 1,   max: 10 },
  { key: '11-50',    label: '小型 (11-50人)',  min: 11,  max: 50 },
  { key: '51-200',   label: '中型 (51-200人)', min: 51,  max: 200 },
  { key: '201-500',  label: '中大型 (201-500人)', min: 201, max: 500 },
  { key: '501-1000', label: '大型 (501-1000人)', min: 501, max: 1000 },
  { key: '1001-5000',label: '大型 (1001-5000人)', min: 1001, max: 5000 },
  { key: '5000+',    label: '超大型 (5000人以上)', min: 5000, max: Infinity },
];

/** 从自由文本识别行业，返回 {sector, sub, keyword, score} 或 null */
function classifyIndustry(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  let best = null;
  for (const group of INDUSTRY_RULES) {
    for (const sub of group.subs) {
      for (const kw of sub.kw) {
        if (s.includes(kw.toLowerCase())) {
          // 关键词越长越具体，得分越高
          const score = kw.length + (sub.kw.indexOf(kw) === 0 ? 2 : 0);
          if (!best || score > best.score) {
            best = { sector: group.sector, sub: sub.name, keyword: kw, score };
          }
        }
      }
    }
  }
  return best;
}

/** 把员工数文本解析为 { count|null, bucket|null } */
function parseEmployees(text) {
  if (!text) return { count: null, bucket: null };
  const s = String(text).toLowerCase();
  // 优先匹配区间 "51-200 employees"（数字允许 1~7 位、含千分位）
  let m = s.match(/(\d[\d,]{0,8})\s*[-–~至到]\s*(\d[\d,]{0,8})\s*(?:employees|staff|people|员工|人)?/);
  if (m) {
    const lo = parseInt(m[1].replace(/,/g, ''), 10);
    const hi = parseInt(m[2].replace(/,/g, ''), 10);
    if (lo > 0 && hi >= lo && hi < 5000000) {
      const mid = Math.round((lo + hi) / 2);
      return { count: mid, range: [lo, hi], bucket: bucketOf(mid) };
    }
  }
  // "over 1000 employees" / "500+ employees" / "10,001+ employees" / "1000 employees"
  m = s.match(/(\d[\d,]{0,8})\s*\+?\s*(?:employees|staff|people|员工)/);
  if (m) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n > 0 && n < 5000000) return { count: n, bucket: bucketOf(n) };
  }
  // "employees: 200" / "员工 200"
  m = s.match(/(?:employees|staff|people|员工)[^\d]{0,6}(\d[\d,]{0,8})/);
  if (m) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n > 0 && n < 5000000) return { count: n, bucket: bucketOf(n) };
  }
  return { count: null, bucket: null };
}

function bucketOf(n) {
  if (n == null) return null;
  for (const b of SIZE_BUCKETS) if (n >= b.min && n <= b.max) return b.key;
  return '5000+';
}
function bucketLabel(key) {
  const b = SIZE_BUCKETS.find(x => x.key === key);
  return b ? b.label : (key || '');
}

/** 营收文本 → 美元档位（粗略） */
function parseRevenue(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  const m = s.match(/([0-9.]+)\s*(million|billion|m|b|万|亿)?\s*(usd|dollars?|\$)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = m[2] || '';
  if (unit === 'billion' || unit === 'b') n *= 1e9;
  else if (unit === 'million' || unit === 'm') n *= 1e6;
  else if (unit === '亿') n *= 1e8;
  else if (unit === '万') n *= 1e4;
  if (n < 1e6) return '<$1M';
  if (n < 1e7) return '$1M-10M';
  if (n < 5e7) return '$10M-50M';
  if (n < 2e8) return '$50M-200M';
  if (n < 1e9) return '$200M-1B';
  return '$1B+';
}

/** 规范化域名：去协议、www、路径、端口 */
function normalizeDomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  if (!s.includes('://')) s = 'http://' + s;
  try {
    const u = new URL(s);
    let h = u.hostname.replace(/^www\./, '');
    return h;
  } catch { return ''; }
}

/** 规范化公司名：小写、去后缀、去标点，用于去重 */
function normalizeCompanyName(input) {
  if (!input) return '';
  return String(input).toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|s\.a|bv|plc)\b/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
    .trim();
}

/** 从国家文本/域名推断国家（常见外贸市场） */
const COUNTRY_HINTS = {
  'us': ['united states', 'u.s.', 'usa', 'america', '美国'],
  'de': ['germany', 'deutschland', '德国'],
  'uk': ['united kingdom', 'england', 'britain', '英国'],
  'fr': ['france', '法国'],
  'it': ['italy', '意大利'],
  'es': ['spain', '西班牙'],
  'nl': ['netherlands', 'holland', '荷兰'],
  'au': ['australia', '澳大利亚'],
  'ca': ['canada', '加拿大'],
  'jp': ['japan', '日本'],
  'kr': ['south korea', 'korea', '韩国'],
  'in': ['india', '印度'],
  'br': ['brazil', '巴西'],
  'mx': ['mexico', '墨西哥'],
  'ae': ['uae', 'dubai', 'abu dhabi', '阿联酋', '迪拜'],
  'sa': ['saudi arabia', '沙特'],
  'za': ['south africa', '南非'],
  'ng': ['nigeria', '尼日利亚'],
  'ke': ['kenya', '肯尼亚'],
  'tr': ['turkey', 'turkiye', '土耳其'],
  'pl': ['poland', '波兰'],
  'ru': ['russia', '俄罗斯'],
  'sg': ['singapore', '新加坡'],
  'my': ['malaysia', '马来西亚'],
  'th': ['thailand', '泰国'],
  'vn': ['vietnam', '越南'],
  'id': ['indonesia', '印尼', '印度尼西亚'],
};
function normalizeCountry(text, domain = '') {
  const s = String(text || '').toLowerCase();
  for (const [code, hints] of Object.entries(COUNTRY_HINTS)) {
    if (hints.some(h => s.includes(h))) return code.toUpperCase();
  }
  // 从域名 ccTLD 推断
  if (domain) {
    const d = domain.split('.').pop();
    if (COUNTRY_HINTS[d] && d !== 'uk' && d !== 'us') return d.toUpperCase();
    if (d === 'uk') return 'UK';
  }
  return text ? String(text).trim() : '';
}

module.exports = {
  INDUSTRY_RULES, SIZE_BUCKETS,
  classifyIndustry, parseEmployees, bucketOf, bucketLabel, parseRevenue,
  normalizeDomain, normalizeCompanyName, normalizeCountry,
};
