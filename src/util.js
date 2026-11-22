'use strict';
// ============ 通用工具函数 ============

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(s) { return esc(s); }

// 本地日期 YYYY-MM-DD
function todayStr(d) {
  const x = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}
function nowStr(d) {
  const x = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return todayStr(x) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes()) + ':' + p(x.getSeconds());
}
function parseDateYMD(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  return (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) ? dt : null;
}
function addDays(s, n) {
  const dt = parseDateYMD(s) || new Date();
  dt.setDate(dt.getDate() + n);
  return todayStr(dt);
}

// 数字千分位（保留两位）
function money(n) {
  const v = Number(n || 0);
  const neg = v < 0;
  const s = Math.abs(v).toFixed(2);
  const [i, dec] = s.split('.');
  const withC = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withC + '.' + dec;
}
// 数量：去掉多余小数
function num(n) {
  const v = Number(n || 0);
  if (!isFinite(v)) return '0';
  return String(Math.round(v * 10000) / 10000);
}

// 中文大写金额
const CN_NUM = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const CN_UNIT = ['', '拾', '佰', '仟'];
const CN_BIG = ['', '万', '亿', '万亿'];
function cnMoney(n) {
  let v = Number(n || 0);
  if (!isFinite(v)) return '';
  if (v === 0) return '零元整';
  let prefix = '';
  if (v < 0) { prefix = '负'; v = -v; }
  v = Math.round(v * 100) / 100;
  const yuan = Math.floor(v);
  let jiao = Math.floor((v * 10)) % 10;
  let fen = Math.round(v * 100) % 10;
  if (jiao === 0 && fen === 0 && yuan === 0) return prefix + '零元整';
  // 处理精度
  const cents = Math.round(v * 100);
  const y2 = Math.floor(cents / 100);
  jiao = Math.floor((cents % 100) / 10);
  fen = cents % 10;
  function intCn(x) {
    if (x === 0) return '';
    let s = '';
    let zero = false;
    let seg = 0;
    while (x > 0) {
      const part = x % 10000;
      let partStr = '';
      let pZero = false;
      const d3 = Math.floor(part / 1000), d2 = Math.floor(part % 1000 / 100), d1 = Math.floor(part % 100 / 10), d0 = part % 10;
      if (seg > 0 && part < 1000) partStr = '零';
      if (d3) { partStr += CN_NUM[d3] + '仟'; pZero = false; } else if (partStr.length && (d2 || d1 || d0)) pZero = true;
      if (d2) { partStr += CN_NUM[d2] + '佰'; pZero = false; } else if (partStr.length && !pZero && (d1 || d0)) { pZero = true; }
      if (d1) { partStr += CN_NUM[d1] + '拾'; pZero = false; } else if (partStr.length && !pZero && d0) { pZero = true; }
      if (d0) partStr += CN_NUM[d0];
      s = partStr + CN_BIG[seg] + s;
      seg++;
      x = Math.floor(x / 10000);
    }
    // 去除连续的 零
    s = s.replace(/零+/g, '零').replace(/零(万|亿)/g, '$1').replace(/^零/, '');
    return s;
  }
  let out = prefix;
  if (y2 > 0) out += intCn(y2) + '元';
  const small = [];
  if (jiao) small.push(CN_NUM[jiao] + '角');
  if (fen) small.push(CN_NUM[fen] + '分');
  if (small.length) {
    if (y2 > 0 && jiao === 0) out += '零';
    out += small.join('');
  } else {
    out += '整';
  }
  return out;
}

function randomToken(len) {
  const b = require('crypto').randomBytes(Math.ceil(len / 2));
  return b.toString('hex').slice(0, len);
}

// 国际电话区号 -> 国家/地区（用于根据电话自动识别）
const COUNTRY_CODES = [
  ['1', '美国 United States'], ['7', '俄罗斯 Russia'],
  ['20', '埃及 Egypt'], ['27', '南非 South Africa'], ['30', '希腊 Greece'], ['31', '荷兰 Netherlands'],
  ['32', '比利时 Belgium'], ['33', '法国 France'], ['34', '西班牙 Spain'], ['36', '匈牙利 Hungary'],
  ['39', '意大利 Italy'], ['40', '罗马尼亚 Romania'], ['41', '瑞士 Switzerland'], ['43', '奥地利 Austria'],
  ['44', '英国 United Kingdom'], ['45', '丹麦 Denmark'], ['46', '瑞典 Sweden'], ['47', '挪威 Norway'],
  ['48', '波兰 Poland'], ['49', '德国 Germany'], ['51', '秘鲁 Peru'], ['52', '墨西哥 Mexico'],
  ['53', '古巴 Cuba'], ['54', '阿根廷 Argentina'], ['55', '巴西 Brazil'], ['56', '智利 Chile'],
  ['57', '哥伦比亚 Colombia'], ['58', '委内瑞拉 Venezuela'], ['60', '马来西亚 Malaysia'],
  ['61', '澳大利亚 Australia'], ['62', '印度尼西亚 Indonesia'], ['63', '菲律宾 Philippines'],
  ['64', '新西兰 New Zealand'], ['65', '新加坡 Singapore'], ['66', '泰国 Thailand'],
  ['81', '日本 Japan'], ['82', '韩国 South Korea'], ['84', '越南 Vietnam'], ['86', '中国 China'],
  ['90', '土耳其 Turkey'], ['91', '印度 India'], ['92', '巴基斯坦 Pakistan'], ['93', '阿富汗 Afghanistan'],
  ['94', '斯里兰卡 Sri Lanka'], ['95', '缅甸 Myanmar'], ['98', '伊朗 Iran'],
  ['211', '南苏丹 South Sudan'], ['212', '摩洛哥 Morocco'], ['213', '阿尔及利亚 Algeria'],
  ['216', '突尼斯 Tunisia'], ['218', '利比亚 Libya'], ['220', '冈比亚 Gambia'], ['221', '塞内加尔 Senegal'],
  ['222', '毛里塔尼亚 Mauritania'], ['223', '马里 Mali'], ['224', '几内亚 Guinea'], ['225', '科特迪瓦 Ivory Coast'],
  ['226', '布基纳法索 Burkina Faso'], ['227', '尼日尔 Niger'], ['228', '多哥 Togo'], ['229', '贝宁 Benin'],
  ['230', '毛里求斯 Mauritius'], ['231', '利比里亚 Liberia'], ['232', '塞拉利昂 Sierra Leone'],
  ['233', '加纳 Ghana'], ['234', '尼日利亚 Nigeria'], ['235', '乍得 Chad'],
  ['236', '中非共和国 Central African Republic'], ['237', '喀麦隆 Cameroon'], ['238', '佛得角 Cape Verde'],
  ['239', '圣多美和普林西比 Sao Tome and Principe'], ['240', '赤道几内亚 Equatorial Guinea'],
  ['241', '加蓬 Gabon'], ['242', '刚果（布） Republic of the Congo'], ['243', '刚果（金） DR Congo'],
  ['244', '安哥拉 Angola'], ['245', '几内亚比绍 Guinea-Bissau'], ['248', '塞舌尔 Seychelles'],
  ['249', '苏丹 Sudan'], ['250', '卢旺达 Rwanda'], ['251', '埃塞俄比亚 Ethiopia'], ['252', '索马里 Somalia'],
  ['253', '吉布提 Djibouti'], ['254', '肯尼亚 Kenya'], ['255', '坦桑尼亚 Tanzania'],
  ['256', '乌干达 Uganda'], ['257', '布隆迪 Burundi'], ['258', '莫桑比克 Mozambique'],
  ['260', '赞比亚 Zambia'], ['261', '马达加斯加 Madagascar'], ['263', '津巴布韦 Zimbabwe'],
  ['264', '纳米比亚 Namibia'], ['265', '马拉维 Malawi'], ['266', '莱索托 Lesotho'],
  ['267', '博茨瓦纳 Botswana'], ['268', '斯威士兰 Eswatini'], ['269', '科摩罗 Comoros'],
  ['291', '厄立特里亚 Eritrea'], ['297', '阿鲁巴 Aruba'], ['298', '法罗群岛 Faroe Islands'],
  ['299', '格陵兰 Greenland'], ['350', '直布罗陀 Gibraltar'], ['351', '葡萄牙 Portugal'],
  ['352', '卢森堡 Luxembourg'], ['353', '爱尔兰 Ireland'], ['354', '冰岛 Iceland'],
  ['355', '阿尔巴尼亚 Albania'], ['356', '马耳他 Malta'], ['357', '塞浦路斯 Cyprus'],
  ['358', '芬兰 Finland'], ['359', '保加利亚 Bulgaria'], ['370', '立陶宛 Lithuania'],
  ['371', '拉脱维亚 Latvia'], ['372', '爱沙尼亚 Estonia'], ['373', '摩尔多瓦 Moldova'],
  ['374', '亚美尼亚 Armenia'], ['375', '白俄罗斯 Belarus'], ['376', '安道尔 Andorra'],
  ['377', '摩纳哥 Monaco'], ['378', '圣马力诺 San Marino'], ['380', '乌克兰 Ukraine'],
  ['381', '塞尔维亚 Serbia'], ['382', '黑山 Montenegro'], ['383', '科索沃 Kosovo'],
  ['385', '克罗地亚 Croatia'], ['386', '斯洛文尼亚 Slovenia'], ['387', '波黑 Bosnia and Herzegovina'],
  ['389', '北马其顿 North Macedonia'], ['420', '捷克 Czech Republic'], ['421', '斯洛伐克 Slovakia'],
  ['423', '列支敦士登 Liechtenstein'], ['500', '福克兰群岛 Falkland Islands'], ['501', '伯利兹 Belize'],
  ['502', '危地马拉 Guatemala'], ['503', '萨尔瓦多 El Salvador'], ['504', '洪都拉斯 Honduras'],
  ['505', '尼加拉瓜 Nicaragua'], ['506', '哥斯达黎加 Costa Rica'], ['507', '巴拿马 Panama'],
  ['509', '海地 Haiti'], ['590', '瓜德罗普 Guadeloupe'], ['591', '玻利维亚 Bolivia'],
  ['592', '圭亚那 Guyana'], ['593', '厄瓜多尔 Ecuador'], ['594', '法属圭亚那 French Guiana'],
  ['595', '巴拉圭 Paraguay'], ['596', '马提尼克 Martinique'], ['597', '苏里南 Suriname'],
  ['598', '乌拉圭 Uruguay'], ['599', '库拉索 Curacao'], ['670', '东帝汶 East Timor'],
  ['673', '文莱 Brunei'], ['674', '瑙鲁 Nauru'], ['675', '巴布亚新几内亚 Papua New Guinea'],
  ['676', '汤加 Tonga'], ['677', '所罗门群岛 Solomon Islands'], ['678', '瓦努阿图 Vanuatu'],
  ['679', '斐济 Fiji'], ['680', '帕劳 Palau'], ['685', '萨摩亚 Samoa'], ['686', '基里巴斯 Kiribati'],
  ['688', '图瓦卢 Tuvalu'], ['689', '法属波利尼西亚 French Polynesia'], ['691', '密克罗尼西亚 Micronesia'],
  ['692', '马绍尔群岛 Marshall Islands'], ['850', '朝鲜 North Korea'], ['852', '中国香港 Hong Kong (China)'],
  ['853', '中国澳门 Macao (China)'], ['855', '柬埔寨 Cambodia'], ['856', '老挝 Laos'],
  ['880', '孟加拉国 Bangladesh'], ['886', '中国台湾 Taiwan (China)'], ['960', '马尔代夫 Maldives'],
  ['961', '黎巴嫩 Lebanon'], ['962', '约旦 Jordan'], ['963', '叙利亚 Syria'], ['964', '伊拉克 Iraq'],
  ['965', '科威特 Kuwait'], ['966', '沙特阿拉伯 Saudi Arabia'], ['967', '也门 Yemen'],
  ['968', '阿曼 Oman'], ['970', '巴勒斯坦 Palestine'], ['971', '阿联酋 U.A.E.'],
  ['972', '以色列 Israel'], ['973', '巴林 Bahrain'], ['974', '卡塔尔 Qatar'], ['975', '不丹 Bhutan'],
  ['976', '蒙古 Mongolia'], ['977', '尼泊尔 Nepal'], ['992', '塔吉克斯坦 Tajikistan'],
  ['993', '土库曼斯坦 Turkmenistan'], ['994', '阿塞拜疆 Azerbaijan'], ['995', '格鲁吉亚 Georgia'],
  ['996', '吉尔吉斯斯坦 Kyrgyzstan'], ['998', '乌兹别克斯坦 Uzbekistan'],
];


// 根据电话号码猜国家/地区（区号匹配最长优先）
function guessCountry(phone) {
  const raw = String(phone || '').replace(/[\s\-()]/g, '');
  let s = raw;
  let explicit = false;
  if (s.startsWith('+')) { s = s.slice(1); explicit = true; }
  else if (s.startsWith('00')) { s = s.slice(2); explicit = true; }
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  const list = COUNTRY_CODES.slice().sort((a, b) => b[0].length - a[0].length);
  for (const [code, label] of list) {
    if (digits.startsWith(code)) {
      if (!explicit && code.length === 1) continue;
      return label;
    }
  }
  return '';
}

// 把“区号 + 号码”合成完整电话（兼容 968 / +968 / 0086 写法）
function makePhone(code, number) {
  const c = String(code || '').trim();
  const n = String(number || '').trim();
  if (!c) return n;
  let digits = c.replace(/\D/g, '');
  let prefix;
  if (c.startsWith('+')) prefix = '+' + digits;
  else if (c.startsWith('00')) prefix = '+' + digits.replace(/^00/, '');
  else prefix = '+' + digits;
  if (!n) return prefix;
  return prefix + ' ' + n;
}

// 拆分完整电话 -> { code:'+968', number:'9417 2440' }
function splitPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return { code: '', number: '' };
  const cleaned = raw.replace(/[\s\-()]/g, '');
  let body = cleaned;
  const hadPrefix = cleaned.startsWith('+') || cleaned.startsWith('00');
  let prefix00 = false;
  if (body.startsWith('+')) body = body.slice(1);
  else if (body.startsWith('00')) { body = body.slice(2); prefix00 = true; }
  const digits = body.replace(/\D/g, '');
  const list = COUNTRY_CODES.slice().sort((a, b) => b[0].length - a[0].length);
  let codeDigits = '';
  for (const [code] of list) {
    if (digits.startsWith(code) && (hadPrefix || code.length > 1)) { codeDigits = code; break; }
  }
  if (!codeDigits && !cleaned.startsWith('+') && !cleaned.startsWith('00')) return { code: '', number: raw };
  if (codeDigits) {
    const rest = cleaned.replace(/^[+0]*/, '').slice(codeDigits.length);
    return { code: '+' + codeDigits, number: rest.replace(/\D/g, '') };
  }
  return { code: '', number: raw };
}

// 把系统中显示的国家/地区文本转成地图用的英文名（ECharts world.json 用英文）
const COUNTRY_EN_ALIAS = {
  'U.A.E.': 'United Arab Emirates', 'UAE': 'United Arab Emirates', '阿联酋': 'United Arab Emirates',
  'USA': 'United States', 'US': 'United States', '美国': 'United States',
  'UK': 'United Kingdom', '英国': 'United Kingdom',
  '香港': 'China', '中国香港': 'China', 'Hong Kong (China)': 'China',
  '澳门': 'China', '中国澳门': 'China', 'Macao (China)': 'China',
  'Korea': 'South Korea', '韩国': 'South Korea',
  '俄罗斯': 'Russia', '日本': 'Japan', '德国': 'Germany', '法国': 'France',
  '意大利': 'Italy', '西班牙': 'Spain', '荷兰': 'Netherlands', '瑞典': 'Sweden',
  '澳大利亚': 'Australia', '新加坡': 'Singapore', '泰国': 'Thailand', '阿曼': 'Oman',
};
function mapCountryName(label) {
  const raw = String(label || '').trim();
  if (!raw) return '';
  if (COUNTRY_EN_ALIAS[raw]) return COUNTRY_EN_ALIAS[raw];
  // '美国 United States' 取空格后的英文；'美国' 走中文别名表
  const sp = raw.indexOf(' ');
  if (sp > 0) {
    const en = raw.slice(sp + 1).trim();
    const enHead = en.split('(')[0].trim();
    if (COUNTRY_EN_ALIAS[enHead]) return COUNTRY_EN_ALIAS[enHead];
    return enHead;
  }
  return COUNTRY_EN_ALIAS[raw] || raw;
}

module.exports = { esc, escAttr, todayStr, nowStr, parseDateYMD, addDays, money, num, cnMoney, randomToken, COUNTRY_CODES, guessCountry, makePhone, splitPhone, mapCountryName };




