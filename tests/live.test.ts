import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Analysis } from '../src/analysis/portfolio.ts';
import { applyLive, fetchLive, liveFxUrl, parseLiveFx, pickLiveQuote } from '../src/report/live.ts';

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
  assert.equal(applyLive(base(), fx, { 'AAA.US': { price: 60, currency: 'USD', date: '2026-11-04' } }).updated.length, 0);
  assert.equal(applyLive(base(), fx, { 'AAA.US': { price: 600, currency: 'USD', date: '2026-11-06' } }).updated.length, 0);
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
  assert.equal(r.czkPer.USD, 20);
  assert.deepEqual(calls.map((c) => c.url).sort(), [
    'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CHF,CZK,GBP,USD',
    'https://api.onvista.de/api/v1/stocks/ISIN:US0000000001/snapshot',
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.body, undefined);
  }
});
