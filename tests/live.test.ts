import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Analysis } from '../src/analysis/portfolio.ts';
import { applyLive, ecbFxUrl, periodGain, fetchLive, liveFxUrl, parseEcbFx, parseLiveFx, parseTradegate, pickLiveQuote, tradegateDay } from '../src/report/live.ts';

const q = (market: string, last: number, isoCurrency: string, datetimeLast: string) => ({ last, isoCurrency, datetimeLast, market: { codeMarket: market } });

test('pickLiveQuote: stock prefers the instrument currency, skips _PNK/_LST, falls back to newest EU market in EUR', () => {
  const data = {
    quote: q('_AMS', 13.0, 'EUR', '2026-11-06T16:30:00Z'),
    quoteList: { list: [
      q('_PNK', 15.5, 'USD', '2026-11-07T20:00:00Z'),
      q('_LST', 13.9, 'EUR', '2026-11-07T21:00:00Z'),
      q('_XET', 13.1, 'EUR', '2026-11-06T17:30:00Z'),
      q('_NYS', 14.9, 'USD', '2026-11-06T21:00:00Z'),
      q('_XYZ', 13.5, 'EUR', '2026-11-07T10:00:00Z'),
    ] },
  };
  assert.deepEqual(pickLiveQuote(data, false, 'USD'), { price: 14.9, currency: 'USD', date: '2026-11-06' });
  assert.deepEqual(pickLiveQuote(data, false, 'EUR'), { price: 13.5, currency: 'EUR', date: '2026-11-07' });
  assert.deepEqual(pickLiveQuote(data, false, 'CZK'), { price: 13.1, currency: 'EUR', date: '2026-11-06' });
  assert.equal(pickLiveQuote({ quoteList: { list: [q('_PNK', 1, 'USD', '2026-11-07T00:00:00Z')] } }, false, 'USD'), null);
});

test('pickLiveQuote: ETF uses the headline quote; garbage is rejected', () => {
  assert.deepEqual(pickLiveQuote({ quote: q('_TRO', 101.2, 'EUR', '2026-11-06T15:00:00Z') }, true, 'EUR'), { price: 101.2, currency: 'EUR', date: '2026-11-06' });
  assert.equal(pickLiveQuote({ quote: { last: 'x', isoCurrency: 'EUR', datetimeLast: '2026-11-06' } }, true, 'EUR'), null);
  assert.equal(pickLiveQuote(null, true, 'EUR'), null);
});

test('parseLiveFx derives CZK per unit from EUR-based ECB rates; liveFxUrl sends only currency codes', () => {
  const r = parseLiveFx({ base: 'EUR', rates: { CZK: 25, USD: 1.25 } });
  assert.deepEqual(r, { CZK: 1, EUR: 25, USD: 20 });
  assert.throws(() => parseLiveFx({ rates: { USD: 1.1 } }));
  assert.equal(liveFxUrl(['USD', 'CZK', 'EUR', '<x>']), 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CZK,USD');
});

function base(): Analysis {
  const money = (native: number, currency: string, czk: number, eur: number) => ({ native, currency, czk, eur });
  const totals = (czk: number, eur: number, native: Record<string, number>) => ({ czk, eur, native });
  const lot = (qty: number, valueDate: string) => ({
    quantity: qty, cost: money(qty * 1000, 'CZK', qty * 1000, qty * 40), value: money(qty * 1100, 'CZK', qty * 1100, qty * 44),
    profit: money(qty * 100, 'CZK', qty * 100, qty * 4), profitPct: { czk: 10, eur: 10, native: 10 },
    valueSource: 'market', valueDate, currentPrice: { date: valueDate, close: 55, currency: 'USD' },
  });
  return {
    holdings: [{
      ticker: 'AAA.US', isin: 'US0000000001', category: 'STOCK', lots: [lot(1, '2026-11-05'), lot(2, '2026-11-05')],
      cost: totals(3000, 120, { CZK: 3000 }), value: totals(3300, 132, { CZK: 3300 }), profit: totals(300, 12, { CZK: 300 }),
      profitPct: { czk: 10, eur: 10, native: 10 }, countries: [{ country: 'US', weight: 100 }], sectors: [{ sector: 'tech', weight: 100 }],
    }, {
      ticker: 'NOISIN', isin: null, category: 'ETF', lots: [lot(1, '2026-11-05')],
      cost: totals(1000, 40, { CZK: 1000 }), value: totals(1100, 44, { CZK: 1100 }), profit: totals(100, 4, { CZK: 100 }),
      profitPct: { czk: 10, eur: 10, native: 10 }, countries: [], sectors: [],
    }],
    instruments: { 'AAA.US': { currency: 'USD', prices: [['2026-11-05', 55]] } },
    summary: { cost: totals(4000, 160, { CZK: 4000 }), value: totals(4400, 176, { CZK: 4400 }), valueDate: '2026-11-05',
      unrealizedProfit: totals(400, 16, { CZK: 400 }), unrealizedPct: { czk: 10, eur: 10, native: 10 } },
    history: [{ date: '2026-11-05', valueCzk: 4400, valueEur: 176, investedCzk: 4000, investedEur: 160 }],
    geography: [], sectors: [], realized: [{ ticker: 'OLD' }], taxYears: [{ year: 2025 }],
  } as unknown as Analysis;
}

test('applyLive revalues held lots, totals, breakdowns and today\'s history point; cost and sales stay fixed', () => {
  const a = base();
  const before = structuredClone(a);
  const r = applyLive(a, { CZK: 1, EUR: 25, USD: 20 }, { 'AAA.US': { price: 60, currency: 'USD', date: '2026-11-06' } });
  assert.deepEqual(a, before, 'input snapshot is not mutated');
  assert.deepEqual(r.updated, ['AAA.US']);
  assert.deepEqual(r.missing, [{ ticker: 'NOISIN', reason: 'chybí ISIN, podle kterého se aktuální cena hledá' }]);
  assert.equal(r.date, '2026-11-06');
  const x = r.analysis.holdings[0]!;
  assert.deepEqual(x.lots[1]!.value, { native: 2400, currency: 'CZK', czk: 2400, eur: 96 });
  assert.equal(x.lots[1]!.profit!.czk, 400);
  assert.deepEqual(x.lots[1]!.currentPrice, { date: '2026-11-06', close: 60, currency: 'USD' });
  assert.deepEqual(x.value, { czk: 3600, eur: 144, native: { CZK: 3600 } });
  assert.equal(x.profitPct.czk, 20);
  assert.deepEqual(x.cost, before.holdings[0]!.cost);
  assert.equal(r.analysis.summary.value.czk, 4700);
  assert.equal(r.analysis.summary.valueDate, '2026-11-06');
  assert.equal(r.analysis.summary.unrealizedProfit.czk, 700);
  assert.deepEqual(r.analysis.history.at(-1), { date: '2026-11-06', valueCzk: 4700, valueEur: 188, investedCzk: 4000, investedEur: 160 });
  assert.deepEqual(r.analysis.instruments['AAA.US']!.prices.at(-1), ['2026-11-06', 60]);
  assert.deepEqual(r.analysis.geography.map((g) => [g.country, Math.round(g.share)]), [['US', 77], ['??', 23]]);
  assert.deepEqual(r.analysis.realized, before.realized);
  assert.deepEqual(r.analysis.taxYears, before.taxYears);
});

test('applyLive converts a quote in another currency and ignores stale or implausible quotes', () => {
  const fx = { CZK: 1, EUR: 25, USD: 20 };
  const eur = applyLive(base(), fx, { 'AAA.US': { price: 48, currency: 'EUR', date: '2026-11-06' } });
  assert.equal(eur.analysis.holdings[0]!.lots[0]!.currentPrice!.close, 60);
  const older = applyLive(base(), fx, { 'AAA.US': { price: 60, currency: 'USD', date: '2026-11-04' } });
  assert.deepEqual([older.updated, older.missing.map((m) => m.ticker)], [[], ['AAA.US', 'NOISIN']], 'an older live quote is not used and is listed');
  assert.equal(older.missing[0]!.reason, 'zdroj má jen starší cenu (k 4. 11. 2026) než report (k 5. 11. 2026)');
  const jump = applyLive(base(), fx, { 'AAA.US': { price: 600, currency: 'USD', date: '2026-11-06' } });
  assert.equal(jump.updated.length, 0);
  assert.match(jump.missing[0]!.reason, /bezpečnostní kontrola/);
});

test('applyLive revalues an instrument that had no price at build time in the quote currency', () => {
  const a = base();
  for (const l of a.holdings[0]!.lots) Object.assign(l, { currentPrice: null, valueSource: 'cost', valueDate: null });
  delete a.instruments['AAA.US'];
  const r = applyLive(a, { CZK: 1, EUR: 25, USD: 20 }, { 'AAA.US': { price: 60, currency: 'USD', date: '2026-11-06' } });
  assert.deepEqual(r.updated, ['AAA.US']);
  assert.deepEqual([r.analysis.holdings[0]!.lots[1]!.value!.czk, r.analysis.holdings[0]!.lots[1]!.currentPrice], [2400, { date: '2026-11-06', close: 60, currency: 'USD' }]);
  assert.equal(r.analysis.holdings[0]!.priceCurrency, 'USD', 'purchase prices are shown in the quote currency');
  assert.deepEqual([r.analysis.instruments['AAA.US']!.currency, r.analysis.instruments['AAA.US']!.prices], ['USD', [['2026-11-06', 60]]]);
});

test('applyLive lists instruments left without a live price and why', () => {
  const reasons = (fx: Record<string, number>, q: Parameters<typeof applyLive>[2]) =>
    applyLive(base(), fx, q).missing.map((m) => `${m.ticker}: ${m.reason}`);
  const noIsin = 'NOISIN: chybí ISIN, podle kterého se aktuální cena hledá';
  assert.deepEqual(reasons({ CZK: 1, EUR: 25, USD: 20 }, {}), ['AAA.US: onvista ani Tradegate aktuální cenu nemají', noIsin]);
  assert.deepEqual(reasons({ CZK: 1, EUR: 25 }, { 'AAA.US': { price: 60, currency: 'USD', date: '2026-11-06' } }), ['AAA.US: chybí aktuální kurz USD', noIsin]);
});

test('fetchLive sends only ISIN / currency GETs without credentials and survives failing quotes', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('frankfurter')) return Response.json({ base: 'EUR', rates: { CZK: 25, USD: 1.25 } });
    return new Response('rate limited', { status: 429 });
  }) as unknown as typeof fetch;
  const r = await fetchLive(base(), fake);
  assert.deepEqual(r.quotes, {});
  assert.equal(r.czkPer?.USD, 20);
  assert.deepEqual(r.sources, { fxFallback: false, quoteFallback: [], errors: ['onvista: HTTP 429'], unsafe: [] });
  assert.deepEqual(calls.map((c) => c.url).sort(), [
    'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CHF,CZK,GBP,USD',
    'https://api.onvista.de/api/v1/stocks/ISIN:US0000000001/snapshot',
    'https://www.tradegatebsx.com/refresh.php?isin=US0000000001',
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.body, undefined);
  }
});

test('Tradegate and ECB fallbacks: German numbers, assumed trading day, SDMX rates', () => {
  const fri = new Date('2026-11-06T15:00:00Z');
  assert.deepEqual(parseTradegate({ last: '1.307,30', close: 300 }, fri), { price: 1307.3, currency: 'EUR', date: '2026-11-06' });
  assert.deepEqual(parseTradegate({ last: 13.11 }, fri)?.price, 13.11);
  assert.equal(parseTradegate({ bid: 1 }, fri), null);
  assert.equal(tradegateDay(new Date('2026-11-07T10:00:00Z')), '2026-11-06'); // Saturday
  assert.equal(tradegateDay(new Date('2026-11-09T06:00:00Z')), '2026-11-06'); // Monday 7:00 Berlin, before opening
  assert.equal(tradegateDay(new Date('2026-11-09T08:00:00Z')), '2026-11-09');
  assert.equal(ecbFxUrl(['USD', 'CZK', 'EUR']), 'https://data-api.ecb.europa.eu/service/data/EXR/D.CZK+USD.EUR.SP00.A?lastNObservations=1&format=jsondata');
  const sdmx = {
    dataSets: [{ series: { '0:0:0:0:0': { observations: { 0: [1.25, 0] } }, '0:1:0:0:0': { observations: { 0: [25, 0] } } } }],
    structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'D' }] }, { id: 'CURRENCY', values: [{ id: 'USD' }, { id: 'CZK' }] }] } },
  };
  assert.deepEqual(parseEcbFx(sdmx), { CZK: 1, EUR: 25, USD: 20 });
});

test('fetchLive falls back to Tradegate and ECB when the primary sources fail and reports it', async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    if (url.includes('tradegatebsx')) return Response.json({ last: '61,50' });
    if (url.includes('data-api.ecb')) {
      return Response.json({
        dataSets: [{ series: { '0:0:0:0:0': { observations: { 0: [25] } }, '0:1:0:0:0': { observations: { 0: [1.25] } } } }],
        structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'D' }] }, { id: 'CURRENCY', values: [{ id: 'CZK' }, { id: 'USD' }] }] } },
      });
    }
    return new Response('down', { status: 503 });
  }) as unknown as typeof fetch;
  const r = await fetchLive(base(), fake, new Date('2026-11-06T15:00:00Z'));
  assert.deepEqual(r.quotes, { 'AAA.US': { price: 61.5, currency: 'EUR', date: '2026-11-06' } });
  assert.deepEqual(r.czkPer, { CZK: 1, EUR: 25, USD: 20 });
  assert.equal(r.sources.fxFallback, true);
  assert.deepEqual(r.sources.quoteFallback, ['AAA.US']);
  assert.deepEqual([...r.sources.errors].sort(), ['Frankfurter: HTTP 503', 'onvista: HTTP 503']);
  assert.ok(urls.every((u) => !/quantity|value|cost/i.test(u)));
});

test('fetchLive discards suspicious responses, reports them and falls back', async () => {
  const fake = (async (url: string) => {
    if (url.includes('onvista')) return Response.json({ quote: { last: 60, isoCurrency: 'USD', datetimeLast: '2026-11-06T15:00:00Z', market: { codeMarket: '<img src=x onerror=alert(1)>' } } });
    if (url.includes('frankfurter')) return new Response('<html><script>alert(1)</script></html>', { headers: { 'content-type': 'text/html' } });
    if (url.includes('tradegatebsx')) return Response.json({ last: 61, __proto__x: 1, ['__proto__']: { polluted: true } });
    return Response.json({ dataSets: [{ series: { '0:0': { observations: { 0: [25] } } } }], structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'D' }] }, { id: 'CURRENCY', values: [{ id: 'CZK' }] }] } } });
  }) as unknown as typeof fetch;
  const r = await fetchLive(base(), fake, new Date('2026-11-06T15:00:00Z'));
  assert.deepEqual(r.quotes, {}, 'nothing from a suspicious response is used');
  assert.deepEqual(r.czkPer, { CZK: 1, EUR: 25 });
  assert.deepEqual([...r.sources.unsafe].sort(), ['Frankfurter: nečekaný typ text/html', 'Tradegate: zakázaný klíč "__proto__"', 'onvista: HTML s obsluhou události']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('periodGain: selling a winner within the period is realized profit, not a loss', () => {
  const pt = (date: string, valueCzk: number, investedCzk: number) => ({ date, valueCzk, investedCzk, valueEur: valueCzk / 25, investedEur: investedCzk / 25 });
  // Held: 100k cost worth 150k; the winner is sold on 2026-06-01 for +40k, the rest stays flat.
  const first = pt('2026-01-01', 150_000, 100_000);
  const last = pt('2026-11-01', 70_000, 60_000);
  const sale = (closeDate: string, czk: number) => ({ closeDate, profit: { native: czk, currency: 'CZK', czk, eur: czk / 25 } });
  assert.deepEqual(periodGain(first, last, [sale('2026-06-01', 40_000), sale('2026-01-01', 999), sale('2026-11-02', 999)], 'czk'),
    { total: 0, realized: 40_000 }, 'only sales after the first and up to the last point count');
  assert.equal(periodGain(first, last, [sale('2026-06-01', 40_000)], 'eur').total, 0);
});
