# 台股投資組合追蹤系統

個人持倉與已出場紀錄看板，支援台股紅漲綠跌、手機卡片、桌面表格、深淺色主題、搜尋、JSON 匯入匯出、損益與配置圖表。無須後端，可部署至 GitHub Pages。

網站：https://corry-hsu.github.io/stock-tracker/

## 使用方式

1. 新增或編輯標的，選擇上市（TWSE）或上櫃（TPEX）。股數以「股」為單位。
2. 開啟網站或點選「同步網路報價」會讀取最近一次雲端報價快照 `quotes.json`，不會從網頁逐檔轟炸公開代理。此按鈕只重新讀取快照，不會觸發 Actions；要立即取得新行情，至 Actions → Sync Taiwan Stock Quotes → Run workflow。
3. 雲端在台北時間平日 09:07–13:52 每 15 分鐘嘗試同步；GitHub 排程可能延後，不是逐秒即時行情。先用官方 TWSE/TPEx MIS 單次批次（上市、上櫃、ETF），鉅亨補缺，再用 Yahoo JSON 補缺（最多 2 個並行，429 後停止新增 Yahoo 請求）。每次請求含讀取內容最多 6 秒，整輪最多 45 秒。報價顯示來源與真實成交時間，超過 30 分鐘標示較舊／休市行情。失敗保留原價，不以買賣掛價或昨收冒充最新成交。
4. 手動修改現價可試算，該筆會標記為手動價格。已出場標的鎖定 exitPrice，不參與網路報價更新。
5. 修改存於目前瀏覽器的 localStorage，請定期匯出 JSON 備份。裝置、瀏覽器、網址來源之間不會自動同步；清除網站資料會移除本機紀錄。網站操作不會回寫 GitHub 檔案。

## 資料與計算限制

- 網站先讀取 portfolio.json 或有效的瀏覽器持倉，再僅合併較新的報價欄位；不新增、刪除、還原或改動交易紀錄。已出場、手動試算價與請求期間編輯的資料保留。新增的本機標的若不在雲端持倉清單中不會有報價；需另行將追蹤代號加入儲存庫。要恢復手動試算標的的雲端更新，可於匯出的 JSON 將該筆 quoteSource 的 manual 清除後重新匯入。直接開啟 index.html 仍使用內建備份與舊版瀏覽器備援，受 CORS 限制；建議使用 Pages。
- 匯入與套用 JSON 檢查唯一 ID、代號、市場、狀態、正整數股數與正數價格。追蹤中必須有買進成本，已出場可保留未知成本，但必須有出場價。
- 未實現損益 =（現價 − 買進價）× 股數；報酬率 = 損益 ÷ 成本。已實現損益只包含已填成本的出場紀錄。
- 未計入手續費、證交稅、股利、除權息、拆併股及匯率；部分出場需自行拆成不同紀錄。sharesAssumed 為 true 表示股數是假設值，需自行確認。
- `quotes.json` 記錄最近嘗試／成功時間、每來源成功／錯誤／空資料、耗時、覆蓋率與未更新代號。部分或全數失敗仍輸出診斷、保留先前報價，Actions 最後呈現失敗，不會假成功。超過 7 天、未附行情時間、未來時間或倒退的行情不套用；長假期間可能維持舊價。
- 公開儲存庫內的預設 JSON 與 HTML 可被他人讀取；個人在瀏覽器新增的資料只存在該瀏覽器。
- Tailwind CSS、Chart.js、Google Fonts 使用外部 CDN，完整樣式與圖表需要網路。

## 部署

將 index.html、portfolio.json、quotes.json 放在 main 根目錄。在 Settings → Pages 選擇 Deploy from a branch → main → / (root)。既有 Pages 設定可沿用，無須安裝套件、後端或新增金鑰。

Actions 只提交 quotes.json，不改寫 portfolio.json 或 HTML。正式 Pages 網址優先從公開儲存庫的 raw.githubusercontent.com/main/quotes.json 讀取，失敗才回退同站檔案；使用 no-store 與時間參數避免快取。這也避開 GITHUB_TOKEN 提交不會再次觸發 Pages 建置的限制。其他主機讀取同站 quotes.json；fork 請按自己的網址調整 cloudQuoteUrls。

PR 自動做離線測試、真實網路同步、同步後再測試與持倉不變檢查，生成檔只上傳至 Actions artifact。只有在預設分支的排程／手動執行才提交報價；推送遇到其他更新時會安全失敗，不強制覆寫。每輪報告可在 Actions summary 與 artifact 查看。

## 本次故障根因

- 2026-11-02 [同步執行 41441460236](https://github.com/Corry-Hsu/stock-tracker/actions/runs/41441460236) 記錄 `Updated 12 symbols`，但後續測試將舊現價固定為 1025、3005；實際變為 1060、3060 後測試失敗，提交步驟被跳過。已改成比較測試開始前的資料，不再依賴每日價格。
- 舊同步程式無逾時、忽略例外與服務端內容錯誤，零報價也回傳成功；沒有真實行情時間與來源紀錄。
- localStorage 優先載入整包舊資料，會遮住部署的新價格；目前以市場與代號合併獨立報價，保留個人交易資料。
- 2026-11-03 來源實測：鉅亨 HTTP 200 但 statusCode 5031（Redis 連線錯誤）；MIS 與 Yahoo JSON 可讀。修復版使用一次 MIS 查詢完成現有 12 檔，保留真實成交時間。這是當次觀察，不代表來源永遠可用。

## 驗證

使用 Node.js 22 或以上，在專案根目錄執行 `node --test tests/*.test.*`。

離線測試以隔離的瀏覽器物件替身與來源回應執行，涵蓋逾時（含內容卡住）、整輪取消、部分／零成功、HTTP 429、HTTP 200 內容錯誤、重複持倉、TWSE/TPEX/ETF、真實成交價與時間、錯誤市場、舊資料回退、雲端快照合併、操作中編輯、出場鎖定與持倉檔位元不變。測試本身不向行情服務發送請求。

手動整合驗證：`node scripts/sync-quotes.mjs`，再執行全部測試及 `git diff --exit-code -- portfolio.json index.html`。請勿將 quoteTime（行情時間）與 attemptedAt（同步嘗試時間）混用。
