const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../portfolio.json'), 'utf8'));
function app(fetch = async () => { throw Error('offline'); }, timers = {}) {
  const nodes = new Map(), storage = new Map(), events = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false,
      classList: { add(){}, remove(){}, contains(){ return true; }, toggle(){} }, setAttribute(){}, addEventListener(){} });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ console, Intl, Date, JSON, Number, String, Math, Set, AbortController, URL,
    fetch, setTimeout: timers.setTimeout || setTimeout, clearTimeout,
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) },
    window: { addEventListener(name, callback){ events.set(name, callback); }, innerWidth: 1200 },
    document: { getElementById: element, querySelectorAll: () => [], documentElement: element('html') } });
  vm.runInContext(source, ctx);
  const run = expression => vm.runInContext(expression,ctx);
  run('showToast = msg => { window.lastToast = msg; };');
  return { ctx, run, element, storage, events };
}

function cloudReport(overrides = {}) {
  return { schemaVersion: 1, attemptedAt: new Date().toISOString(), status: 'ok', updated: 1, requested: 12,
    sources: [{ source: 'TWSE MIS', status: 'ok' }], quotes: { 'TWSE:2330': {
      price: 2345, prevClose: 2370, quoteTime: new Date().toISOString(), quoteSource: 'TWSE MIS', priceType: 'trade'
    } }, ...overrides };
}

test('page startup overlays cloud quotes onto cached local holdings', async () => {
  const calls = [];
  const a = app(async url => {
    calls.push(url);
    return { ok: true, json: async () => url === './portfolio.json' ? seed : cloudReport() };
  });
  a.ctx.location = { protocol: 'https:', hostname: 'localhost', pathname: '/' };
  a.run('portfolioData.positions[3].shares = 999; portfolioData.positions[3].note = "cached local note"; savePortfolioState();');
  await a.events.get('DOMContentLoaded')();
  assert.deepEqual(calls.map(url => url.split('?')[0]), ['./portfolio.json', './quotes.json']);
  assert.equal(a.run('portfolioData.positions[3].shares'), 999);
  assert.equal(a.run('portfolioData.positions[3].note'), 'cached local note');
  assert.equal(a.run('portfolioData.positions[3].currentPrice'), 2345);
});

test('explicit new trades reach existing browser portfolios once without losing local edits or repeating deleted trades', () => {
  const a = app();
  const original = structuredClone(seed);
  original.positions = original.positions.filter(p => !seed.settings.positionAdditions.includes(p.id));
  original.positions[0].shares = 777;
  original.positions[0].note = 'preserve local note';
  original.positions.splice(1, 1); // A user's earlier deletion must stay deleted.
  a.ctx.cached = original;
  a.storage.clear();
  a.run('localStorage.setItem(STORAGE_KEY, JSON.stringify(cached)); portfolioData = loadPortfolioState();');
  const first = JSON.parse(a.run('JSON.stringify(portfolioData)'));
  for (const p of original.positions) assert.deepEqual(first.positions.find(item => item.id === p.id), p);
  assert.equal(first.positions.some(p => p.id === seed.positions[1].id), false);
  for (const id of seed.settings.positionAdditions) assert.equal(first.positions.filter(p => p.id === id).length, 1);
  a.run('portfolioData = loadPortfolioState();');
  assert.equal(a.run('portfolioData.positions.length'), first.positions.length);
  a.run('portfolioData.positions = portfolioData.positions.filter(p => p.id !== "tw-5269-20261103"); savePortfolioState(); portfolioData = loadPortfolioState();');
  assert.equal(a.run('portfolioData.positions.some(p => p.id === "tw-5269-20261103")'), false);
});

test('deployed page reads one cloud snapshot with no proxies and preserves all holdings fields', async () => {
  const calls = [];
  const a = app(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => cloudReport() }; });
  a.ctx.location = { protocol: 'https:', hostname: 'corry-hsu.github.io', pathname: '/stock-tracker/' };
  a.run('portfolioData.positions[3].shares = 777; portfolioData.positions[3].note = "local edit"; savePortfolioState(); portfolioData = loadPortfolioState();');
  const before = JSON.parse(a.run('JSON.stringify(portfolioData)'));
  await a.run('syncNetworkQuotes()');
  const after = JSON.parse(a.run('JSON.stringify(portfolioData)'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/raw.githubusercontent.com\/Corry-Hsu\/stock-tracker\/main\/quotes.json\?/);
  assert.equal(calls[0].options.cache, 'no-store');
  for (let i = 0; i < before.positions.length; i++) {
    const old = before.positions[i], p = after.positions[i];
    for (const [key, value] of Object.entries(old)) {
      if (!['currentPrice', 'prevClose', 'quoteTime', 'quoteSource', 'quoteDelivery'].includes(key)) assert.deepEqual(p[key], value);
    }
    if (old.symbol === '2330' && old.status === 'active') assert.equal(p.currentPrice, 2345);
    else assert.deepEqual(p, old);
  }
  assert.match(a.run('quoteLabel(portfolioData.positions[3])'), /行情.*可能延遲/);
  assert.equal(a.element('btnLiveFetch').disabled, false);
});

test('cloud merge never restores deleted lots, changes manual prices, locked trades or edits made in flight', async () => {
  let resolveFetch;
  const a = app(() => new Promise(resolve => { resolveFetch = resolve; }));
  a.ctx.location = { protocol: 'https:', hostname: 'localhost', pathname: '/' };
  a.run('portfolioData.positions[3].quoteSource = "manual"; portfolioData.positions[3].currentPrice = 3456;');
  const pending = a.run('syncNetworkQuotes()');
  a.run('portfolioData.positions[5].currentPrice = 3457; portfolioData.positions.splice(10, 1);');
  resolveFetch({ ok: true, json: async () => cloudReport() });
  await pending;
  assert.equal(a.run('portfolioData.positions.length'), seed.positions.length - 1);
  assert.equal(a.run('portfolioData.positions[3].currentPrice'), 3456);
  assert.equal(a.run('portfolioData.positions[5].currentPrice'), 3457);
  assert.match(a.run('quoteLabel(portfolioData.positions[3])'), /手動/);
  assert.equal(a.run('portfolioData.positions.find(p => p.id === "tw-2330-20260929-exit").exitPrice'), 2480);
});

test('cloud failures preserve data, expose source errors, fall back from raw host and restore the button', async () => {
  let calls = 0;
  const a = app(async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => cloudReport({ status: 'failed', updated: 0, quotes: {}, sources: [{ source: 'Cnyes', status: 'error', error: 'Redis 5031' }] }) };
  });
  a.ctx.location = { protocol: 'https:', hostname: 'corry-hsu.github.io', pathname: '/stock-tracker/' };
  const before = a.run('JSON.stringify(portfolioData)');
  await a.run('syncNetworkQuotes()');
  assert.equal(calls, 2);
  assert.equal(a.run('JSON.stringify(portfolioData)'), before);
  assert.match(a.element('statusText').textContent, /失敗.*Redis 5031/);
  assert.equal(a.element('btnLiveFetch').disabled, false);
});

test('cloud hung bodies terminate and duplicate refreshes do not create more requests', async () => {
  let calls = 0;
  const a = app(async () => { calls++; return { ok: true, json: () => new Promise(() => {}) }; }, { setTimeout: fn => setTimeout(fn, 15) });
  a.ctx.location = { protocol: 'https:', hostname: 'localhost', pathname: '/' };
  const before = a.run('JSON.stringify(portfolioData)');
  const pending = a.run('syncNetworkQuotes()');
  await a.run('syncNetworkQuotes()');
  await pending;
  assert.equal(calls, 1);
  assert.equal(a.run('JSON.stringify(portfolioData)'), before);
  assert.match(a.element('statusText').textContent, /逾時/);
  assert.equal(a.element('btnLiveFetch').disabled, false);
});

test('cloud rejects invalid schemas and invalid, stale, future or regressing prices', async () => {
  for (const mutate of [
    r => { r.schemaVersion = 99; },
    r => { r.quotes['TWSE:2330'].price = -1; },
    r => { r.quotes['TWSE:2330'].quoteTime = null; },
    r => { r.quotes['TWSE:2330'].quoteTime = '2000-01-01T00:00:00Z'; },
    r => { r.quotes['TWSE:2330'].quoteTime = '2099-01-01T00:00:00Z'; },
    r => { r.quotes['TWSE:2330'].quoteTime = new Date(Date.now() - 60000).toISOString(); }
  ]) {
    const report = cloudReport(); mutate(report);
    const a = app(async () => ({ ok: true, json: async () => report }));
    a.ctx.location = { protocol: 'https:', hostname: 'localhost', pathname: '/' };
    a.run('portfolioData.positions.filter(p => p.symbol === "2330").forEach(p => { p.quoteTime = new Date().toISOString(); });');
    const before = a.run('JSON.stringify(portfolioData)');
    await a.run('syncNetworkQuotes()');
    assert.equal(a.run('JSON.stringify(portfolioData)'), before);
  }
});
test('embedded fallback and deployed JSON agree and validate', () => {
  const a=app();
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(DEFAULT_PORTFOLIO_JSON)')), seed);
  assert.equal(a.run('validatePortfolio(portfolioData).positions.length'),seed.positions.length);
});
test('reject malformed holdings before applying data', () => {
  const a=app();
  for (const change of ['p.shares=-1','p.shares=1.5','p.buyPrice=null','p.currentPrice="12"','p.currentPrice=Infinity','p.symbol="<script>"','p.market="BAD"','p.status="bad"','p.trackLive=false','p.name=""']) {
    assert.throws(()=>a.run(`{ const d=JSON.parse(JSON.stringify(DEFAULT_PORTFOLIO_JSON)); const p=d.positions[0]; ${change}; validatePortfolio(d); }`));
  }
  assert.throws(()=>a.run('validatePortfolio({positions:[null]})'));
  assert.throws(()=>a.run('validatePortfolio({positions:[DEFAULT_PORTFOLIO_JSON.positions[0],DEFAULT_PORTFOLIO_JSON.positions[0]]})'));
});
test('network failure leaves prices and update time unchanged and restores button', async () => {
  const a=app(); const before=a.run('JSON.stringify(portfolioData)');
  await a.run('syncNetworkQuotes()');
  assert.equal(a.run('JSON.stringify(portfolioData)'),before);
  assert.match(a.element('statusText').textContent,/同步失敗/);
  assert.equal(a.element('btnLiveFetch').disabled,false);
});
test('partial success uses daily previous close, records quote time and leaves exited positions locked', async () => {
  const a=app(async url => {
    if (!decodeURIComponent(url).includes('3017.TW')) throw Error('offline');
    return { ok:true, json: async()=>({contents:JSON.stringify({chart:{result:[{meta:{regularMarketPrice:3200, regularMarketTime:1793151000, previousClose:3100, chartPreviousClose:3000}}]}})}) };
  });
  const exited=a.run('JSON.stringify(portfolioData.positions.filter(p=>p.status==="exited"))');
  await a.run('syncNetworkQuotes()');
  assert.equal(a.run('portfolioData.positions[0].currentPrice'),3200);
  assert.equal(a.run('portfolioData.positions[0].prevClose'),3100);
  assert.equal(a.run('portfolioData.positions[1].currentPrice'),seed.positions[1].currentPrice);
  assert.equal(a.run('JSON.stringify(portfolioData.positions.filter(p=>p.status==="exited"))'),exited);
  assert.match(a.element('statusText').textContent, new RegExp('1/' + seed.positions.filter(p => p.status === 'active' && p.trackLive).length));
  assert.match(a.run('quoteLabel(portfolioData.positions[0])'),/Yahoo/);
});
test('invalid payload never overwrites a stored price', async()=>{
  const a=app(async()=>({ok:true,json:async()=>({contents:'{"chart":{"result":[{"meta":{"regularMarketPrice":-10}}]}}'})}));
  const before=a.run('JSON.stringify(portfolioData)'); await a.run('syncNetworkQuotes()');
  assert.equal(a.run('JSON.stringify(portfolioData)'),before);
});
test('exiting a position while its quote is in flight preserves it', async()=>{
  const a=app(async()=>{ a.run('portfolioData.positions[0].status="exited"; portfolioData.positions[0].trackLive=false; portfolioData.positions[0].exitPrice=3333;');
    return {ok:true,json:async()=>({contents:JSON.stringify({chart:{result:[{meta:{regularMarketPrice:3400,regularMarketTime:1793151000}}]}})})};
  });
  await a.run('syncNetworkQuotes()');
  assert.equal(a.run('portfolioData.positions[0].currentPrice'),seed.positions[0].currentPrice);
  assert.equal(a.run('portfolioData.positions[0].exitPrice'),3333);
});
test('KPI matches sum of the active positions and excludes unknown exited costs',()=>{
  const a=app(); a.run('renderKPIs()');
  const active=seed.positions.filter(p=>p.status==='active');
  const value=active.reduce((n,p)=>n+p.currentPrice*p.shares,0);
  const cost=active.reduce((n,p)=>n+p.buyPrice*p.shares,0);
  assert.equal(a.element('kpiMarketValue').textContent, a.run(`fmtCurrency(${value})`));
  assert.equal(a.element('kpiUnrealizedPnl').textContent,a.run(`fmtSignedCurrency(${value-cost})`));
  assert.equal(a.element('kpiRealizedPnl').textContent,'點編輯可補買價');
});
test('edit saves notes and TPEX market; invalid shares do not mutate portfolio',()=>{
  const a=app(); a.run('openPositionModal(portfolioData.positions[0])');
  a.element('formNote').value='updated note'; a.element('formMarket').value='TPEX';
  a.run('handlePositionFormSubmit({preventDefault(){}})');
  assert.equal(a.run('portfolioData.positions[0].note'),'updated note');
  assert.equal(a.run('portfolioData.positions[0].market'),'TPEX');
  assert.equal(a.run('portfolioData.positions[0].quoteSource'),'manual');
  const before=a.run('JSON.stringify(portfolioData)');
  a.element('formShares').value='0'; a.run('handlePositionFormSubmit({preventDefault(){}})');
  assert.equal(a.run('JSON.stringify(portfolioData)'),before);
});
test('HTML attributes escape imported IDs',()=>{
  const a=app(); a.run('portfolioData.positions[0].id=\'x" onfocus="alert(1)\'; renderTables()');
  assert.ok(!a.element('activeTableBody').innerHTML.includes('data-id="x" onfocus='));
  assert.match(a.element('activeTableBody').innerHTML,/x&quot; onfocus=&quot;alert/);
});
test('runtime dates are dynamic and no random prices remain',()=>{
  const a=app(); a.run('openPositionModal(null)');
  assert.equal(a.element('formTradeDate').value,a.run('taipeiNow().slice(0,10)'));
  assert.ok(!source.includes('Math.random'));
});

test('falls back to secondary Yahoo proxy or tw.stock.yahoo.com HTML (iOS 股價報報 shortcut source) when primary AllOrigins proxy fails', async () => {
  const a = app(async url => {
    const decoded = decodeURIComponent(url);
    // Primary allorigins/get fails
    if (url.includes('api.allorigins.win/get')) throw Error('AllOrigins 522 timeout');
    // Secondary codetabs proxy succeeds for 2330.TW JSON
    if (url.includes('api.codetabs.com') && decoded.includes('query1.finance.yahoo.com') && decoded.includes('2330.TW')) {
      return {
        ok: true,
        json: async () => ({
          chart: {
            result: [{
              meta: { regularMarketPrice: 2450, regularMarketTime: 1793152000, previousClose: 2400 }
            }]
          }
        })
      };
    }
    // Yahoo 奇摩股市 HTML page (tw.stock.yahoo.com/quote/1101) succeeds via proxy (same structure as iOS 股價報報 shortcut)
    if (decoded.includes('tw.stock.yahoo.com/quote/1101')) {
      return {
        ok: true,
        text: async () => '<div id="main-0-QuoteHeader-Proxy"><h1>台泥</h1><span class="Fz(32px) Fw(b)">28.60</span><span class="Fz(20px) C($c-trend-up)">1.10</span><span>昨收</span><span>27.50</span></div>'
      };
    }
    throw Error('offline');
  });
  await a.run('syncNetworkQuotes()');
  const tsmc = a.run('portfolioData.positions.find(p => p.symbol === "2330" && p.status === "active")');
  const tcc = a.run('portfolioData.positions.find(p => p.symbol === "1101" && p.status === "active")');
  assert.equal(tsmc.currentPrice, 2450);
  assert.equal(tsmc.prevClose, 2400);
  assert.equal(tcc.currentPrice, 28.6);
  assert.equal(tcc.prevClose, 27.5);
  assert.match(a.run('quoteLabel(portfolioData.positions.find(p => p.symbol === "1101"))'), /Yahoo奇摩股市/);
});

test('falls back to TWSE MIS batch endpoint when per-stock Yahoo endpoints fail', async () => {
  const a = app(async url => {
    if (decodeURIComponent(url).includes('mis.twse.com.tw/stock/api/getStockInfo.jsp')) {
      return {
        ok: true,
        json: async () => ({
          msgArray: [
            { c: '3231', z: '196.50', y: '190.00', tlong: '1793153000000' },
            { c: '8021', z: '-', b: '445.00_444.50', a: '446.00_446.50', y: '433.00', tlong: '1793153000000' }
          ]
        })
      };
    }
    throw Error('timeout');
  });
  await a.run('syncNetworkQuotes()');
  const wistron = a.run('portfolioData.positions.find(p => p.symbol === "3231")');
  const topoint = a.run('portfolioData.positions.find(p => p.symbol === "8021")');
  assert.equal(wistron.currentPrice, 196.5);
  assert.equal(wistron.prevClose, 190);
  assert.equal(topoint.currentPrice, 445);
  assert.equal(topoint.prevClose, 433);
  assert.match(a.run('quoteLabel(portfolioData.positions.find(p => p.symbol === "3231"))'), /證交所/);
});

test('groups multiple lots of the same symbol with weighted average cost, latest date, and max target price', () => {
  const a = app();
  const groups = a.run('groupPositionsBySymbol(portfolioData.positions.filter(p => p.status === "active"), "active")');
  assert.equal(groups.length, new Set(seed.positions.filter(p => p.status === 'active').map(p => p.market + ':' + p.symbol)).size);
  const tsmc = groups.find(g => g.symbol === '2330');
  const tsmcLots = seed.positions.filter(p => p.status === 'active' && p.symbol === '2330');
  assert.equal(tsmc.items.length, tsmcLots.length);
  assert.equal(tsmc.totalShares, tsmcLots.reduce((sum, p) => sum + p.shares, 0));
  assert.equal(tsmc.totalCost, tsmcLots.reduce((sum, p) => sum + p.shares * p.buyPrice, 0));
  assert.equal(Number(tsmc.avgBuyPrice.toFixed(2)), Number((tsmc.totalCost / tsmc.totalShares).toFixed(2)));
  assert.equal(tsmc.latestDate, tsmcLots.map(p => p.tradeDate).sort().at(-1));

  const nanya = groups.find(g => g.symbol === '2408');
  assert.equal(nanya.items.length, 2);
  assert.equal(nanya.totalShares, 110);
  assert.equal(nanya.latestDate, '2026-10-15');
  assert.equal(nanya.maxTargetPrice, 570);
  const nanyaPlastics = groups.find(g => g.symbol === '1303');
  assert.equal(nanyaPlastics.items.length, 2);
  assert.equal(nanyaPlastics.totalShares, 150);
  assert.equal(nanyaPlastics.avgBuyPrice, 310);
  const etf = groups.find(g => g.symbol === '00981A');
  assert.equal(etf.items.length, 2);
  assert.equal(etf.totalShares, 2000);
  assert.equal(Number(etf.avgBuyPrice.toFixed(2)), 27.84);
});

test('only renders second-level detail toggle for symbols with 2 or more lots', () => {
  const a = app();
  a.run('renderTables()');
  const desktopHtml = a.element('activeTableBody').innerHTML;
  const mobileHtml = a.element('activeMobileCards').innerHTML;

  // Single-lot symbols (e.g., 3017, 2368, 3231) must NOT have toggle-group buttons or "明細 (1)" / "共 1 筆"
  assert.ok(!desktopHtml.includes('明細 (1)'));
  assert.ok(!mobileHtml.includes('分批明細 (1)'));
  assert.ok(!desktopHtml.includes('共 1 筆'));
  assert.ok(!desktopHtml.includes('data-group-key="active:TWSE:3017"'));
  assert.ok(!mobileHtml.includes('data-group-key="active:TWSE:3017"'));

  // Multi-lot symbols (2330 has 5 lots, 2408 has 2 lots, 6147 has 2 lots, 1303 has 2 lots, 00981A has 2 lots) MUST have toggle-group buttons
  assert.ok(desktopHtml.includes('data-group-key="active:TWSE:2330"'));
  assert.ok(desktopHtml.includes('▼ 明細 (' + seed.positions.filter(p => p.symbol === '2330' && p.status === 'active').length + ')'));
  assert.ok(desktopHtml.includes('data-group-key="active:TWSE:2408"'));
  assert.ok(desktopHtml.includes('▼ 明細 (2)'));
  assert.ok(desktopHtml.includes('data-group-key="active:TPEX:6147"'));
  assert.ok(desktopHtml.includes('data-group-key="active:TWSE:1303"'));
  assert.ok(desktopHtml.includes('data-group-key="active:TWSE:00981A"'));
});

test('FinMind EOD database is completely removed so intraday sync never overwrites prices with yesterday close', () => {
  assert.ok(!source.includes('finmindtrade.com'));
  assert.ok(!source.includes('TaiwanStockPrice'));
});

test('updates multiple stocks in a single request via Cnyes direct-CORS batch API and Yahoo Taiwan ApacLibraCharts batch API', async () => {
  let requestCount = 0;
  const a = app(async url => {
    requestCount++;
    if (url.startsWith('https://ws.api.cnyes.com/ws/api/v1/quote/quotes/')) {
      return {
        ok: true,
        json: async () => ({
          statusCode: 200,
          data: {
            items: [
              { '0': 'TWS:2330:STOCK', '200010': '2330', '6': 2345, '11': -25, '21': 2370, '200007': 1793584200 },
              { '0': 'TWS:1303:STOCK', '200010': '1303', '6': 299.5, '11': 3.5, '21': 296, '200007': 1793584200 }
            ]
          }
        })
      };
    }
    if (decodeURIComponent(url).includes('FinanceChartService.ApacLibraCharts')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { symbol: '6147.TWO', chart: { meta: { symbol: '6147.TWO', regularMarketPrice: 198.5, previousClose: 196, regularMarketTime: 1793584200 } } }
          ]
        })
      };
    }
    throw Error('offline');
  });
  await a.run('syncNetworkQuotes()');
  const tsmc = a.run('portfolioData.positions.find(p => p.symbol === "2330" && p.status === "active")');
  const nanyaPlastics = a.run('portfolioData.positions.find(p => p.symbol === "1303" && p.status === "active")');
  const chipbond = a.run('portfolioData.positions.find(p => p.symbol === "6147" && p.status === "active")');
  assert.equal(tsmc.currentPrice, 2345);
  assert.equal(tsmc.prevClose, 2370);
  assert.match(a.run('quoteLabel(portfolioData.positions.find(p => p.symbol === "2330"))'), /鉅亨網即時/);
  assert.equal(nanyaPlastics.currentPrice, 299.5);
  assert.equal(chipbond.currentPrice, 198.5);
  assert.equal(chipbond.prevClose, 196);
  assert.match(a.run('quoteLabel(portfolioData.positions.find(p => p.symbol === "6147"))'), /Yahoo奇摩股市/);
});


test('parallel batch success renders while other sources are pending and deadline cancels them', async () => {
  const signals = [];
  let resolveSlow;
  const a = app(async (url, options) => {
    signals.push(options.signal);
    if (url.startsWith('https://ws.api.cnyes.com/')) {
      return { ok: true, json: async () => ({ data: { items: [
        { '200010': '3017', '6': 3200, '21': 3100, '200007': 1793584200 }
      ] } }) };
    }
    return new Promise(resolve => { resolveSlow = resolve; });
  }, { setTimeout: (fn, ms) => setTimeout(fn, ms === 12000 ? 50 : 500) });
  const pending = a.run('syncNetworkQuotes()');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(a.run('portfolioData.positions[0].currentPrice'), 3200);
  assert.match(a.element('statusText').textContent, /同步中/);
  assert.equal(a.element('btnLiveFetch').disabled, true);
  assert.ok(signals.length >= 3);
  await pending;
  assert.match(a.element('statusText').textContent, /12 秒上限/);
  assert.equal(a.element('btnLiveFetch').disabled, false);
  assert.ok(signals.slice(1).every(signal => signal.aborted));
  const after = a.run('JSON.stringify(portfolioData)');
  resolveSlow({ ok: true, json: async () => ({}) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(a.run('JSON.stringify(portfolioData)'), after);
});

test('request timeout covers stalled response bodies and records the source error', async () => {
  const a = app(async () => ({ ok: true, text: () => new Promise(() => {}) }),
    { setTimeout: fn => setTimeout(fn, 5) });
  await assert.rejects(a.run(`fetchWithTimeout('https://example.com/quote', 4000,
    { signal: new AbortController().signal, errors: new Set() })`), /請求逾時/);
});

test('failed sync reports HTTP errors and preserves saved prices', async () => {
  const a = app(async () => ({ ok: false, status: 429 }));
  const before = a.run('JSON.stringify(portfolioData)');
  await a.run('syncNetworkQuotes()');
  assert.equal(a.run('JSON.stringify(portfolioData)'), before);
  assert.match(a.element('statusText').textContent, /HTTP 429/);
  assert.match(a.element('statusText').textContent, /未更新/);
});
