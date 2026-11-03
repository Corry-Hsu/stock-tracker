import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncQuotes, parseMis, parseCnyes, parseYahoo, requestJson, runSync } from '../scripts/sync-quotes.mjs';

const now = () => new Date('2026-11-03T03:00:00Z');
const tw = { symbol: '2330', market: 'TWSE', status: 'active', trackLive: true };
const otc = { symbol: '6147', market: 'TPEX', status: 'active', trackLive: true };
const etf = { symbol: '00981A', market: 'TWSE', status: 'active', trackLive: true };
const portfolio = { positions: [tw, { ...tw }, otc, etf, { ...tw, status: 'exited', trackLive: false }] };
const response = data => ({ ok: true, json: async () => data });
const mis = positions => ({ rtcode: '0000', msgArray: positions.map(p => ({ c: p.symbol, ex: p.market === 'TPEX' ? 'otc' : 'tse', d: '20261103', t: '10:59:00', z: '123.5', y: '120' })) });
const yahoo = p => ({ chart: { result: [{ meta: { symbol: p.symbol + (p.market === 'TPEX' ? '.TWO' : '.TW'), currency: 'TWD', regularMarketPrice: 124, previousClose: 121, regularMarketTime: now().getTime()/1000 } }], error: null } });

test('one MIS request covers TWSE, TPEX, ETF and repeated lots; input is untouched', async () => {
  const before = JSON.stringify(portfolio), urls = [];
  const report = await syncQuotes(portfolio, {}, { now, fetchImpl: async url => { urls.push(url); return response(mis([tw, otc, etf])); } });
  assert.equal(urls.length, 1);
  assert.match(decodeURIComponent(urls[0]), /tse_2330.tw\|otc_6147.tw\|tse_00981A.tw/);
  assert.equal(report.status, 'ok');
  assert.equal(report.updated, 3);
  assert.equal(report.quotes['TPEX:6147'].price, 123.5);
  assert.equal(JSON.stringify(portfolio), before);
});

test('MIS missing last-price uses last executed trade with its real timestamp; never bid, ask or yesterday close', () => {
  const data = mis([otc]);
  Object.assign(data.msgArray[0], { z: '-', b: '999_', a: '1000_', trade: { z: '123', t: '10:57:00' } });
  assert.equal(parseMis(data, [otc])['TPEX:6147'].price, 123);
  assert.equal(parseMis(data, [otc])['TPEX:6147'].quoteTime, '2026-11-03T02:57:00.000Z');
  delete data.msgArray[0].trade;
  assert.deepEqual(parseMis(data, [otc]), {});
  assert.deepEqual(parseMis(mis([otc]), [tw]), {});
});

test('HTTP 200 application errors and invalid schemas are errors, not successes', () => {
  assert.throws(() => parseCnyes({ statusCode: 5031, message: 'Redis連線錯誤', data: [] }, [tw]), /5031.*Redis/);
  assert.throws(() => parseMis({ rtcode: '5000', msgArray: [] }, [tw]), /5000/);
  assert.throws(() => parseYahoo(yahoo(otc), tw), /symbol/);
  const data = yahoo(tw); data.chart.result[0].meta.currency = 'USD';
  assert.throws(() => parseYahoo(data, tw), /currency/);
});

test('partial MIS falls back only for missing symbols and validates Cnyes timestamps and trade prices', async () => {
  const urls = [];
  const report = await syncQuotes(portfolio, {}, { now, fetchImpl: async url => {
    urls.push(url);
    if (url.includes('mis.twse')) return response(mis([tw]));
    if (url.includes('cnyes')) return response({ statusCode: 200, data: { items: [{ '200010': '6147', '6': 125, '21': 120, '200007': now().getTime()/1000 }] } });
    assert.match(url, /00981A.TW/);
    return response(yahoo(etf));
  } });
  assert.equal(urls.length, 3);
  assert.ok(!urls[1].includes('2330'));
  assert.equal(report.status, 'ok');
  assert.equal(report.sources[1].accepted, 1);
  assert.equal(report.quotes['TWSE:00981A'].quoteSource, 'Yahoo Finance');
  assert.deepEqual(parseCnyes({ statusCode: 200, data: { items: [{ '200010': '2330', '6': '-', '75': 99, '200007': now().getTime()/1000 }] } }, [tw]), {});
});

test('failures preserve saved prices, timestamps and last success; zero success is explicit', async () => {
  const previous = { lastSuccessAt: '2026-11-02T03:00:00Z', quotes: { 'TWSE:2330': { price: 120, quoteTime: '2026-11-02T03:00:00Z', quoteSource: 'TWSE MIS', priceType: 'trade' } } };
  const report = await syncQuotes(portfolio, previous, { now, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.quotes, previous.quotes);
  assert.equal(report.lastSuccessAt, previous.lastSuccessAt);
  assert.equal(report.missing.length, 3);
  assert.ok(report.sources.length <= 4); // Two batches, at most two in-flight Yahoo calls.
  assert.ok(report.sources.every(s => s.error === 'HTTP 429'));
});

test('partial coverage reports unresolved keys while retaining old data', async () => {
  const report = await syncQuotes(portfolio, {}, { now, fetchImpl: async url => url.includes('mis.twse') ? response(mis([tw])) : response({}) });
  assert.equal(report.status, 'partial');
  assert.equal(report.updated, 1);
  assert.deepEqual(report.missing, ['TPEX:6147', 'TWSE:00981A']);
});

test('reject absent, future, stale and regressing quote times', async () => {
  for (const stamp of [null, '2026-11-04T00:00:00Z', '2026-10-01T00:00:00Z', '2026-11-02T00:00:00Z']) {
    const previous = { quotes: { 'TWSE:2330': { price: 130, quoteTime: '2026-11-03T02:59:30Z', quoteSource: 'TWSE MIS', priceType: 'trade' } } };
    const report = await syncQuotes({ positions: [tw] }, previous, { now, fetchImpl: async url => {
      if (!url.includes('query1')) return response({});
      const data = yahoo(tw); data.chart.result[0].meta.regularMarketTime = stamp ? Date.parse(stamp)/1000 : null;
      return response(data);
    } });
    assert.equal(report.status, 'failed');
    assert.equal(report.quotes['TWSE:2330'].price, 130);
  }
});

test('request timeout covers a hung fetch and a hung body, even if fetch ignores abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) })]) {
    const start = Date.now();
    await assert.rejects(requestJson('https://test.invalid', { fetchImpl, timeoutMs: 15 }), /timeout/);
    assert.ok(Date.now() - start < 1000);
  }
});

test('whole sync deadline aborts pending work and starts no further calls', async () => {
  let calls = 0, resolveLate;
  const report = await syncQuotes(portfolio, {}, { now, deadlineMs: 20, timeoutMs: 1000,
    fetchImpl: () => { calls++; return new Promise(resolve => { resolveLate = resolve; }); } });
  assert.equal(report.status, 'failed');
  assert.equal(report.timedOut, true);
  assert.equal(calls, 1);
  const before = JSON.stringify(report);
  resolveLate(response(mis([tw])));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.stringify(report), before);
});

test('empty portfolios make no requests', async () => {
  const report = await syncQuotes({ positions: [] }, {}, { now, fetchImpl: () => { throw Error('unexpected'); } });
  assert.equal(report.status, 'idle');
  assert.equal(report.updated, 0);
});

test('file integration publishes only quotes.json; portfolio and HTML remain byte-for-byte unchanged after success and failure', async t => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.sync-test-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(process.cwd()) + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = JSON.stringify(portfolio, null, 4) + '\n';
  await fs.writeFile(path.join(dir, 'portfolio.json'), input);
  await fs.writeFile(path.join(dir, 'index.html'), '<!-- unchanged -->');
  await runSync({ rootDir: dir, now, fetchImpl: async () => response(mis([tw, otc, etf])) });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'quotes.json'), 'utf8'));
  assert.equal(saved.status, 'ok');
  await runSync({ rootDir: dir, now, fetchImpl: async () => { throw Error('network offline'); } });
  const failed = JSON.parse(await fs.readFile(path.join(dir, 'quotes.json'), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.quotes, saved.quotes);
  assert.equal(await fs.readFile(path.join(dir, 'portfolio.json'), 'utf8'), input);
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), '<!-- unchanged -->');
});
