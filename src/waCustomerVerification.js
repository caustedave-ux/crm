'use strict';

const { findPhoneNumbersInText, parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { all, get } = require('./db');
const { iso2Country } = require('./country');
const wa = require('./wa');
const { parseBing } = require('../lead-gen/src/sources');

const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const numberTypes = {
  MOBILE: '手机', FIXED_LINE: '固定电话', FIXED_LINE_OR_MOBILE: '固定电话或手机',
  TOLL_FREE: '免费电话', PREMIUM_RATE: '高资费电话', SHARED_COST: '分摊付费电话',
  VOIP: '网络电话', PERSONAL_NUMBER: '个人号码', PAGER: '寻呼号码',
  UAN: '统一接入号码', VOICEMAIL: '语音信箱',
};

function internationalNumber(value) {
  const raw = String(value || '').trim();
  if (!/^\+?[\d()\s.-]+$/.test(raw)) return;
  const digits = raw.replace(/\D/g, '');
  return parsePhoneNumberFromString('+' + (raw.startsWith('00') ? digits.slice(2) : digits), { extract: false });
}

function chatNumber(chat) {
  if (!chat || chat.is_group || /@(?:g\.us|broadcast|newsletter)$/.test(chat.jid)) return;
  const raw = /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(chat.jid) ? wa.chatPhone(chat.jid) : chat.phone;
  return internationalNumber(raw);
}

function matchesNumber(value, target, country) {
  if (internationalNumber(value)?.number === target.number) return true;
  const raw = String(value || '').trim();
  return !!target.country && (!country || country === target.country)
    && /^\d[\d()\s.-]*$/.test(raw) && !raw.startsWith('00')
    && parsePhoneNumberFromString(raw, { defaultCountry: target.country, extract: false })?.number === target.number;
}

function matchingCustomers(userId, number) {
  const customers = all('SELECT id, company_name, country, phone, contact_phone, whatsapp ' +
    'FROM customers WHERE user_id=? ORDER BY updated_at DESC, id DESC', userId);
  const contactMatches = new Set(all('SELECT ct.customer_id, ct.phone, ct.mobile, c.country FROM contacts ct ' +
    'JOIN customers c ON c.id=ct.customer_id WHERE c.user_id=?', userId)
    .filter(row => [row.phone, row.mobile].some(value => matchesNumber(value, number, iso2Country(row.country))))
    .map(row => row.customer_id));
  return customers.filter(row => contactMatches.has(row.id)
    || [row.phone, row.contact_phone, row.whatsapp].some(value => matchesNumber(value, number, iso2Country(row.country))))
    .map(({ id, company_name, country }) => ({ id, name: company_name, country }));
}

function publicHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function bingResultUrl(value) {
  const url = publicHttpUrl(value);
  if (url?.hostname === 'www.bing.com' && url.pathname === '/ck/a') {
    const encoded = url.searchParams.get('u') || '';
    return encoded.startsWith('a1')
      ? publicHttpUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8')) : null;
  }
  return url;
}

function searchUrl(base, query) {
  return base + encodeURIComponent(query);
}

function searchOptions(number) {
  const formats = [...new Set([number.number, number.number.slice(1), number.formatInternational(), number.formatNational()])];
  const query = '(' + formats.map(format => '"' + format + '"').join(' OR ') + ')';
  return {
    query,
    links: [
      { label: 'Google 网页', url: searchUrl('https://www.google.com/search?q=', query) },
      { label: 'Google 地图', url: searchUrl('https://www.google.com/maps/search/?api=1&query=', number.number) },
      { label: 'LinkedIn 企业', url: searchUrl('https://www.google.com/search?q=', 'site:linkedin.com/company ' + query) },
      { label: 'Facebook 公开页面', url: searchUrl('https://www.google.com/search?q=', 'site:facebook.com ' + query) },
    ],
  };
}

function matchingWebResults(candidates, number) {
  const results = [];
  const seen = new Set();
  const fullDigits = new RegExp('\\b' + number.number.slice(1) + '\\b');
  for (const candidate of candidates) {
    const url = bingResultUrl(candidate.url);
    if (!url) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    const title = String(candidate.title || '');
    const snippet = String(candidate.snippet || '');
    const text = [title, snippet, url.pathname].join('\n');
    const international = fullDigits.test(text) || findPhoneNumbersInText(text).some(match => match.number.number === number.number);
    const national = !international && number.country
      && findPhoneNumbersInText(text, number.country).some(match => match.number.number === number.number);
    if (!international && !national) continue;
    seen.add(url.href);
    results.push({
      title: title.slice(0, 200), snippet: snippet.slice(0, 300), url: url.href, host: url.hostname,
      match: international ? '国际号码吻合' : '本地格式吻合',
    });
    if (results.length === 6) break;
  }
  return results;
}

async function searchPublicWeb(number, query) {
  const apiKey = process.env.CRM_WA_VERIFICATION_SERPAPI_KEY?.trim();
  if (apiKey) {
    try {
      const params = new URLSearchParams({ engine: 'google', q: query, api_key: apiKey });
      const response = await fetch('https://serpapi.com/search.json?' + params, {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (response.ok) {
        const data = await response.json();
        if (!data.error) {
          const candidates = (data.organic_results || []).map(row => ({ title: row.title, url: row.link, snippet: row.snippet }));
          return { source: 'Google · SerpAPI', state: 'complete', results: matchingWebResults(candidates, number) };
        }
      }
    } catch { /* 搜索接口不可用时继续用 Bing */ }
  }
  const unavailable = { source: 'Bing', state: 'unavailable', results: [] };
  try {
    const response = await fetch(searchUrl('https://www.bing.com/search?count=12&q=', query), {
      signal: AbortSignal.timeout(7000),
      redirect: 'error',
      headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!response.ok) return unavailable;
    const html = await response.text();
    const candidates = parseBing(html, 12);
    if (candidates.length === 0 && !/class=["'][^"']*\bb_no\b/i.test(html)) return unavailable;
    return { source: 'Bing', state: 'complete', results: matchingWebResults(candidates, number) };
  } catch {
    return unavailable;
  }
}

async function businessProfile(userId, chat, number) {
  const account = get('SELECT user_id FROM wa_accounts WHERE id=?', chat.account_id);
  const session = account?.user_id === userId ? wa.sessions.get(userId) : null;
  const socket = session?.sock;
  if (typeof socket?.getBusinessProfile !== 'function' || session.status !== 'online') {
    return { state: 'unavailable' };
  }
  let timeout;
  try {
    const profile = await Promise.race([
      socket.getBusinessProfile(number.number.slice(1) + '@s.whatsapp.net'),
      new Promise((_, reject) => { timeout = setTimeout(reject, 6000); }),
    ]);
    if (!profile) return { state: 'empty' };
    const websites = (profile.website || []).map(publicHttpUrl).filter(Boolean).map(url => url.href);
    const fields = [
      ['类别', profile.category], ['商家简介', profile.description], ['商务邮箱', profile.email], ['营业地址', profile.address],
    ].filter(([, value]) => value).map(([label, value]) => ({ label, value: String(value).slice(0, 350) }));
    return fields.length || websites.length ? { state: 'complete', fields, websites } : { state: 'empty' };
  } catch {
    return { state: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyCustomer(userId, chat, phone) {
  const valid = phone.isValid();
  const customers = matchingCustomers(userId, phone);
  const { query, links } = valid ? searchOptions(phone) : { links: [] };
  const [business, web] = valid ? await Promise.all([
    businessProfile(userId, chat, phone), searchPublicWeb(phone, query),
  ]) : [{ state: 'skipped' }, { state: 'skipped', results: [] }];
  return {
    number: phone.number,
    country: phone.country ? regionNames.of(phone.country) : '',
    type: numberTypes[phone.getType()] || '未知',
    valid,
    customers,
    business,
    web,
    links,
  };
}

module.exports = { chatNumber, verifyCustomer };
