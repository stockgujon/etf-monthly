// 端對端測試：用模擬世界依序跑 update.mjs，檢查產出的 data/returns.json
// 執行：node test/run-tests.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, cpSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeOf, ETFS, preSplitClose } from './mock-world.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = process.env.TEST_DIR || mkdtempSync(path.join(tmpdir(), 'etfm-'));
let pass = 0;
let fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } }
function near(a, b, tol = 1e-9) { return a != null && b != null && Math.abs(a - b) <= tol; }

function run(dir, nowIso, extraEnv = {}, mode = 'normal') {
  const log = path.join(dir, 'req.log');
  rmSync(log, { force: true });
  const r = spawnSync(process.execPath, ['--import', path.join(ROOT, 'test/mock-fetch.mjs'), path.join(ROOT, 'scripts/update.mjs'), mode], {
    env: { ...process.env, DATA_DIR: path.join(dir, 'data'), NOW: nowIso, RWD_GAP_MS: '0', RETRY_DELAYS_MS: '0,0,0', MOCK_LOG: log, ...extraEnv },
    encoding: 'utf8',
  });
  const requests = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { code: r.status, out: r.stdout + r.stderr, requests };
}
const load = (dir) => JSON.parse(readFileSync(path.join(dir, 'data/returns.json'), 'utf8'));
const loadState = (dir) => JSON.parse(readFileSync(path.join(dir, 'data/state.json'), 'utf8'));
function fork(from, name) { const to = path.join(BASE, name); rmSync(to, { recursive: true, force: true }); cpSync(from, to, { recursive: true }); return to; }

// ------------------------------------------------------------
console.log('\n[1] 第一次執行：歷史補抓 2024/12 ～ 2026/09 ＋ 當日資料');
const A = path.join(BASE, 'A');
rmSync(A, { recursive: true, force: true });
mkdirSync(A, { recursive: true });
let r = run(A, '2026-10-21T06:40:00Z'); // 台北 14:40
ok(r.code === 0, `結束碼 0（實際 ${r.code}）`);
let R = load(A);
ok(Object.keys(R.months).length === 22, `22 個月都有月底資料（實際 ${Object.keys(R.months).length}）`);
ok(R.months['2025-01'].twse.date === '2025-01-22', '2025/1 月底是封關日 1/22（春節休市）');
ok(R.months['2025-02'].twse.date === '2025-02-27', '2025/2 月底是 2/27（2/28 休市）');
ok(R.months['2025-01'].tpex.date === '2025-01-22', '上櫃 2025/1 月底也是 1/22');
ok(near(R.etfs['0050'].me['2025-05'], closeOf('0050', '2025-05-29')), '0050 2025/5 月底價＝分割前價格');
ok(near(R.etfs['0050'].me['2025-06'], closeOf('0050', '2025-06-30')), '0050 2025/6 月底價＝分割後價格');
const s0050 = R.splits.find((s) => s.code === '0050');
ok(s0050 && s0050.ratio === 4, `0050 分割比例取整為 4（實際 ${s0050?.ratio}）`);
const s631 = R.splits.find((s) => s.code === '00631L');
ok(s631 && s631.ratio === 22, `00631L 文字欄空白，仍用價格算出 22（實際 ${s631?.ratio}）`);
ok(R.etfs['00981A'].listed === '2025-05-27' && near(R.etfs['00981A'].listClose, closeOf('00981A', '2025-05-27')), '00981A 掛牌首日 2025-05-27 與首日收盤');
ok(R.etfs['00999B'].listed === '2025-09-10', '上櫃新掛牌 00999B 首日 2025-09-10');
ok(R.etfs['00415A'].listed === '2026-10-05', '本月新掛牌 00415A 首日 2026-10-05（每日資料發現）');
ok(R.etfs['0050'].listed === null, '起算點前就存在的 0050 沒有掛牌日');
ok(!!R.etfs['00699'].delisted, `00699 標為已下市（${R.etfs['00699'].delisted}）`);
ok(near(R.etfs['00777'].me['2025-07'], closeOf('00777', '2025-07-28')), '00777 月底停牌，7 月月底價用 7/28 收盤');
ok(R.latest.twse === '2026-10-20' && R.latest.tpex === '2026-10-21', `14:40 時上市 OpenAPI 還是前一天、上櫃是當天（${R.latest.twse}／${R.latest.tpex}）`);
ok(R.etfs['0056'].themes.includes('高股息') && R.etfs['00713'].themes.includes('高股息'), '高股息＝高股息 ∪ 高息低波動（00713 只掛後者）');
ok(R.etfs['0050'].themes.includes('大型權值') && R.etfs['00631L'].themes.includes('大型權值'), '大型權值照證交所（含 00631L）');
ok(R.etfs['00888'].themes.includes('高股息') && R.etfs['00888'].themeByName, '上櫃依名稱判斷高股息');
ok(R.etfs['00646'].region === '海外' && R.etfs['0050'].region === '國內', '地區依官方國內清單');
ok(R.etfs['00625K'].type === '股票型' && R.etfs['00625K'].sub === '外幣計價', 'K 尾碼＝股票型＋外幣計價');
ok(R.etfs['00631L'].type === '槓桿' && R.etfs['00679B'].type === '債券' && R.etfs['00981A'].type === '主動式', '末碼分類');
ok(!R.etfs['2330'] && !R.etfs['020000'], '個股與 ETN 不收');
ok(r.requests.length < 120, `請求數 ${r.requests.length}（一次性補抓）`);
const firstRunRequests = r.requests.length;

// ------------------------------------------------------------
console.log('\n[2] 同一天晚上再跑：不重補，只抓當日');
r = run(A, '2026-10-21T11:40:00Z'); // 19:40
R = load(A);
ok(r.code === 0, '結束碼 0');
ok(R.latest.twse === '2026-10-21', '上市更新到 10/21');
ok(r.requests.length <= 4, `只送出 ${r.requests.length} 個請求（每日 2 支＋必要時分割）`);
ok(!/歷史補抓/.test(r.out), '沒有重做歷史補抓');

console.log('\n[3] 沒有新資料：不改寫 returns.json');
r = run(A, '2026-10-21T15:40:00Z'); // 23:40
ok(/資料沒有變化/.test(r.out), '印出「資料沒有變化」');

// ------------------------------------------------------------
console.log('\n[4] 10/30（五）晚上跑一次 → 暫存區有月底最後一天');
run(A, '2026-10-30T15:40:00Z');
let S = loadState(A);
ok(!!S.buffer.twse['2026-10-30'], '暫存區有上市 10/30');
const B = fork(A, 'B'); // 給失敗情境用
const C = fork(A, 'C');

console.log('\n[5] 11/1（日）10:33：日曆上 10 月已結束 → 用歷史查詢凍結 10 月，並與暫存交叉比對');
r = run(A, '2026-11-01T02:33:00Z');
R = load(A);
ok(R.months['2026-10']?.twse?.date === '2026-10-30' && R.months['2026-10'].twse.source === 'history', '上市 10 月凍結於 10/30（歷史查詢）');
ok(R.months['2026-10']?.tpex?.date === '2026-10-30', '上櫃 10 月凍結於 10/30');
ok(/交叉比對一致/.test(r.out), '印出交叉比對一致');
ok(near(R.etfs['00415A'].me['2026-10'], closeOf('00415A', '2026-10-30')), '本月新掛牌的也寫入月底價');

// ------------------------------------------------------------
console.log('\n[6] 歷史查詢壞掉、暫存有月底最後工作天 → 改用暫存');
r = run(B, '2026-11-02T06:40:00Z', { MOCK_FAIL: 'MI_INDEX' });
R = load(B);
ok(R.months['2026-10']?.twse?.source === 'buffer', `上市 10 月改用暫存（${JSON.stringify(R.months['2026-10']?.twse)}）`);
ok(near(R.etfs['0050'].me['2026-10'], closeOf('0050', '2026-10-30')), '暫存的月底價正確');

// ------------------------------------------------------------
console.log('\n[7] 歷史查詢壞掉、暫存也沒有月底那天 → 補抓中，10 個工作天後標缺資料並亮紅燈');
const D = path.join(BASE, 'D');
rmSync(D, { recursive: true, force: true });
cpSync(C, D, { recursive: true });
S = loadState(D);
delete S.buffer.twse['2026-10-30'];
delete S.buffer.tpex['2026-10-30'];
writeFileSync(path.join(D, 'data/state.json'), JSON.stringify(S));
r = run(D, '2026-11-03T06:40:00Z', { MOCK_FAIL: 'MI_INDEX|afterTrading/otc' });
R = load(D);
ok(R.months['2026-10']?.twse?.pending === true, '上市 10 月標「補抓中」');
ok(r.code === 0, '還在等的期間不亮紅燈');
r = run(D, '2026-11-17T06:40:00Z', { MOCK_FAIL: 'MI_INDEX|afterTrading/otc' });
R = load(D);
ok(R.months['2026-10']?.twse?.missing === true, '超過 10 個工作天 → 缺資料');
ok(r.code === 1, '並且亮紅燈（結束碼 1）');

// ------------------------------------------------------------
console.log('\n[8] 防呆：OpenAPI 只回 2 檔 → 不採用');
const E = fork(C, 'E');
const before = readFileSync(path.join(E, 'data/returns.json'), 'utf8');
r = run(E, '2026-11-02T11:40:00Z', { MOCK_FEW: '1', MOCK_FAIL: 'tpex_mainboard' });
ok(/少超過三成，不採用/.test(r.out), '印出拒收原因');
ok(JSON.parse(readFileSync(path.join(E, 'data/returns.json'), 'utf8')).latest.twse === JSON.parse(before).latest.twse, '最新日期沒有被改');

console.log('\n[9] 兩個每日來源都失敗 → 結束碼 1、不寫檔');
const F = fork(C, 'F');
const beforeF = readFileSync(path.join(F, 'data/returns.json'), 'utf8');
r = run(F, '2026-10-31T02:33:00Z', { MOCK_FAIL: 'STOCK_DAY_ALL|tpex_mainboard' });
ok(r.code === 1, '結束碼 1');
ok(readFileSync(path.join(F, 'data/returns.json'), 'utf8') === beforeF, 'returns.json 沒被改');
ok(/回應 503/.test(r.out), '日誌印出真正原因（HTTP 503）');

console.log('\n[10] 上櫃歷史補抓失敗 → 上市照常、上櫃之後再補，且同一天不重試');
const G = path.join(BASE, 'G');
rmSync(G, { recursive: true, force: true });
mkdirSync(G, { recursive: true });
r = run(G, '2026-10-21T06:40:00Z', { MOCK_FAIL: 'afterTrading/otc' });
R = load(G);
S = loadState(G);
ok(!!S.backfill.twse && !S.backfill.tpex, '上市補完、上櫃未完成');
ok(r.code === 0, '上櫃補抓失敗不亮紅燈（上市正常）');
ok(!R.etfs['00679B']?.listed, '上櫃舊 ETF 沒有被誤判成新掛牌');
r = run(G, '2026-10-21T11:40:00Z', { MOCK_FAIL: 'afterTrading/otc' });
ok(/今天已失敗過/.test(r.out) && !r.requests.some((x) => x.includes('afterTrading/otc')), '同一天不再打上櫃歷史');
r = run(G, '2026-10-22T11:40:00Z');
R = load(G);
S = loadState(G);
ok(!!S.backfill.tpex && R.months['2025-06'].tpex?.date === '2025-06-30', '隔天上櫃補抓成功');
ok(R.etfs['00679B'].listed === null && R.etfs['00999B'].listed === '2025-09-10', '補完後掛牌判斷正確');

console.log('\n[11] probe 模式不寫檔');
const H = path.join(BASE, 'H');
rmSync(H, { recursive: true, force: true });
mkdirSync(H, { recursive: true });
r = run(H, '2026-10-21T11:40:00Z', {}, 'probe');
ok(r.code === 0 && !existsSync(path.join(H, 'data')), 'probe 結束碼 0 且沒有 data 資料夾');
ok(/probe 完成/.test(r.out), '印出 probe 完成');

console.log(`\n結果：${pass} 通過、${fail} 失敗（第一次補抓 ${firstRunRequests} 個請求）。測試資料夾：${BASE}`);
process.exitCode = fail ? 1 : 0;
