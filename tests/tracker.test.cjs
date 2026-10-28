const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../portfolio.json'), 'utf8'));
function app(fetch = async () => { throw Error('offline'); }) {
  const nodes = new Map(), storage = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false,
      classList: { add(){}, remove(){}, contains(){ return true; }, toggle(){} }, setAttribute(){}, addEventListener(){} });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ console, Intl, Date, JSON, Number, String, Math, Set, AbortController,
    fetch, setTimeout, clearTimeout,
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) },
    window: { addEventListener(){}, innerWidth: 1200 },
    document: { getElementById: element, querySelectorAll: () => [], documentElement: element('html') } });
  vm.runInContext(source, ctx);
  const run = expression => vm.runInContext(expression,ctx);
  run('showToast = msg => { window.lastToast = msg; };');
  return { ctx, run, element, storage };
}
test('embedded fallback and deployed JSON agree and validate', () => {
  const a=app();
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(DEFAULT_PORTFOLIO_JSON)')), seed);
  assert.equal(a.run('validatePortfolio(portfolioData).positions.length'),9);
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
  assert.equal(a.run('portfolioData.positions[1].currentPrice'),1115);
  assert.equal(a.run('JSON.stringify(portfolioData.positions.filter(p=>p.status==="exited"))'),exited);
  assert.match(a.element('statusText').textContent,/1\/7/);
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
  assert.equal(a.run('portfolioData.positions[0].currentPrice'),3130);
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
