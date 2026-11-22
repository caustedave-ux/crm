'use strict';
// ============ 国家/地区 ↔ ISO 3166-1 alpha-2，电话 E.164 归一 ============
// 库里 customers.country 存的是「尼日利亚 Nigeria」这种双语串，导出时需要 NG 这种两字母代码。
// 这里用 util 里已有的国际区号表反推，避免再维护一份国家清单。
const { COUNTRY_CODES } = require('./util');

// 国际区号 → ISO2（与 util.COUNTRY_CODES 的区号一一对应）
const DIAL_ISO = {
  '1': 'US', '7': 'RU', '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL', '32': 'BE', '33': 'FR',
  '34': 'ES', '36': 'HU', '39': 'IT', '40': 'RO', '41': 'CH', '43': 'AT', '44': 'GB', '45': 'DK',
  '46': 'SE', '47': 'NO', '48': 'PL', '49': 'DE', '51': 'PE', '52': 'MX', '53': 'CU', '54': 'AR',
  '55': 'BR', '56': 'CL', '57': 'CO', '58': 'VE', '60': 'MY', '61': 'AU', '62': 'ID', '63': 'PH',
  '64': 'NZ', '65': 'SG', '66': 'TH', '81': 'JP', '82': 'KR', '84': 'VN', '86': 'CN', '90': 'TR',
  '91': 'IN', '92': 'PK', '93': 'AF', '94': 'LK', '95': 'MM', '98': 'IR',
  '211': 'SS', '212': 'MA', '213': 'DZ', '216': 'TN', '218': 'LY', '220': 'GM', '221': 'SN',
  '222': 'MR', '223': 'ML', '224': 'GN', '225': 'CI', '226': 'BF', '227': 'NE', '228': 'TG',
  '229': 'BJ', '230': 'MU', '231': 'LR', '232': 'SL', '233': 'GH', '234': 'NG', '235': 'TD',
  '236': 'CF', '237': 'CM', '238': 'CV', '239': 'ST', '240': 'GQ', '241': 'GA', '242': 'CG',
  '243': 'CD', '244': 'AO', '245': 'GW', '248': 'SC', '249': 'SD', '250': 'RW', '251': 'ET',
  '252': 'SO', '253': 'DJ', '254': 'KE', '255': 'TZ', '256': 'UG', '257': 'BI', '258': 'MZ',
  '260': 'ZM', '261': 'MG', '263': 'ZW', '264': 'NA', '265': 'MW', '266': 'LS', '267': 'BW',
  '268': 'SZ', '269': 'KM', '291': 'ER', '297': 'AW', '298': 'FO', '299': 'GL',
  '350': 'GI', '351': 'PT', '352': 'LU', '353': 'IE', '354': 'IS', '355': 'AL', '356': 'MT',
  '357': 'CY', '358': 'FI', '359': 'BG', '370': 'LT', '371': 'LV', '372': 'EE', '373': 'MD',
  '374': 'AM', '375': 'BY', '376': 'AD', '377': 'MC', '378': 'SM', '380': 'UA', '381': 'RS',
  '382': 'ME', '383': 'XK', '385': 'HR', '386': 'SI', '387': 'BA', '389': 'MK', '420': 'CZ',
  '421': 'SK', '423': 'LI',
  '500': 'FK', '501': 'BZ', '502': 'GT', '503': 'SV', '504': 'HN', '505': 'NI', '506': 'CR',
  '507': 'PA', '509': 'HT', '590': 'GP', '591': 'BO', '592': 'GY', '593': 'EC', '594': 'GF',
  '595': 'PY', '596': 'MQ', '597': 'SR', '598': 'UY', '599': 'CW',
  '670': 'TL', '673': 'BN', '674': 'NR', '675': 'PG', '676': 'TO', '677': 'SB', '678': 'VU',
  '679': 'FJ', '680': 'PW', '685': 'WS', '686': 'KI', '688': 'TV', '689': 'PF', '691': 'FM',
  '692': 'MH',
  '850': 'KP', '852': 'HK', '853': 'MO', '855': 'KH', '856': 'LA', '880': 'BD', '886': 'TW',
  '960': 'MV', '961': 'LB', '962': 'JO', '963': 'SY', '964': 'IQ', '965': 'KW', '966': 'SA',
  '967': 'YE', '968': 'OM', '970': 'PS', '971': 'AE', '972': 'IL', '973': 'BH', '974': 'QA',
  '975': 'BT', '976': 'MN', '977': 'NP', '992': 'TJ', '993': 'TM', '994': 'AZ', '995': 'GE',
  '996': 'KG', '998': 'UZ',
};

// 区号表里没有、但外贸常见的补充（按英文名/别名）
const EXTRA_NAMES = {
  'canada': 'CA', 'kazakhstan': 'KZ', 'kyrgyzstan': 'KG', 'usa': 'US',
  'united states of america': 'US', 'uk': 'GB', 'england': 'GB', 'britain': 'GB',
  'great britain': 'GB', 'viet nam': 'VN', 'russia federation': 'RU', 'korea': 'KR',
  'uae': 'AE', 'u.a.e': 'AE', 'hong kong': 'HK', 'taiwan': 'TW', 'macau': 'MO', 'macao': 'MO',
  'drc': 'CD', 'ivory coast': 'CI', "cote d'ivoire": 'CI',
};

/** 名称 → ISO2；同时收录「中文 English」「English」「中文」三种写法 */
const NAME_ISO = (() => {
  const m = {};
  for (const [dial, label] of COUNTRY_CODES) {
    const iso = DIAL_ISO[dial];
    if (!iso) continue;
    const full = String(label).trim();
    m[full.toLowerCase()] = iso;
    const parts = full.split(' ');
    if (parts.length > 1) m[parts.slice(1).join(' ').toLowerCase()] = iso;   // English
    m[parts[0].toLowerCase()] = iso;                                        // 中文
  }
  return Object.assign(m, EXTRA_NAMES);
})();

const ISO_DIAL = (() => {
  const m = {};
  for (const [iso, dial] of Object.entries(
    Object.fromEntries(Object.entries(DIAL_ISO).map(([d, c]) => [c, d])))) {
    m[iso] = dial;
  }
  return m;
})();

/** 「尼日利亚 Nigeria」/「Nigeria」/「NG」/「ng」 → 'NG'；认不出返回 '' */
function iso2Country(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  const low = raw.toLowerCase();
  if (NAME_ISO[low]) return NAME_ISO[low];
  const cleaned = low.replace(/[()（）]/g, ' ').replace(/\s+/g, ' ').trim();
  if (NAME_ISO[cleaned]) return NAME_ISO[cleaned];
  // 包含匹配（取最长的键，避免 "Rep" 之类误命中）
  let best = '';
  for (const k of Object.keys(NAME_ISO)) {
    if (k.length > 3 && cleaned.indexOf(k) >= 0 && k.length > best.length) best = k;
  }
  return best ? NAME_ISO[best] : '';
}

const DIALS_DESC = Object.keys(DIAL_ISO).sort((a, b) => b.length - a.length);

/**
 * 归一成 E.164：+<国家码><号码>
 * - 已经带 + 或 00 的，保留国际部分
 * - 本地号码（带前导 0 或纯号码）按已知国家补国家码
 * - 认不出国家且不是国际写法时不硬猜（返回空），避免写出错的国家码
 * - 顺手修历史脏数据：国家码被重复粘贴（"+234 +234 806..."）
 */
function intlPhone(raw, iso) {
  const src = String(raw || '').trim();
  if (!src) return '';
  const wasIntl = src.startsWith('+') || /^00\d/.test(src.replace(/[\s\-()]/g, ''));
  let d = src.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);

  // 折叠重复的国家码，例如 2342348065787564 → 2348065787564
  for (const cand of DIALS_DESC) {
    while (d.startsWith(cand + cand)) d = d.slice(cand.length);
  }

  if (d.length < 6) return '';
  const dial = ISO_DIAL[String(iso || '').toUpperCase()] || '';
  if (!wasIntl && dial) {
    if (!d.startsWith(dial)) {
      if (d.startsWith('0')) d = dial + d.replace(/^0+/, '');
      else if (d.length <= 12) d = dial + d;
    }
  } else if (!wasIntl && !dial) {
    if (d.length < 11) return '';
  }
  if (d.length < 7 || d.length > 15) return '';
  return '+' + d;
}

module.exports = { iso2Country, intlPhone, DIAL_ISO };
