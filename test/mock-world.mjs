// 模擬的證交所／櫃買世界：用來在沙箱裡測試 update.mjs（沙箱連不到真的交易所）
// 數字都是假的，只有「結構」模仿實測到的回應。

const pad = (n) => String(n).padStart(2, '0');
const parse = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (dt) => dt.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = parse(iso); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const isWeekend = (iso) => { const w = parse(iso).getUTCDay(); return w === 0 || w === 6; };
export const toRoc = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(y) - 1911}/${m}/${d}`; };
const toRocCompact = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(y) - 1911}${m}${d}`; };
const toRocTitle = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(y) - 1911}年${m}月${d}日`; };

// 休市日（工作日中）
const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-23', '2025-01-24', '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-28', '2025-04-03', '2025-04-04', '2025-05-30', '2025-10-06', '2025-10-10',
  '2026-01-01', '2026-02-13', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-10-09',
]);
export function isTradingDay(iso) { return !isWeekend(iso) && !HOLIDAYS.has(iso); }

// ETF 設定
export const ETFS = {
  '0050': { name: '元大台灣50', mkt: 'twse', base: 180, drift: 0.0009, splits: [{ date: '2025-06-18', ratio: 4, halt: ['2025-06-11', '2025-06-17'] }], tags: ['big'], domestic: true },
  '006208': { name: '富邦台50', mkt: 'twse', base: 105, drift: 0.0009, tags: ['big'], domestic: true },
  '0056': { name: '元大高股息', mkt: 'twse', base: 37, drift: 0.0001, tags: ['hd'], domestic: true },
  '00713': { name: '元大台灣高息低波', mkt: 'twse', base: 52, drift: 0.0002, tags: ['hdlv'], domestic: true },
  '00631L': { name: '元大台灣50正2', mkt: 'twse', base: 200, drift: 0.0018, splits: [{ date: '2026-03-31', ratio: 22, halt: ['2026-03-24', '2026-03-30'] }], tags: ['big'], domestic: true },
  '00632R': { name: '元大台灣50反1', mkt: 'twse', base: 22, drift: -0.0009, tags: ['big'], domestic: true },
  '00646': { name: '元大S&P500', mkt: 'twse', base: 50, drift: 0.0005, tags: ['big'], domestic: false },
  '00625K': { name: '富邦上証+R', mkt: 'twse', base: 8, drift: 0.0001, domestic: false },
  '00981A': { name: '主動統一台股增長', mkt: 'twse', base: 9.89, drift: 0.0012, listed: '2025-05-27', domestic: true },
  '00415A': { name: '主動群益核心50', mkt: 'twse', base: 10, drift: 0.0005, listed: '2026-10-05', tags: ['big'], domestic: true },
  '00699': { name: '下市測試ETF', mkt: 'twse', base: 20, drift: -0.0003, delisted: '2025-08-15', domestic: true },
  '00777': { name: '月底停牌測試', mkt: 'twse', base: 30, drift: 0.0002, halts: [['2025-07-29', '2025-08-04']], domestic: true },
  '00679B': { name: '元大美債20年', mkt: 'tpex', base: 30, drift: -0.0002 },
  '00937B': { name: '群益ESG投等債20+', mkt: 'tpex', base: 15, drift: 0.00005 },
  '00999B': { name: '測試新債券', mkt: 'tpex', base: 15, drift: 0.0001, listed: '2025-09-10' },
  '00888': { name: '測試台灣高股息', mkt: 'tpex', base: 18, drift: 0.0001 },
};

const ORIGIN = '2024-11-01';
function dayIndex(iso) { return Math.round((parse(iso) - parse(ORIGIN)) / 864e5); }
function halted(e, iso) {
  for (const s of e.splits || []) if (iso >= s.halt[0] && iso <= s.halt[1]) return true;
  for (const h of e.halts || []) if (iso >= h[0] && iso <= h[1]) return true;
  return false;
}
export function closeOf(code, iso) {
  const e = ETFS[code];
  if (!e || !isTradingDay(iso)) return null;
  if (e.listed && iso < e.listed) return null;
  if (e.delisted && iso > e.delisted) return null;
  if (halted(e, iso)) return null;
  const i = e.listed ? dayIndex(iso) - dayIndex(e.listed) : dayIndex(iso);
  let p = e.base * (1 + e.drift * i + 0.01 * Math.sin(i / 9));
  for (const s of e.splits || []) if (iso >= s.date) p /= s.ratio;
  return Math.round(p * 100) / 100;
}
export function preSplitClose(code, s) {
  // 停止買賣前最後一個交易日的收盤
  let d = addDays(s.halt[0], -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return closeOf(code, d);
}

function tradingOn(mkt, iso) {
  const out = [];
  for (const [code, e] of Object.entries(ETFS)) if (e.mkt === mkt) { const c = closeOf(code, iso); if (c != null) out.push([code, e.name, c]); }
  return out;
}
function lastTradingOnOrBefore(iso) { let d = iso; while (!isTradingDay(d)) d = addDays(d, -1); return d; }

// 現在時間（台北）決定 OpenAPI 給哪一天
function nowTaipei() { const now = process.env.NOW ? new Date(process.env.NOW) : new Date(); const t = new Date(now.getTime() + 8 * 3600e3); return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours() }; }
function openapiDate(mkt) {
  const { date, hour } = nowTaipei();
  const readyHour = mkt === 'twse' ? 19 : 14; // 上市 OpenAPI 比較慢
  let d = isTradingDay(date) && hour >= readyHour ? date : addDays(date, -1);
  return lastTradingOnOrBefore(d);
}

function json(body, status = 200) { return { status, body: JSON.stringify(body) }; }

export function handle(url, init = {}) {
  const u = new URL(url);
  const p = u.pathname;
  const q = u.searchParams;
  const fail = process.env.MOCK_FAIL ? new RegExp(process.env.MOCK_FAIL) : null;
  if (fail && fail.test(url)) return { status: 503, body: 'Service Unavailable' };

  if (u.host === 'openapi.twse.com.tw' && p.endsWith('/STOCK_DAY_ALL')) {
    const d = openapiDate('twse');
    let rows = tradingOn('twse', d).map(([c, n, close]) => ({ Date: toRocCompact(d), Code: c, Name: n, TradeVolume: '1000', ClosingPrice: close.toFixed(2) }));
    if (process.env.MOCK_FEW) rows = rows.slice(0, 2);
    rows.push({ Date: toRocCompact(d), Code: '2330', Name: '台積電', ClosingPrice: '1000.00' });
    rows.push({ Date: toRocCompact(d), Code: '020000', Name: 'ETN', ClosingPrice: '10.00' });
    return json(rows);
  }
  if (u.host === 'www.tpex.org.tw' && p.endsWith('/tpex_mainboard_daily_close_quotes')) {
    const d = openapiDate('tpex');
    return json(tradingOn('tpex', d).map(([c, n, close]) => ({ Date: toRocCompact(d), SecuritiesCompanyCode: c, CompanyName: n, Close: close.toFixed(2), TradingShares: '1000' })));
  }
  if (/twse\.com\.tw$/.test(u.host) && p === '/rwd/zh/afterTrading/MI_INDEX') {
    const ymd = q.get('date');
    const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    const rows = isTradingDay(iso) ? tradingOn('twse', iso) : [];
    const fields = ['證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌(+/-)'];
    const tables = [{}, {}, { title: rows.length ? `${toRocTitle(iso)} 每日收盤行情(ETF)` : '', fields: rows.length ? fields : [], data: rows.map(([c, n, close]) => [c, n, '1,000', '10', '1,000', '', '', '', close.toLocaleString('en-US', { minimumFractionDigits: 2 }), '<p style= color:red>+</p>']) }];
    return json({ stat: 'OK', date: ymd, tables });
  }
  if (/twse\.com\.tw$/.test(u.host) && p === '/rwd/zh/afterTrading/STOCK_DAY') {
    const ymd = q.get('date');
    const code = q.get('stockNo');
    const e = ETFS[code];
    const m = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}`;
    if (!e) return json({ stat: '很抱歉，沒有符合條件的資料!' });
    const data = [];
    for (let d = `${m}-01`; d.startsWith(m); d = addDays(d, 1)) { const c = closeOf(code, d); if (c != null) data.push([toRoc(d), '1,000', '1,000', '', '', '', c.toFixed(2), '', '10', '']); }
    return json({ stat: 'OK', title: `${Number(ymd.slice(0, 4)) - 1911}年${ymd.slice(4, 6)}月 ${code} ${e.name} 各日成交資訊`, fields: ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數', '註記'], data });
  }
  if (/twse\.com\.tw$/.test(u.host) && p === '/rwd/zh/split/TWTCAU') {
    const a = q.get('startDate'); const b = q.get('endDate');
    const from = `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}`;
    const to = `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}`;
    const data = [];
    for (const [code, e] of Object.entries(ETFS)) for (const s of e.splits || []) if (s.date >= from && s.date <= to) {
      const pre = preSplitClose(code, s);
      // 00631L 那筆的文字欄故意留空，模仿實測
      data.push([toRoc(s.date), code, e.name, code === '00631L' ? '' : '分割', pre.toFixed(2), (Math.round((pre / s.ratio) * 100) / 100).toFixed(2), '', '', '']);
    }
    data.sort((x, y) => x[0].localeCompare(y[0]));
    return json({ stat: 'OK', title: 'ETF分割(反分割)恢復買賣參考價格', fields: ['恢復買賣日期', 'ETF代號', '名稱', '分割(反分割)', '停止買賣前收盤價格', '恢復買賣參考價', '漲停價格', '跌停價格', '開盤競價基準'], data });
  }
  if (/twse\.com\.tw$/.test(u.host) && p === '/rwd/zh/ETFortune/ajaxProductsResult') {
    const body = new URLSearchParams(String(init.body || ''));
    const tagMap = { ff808081899b8efc0189aa050440001c: 'hd', ff808081899b8efc0189aa05af5c001d: 'hdlv', ff808081899b8efc0189aa06d5ce0021: 'big' };
    const t = tagMap[body.get('hashtag')];
    const data = Object.entries(ETFS).filter(([, e]) => (e.tags || []).includes(t)).map(([c, e]) => ({ stockNo: c, stockName: e.name }));
    return json({ status: 'success', data });
  }
  if (/twse\.com\.tw$/.test(u.host) && /^\/rwd\/zh\/ETF\/(domestic|activeList)$/.test(p)) {
    const active = p.endsWith('activeList');
    const data = Object.entries(ETFS).filter(([c, e]) => e.mkt === 'twse' && /A$/.test(c) === active).map(([c, e]) => [c, e.name, '', e.domestic ? 'domestic' : 'foreign']);
    return json({ stat: 'OK', data });
  }
  if (u.host === 'www.tpex.org.tw' && p === '/www/zh-tw/afterTrading/otc') {
    const [y, m, d] = q.get('date').split('/');
    const iso = `${y}-${m}-${d}`;
    const rows = isTradingDay(iso) ? tradingOn('tpex', iso) : [];
    return json({ stat: 'ok', date: `${y}${m}${d}`, tables: [{ title: '上櫃股票行情', date: `${y}${m}${d}`, fields: ['代號', '名稱', '收盤', '漲跌'], data: rows.map(([c, n, close]) => [c, n, close.toFixed(2), '0']) }] });
  }
  if (u.host === 'www.tpex.org.tw' && p === '/www/zh-tw/afterTrading/tradingStock') {
    const code = q.get('code');
    const [y, mo] = q.get('date').split('/');
    const m = `${y}-${mo}`;
    const data = [];
    for (let d = `${m}-01`; d.startsWith(m); d = addDays(d, 1)) { const c = closeOf(code, d); if (c != null) data.push([toRoc(d), '1', '1', '', '', '', c.toFixed(2), '']); }
    return json({ stat: 'ok', tables: [{ title: `${code} 個股日成交資訊`, fields: ['日期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌'], data }] });
  }
  return { status: 404, body: `mock: no route for ${url}` };
}
