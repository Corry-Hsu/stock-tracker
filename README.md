# stock-tracker
互動式「台股標的即時報酬追蹤系統」
# 台股標的即時報酬追蹤系統 (TW Stock Portfolio Tracker)

這是一個以 **JSON 資料格式驅動** 的台股投資組合即時看盤與報酬率追蹤網頁。支援台股「紅漲綠跌」配色、即時報價同步、盤中模擬跳動、視覺化資產配置圖表，以及一鍵將已出場標的「鎖定出場價」不再隨盤勢波動。

## 核心特色

- **JSON Data 驅動架構**：所有持倉與歷史出場紀錄皆由標準化 JSON 管理，支援線上直接編輯、匯入 `.json` 或匯出備份。
- **追蹤中 vs. 已出場固定**：
  - `status: "active"` 且 `trackLive: true`：隨最新報價即時計算未實現損益與報酬率 (ROI)。
  - `status: "exited"` 且 `trackLive: false`：鎖定於 `exitPrice` 出場成交價，不再隨大盤跳動。
- **零後端依賴 (GitHub Pages Ready)**：單一 `index.html` 即可直接透過 GitHub Pages 發佈為個人看盤網站。

