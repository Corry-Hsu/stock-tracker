import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const portfolioPath = path.join(rootDir, 'portfolio.json');
const indexPath = path.join(rootDir, 'index.html');

const portfolio = JSON.parse(fs.readFileSync(portfolioPath, 'utf8'));
const activePositions = portfolio.positions.filter(p => p.status === 'active' && p.trackLive !== false);
const symbols = [...new Map(activePositions.map(p => [p.symbol, p])).values()];

async function fetchQuotesServerSide() {
  const quotes = new Map();

  // 1. Direct Cnyes Batch JSON API (No CORS in Node.js)
  try {
    const codes = symbols.map(s => `TWS:${s.symbol}:STOCK`).join(',');
    const res = await fetch(`https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${codes}?column=I&_=${Date.now()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const data = await res.json();
      const items = data?.data?.items || [];
      for (const item of items) {
        const sym = String(item['200010'] || '').trim().toUpperCase();
        const price = Number(item['6'] ?? item['75'] ?? item['76']);
        const prevClose = Number(item['21']);
        if (sym && Number.isFinite(price) && price > 0) {
          quotes.set(sym, { price, prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null });
        }
      }
    }
  } catch (e) {}

  // 2. Direct Yahoo 奇摩股市 HTML (iOS「股價報報」捷徑同源，Node.js 端無 CORS 限制)
  for (const s of symbols) {
    if (quotes.has(s.symbol)) continue;
    try {
      const res = await fetch(`https://tw.stock.yahoo.com/quote/${s.symbol}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const headerIdx = html.indexOf('main-0-QuoteHeader-Proxy');
      const scope = headerIdx !== -1 ? html.slice(headerIdx, headerIdx + 12000) : html;
      const m = scope.match(/class="[^"]*Fz\(32px\)[^"]*"[^>]*>\s*([0-9,]+(?:\.[0-9]+)?)\s*</);
      if (m) {
        const price = parseFloat(m[1].replace(/,/g, ''));
        const pm = html.match(/昨收<\/span>\s*<span[^>]*>\s*([0-9,]+(?:\.[0-9]+)?)\s*</);
        const prevClose = pm ? parseFloat(pm[1].replace(/,/g, '')) : null;
        if (Number.isFinite(price) && price > 0) {
          quotes.set(s.symbol, { price, prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null });
        }
      }
    } catch (e) {}
  }

  return quotes;
}

const quotes = await fetchQuotesServerSide();
if (quotes.size > 0) {
  for (const pos of portfolio.positions) {
    if (pos.status === 'active' && quotes.has(pos.symbol)) {
      const q = quotes.get(pos.symbol);
      pos.currentPrice = q.price;
      if (q.prevClose) pos.prevClose = q.prevClose;
    }
  }
  portfolio.lastUpdated = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());

  const jsonStr = JSON.stringify(portfolio, null, 2);
  fs.writeFileSync(portfolioPath, jsonStr + '\n', 'utf8');

  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/let DEFAULT_PORTFOLIO_JSON = \{[\s\S]*?\n\};/, `let DEFAULT_PORTFOLIO_JSON = ${jsonStr};`);
  fs.writeFileSync(indexPath, html, 'utf8');
  console.log(`Updated ${quotes.size} symbols at ${portfolio.lastUpdated}`);
} else {
  console.log('No new quotes fetched.');
}
