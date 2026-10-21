#!/usr/bin/env node
// etf-monthly 抓取程式
// ------------------------------------------------------------
// 用法：node scripts/update.mjs [normal|probe]
//   normal：每日更新（第一次執行時會自動補抓 2024/12 起的歷史月底價）
//   probe ：只把每個資料來源讀一次、印出結果，不寫任何檔案
//
// 產出：
//   data/returns.json  網頁讀的資料（月底價、最新價、分割、分類）
//   data/state.json    程式自己用的暫存（最近 15 個交易日的收盤價、待補抓的月份）
//
// 原則（沿用 etf-radar／大秘寶的教訓）：
//   - 每一則讀取失敗都把「真正的原因」印出來，不要只說失敗
//   - 來源壞掉時寧可沿用舊資料或留白，不要寫出看起來像真的錯數字
//   - 請求之間留間隔；被擋的是速度，不是總量
// ------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MODE = (process.argv[2] || 'normal').trim();
const DATA_DIR = process.env.DATA_DIR || 'data';
const RETURNS_PATH = path.join(DATA_DIR, 'returns.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();

const BASELINE_MONTH = '2024-12';          // 起算點：2024/12/31 收盤
const BUFFER_DAYS = 15;                     // 保留最近幾個交易日的收盤價
const FREEZE_GIVE_UP_WEEKDAYS = 10;         // 月底價補不到，最多等幾個工作天
const DELIST_AFTER_WEEKDAYS = 10;           // 幾個工作天沒出現就視為下市
const THEME_REFRESH_DAYS = 7;               // 主題標籤與地區清單多久更新一次
const SPLIT_LOOKBACK_DAYS = 120;            // 每天查最近幾天的分割紀錄
const MAX_DROP_RATIO = 0.3;                 // 檔數一次少超過三成就拒收
const THEME_CHANGE_RATIO = 0.3;             // 主題檔數一次變動超過三成就沿用上一版
const PRICE_MISMATCH = 0.005;               // 兩個來源的收盤價差超過 0.5% 就警告
const MAX_NEW_PER_RUN = 25;                 // 單次最多查幾檔新掛牌的首日收盤
const MAX_GAP_FILL_PER_RUN = 15;            // 單次最多補幾檔個別月底價
const RWD_GAP_MS = Number(process.env.RWD_GAP_MS ?? 1500);
const RETRY_DELAYS_MS = (process.env.RETRY_DELAYS_MS ?? '2000,6000,15000').split(',').map(Number);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 45000);

const THEME_TAGS = [
  { id: 'ff808081899b8efc0189aa050440001c', label: '高股息', theme: '高股息' },
  { id: 'ff808081899b8efc0189aa05af5c001d', label: '高息低波動', theme: '高股息' },
  { id: 'ff808081899b8efc0189aa06d5ce0021', label: '大型權值', theme: '大型權值' },
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const H_TWSE = { 'user-agent': BROWSER_UA, referer: 'https://www.twse.com.tw/' };
const H_TPEX = { 'user-agent': BROWSER_UA, referer: 'https://www.tpex.org.tw/' };
const MARKETS = { twse: '上市', tpex: '上櫃' };

// ------------------------------------------------------------
// 記錄
// ------------------------------------------------------------
const warnings = [];
let mustFail = false;
let requestCount = 0;

function log(msg) { console.log(msg); }
function warn(msg) { warnings.push(msg); console.log(`::warning::${msg}`); }
function sleep(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

// ------------------------------------------------------------
// 日期工具（全部以台北時間的 YYYY-MM-DD 表示）
// ------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function taipeiToday() { return new Date(NOW.getTime() + 8 * 3600e3).toISOString().slice(0, 10); }
function taipeiNowIso() { return new Date(NOW.getTime() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00'; }
function monthKey(iso) { return iso.slice(0, 7); }
function parseIso(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmtIso(dt) { return dt.toISOString().slice(0, 10); }
function addDays(iso, n) { const dt = parseIso(iso); dt.setUTCDate(dt.getUTCDate() + n); return fmtIso(dt); }
function isWeekend(iso) { const w = parseIso(iso).getUTCDay(); return w === 0 || w === 6; }
function lastDayOfMonth(m) { const [y, mo] = m.split('-').map(Number); return fmtIso(new Date(Date.UTC(y, mo, 0))); }
function lastWeekdayOfMonth(m) { let d = lastDayOfMonth(m); while (isWeekend(d)) d = addDays(d, -1); return d; }
function nextMonth(m) { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`; }
function prevMonth(m) { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`; }
function monthsFromTo(a, b) { const out = []; for (let m = a; m <= b; m = nextMonth(m)) out.push(m); return out; }
function weekdaysBetween(a, b) { let n = 0; for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (!isWeekend(d)) n++; return n; }

function rocCompactToIso(s) {
  const m = /^(\d{3})(\d{2})(\d{2})$/.exec(String(s ?? '').trim());
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}
function rocSlashToIso(s) {
  const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})/.exec(String(s ?? '').trim());
  return m ? `${Number(m[1]) + 1911}-${pad(m[2])}-${pad(m[3])}` : null;
}
function rocTitleToIso(s) {
  const m = /(\d{2,3})年(\d{1,2})月(\d{1,2})日/.exec(String(s ?? ''));
  return m ? `${Number(m[1]) + 1911}-${pad(m[2])}-${pad(m[3])}` : null;
}
function anyDateToIso(s) {
  const t = String(s ?? '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return rocCompactToIso(t) || rocSlashToIso(t) || rocTitleToIso(t);
}

// ------------------------------------------------------------
// 數值與代號
// ------------------------------------------------------------
const ETF_CODE = /^00\d{2,4}[A-Z]?$/; // 0050、0056 這類只有四碼
function isEtfCode(code) { return ETF_CODE.test(code); }
function stripHtml(s) { return String(s ?? '').replace(/<[^>]*>/g, '').trim(); }
function toPrice(v) {
  const s = stripHtml(v).replace(/,/g, '');
  if (!s || /^[-–—]+$/.test(s) || s === 'X') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function cleanName(s) { return stripHtml(s).replace(/\(原簡稱:[^)]*\)/g, '').replace(/（原簡稱:[^）]*）/g, '').trim(); }

function classify(code) {
  const suffix = /[A-Z]$/.exec(code)?.[0] || '';
  switch (suffix) {
    case 'A': return { type: '主動式', sub: null };
    case 'D': return { type: '主動式', sub: '主動債券' };
    case 'B': case 'C': return { type: '債券', sub: null };
    case 'L': return { type: '槓桿', sub: null };
    case 'R': return { type: '反向', sub: null };
    case 'U': return { type: '期貨', sub: null };
    case 'T': return { type: '多資產', sub: null };
    case 'K': return { type: '股票型', sub: '外幣計價' };
    case '': return { type: '股票型', sub: null };
    default: return { type: '其他', sub: null };
  }
}

// ------------------------------------------------------------
// HTTP：重試、換主機、請求間隔，失敗時說清楚原因
// ------------------------------------------------------------
let lastPacedAt = 0;
async function pace() {
  const wait = lastPacedAt + RWD_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastPacedAt = Date.now();
}
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
function twseUrls(p) { return [`https://www.twse.com.tw${p}`, `https://wwwc.twse.com.tw${p}`]; }

async function getJson(label, urls, { headers = {}, method = 'GET', body, validate, retryDelays = RETRY_DELAYS_MS } = {}) {
  const problems = [];
  for (let round = 0; round <= retryDelays.length; round++) {
    if (round > 0) await sleep(retryDelays[round - 1]);
    for (const url of urls) {
      await pace();
      requestCount++;
      try {
        const res = await fetch(url, {
          method,
          body,
          headers: { accept: 'application/json, text/plain, */*', 'accept-language': 'zh-TW,zh;q=0.9', ...headers },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) { problems.push(`${hostOf(url)} 回應 ${res.status}`); continue; }
        let json;
        try { json = JSON.parse(text); } catch { problems.push(`${hostOf(url)} 不是 JSON（開頭：${text.slice(0, 60).replace(/\s+/g, ' ')}）`); continue; }
        const bad = validate ? validate(json) : null;
        if (bad) { problems.push(`${hostOf(url)} 內容不符：${bad}`); continue; }
        return json;
      } catch (e) {
        problems.push(`${hostOf(url)} ${e?.cause?.code || e?.name || 'Error'}：${e?.message || e}`);
      }
    }
  }
  const err = new Error(`${label} 讀取失敗。原因：${[...new Set(problems)].join('；')}`);
  err.problems = problems;
  throw err;
}

// 在 { tables:[{title, fields, data}] } 或 { fields, data } 裡找出含有指定欄位的表
function findTable(json, needles) {
  const tables = Array.isArray(json?.tables) ? json.tables : (Array.isArray(json?.fields) ? [json] : []);
  for (const t of tables) {
    const fields = (t.fields || []).map((f) => stripHtml(f));
    const idx = needles.map((n) => fields.findIndex((f) => f.includes(n)));
    if (idx.every((i) => i >= 0)) return { title: stripHtml(t.title || json.title || ''), fields, data: t.data || [], idx, date: t.date || json.date || null };
  }
  return null;
}
function statIsEmpty(stat) { return /沒有符合|查無|無資料|no data/i.test(String(stat ?? '')); }
function statIsOk(stat) { return stat == null || /^ok$/i.test(String(stat)); }

// ------------------------------------------------------------
// 資料來源
// ------------------------------------------------------------

// 每日：官方 OpenAPI，只給最近一個交易日
function snapshotFromRows(rows, pick, label) {
  const prices = {};
  const names = {};
  const dates = new Map();
  for (const r of rows) {
    const code = String(pick.code(r) ?? '').trim();
    if (!isEtfCode(code)) continue;
    names[code] = cleanName(pick.name(r));
    const d = pick.date(r);
    if (d) dates.set(d, (dates.get(d) || 0) + 1);
    const close = toPrice(pick.close(r));
    if (close != null) prices[code] = close;
  }
  const date = [...dates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (!date) throw new Error(`${label}：資料裡找不到可辨識的交易日期`);
  return { date, prices, names };
}
async function fetchTwseDaily() {
  const rows = await getJson('上市每日收盤（OpenAPI）', ['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'], {
    headers: H_TWSE,
    validate: (j) => (Array.isArray(j) && j.length ? null : '不是非空陣列'),
  });
  return snapshotFromRows(rows, { code: (r) => r.Code, name: (r) => r.Name, close: (r) => r.ClosingPrice, date: (r) => rocCompactToIso(r.Date) }, '上市每日收盤');
}
async function fetchTpexDaily() {
  try {
    const rows = await getJson('上櫃每日收盤（OpenAPI）', ['https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'], {
      headers: H_TPEX,
      retryDelays: RETRY_DELAYS_MS.slice(0, 1), // 有備援，不必等太久
      validate: (j) => (Array.isArray(j) && j.length ? null : '不是非空陣列'),
    });
    return snapshotFromRows(rows, { code: (r) => r.SecuritiesCompanyCode, name: (r) => r.CompanyName, close: (r) => r.Close, date: (r) => rocCompactToIso(r.Date) }, '上櫃每日收盤');
  } catch (err) {
    // 備援：櫃買「上櫃股票每日收盤行情」（2026-10-21 probe 實測：OpenAPI 逾時，這支正常）
    warn(`${err.message}；改用櫃買每日收盤行情頁面`);
    const today = taipeiToday();
    for (let i = 0, d = today; i < 7; i++, d = addDays(d, -1)) {
      if (isWeekend(d)) continue;
      const snap = await fetchTpexDay(d, { strictDate: false });
      if (!snap.empty && Object.keys(snap.prices).length) { log(`上櫃每日收盤改由備援取得：${snap.date}`); return snap; }
    }
    throw new Error('上櫃每日收盤：OpenAPI 與備援都沒有資料');
  }
}

// 歷史某一天：上市 MI_INDEX（只取 ETF 表）
async function fetchTwseDay(iso) {
  const ymd = iso.replace(/-/g, '');
  const j = await getJson(`上市 ${iso} 收盤（MI_INDEX）`, twseUrls(`/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=0099P&response=json`), {
    headers: H_TWSE,
    validate: (x) => {
      if (!x || typeof x !== 'object') return '格式不符';
      if (statIsEmpty(x.stat)) return null;
      if (!statIsOk(x.stat)) return `stat=${x.stat}`;
      const t = findTable(x, ['證券代號', '收盤價']);
      if (!t || !t.data.length) return null; // 非交易日：沒有 ETF 表
      const td = rocTitleToIso(t.title);
      if (td && td !== iso) return `回應的日期是 ${td}，不是 ${iso}（可能讀到快取）`;
      return null;
    },
  });
  const t = findTable(j, ['證券代號', '證券名稱', '收盤價']);
  if (statIsEmpty(j.stat) || !t || !t.data.length) return { date: iso, prices: {}, names: {}, empty: true };
  const prices = {};
  const names = {};
  for (const row of t.data) {
    const code = stripHtml(row[t.idx[0]]);
    if (!isEtfCode(code)) continue;
    names[code] = cleanName(row[t.idx[1]]);
    const close = toPrice(row[t.idx[2]]);
    if (close != null) prices[code] = close;
  }
  return { date: iso, prices, names, empty: Object.keys(names).length === 0 };
}

// 歷史某一天：上櫃（端點未經實測，第一次請先跑 probe）
// strictDate=false：不要求回應日期等於查詢日，改用回應自己標的日期（每日備援用）
async function fetchTpexDay(iso, { strictDate = true } = {}) {
  const [y, m, d] = iso.split('-');
  const j = await getJson(`上櫃 ${iso} 收盤`, [`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${y}/${m}/${d}&type=EW&response=json`], {
    headers: H_TPEX,
    validate: (x) => {
      if (!x || typeof x !== 'object') return '格式不符';
      if (statIsEmpty(x.stat)) return null;
      if (!statIsOk(x.stat)) return `stat=${x.stat}`;
      const t = findTable(x, ['代號', '收盤']);
      if (!t) return x.tables ? `找不到含「代號」「收盤」的表（欄位：${JSON.stringify((x.tables[0] || {}).fields || [])}）` : `沒有 tables（鍵：${Object.keys(x).join(',')}）`;
      const rd = anyDateToIso(t.date) || rocTitleToIso(t.title) || anyDateToIso(x.date);
      if (strictDate && rd && t.data.length && rd !== iso) return `回應的日期是 ${rd}，不是 ${iso}（可能讀到快取）`;
      return null;
    },
  });
  const t = findTable(j, ['代號', '名稱', '收盤']);
  if (statIsEmpty(j.stat) || !t || !t.data.length) return { date: iso, prices: {}, names: {}, empty: true };
  const reported = anyDateToIso(t.date) || rocTitleToIso(t.title) || anyDateToIso(j.date);
  if (!strictDate && !reported) return { date: iso, prices: {}, names: {}, empty: true };
  const prices = {};
  const names = {};
  for (const row of t.data) {
    const code = stripHtml(row[t.idx[0]]);
    if (!isEtfCode(code)) continue;
    names[code] = cleanName(row[t.idx[1]]);
    const close = toPrice(row[t.idx[2]]);
    if (close != null) prices[code] = close;
  }
  return { date: strictDate ? iso : reported, prices, names, empty: Object.keys(names).length === 0 };
}

// 單一 ETF 某個月的逐日收盤（用來找掛牌首日、補個別月底價）
async function fetchTwseMonth(code, m) {
  const ym = m.replace('-', '');
  const j = await getJson(`上市 ${code} ${m} 日成交`, twseUrls(`/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${code}&response=json`), {
    headers: H_TWSE,
    validate: (x) => {
      if (!x || typeof x !== 'object') return '格式不符';
      if (statIsEmpty(x.stat)) return null;
      if (!statIsOk(x.stat)) return `stat=${x.stat}`;
      if (x.title && !String(x.title).includes(code)) return `標題不是 ${code}（${x.title}）`;
      return null;
    },
  });
  if (statIsEmpty(j.stat)) return [];
  const fields = (j.fields || []).map(stripHtml);
  const di = fields.findIndex((f) => f.includes('日期'));
  const ci = fields.findIndex((f) => f.includes('收盤'));
  if (di < 0 || ci < 0) throw new Error(`上市 ${code} ${m}：欄位不符 ${JSON.stringify(fields)}`);
  return (j.data || []).map((r) => ({ date: rocSlashToIso(r[di]), close: toPrice(r[ci]) }))
    .filter((r) => r.date && r.close != null && monthKey(r.date) === m)
    .sort((a, b) => a.date.localeCompare(b.date));
}
async function fetchTpexMonth(code, m) {
  const [y, mo] = m.split('-');
  const j = await getJson(`上櫃 ${code} ${m} 日成交`, [`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${y}/${mo}/01&response=json`], {
    headers: H_TPEX,
    validate: (x) => (x && typeof x === 'object' ? null : '格式不符'),
  });
  if (statIsEmpty(j.stat)) return [];
  const t = findTable(j, ['日期', '收盤']);
  if (!t) throw new Error(`上櫃 ${code} ${m}：找不到含「日期」「收盤」的表（鍵：${Object.keys(j).join(',')}）`);
  return t.data.map((r) => ({ date: rocSlashToIso(stripHtml(r[t.idx[0]])) || anyDateToIso(stripHtml(r[t.idx[0]])), close: toPrice(r[t.idx[1]]) }))
    .filter((r) => r.date && r.close != null && monthKey(r.date) === m)
    .sort((a, b) => a.date.localeCompare(b.date));
}
function fetchMonth(market, code, m) { return market === 'twse' ? fetchTwseMonth(code, m) : fetchTpexMonth(code, m); }

// 參考價會四捨五入到跳動單位，算出來的比例會有些微誤差（例如 188.65 ÷ 47.16 = 4.0003）。
// 離整數（或整數分之一）不到 1% 就取整，否則保留原值。
function snapRatio(r) {
  if (r >= 1) { const n = Math.round(r); if (n >= 1 && Math.abs(r - n) / n < 0.01) return n; }
  else { const n = Math.round(1 / r); if (n >= 1 && Math.abs(1 / r - n) / n < 0.01) return Math.round((1 / n) * 1e9) / 1e9; }
  return Math.round(r * 1e6) / 1e6;
}

// 分割／反分割：恢復買賣參考價（只有上市）
async function fetchSplits(fromIso, toIso) {
  const a = fromIso.replace(/-/g, '');
  const b = toIso.replace(/-/g, '');
  const j = await getJson('ETF 分割恢復買賣參考價（TWTCAU）', twseUrls(`/rwd/zh/split/TWTCAU?startDate=${a}&endDate=${b}&response=json`), {
    headers: H_TWSE,
    validate: (x) => (x && typeof x === 'object' && (statIsOk(x.stat) || statIsEmpty(x.stat)) ? null : `stat=${x?.stat}`),
  });
  if (statIsEmpty(j.stat)) return [];
  const fields = (j.fields || []).map(stripHtml);
  const fi = (n, fb) => { const i = fields.findIndex((f) => f.includes(n)); return i >= 0 ? i : fb; };
  const iDate = fi('恢復買賣日期', 0);
  const iCode = fi('代號', 1);
  const iPre = fi('停止買賣前收盤', 4);
  const iRef = fi('恢復買賣參考價', 5);
  const out = [];
  for (const r of j.data || []) {
    const date = rocSlashToIso(r[iDate]);
    const code = stripHtml(r[iCode]);
    const pre = toPrice(r[iPre]);
    const ref = toPrice(r[iRef]);
    if (!date || !isEtfCode(code) || !pre || !ref) { warn(`分割資料有一列看不懂，已略過：${JSON.stringify(r)}`); continue; }
    // 比例一律用價格算，不靠「分割／反分割」文字欄（00631L 那筆是空的）
    out.push({ code, date, pre, ref, ratio: snapRatio(pre / ref) });
  }
  return out;
}

// e添富主題標籤成員（上市）
async function fetchThemeMembers(tag) {
  const body = new URLSearchParams({ rangeTotalAv: '0,999999', rangeValueYTD: '-999999,999999', rangeClose1: '0,999999', stkNo: '', sort: '', orderBy: '', hashtag: tag.id }).toString();
  const j = await getJson(`e添富主題「${tag.label}」`, twseUrls('/rwd/zh/ETFortune/ajaxProductsResult'), {
    method: 'POST',
    body,
    headers: { ...H_TWSE, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', referer: 'https://www.twse.com.tw/zh/ETFortune/products', origin: 'https://www.twse.com.tw' },
    validate: (x) => (Array.isArray(x?.data) ? null : `沒有 data 陣列（鍵：${Object.keys(x || {}).join(',')}）`),
  });
  return [...new Set(j.data.map((d) => String(d.stockNo ?? '').trim()).filter(isEtfCode))].sort();
}

// 國內成分 ETF 官方清單（上市）
async function fetchDomesticCodes() {
  const set = new Set();
  for (const p of ['domestic', 'activeList']) {
    const j = await getJson(`國內 ETF 清單（${p}）`, twseUrls(`/rwd/zh/ETF/${p}?response=json`), {
      headers: H_TWSE,
      validate: (x) => (Array.isArray(x?.data) ? null : `沒有 data 陣列（鍵：${Object.keys(x || {}).join(',')}）`),
    });
    for (const row of j.data) if (row[3] === 'domestic' && isEtfCode(stripHtml(row[0]))) set.add(stripHtml(row[0]));
  }
  if (!set.size) throw new Error('國內 ETF 清單是空的');
  return set;
}

// ------------------------------------------------------------
// 讀寫檔案
// ------------------------------------------------------------
async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${p} 讀不懂：${e.message}`);
  }
}
function emptyReturns() {
  return { version: 1, updatedAt: null, baseline: BASELINE_MONTH, latest: { twse: null, tpex: null }, months: {}, splits: [], themesUpdatedAt: null, etfs: {} };
}
function emptyState() {
  return { backfill: { twse: false, tpex: false }, buffer: { twse: {}, tpex: {} }, pending: {}, splitsCheckedOn: null, themeMembers: {}, domestic: null };
}
function stableClone(o) { return JSON.parse(JSON.stringify(o)); }

// ------------------------------------------------------------
// ETF 紀錄
// ------------------------------------------------------------
function ensureEtf(R, code, market, name) {
  let e = R.etfs[code];
  if (!e) {
    const c = classify(code);
    e = R.etfs[code] = { name: name || code, market: MARKETS[market], type: c.type, sub: c.sub, themes: [], themeByName: false, region: null, regionByName: false, listed: null, listClose: null, listNote: null, delisted: null, last: null, me: {} };
  }
  if (name) e.name = name;
  return e;
}
function marketKeyOf(e) { return e.market === '上市' ? 'twse' : 'tpex'; }

// ------------------------------------------------------------
// 歷史補抓（第一次執行時）
// ------------------------------------------------------------
async function findMonthEnd(market, m) {
  // 從月底那天往前找，第一個有 ETF 資料的日子就是該月最後交易日
  const fetchDay = market === 'twse' ? fetchTwseDay : fetchTpexDay;
  for (let d = lastDayOfMonth(m); monthKey(d) === m; d = addDays(d, -1)) {
    if (isWeekend(d)) continue;
    const snap = await fetchDay(d);
    if (!snap.empty && Object.keys(snap.prices).length) return snap;
  }
  return null;
}

async function backfillMarket(R, S, market, months) {
  const label = MARKETS[market];
  log(`\n== 歷史補抓：${label}，${months[0]} ～ ${months.at(-1)}，共 ${months.length} 個月 ==`);
  const snaps = [];
  for (const m of months) {
    const snap = await findMonthEnd(market, m);
    if (!snap) throw new Error(`${label} ${m}：整個月都找不到交易資料`);
    snaps.push({ m, ...snap });
    log(`  ${m} 月底 = ${snap.date}，${Object.keys(snap.prices).length} 檔`);
  }
  // 寫入月底價；第一次出現在起算點之後的，記為新掛牌
  const firstSeen = {};
  for (const s of snaps) {
    for (const [code, close] of Object.entries(s.prices)) {
      const e = ensureEtf(R, code, market, s.names[code]);
      e.me[s.m] = close;
      if (!firstSeen[code]) firstSeen[code] = s.m;
    }
    R.months[s.m] = { ...(R.months[s.m] || {}), [market]: { date: s.date, source: 'history' } };
  }
  // 名稱補齊（有名稱但沒收盤價的也要建檔）
  for (const s of snaps) for (const [code, name] of Object.entries(s.names)) if (!R.etfs[code]) { ensureEtf(R, code, market, name); firstSeen[code] = firstSeen[code] || s.m; }

  // 新掛牌：查掛牌那個月的逐日資料，第一列就是掛牌首日
  const newcomers = Object.entries(firstSeen).filter(([, m]) => m > BASELINE_MONTH);
  log(`  起算點之後新掛牌：${newcomers.length} 檔，逐檔查掛牌首日收盤…`);
  for (const [code, m] of newcomers) await resolveListing(R, market, code, m, null, false);

  // 下市：曾出現、後來的月底快照都沒有了
  const lastSnap = snaps.at(-1);
  for (const [code, e] of Object.entries(R.etfs)) {
    if (marketKeyOf(e) !== market || e.delisted) continue;
    if (!(code in lastSnap.names)) {
      const seen = snaps.filter((s) => code in s.names).at(-1);
      if (seen && seen.m !== lastSnap.m) e.delistedHint = seen.date; // 暫記，每日資料再確認
    }
  }

  // 停牌剛好跨月底：前後月都有、中間某月沒有 → 個別補
  await fillGaps(R, market, snaps.map((s) => s.m), Infinity);
}

// 找掛牌首日收盤。checkPrev：掛牌日落在月初幾天時，順便查上個月（排程連續失敗時，可能其實上個月就掛牌了）
async function resolveListing(R, market, code, firstMonth, fallback, checkPrev) {
  const e = R.etfs[code];
  const label = MARKETS[market];
  try {
    const byMonth = {};
    byMonth[firstMonth] = await fetchMonth(market, code, firstMonth);
    let rows = byMonth[firstMonth];
    const pm = prevMonth(firstMonth);
    if (checkPrev && pm > BASELINE_MONTH && (!rows.length || Number(rows[0].date.slice(8)) <= 7)) {
      byMonth[pm] = await fetchMonth(market, code, pm);
      if (byMonth[pm].length) rows = byMonth[pm].concat(rows);
    }
    if (rows.length) {
      e.listed = rows[0].date;
      e.listClose = rows[0].close;
      e.listNote = null;
      // 掛牌月份如果已經凍結、卻沒有這檔的月底價，用逐日資料補上
      for (const [mm, list] of Object.entries(byMonth)) {
        const endDate = R.months[mm]?.[market]?.date;
        if (!endDate || e.me[mm] != null) continue;
        const lastRow = list.filter((r) => r.date <= endDate).at(-1);
        if (lastRow) e.me[mm] = lastRow.close;
      }
      log(`    ${code} ${e.name}：${e.listed} 掛牌，首日收盤 ${e.listClose}`);
      return true;
    }
    throw new Error('查不到任何交易日');
  } catch (err) {
    if (fallback) {
      e.listed = fallback.date;
      e.listClose = fallback.close;
      e.listNote = 'approx';
      warn(`${label} ${code} 查不到掛牌首日（${err.message}），先用第一次看到的 ${fallback.date} 收盤 ${fallback.close} 起算`);
    } else {
      e.listed = `${firstMonth}-01`;
      e.listClose = null;
      e.listNote = 'unknown';
      warn(`${label} ${code} 查不到掛牌首日（${err.message}），掛牌月不計報酬，從下個月起算`);
    }
    return false;
  }
}

async function fillGaps(R, market, monthList, budget) {
  let used = 0;
  for (const [code, e] of Object.entries(R.etfs)) {
    if (marketKeyOf(e) !== market) continue;
    const have = monthList.filter((m) => e.me[m] != null);
    if (have.length < 2) continue;
    const first = have[0];
    const last = have.at(-1);
    for (const m of monthList) {
      if (m <= first || m >= last || e.me[m] != null) continue;
      if (e.listed && monthKey(e.listed) > m) continue;
      if (used >= budget) { warn(`個別補月底價已達本次上限，${code} ${m} 留待下次`); return; }
      used++;
      try {
        const rows = await fetchMonth(market, code, m);
        if (rows.length) { e.me[m] = rows.at(-1).close; log(`    ${code} ${m} 月底價（停牌跨月）補為 ${rows.at(-1).date} 收盤 ${rows.at(-1).close}`); }
        else warn(`${code} ${m} 整個月沒有成交，月底價留白`);
      } catch (err) { warn(`${code} ${m} 個別補月底價失敗：${err.message}`); }
    }
  }
}

// ------------------------------------------------------------
// 每日更新
// ------------------------------------------------------------
function applyDaily(R, S, market, snap, prevActiveCount) {
  const label = MARKETS[market];
  const count = Object.keys(snap.prices).length;
  if (!count) { warn(`${label}每日收盤：有日期 ${snap.date} 但 0 檔有收盤價，不採用`); return { applied: false, newCodes: [] }; }
  if (prevActiveCount && count < prevActiveCount * (1 - MAX_DROP_RATIO)) {
    warn(`${label}每日收盤：只有 ${count} 檔（上次約 ${prevActiveCount} 檔），少超過三成，不採用`);
    return { applied: false, newCodes: [] };
  }
  const prevLatest = R.latest[market];
  if (prevLatest && snap.date < prevLatest) {
    warn(`${label}每日收盤：日期 ${snap.date} 比已有的 ${prevLatest} 舊，不採用（可能讀到快取）`);
    return { applied: false, newCodes: [] };
  }
  // 暫存區：最近 15 個交易日
  const buf = (S.buffer[market] ||= {});
  buf[snap.date] = snap.prices;
  for (const d of Object.keys(buf).sort().slice(0, -BUFFER_DAYS)) delete buf[d];

  const newCodes = [];
  for (const [code, close] of Object.entries(snap.prices)) {
    if (!R.etfs[code]) newCodes.push(code);
    const e = ensureEtf(R, code, market, snap.names[code]);
    if (!e.last || e.last.date <= snap.date) e.last = { date: snap.date, close };
    if (e.delisted) { warn(`${code} 原本標為已下市，但 ${snap.date} 又有收盤價，取消下市標記`); e.delisted = null; }
    delete e.delistedHint;
  }
  R.latest[market] = snap.date;
  log(`${label}每日收盤：${snap.date}，${count} 檔${prevLatest === snap.date ? '（與上次同一天）' : ''}`);
  return { applied: true, newCodes };
}

function closeFromBuffer(S, market, code, m, upTo) {
  const buf = S.buffer[market] || {};
  const dates = Object.keys(buf).filter((d) => monthKey(d) === m && d <= upTo && buf[d][code] != null).sort();
  return dates.length ? buf[dates.at(-1)][code] : null;
}

async function freezeMonth(R, S, market, m, today) {
  const label = MARKETS[market];
  const key = `${m}|${market}`;
  let snap = null;
  let source = 'history';
  try {
    snap = await findMonthEnd(market, m);
    if (!snap) warn(`${label} ${m}：歷史查詢整個月都沒有資料`);
  } catch (err) {
    warn(`${label} ${m} 月底價補抓失敗：${err.message}`);
  }
  // 第 4 層：和暫存區交叉比對
  if (snap) {
    const bufDay = (S.buffer[market] || {})[snap.date];
    if (bufDay) {
      let diff = 0;
      for (const [code, close] of Object.entries(snap.prices)) {
        const b = bufDay[code];
        if (b != null && Math.abs(b - close) / close > PRICE_MISMATCH) { diff++; if (diff <= 5) warn(`${label} ${snap.date} ${code}：歷史查詢 ${close}，每日 OpenAPI ${b}，兩邊不一致`); }
      }
      if (diff) warn(`${label} ${snap.date} 共 ${diff} 檔兩個來源收盤價不一致，採用歷史查詢的數字`);
      else log(`  ${label} ${m} 月底 ${snap.date}：歷史查詢與每日暫存交叉比對一致`);
    }
  }
  // 第 2 層備援：暫存區剛好有月底最後一個工作天
  if (!snap) {
    const buf = S.buffer[market] || {};
    const lastBuf = Object.keys(buf).filter((d) => monthKey(d) === m).sort().at(-1);
    if (lastBuf && lastBuf === lastWeekdayOfMonth(m)) {
      snap = { date: lastBuf, prices: buf[lastBuf] };
      source = 'buffer';
      warn(`${label} ${m}：改用每日暫存的 ${lastBuf} 收盤當月底價`);
    }
  }
  if (!snap) {
    const p = (S.pending[key] ||= { since: today, tries: 0 });
    p.tries++;
    const waited = weekdaysBetween(lastDayOfMonth(m), today);
    if (waited > FREEZE_GIVE_UP_WEEKDAYS) {
      R.months[m] = { ...(R.months[m] || {}), [market]: { missing: true } };
      delete S.pending[key];
      warn(`${label} ${m} 月底價等了 ${waited} 個工作天仍補不到，該月標為「缺資料」`);
      mustFail = true;
    } else {
      R.months[m] = { ...(R.months[m] || {}), [market]: { pending: true, since: p.since } };
      warn(`${label} ${m} 月底價暫時補不到（第 ${p.tries} 次），下一班再試；最多等到月底後 ${FREEZE_GIVE_UP_WEEKDAYS} 個工作天`);
    }
    return [];
  }
  // 月底快照裡有、但還不認識的代號 → 新掛牌，交給後面查首日
  const newcomers = [];
  for (const code of Object.keys(snap.prices)) {
    if (!R.etfs[code]) { ensureEtf(R, code, market, snap.names?.[code]); newcomers.push({ code, month: m }); }
  }
  // 寫入每一檔的月底價
  let filled = 0;
  const gaps = [];
  for (const [code, e] of Object.entries(R.etfs)) {
    if (marketKeyOf(e) !== market || e.me[m] != null) continue;
    if (e.listed && e.listed > snap.date) continue;
    let close = snap.prices[code] ?? null;
    if (close == null) close = closeFromBuffer(S, market, code, m, snap.date);
    if (close == null && e.last && monthKey(e.last.date) === m && e.last.date <= snap.date) close = e.last.close;
    if (close != null) { e.me[m] = close; filled++; }
    else if (!e.delisted && e.me[prevMonth(m)] != null && e.last && e.last.date > snap.date) gaps.push(code);
  }
  R.months[m] = { ...(R.months[m] || {}), [market]: { date: snap.date, source } };
  delete S.pending[key];
  log(`  ${label} ${m} 凍結：月底 ${snap.date}（${source === 'history' ? '歷史查詢' : '每日暫存'}），寫入 ${filled} 檔`);
  // 月底當天停牌（例如分割）的，逐檔查該月最後一個有成交的日子
  for (const code of gaps.slice(0, MAX_GAP_FILL_PER_RUN)) {
    try {
      const rows = (await fetchMonth(market, code, m)).filter((r) => r.date <= snap.date);
      if (rows.length) { R.etfs[code].me[m] = rows.at(-1).close; log(`    ${code} 月底停牌，${m} 月底價改用 ${rows.at(-1).date} 收盤 ${rows.at(-1).close}`); }
      else warn(`${code} ${m} 整個月沒有成交，月底價留白`);
    } catch (err) { warn(`${code} ${m} 個別補月底價失敗：${err.message}`); }
  }
  if (gaps.length > MAX_GAP_FILL_PER_RUN) warn(`${label} ${m} 有 ${gaps.length} 檔月底沒有收盤價，超過單次上限，只補了前 ${MAX_GAP_FILL_PER_RUN} 檔`);
  return newcomers;
}

function lastMonthEndDate(R, e, market) {
  const months = Object.keys(e.me).sort();
  for (let i = months.length - 1; i >= 0; i--) { const d = R.months[months[i]]?.[market]?.date; if (d) return d; }
  return null;
}
function markDelisted(R, market) {
  const latest = R.latest[market];
  if (!latest) return;
  for (const [code, e] of Object.entries(R.etfs)) {
    if (marketKeyOf(e) !== market || e.delisted) continue;
    const lastDate = e.last?.date || e.delistedHint || lastMonthEndDate(R, e, market);
    if (!lastDate) continue;
    if (weekdaysBetween(lastDate, latest) > DELIST_AFTER_WEEKDAYS) {
      e.delisted = lastDate;
      delete e.delistedHint;
      log(`  ${code} ${e.name}：最後一次看到收盤是 ${lastDate}，標為已下市`);
    }
  }
}

async function refreshSplits(R, S, today) {
  if (S.splitsCheckedOn === today) return;
  const from = R.splits.length ? addDays(today, -SPLIT_LOOKBACK_DAYS) : `${BASELINE_MONTH.slice(0, 4)}-12-01`;
  try {
    const list = await fetchSplits(from, today);
    let added = 0;
    for (const s of list) {
      if (!R.splits.some((x) => x.code === s.code && x.date === s.date)) { R.splits.push(s); added++; log(`  分割紀錄：${s.code} ${s.date}，${s.pre} → ${s.ref}（比例 ${s.ratio}）`); }
    }
    R.splits.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
    S.splitsCheckedOn = today;
    log(`分割紀錄：查 ${from} ～ ${today}，共 ${list.length} 筆，新增 ${added} 筆`);
  } catch (err) {
    warn(`分割紀錄讀取失敗（只影響分割換算，網頁還有安全網）：${err.message}`);
  }
}

async function refreshThemes(R, S, today, force) {
  const stale = !R.themesUpdatedAt || (parseIso(today) - parseIso(R.themesUpdatedAt)) / 864e5 >= THEME_REFRESH_DAYS;
  if (!stale && !force) { applyClassification(R, S); return; }
  let ok = 0;
  for (const tag of THEME_TAGS) {
    try {
      const members = await fetchThemeMembers(tag);
      const prev = S.themeMembers[tag.id];
      if (prev && prev.length && Math.abs(members.length - prev.length) / prev.length > THEME_CHANGE_RATIO) {
        warn(`主題「${tag.label}」這次 ${members.length} 檔、上次 ${prev.length} 檔，變動超過三成，沿用上一版（請檢查標籤代碼是否失效）`);
      } else if (!members.length && prev && prev.length) {
        warn(`主題「${tag.label}」這次 0 檔，沿用上一版`);
      } else {
        S.themeMembers[tag.id] = members;
        ok++;
        log(`主題「${tag.label}」：${members.length} 檔`);
      }
    } catch (err) {
      warn(`${err.message}（沿用上一版的主題標籤）`);
    }
  }
  try {
    const set = await fetchDomesticCodes();
    const prev = S.domestic;
    if (prev && prev.length && Math.abs(set.size - prev.length) / prev.length > THEME_CHANGE_RATIO) warn(`國內 ETF 清單 ${set.size} 檔、上次 ${prev.length} 檔，變動超過三成，沿用上一版`);
    else { S.domestic = [...set].sort(); ok++; log(`國內 ETF 官方清單：${set.size} 檔`); }
  } catch (err) {
    warn(`${err.message}（沿用上一版的地區分類）`);
  }
  if (ok) R.themesUpdatedAt = today;
  applyClassification(R, S);
}

function applyClassification(R, S) {
  const byTheme = {};
  for (const tag of THEME_TAGS) for (const code of S.themeMembers[tag.id] || []) (byTheme[code] ||= new Set()).add(tag.theme);
  const domestic = S.domestic ? new Set(S.domestic) : null;
  for (const [code, e] of Object.entries(R.etfs)) {
    const c = classify(code);
    e.type = c.type;
    e.sub = c.sub;
    if (e.market === '上市') {
      const order = ['高股息', '大型權值'];
      e.themes = [...(byTheme[code] || [])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      e.themeByName = false;
      if (domestic) { e.region = domestic.has(code) ? '國內' : '海外'; e.regionByName = false; }
    } else {
      const named = (e.type === '股票型' || e.type === '主動式') && /高股息|高息/.test(e.name);
      e.themes = named ? ['高股息'] : [];
      e.themeByName = named;
      e.region = /台灣|臺灣|台股|臺股/.test(e.name) ? '國內' : '海外';
      e.regionByName = true;
    }
  }
}

// ------------------------------------------------------------
// probe：每個來源讀一次、印出來，不寫檔
// ------------------------------------------------------------
async function probe() {
  const today = taipeiToday();
  const pm = prevMonth(monthKey(today));
  const step = async (title, fn) => {
    log(`\n### ${title}`);
    try { await fn(); } catch (err) { log(`::error::${title}：${err.message}`); }
  };
  let tpexSample = null;
  await step('上市每日（OpenAPI STOCK_DAY_ALL）', async () => {
    const s = await fetchTwseDaily();
    const codes = Object.keys(s.names);
    log(`日期 ${s.date}；ETF ${codes.length} 檔（有收盤價 ${Object.keys(s.prices).length}）；例：${codes.slice(0, 5).map((c) => `${c} ${s.names[c]} ${s.prices[c]}`).join('、')}`);
    const suf = {}; for (const c of codes) { const k = /[A-Z]$/.exec(c)?.[0] || '無'; suf[k] = (suf[k] || 0) + 1; }
    log(`末碼分布：${JSON.stringify(suf)}`);
  });
  await step('上櫃每日（OpenAPI tpex_mainboard_daily_close_quotes）', async () => {
    const s = await fetchTpexDaily();
    const codes = Object.keys(s.names);
    tpexSample = codes.find((c) => /B$/.test(c)) || codes[0];
    log(`日期 ${s.date}；ETF ${codes.length} 檔（有收盤價 ${Object.keys(s.prices).length}）；例：${codes.slice(0, 5).map((c) => `${c} ${s.names[c]} ${s.prices[c]}`).join('、')}`);
  });
  await step(`上市 ${pm} 月底（MI_INDEX）`, async () => {
    const s = await findMonthEnd('twse', pm);
    log(s ? `月底 ${s.date}，${Object.keys(s.prices).length} 檔；0050=${s.prices['0050']}，0056=${s.prices['0056']}` : '整個月找不到資料');
  });
  await step(`上櫃 ${pm} 月底（www/zh-tw/afterTrading/otc）`, async () => {
    const d = lastWeekdayOfMonth(pm);
    const [y, m, dd] = d.split('-');
    const raw = await getJson('上櫃歷史原始回應', [`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${y}/${m}/${dd}&type=EW&response=json`], { headers: H_TPEX });
    log(`原始回應鍵：${Object.keys(raw).join(',')}；stat=${raw.stat}；date=${raw.date}`);
    for (const t of raw.tables || []) log(`  表「${stripHtml(t.title)}」date=${t.date}；欄位 ${JSON.stringify(t.fields)}；${(t.data || []).length} 列；第一列 ${JSON.stringify((t.data || [])[0])}`);
    const s = await findMonthEnd('tpex', pm);
    log(s ? `解析結果：月底 ${s.date}，ETF ${Object.keys(s.prices).length} 檔；例：${Object.entries(s.prices).slice(0, 5).map(([c, p]) => `${c}=${p}`).join('、')}` : '解析結果：整個月找不到資料');
  });
  await step('分割紀錄（TWTCAU，2025-01-01 起）', async () => {
    const list = await fetchSplits('2025-01-01', today);
    log(`${list.length} 筆：${list.map((s) => `${s.code}@${s.date}×${s.ratio}`).join('、')}`);
  });
  await step('上市單檔月資料（00981A 2025-05）', async () => {
    const rows = await fetchTwseMonth('00981A', '2025-05');
    log(`${rows.length} 個交易日；第一天 ${JSON.stringify(rows[0])}`);
  });
  await step(`上櫃單檔月資料（${tpexSample || '00679B'} ${pm}）`, async () => {
    tpexSample ||= '00679B';
    const [y, mo] = pm.split('-');
    const raw = await getJson('上櫃單檔原始回應', [`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${tpexSample}&date=${y}/${mo}/01&response=json`], { headers: H_TPEX });
    log(`原始回應鍵：${Object.keys(raw).join(',')}；stat=${raw.stat}`);
    for (const t of raw.tables || []) log(`  表「${stripHtml(t.title)}」欄位 ${JSON.stringify(t.fields)}；${(t.data || []).length} 列；第一列 ${JSON.stringify((t.data || [])[0])}`);
    const rows = await fetchTpexMonth(tpexSample, pm);
    log(`解析結果：${rows.length} 個交易日；最後一天 ${JSON.stringify(rows.at(-1))}`);
  });
  for (const tag of THEME_TAGS) await step(`e添富主題「${tag.label}」`, async () => { const m = await fetchThemeMembers(tag); log(`${m.length} 檔：${m.slice(0, 12).join('、')}…`); });
  await step('國內 ETF 官方清單', async () => { const s = await fetchDomesticCodes(); log(`${s.size} 檔`); });
  log(`\nprobe 完成，共送出 ${requestCount} 個請求。沒有寫入任何檔案。`);
}

// ------------------------------------------------------------
// 主程式
// ------------------------------------------------------------
async function main() {
  const today = taipeiToday();
  log(`etf-monthly 抓取程式，模式 ${MODE}，台北時間 ${taipeiNowIso()}`);
  if (MODE === 'probe') return probe();

  const R = await readJson(RETURNS_PATH, emptyReturns());
  const S = await readJson(STATE_PATH, emptyState());
  S.buffer ||= { twse: {}, tpex: {} };
  S.pending ||= {};
  S.themeMembers ||= {};
  S.backfill ||= { twse: false, tpex: false };
  const before = JSON.stringify(R);
  const beforeState = JSON.stringify(S);

  // 1. 歷史補抓（各市場獨立；上櫃失敗不影響上市；失敗的話同一天不重試，避免一直打）
  const backfillMonths = monthsFromTo(BASELINE_MONTH, prevMonth(monthKey(today)));
  S.backfillTriedOn ||= {};
  let didBackfill = false;
  for (const market of ['twse', 'tpex']) {
    if (S.backfill[market]) continue;
    if (S.backfillTriedOn[market] === today && MODE !== 'backfill') { log(`${MARKETS[market]}歷史補抓今天已失敗過，明天再試`); continue; }
    S.backfillTriedOn[market] = today;
    try {
      await backfillMarket(R, S, market, backfillMonths);
      S.backfill[market] = today;
      didBackfill = true;
    } catch (err) {
      warn(`${MARKETS[market]}歷史補抓沒有完成，明天會重來：${err.message}`);
      if (market === 'twse') mustFail = true;
    }
  }

  // 2. 每日收盤（OpenAPI）
  const activeCount = (mk) => Object.values(R.etfs).filter((e) => marketKeyOf(e) === mk && !e.delisted && e.last).length;
  let dailyOk = 0;
  const newByMarket = { twse: [], tpex: [] };
  for (const market of ['twse', 'tpex']) {
    try {
      const snap = market === 'twse' ? await fetchTwseDaily() : await fetchTpexDaily();
      const res = applyDaily(R, S, market, snap, activeCount(market));
      if (res.applied) { dailyOk++; newByMarket[market] = res.newCodes.map((c) => ({ code: c, date: snap.date, close: snap.prices[c] })); }
    } catch (err) {
      warn(err.message);
    }
  }
  if (!dailyOk && !didBackfill) {
    log('::error::上市、上櫃的每日收盤都沒有讀到，這次不寫入任何檔案');
    process.exitCode = 1;
    return;
  }

  // 3. 分割紀錄（每天一次）
  await refreshSplits(R, S, today);

  // 4. 月底凍結：日曆上已經結束、還沒凍結的月份（五層保險見 freezeMonth）
  const freezeNew = { twse: [], tpex: [] };
  for (const market of ['twse', 'tpex']) {
    if (!S.backfill[market]) continue;
    for (const m of monthsFromTo(BASELINE_MONTH, prevMonth(monthKey(today)))) {
      const st = R.months[m]?.[market];
      if (st && (st.date || st.missing)) continue;
      freezeNew[market].push(...(await freezeMonth(R, S, market, m, today)));
    }
  }

  // 5. 新掛牌：查掛牌首日收盤（歷史補抓還沒完成的市場先不查，免得把舊 ETF 誤判成新掛牌）
  for (const market of ['twse', 'tpex']) {
    if (!S.backfill[market]) continue;
    const seen = new Set();
    const list = [];
    S.listingQueue ||= {};
    for (const x of S.listingQueue[market] || []) if (!seen.has(x.code)) { seen.add(x.code); list.push(x); }
    for (const x of freezeNew[market]) if (!seen.has(x.code)) { seen.add(x.code); list.push({ code: x.code, month: x.month, fallback: null }); }
    for (const x of newByMarket[market]) if (!seen.has(x.code)) { seen.add(x.code); list.push({ code: x.code, month: monthKey(x.date), fallback: { date: x.date, close: x.close } }); }
    const todo = list.filter(({ code }) => R.etfs[code] && !R.etfs[code].listed);
    S.listingQueue[market] = todo.slice(MAX_NEW_PER_RUN);
    if (!todo.length) continue;
    if (todo.length > MAX_NEW_PER_RUN) warn(`${MARKETS[market]}一次有 ${todo.length} 檔新代號，這次先查 ${MAX_NEW_PER_RUN} 檔的掛牌首日，其餘排到下一班`);
    log(`${MARKETS[market]}新掛牌 ${todo.length} 檔：${todo.map((x) => x.code).join('、')}`);
    for (const x of todo.slice(0, MAX_NEW_PER_RUN)) await resolveListing(R, market, x.code, x.month, x.fallback, true);
  }

  // 6. 下市判斷
  for (const market of ['twse', 'tpex']) markDelisted(R, market);

  // 7. 主題標籤與地區（每週，或有新代號時）
  const anyNew = newByMarket.twse.length + newByMarket.tpex.length > 0;
  await refreshThemes(R, S, today, anyNew || didBackfill);

  // 8. 寫檔（內容沒變就不寫）
  const changed = JSON.stringify(R) !== before;
  if (changed) R.updatedAt = taipeiNowIso();
  R.warnings = warnings.slice(0, 20);
  const changedState = JSON.stringify(S) !== beforeState;
  await mkdir(DATA_DIR, { recursive: true });
  if (changed) {
    await writeFile(RETURNS_PATH, JSON.stringify(R, null, 1) + '\n');
    log(`\n已寫入 ${RETURNS_PATH}（${Object.keys(R.etfs).length} 檔）`);
  } else {
    log('\n資料沒有變化，不改寫 returns.json');
  }
  if (changedState || changed) await writeFile(STATE_PATH, JSON.stringify(S) + '\n');

  // 統計
  const etfs = Object.values(R.etfs);
  log(`統計：上市 ${etfs.filter((e) => e.market === '上市' && !e.delisted).length} 檔、上櫃 ${etfs.filter((e) => e.market === '上櫃' && !e.delisted).length} 檔、已下市 ${etfs.filter((e) => e.delisted).length} 檔；最新資料 上市 ${R.latest.twse}、上櫃 ${R.latest.tpex}；分割紀錄 ${R.splits.length} 筆`);
  log(`本次共送出 ${requestCount} 個請求，警告 ${warnings.length} 則`);
  if (mustFail) process.exitCode = 1;
}

main().catch((err) => {
  console.log(`::error::${err.stack || err.message}`);
  process.exitCode = 1;
});
