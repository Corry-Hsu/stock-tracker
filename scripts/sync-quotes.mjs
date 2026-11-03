import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const keyOf = p => `${p.market}:${p.symbol}`;
const positive = value => ['number', 'string'].includes(typeof value) && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const iso = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;

export function parseMis(data, positions) {
  if (data.rtcode !== '0000' || !Array.isArray(data.msgArray)) throw Error(`MIS ${data.rtcode ?? 'invalid schema'}: ${data.rtmessage ?? ''}`);
  const quotes = {};
  for (const item of data.msgArray) {
    const market = item.ex === 'otc' ? 'TPEX' : item.ex === 'tse' ? 'TWSE' : null;
    const p = positions.find(p => p.market === market && p.symbol === item.c);
    if (!p) continue;
    // z can be '-' between trades. trade.z is the last execution; bid/ask is never a trade.
    const price = positive(item.z) ?? positive(item.trade?.z);
    const time = positive(item.z) ? item.t : item.trade?.t;
    const d = String(item.d ?? '');
    const quoteTime = /^\d{8}$/.test(d) && /^\d{2}:\d{2}:\d{2}$/.test(time ?? '')
      ? iso(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${time}+08:00`) : null;
    if (price && quoteTime) quotes[keyOf(p)] = { price, prevClose: positive(item.y), quoteTime, quoteSource: 'TWSE MIS', priceType: 'trade' };
  }
  return quotes;
}

export function parseCnyes(data, positions) {
  if (data.statusCode !== 200 || !Array.isArray(data.data?.items)) throw Error(`Cnyes ${data.statusCode ?? 'invalid schema'}: ${data.message ?? ''}`);
  const quotes = {};
  for (const item of data.data.items) {
    const symbol = String(item['200010'] ?? item['0']?.split(':')[1] ?? '');
    const p = positions.find(p => p.symbol === symbol);
    const price = positive(item['6']);
    const quoteTime = positive(item['200007']) ? iso(Number(item['200007']) * 1000) : null;
    if (p && price && quoteTime) quotes[keyOf(p)] = { price, prevClose: positive(item['21']), quoteTime, quoteSource: '鉅亨網', priceType: 'trade' };
  }
  return quotes;
}

export function parseYahoo(data, p) {
  const meta = data.chart?.result?.[0]?.meta;
  const expected = p.symbol + (p.market === 'TPEX' ? '.TWO' : '.TW');
  if (data.chart?.error || meta?.symbol !== expected || meta.currency !== 'TWD') throw Error('Yahoo invalid symbol/currency/schema');
  const price = positive(meta.regularMarketPrice);
  const quoteTime = positive(meta.regularMarketTime) ? iso(Number(meta.regularMarketTime) * 1000) : null;
  return price && quoteTime ? { [keyOf(p)]: { price, prevClose: positive(meta.previousClose ?? meta.chartPreviousClose), quoteTime, quoteSource: 'Yahoo Finance', priceType: 'trade' } } : {};
}

export async function requestJson(url, { fetchImpl = fetch, signal, timeoutMs = 6000 } = {}) {
  if (signal?.aborted) throw Error('sync deadline exceeded');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  const cancelled = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(Error(signal?.aborted ? 'sync deadline exceeded' : 'request timeout')), { once: true });
    if (controller.signal.aborted) reject(Error('sync deadline exceeded'));
    timer = setTimeout(abort, timeoutMs);
  });
  try {
    return await Promise.race([cancelled, (async () => {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      if (!res.ok) throw Error(`HTTP ${res.status}`);
      return await res.json();
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

export async function syncQuotes(portfolio, previous = {}, { fetchImpl = fetch, now = () => new Date(), timeoutMs = 6000, deadlineMs = 45000 } = {}) {
  const positions = [...new Map(portfolio.positions.filter(p => p.status === 'active' && p.trackLive !== false).map(p => [keyOf(p), p])).values()];
  const attemptedAt = now().toISOString();
  const quotes = {}, refreshed = new Set(), sources = [];
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  const valid = q => q && positive(q.price) && q.priceType === 'trade' && typeof q.quoteSource === 'string' && q.quoteTime && Number.isFinite(Date.parse(q.quoteTime)) && Date.parse(q.quoteTime) <= now().getTime() + 300000;
  for (const p of positions) {
    const old = previous.quotes?.[keyOf(p)];
    if (valid(old)) quotes[keyOf(p)] = old;
  }
  const remaining = () => positions.filter(p => !refreshed.has(keyOf(p)));
  async function attempt(source, url, parse) {
    if (controller.signal.aborted) return;
    const start = Date.now();
    const status = { source, status: 'error', accepted: 0 };
    sources.push(status);
    try {
      const payload = await requestJson(url, { fetchImpl, signal: controller.signal, timeoutMs });
      const parsed = parse(payload);
      for (const [key, q] of Object.entries(parsed)) {
        if (!positions.some(p => keyOf(p) === key) || !valid(q)) continue;
        if (now().getTime() - Date.parse(q.quoteTime) > 7 * 86400000) continue;
        if (quotes[key] && Date.parse(q.quoteTime) < Date.parse(quotes[key].quoteTime)) continue;
        quotes[key] = q;
        refreshed.add(key);
        status.accepted++;
      }
      status.status = status.accepted ? 'ok' : 'empty';
      if (!status.accepted) status.error = 'No valid, recent trade quotes (or older than saved quotes)';
    } catch (e) { status.error = e.message; }
    status.durationMs = Date.now() - start;
    return status;
  }
  try {
    if (positions.length) {
      const channels = positions.map(p => `${p.market === 'TPEX' ? 'otc' : 'tse'}_${p.symbol}.tw`).join('|');
      await attempt('TWSE MIS', `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(channels)}&_=${now().getTime()}`, data => parseMis(data, positions));
    }
    if (remaining().length) {
      const missing = remaining();
      await attempt('Cnyes', `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${missing.map(p => `TWS:${p.symbol}:STOCK`).join(',')}?column=I`, data => parseCnyes(data, missing));
    }
    const missing = remaining();
    let next = 0, rateLimited = false;
    await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
      while (next < missing.length && !controller.signal.aborted && !rateLimited) {
        const p = missing[next++];
        const ticker = p.symbol + (p.market === 'TPEX' ? '.TWO' : '.TW');
        const status = await attempt(`Yahoo ${ticker}`, `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`, data => parseYahoo(data, p));
        if (status?.error?.includes('HTTP 429')) rateLimited = true;
      }
    }));
    const missingKeys = positions.map(keyOf).filter(key => !refreshed.has(key));
    return { schemaVersion: 1, attemptedAt, lastSuccessAt: refreshed.size ? attemptedAt : previous.lastSuccessAt ?? null,
      status: !positions.length ? 'idle' : !refreshed.size ? 'failed' : missingKeys.length ? 'partial' : 'ok',
      requested: positions.length, updated: refreshed.size, missing: missingKeys, timedOut: controller.signal.aborted, sources, quotes };
  } finally { clearTimeout(deadline); controller.abort(); }
}

export async function runSync({ rootDir = root, ...options } = {}) {
  const portfolio = JSON.parse(await fs.readFile(path.join(rootDir, 'portfolio.json'), 'utf8'));
  const output = path.join(rootDir, 'quotes.json');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(output, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const report = await syncQuotes(portfolio, previous, options);
  // Only the quote artifact is written. Holdings and HTML are never rewritten.
  await fs.writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n');
  await fs.rename(output + '.tmp', output);
  console.log(JSON.stringify({ ...report, quotes: undefined }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Quote sync: ${report.status}\nUpdated ${report.updated}/${report.requested}; missing: ${report.missing.join(', ') || 'none'}\n\n${report.sources.map(s => `- ${s.source}: ${s.status}, accepted ${s.accepted}${s.error ? ` (${s.error})` : ''}`).join('\n')}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runSync(); process.exitCode = ['ok', 'idle'].includes(report.status) ? 0 : 1; }
  catch (e) { console.error(e); process.exitCode = 1; }
}
