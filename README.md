# 國內ETF月報酬（etf-monthly）

網址：https://stockgujon.github.io/etf-monthly/

上市＋上櫃全部掛牌 ETF 的**單月報酬率**與**今年以來報酬率**。當月每天收盤後更新，月份結束後凍結保存；跨年後保留全年紀錄。可依市場／類型／主題／地區篩選，並下載 Excel（每個年度一張工作表）。

> 僅為個人用途，不做任何商業利益行為。與 etf-radar、etf-income、etf-dabaobao 完全獨立，不共用任何檔案或排程。

---

## 🔔 人工確認紀錄（每 1～2 個月加一列並 Commit）

GitHub 規定：公開 repo 連續 60 天沒有人為活動，排程會被自動停用（機器人的 commit 不一定算）。
在這裡加一列並 Commit，就能重置計時器，順便確認網站還活著。**建議抓 6 週左右。**

| 日期 | 網頁上的官方資料日 | 狀態 |
|---|---|---|
| （上線日） | | 第一次上線 |

---

## 第一次上線步驟（全部在 GitHub 網頁上操作）

1. 建立 **public** repo，名稱 `etf-monthly`。
2. 上傳 zip 裡的檔案：`index.html`、`README.md`、`scripts/`、`test/`、`.github/`。
   - Mac 的 Finder 預設看不到 `.github` 資料夾。如果上傳後 repo 裡沒有 `.github/workflows/update.yml`，
     就用 **Add file → Create new file**，檔名打 `.github/workflows/update.yml`（打斜線會自動建資料夾），
     內容貼上 zip 裡那個檔案的全文。
3. **Settings → Actions → General → Workflow permissions** 改成 **Read and write permissions**，Save。
4. **Settings → Pages**：Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)`，Save。
5. **Actions → Update ETF monthly returns → Run workflow**，模式選 **probe**，按 Run。
   跑完點進去看「抓資料」步驟，確認每個來源都有讀到（上櫃那兩項是第一次實測，最需要看）。
6. 再 **Run workflow** 一次，模式選 **normal**。第一次會補抓 2024/12 起的歷史資料，大約 3～6 分鐘。
7. 跑完（綠勾）後打開網址。

---

## 資料怎麼來

| 用途 | 來源 | 頻率 |
|---|---|---|
| 每日收盤（上市） | 證交所 OpenAPI `STOCK_DAY_ALL` | 每班 1 次 |
| 每日收盤（上櫃） | 櫃買 OpenAPI `tpex_mainboard_daily_close_quotes` | 每班 1 次 |
| 歷史月底收盤（上市） | 證交所 `MI_INDEX?type=0099P`（只取 ETF 表，標題自帶日期可驗證） | 第一次補抓＋每月凍結時 |
| 歷史月底收盤（上櫃） | 櫃買 `www/zh-tw/afterTrading/otc` | 同上 |
| 掛牌首日收盤 | 證交所 `STOCK_DAY`／櫃買 `tradingStock`（單檔當月逐日） | 有新掛牌時 |
| 分割／反分割 | 證交所 `split/TWTCAU`（比例用「停止買賣前收盤 ÷ 恢復買賣參考價」計算） | 每天 1 次 |
| 主題（高股息＝高股息∪高息低波動；大型權值） | 證交所 e添富主題因子 | 每週 1 次，有新代號時加查 |
| 地區（國內／海外） | 證交所國內成分 ETF 清單；上櫃依名稱 | 每週 1 次 |

平常每一班只送 2～3 個請求。

## 排程（台北時間）

- 週一～週五 14:33、19:33、23:33。14:33 那班通常只有上櫃是當天的（上市 OpenAPI 比較慢），當天的上市收盤多半在 19:33 或 23:33 進來。每一筆資料自帶交易日期，不會歸錯天。
- 每月 1～3 號 10:33（含週末）：月底收盤價的保險。

GitHub 的排程常延遲 15 分鐘到數小時，這是 GitHub 端的負載問題，不影響資料正確性。

## 月底收盤價的五層保險

1. 每天的收盤價保留最近 15 個交易日，月底那天只要被看到一次就記住。
2. 日曆上月份一結束，就用歷史查詢抓月底最後交易日（遇到假日自動往前找）。查不到時，如果暫存區剛好有該月最後一個工作天的資料，就用暫存區的。
3. 都補不到 → 不凍結，網頁表頭顯示「補抓中」，之後每一班重試。
4. 歷史查詢與暫存區都有時交叉比對，不一致就在日誌留警告。
5. 等了 10 個工作天還是補不到 → 該月顯示「缺資料」，Actions 亮紅燈（GitHub 會寄信）。

## 網頁怎麼算

- 單月報酬＝本月最後收盤 ÷ 上月底收盤 − 1；**只計價差，不含配息**。
- 新掛牌：掛牌當月從**掛牌首日收盤價**起算，標「掛牌月」；年度欄改為「掛牌以來」。
- 分割：期間內有分割時，起點價格依比例換算。
- 安全網：單月 ≤ −40% 或 ≥ +100% 時，程式會抓該月逐日收盤檢查。沒有「單日翻倍／腰斬」這種像分割的跳動 → 確認是真實行情，照常顯示並標「已逐日確認」；有 → 疑似漏掉的分割，標「⚠ 待確認」。
- 冷門 ETF 月底當天沒成交：用該月最後一次成交；整個月沒成交：沿用上月底（報酬 0%）。
- 下市判斷看「是否還在交易所名單上」，不是看有沒有成交。
- 已下市：保留歷史，標「已下市」。

## 正常／異常判讀

- 🟢 綠勾：成功。「資料沒有變更，不需要 commit」也是正常的（例如週末、休市）。
- 🔴 紅叉：展開「抓資料」步驟，`::warning::` 和 `::error::` 那幾行會寫出每個來源**真正的原因**（含 HTTP 狀態碼）。舊資料會完整保留，網頁不會壞。
- 日誌出現一堆 403／307 → 被擋了，把 `scripts/update.mjs` 開頭的 `RWD_GAP_MS` 調大（1500 → 3000）。
- 主題檔數突然大變 → 程式會沿用上一版並警告；請檢查 e添富的主題代碼是否換了（`THEME_TAGS`）。
- 網頁上「官方資料日」超過一週沒前進（不是連假）→ 去 Actions 看最近幾次的日誌。
- 程式邏輯修正後要重算全部歷史：Run workflow 選 **rebuild**（丟掉現有資料從頭補抓，約 6～8 分鐘）。平常不需要。

⚠️ 用網頁抓取工具檢查 `raw.githubusercontent.com` 或 GitHub Pages 常會讀到快取的舊版本。要確認 repo 內容，請直接看 GitHub 上的檔案畫面；要確認程式行為，看 Actions 日誌。

## 檔案

```
index.html                     網頁（讀 raw.githubusercontent.com 上的 data/returns.json）
scripts/update.mjs             抓取程式（Node 22，無外部套件）
.github/workflows/update.yml   排程
data/returns.json              網頁讀的資料（自動產生，勿手動編輯）
data/state.json                程式的暫存（自動產生，勿手動編輯）
test/                          在模擬資料上跑的測試（node test/run-tests.mjs）
```
