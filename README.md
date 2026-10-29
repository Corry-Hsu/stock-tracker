# 台股投資組合追蹤系統

個人持倉與已出場紀錄看板，支援台股紅漲綠跌、手機卡片、桌面表格、深淺色主題、搜尋、JSON 匯入匯出、損益與配置圖表。無須後端，可部署至 GitHub Pages。

網站：https://corry-hsu.github.io/stock-tracker/

## 使用方式

1. 新增或編輯標的，選擇上市（TWSE）或上櫃（TPEX）。股數以「股」為單位。
2. 點選「同步網路報價」自動透過多來源備援（Yahoo Finance 多節點代理、FinMind 台股直連 API、證交所／櫃買中心 MIS 批次行情）取得最新股價。每筆價格下方顯示來源與行情時間（台北時間）；資料可能延遲，並非保證即時的交易報價。
3. 同步失敗保留原價與時間，部分失敗會顯示成功筆數。已移除會改寫持倉價格的模擬功能，系統不會生成隨機價格冒充行情。
4. 手動修改現價可試算，該筆會標記為手動價格。已出場標的鎖定 exitPrice，不參與網路報價更新。
5. 修改存於目前瀏覽器的 localStorage，請定期匯出 JSON 備份。裝置、瀏覽器、網址來源之間不會自動同步；清除網站資料會移除本機紀錄。網站操作不會回寫 GitHub 檔案。

## 資料與計算限制

- 網站首次使用讀取 portfolio.json；已有有效瀏覽器資料時優先保留個人修改。「還原預設」使用部署的 JSON。直接開啟 index.html 或 JSON 載入失敗時使用 HTML 內建備份；更新預設資料時應同步兩者。
- 匯入與套用 JSON 檢查唯一 ID、代號、市場、狀態、正整數股數與正數價格。追蹤中必須有買進成本，已出場可保留未知成本，但必須有出場價。
- 未實現損益 =（現價 − 買進價）× 股數；報酬率 = 損益 ÷ 成本。已實現損益只包含已填成本的出場紀錄。
- 未計入手續費、證交稅、股利、除權息、拆併股及匯率；部分出場需自行拆成不同紀錄。sharesAssumed 為 true 表示股數是假設值，需自行確認。
- 報價支援多來源自動備援（AllOrigins、CodeTabs、CorsProxy 代理 Yahoo Finance、FinMind 原生 CORS 直連 API，以及 TWSE/TPEx MIS 批次查詢），解決單一代理限流或 Yahoo 阻擋導致無法更新的問題。
- 公開儲存庫內的預設 JSON 與 HTML 可被他人讀取；個人在瀏覽器新增的資料只存在該瀏覽器。
- Tailwind CSS、Chart.js、Google Fonts 使用外部 CDN，完整樣式與圖表需要網路。

## 部署

將 index.html、portfolio.json 放在 main 根目錄。在 Settings → Pages 選擇 Deploy from a branch → main → / (root)。既有 Pages 設定可沿用。

## 驗證

使用 Node.js 18 或以上，在專案根目錄執行 `node --test tests/tracker.test.cjs`。

測試以隔離的瀏覽器物件替身執行頁面 JavaScript，涵蓋資料驗證、報價失敗保留、部分成功、出場鎖定、編輯儲存與損益計算，不會向行情服務發送測試請求。
