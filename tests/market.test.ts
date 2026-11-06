import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Db } from '../src/db/database.ts';
import { importBuffer } from '../src/importer.ts';
import { Http } from '../src/net/http.ts';
import { updateMarketData } from '../src/market/update.ts';
import { analyze } from '../src/analysis/portfolio.ts';
import { geography } from '../src/analysis/market.ts';
import { fakeXtbExport } from './helpers/fakeXtb.ts';
import { fakeFetch } from './helpers/fakeFetch.ts';

const ACCOUNT = '98765432';

function seed(): Db {
  const db = openDatabase(':memory:');
  importBuffer(
    db,
    'a.xlsx',
    fakeXtbExport({
      account: ACCOUNT,
      cash: [{ id: '1', type: 'Deposit', time: '2024-12-01T08:00:00Z', amount: 5000 }],
      openAsOf: '2025-01-10T10:00:00Z',
      open: [
        { ticker: 'ETFA.DE', name: 'World', positionId: '1', volume: 10, openPrice: 100, openTime: '2025-01-06T09:00:00Z', currentPrice: 110 },
        { ticker: 'STK.US', name: 'Stock', positionId: '2', volume: 2, openPrice: 50, openTime: '2025-01-07T15:00:00Z', currentPrice: 60 },
      ],
    }),
  );
  // ETF category comes from the export; mark the stock as STOCK
  db.prepare(`UPDATE instruments SET category = 'STOCK' WHERE ticker = 'STK.US'`).run();
  return db;
}

const cnb = ['Datum|1 EUR|1 USD', '06.01.2025|25,000|24,000', '07.01.2025|25,000|24,000', '13.01.2025|25,000|25,000'].join('\n');
const xetra = 'Product Status;Instrument Status;Instrument;ISIN;Mnemonic\nActive;Active;WORLD ETF;IE0000000001;ETFA';
const profile =
  '<meta property="og:title" content="World ETF | ETFA | IE0000000001" />' +
  '<td data-testid="tl_etf-holdings_countries_value_name">United States</td><span data-testid="tl_etf-holdings_countries_value_percentage">60.00%</span>' +
  '<td data-testid="tl_etf-holdings_countries_value_name">Japan</td><span data-testid="tl_etf-holdings_countries_value_percentage">10.00%</span>';
const chart = JSON.stringify({ series: [{ date: '2025-01-06', value: { raw: 100 } }, { date: '2025-01-13', value: { raw: 120 } }] });
const yahoo = JSON.stringify({
  chart: { result: [{ meta: { currency: 'USD', gmtoffset: -18000 }, timestamp: [1736784000], indicators: { quote: [{ close: [75] }] } }] },
});

function routes(u: string): Response | undefined {
  if (u.includes('cnb.cz')) return new Response(cnb);
  if (u.includes('allTradableInstruments')) return new Response(xetra);
  if (u.includes('etf-profile')) return new Response(profile);
  if (u.includes('performance-chart')) return new Response(chart);
  if (u.includes('finance.yahoo.com')) return new Response(yahoo);
  return undefined;
}

test('updateMarketData stores rates, ISINs, countries and prices; requests carry no personal data', async () => {
  const db = seed();
  const calls: string[] = [];
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch(routes, calls) });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });

  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.fxYears, [2025]);
  assert.deepEqual(
    r.instruments.map((i) => [i.ticker, i.isin, i.priceSource, i.newPrices, i.countrySource]),
    [
      ['ETFA.DE', 'IE0000000001', 'justetf', 2, 'justetf'],
      ['STK.US', null, 'yahoo', 1, 'exchange'],
    ],
  );
  const weights = db.prepare(`SELECT country, weight FROM country_weights WHERE ticker = 'ETFA.DE' ORDER BY country`).all().map((x) => ({ ...x }));
  assert.deepEqual(weights, [
    { country: 'JP', weight: 10 },
    { country: 'US', weight: 60 },
    { country: 'XX', weight: 30 },
  ]);

  // Privacy: only tickers/ISINs/dates leave the machine
  for (const url of calls) {
    assert.ok(!url.includes(ACCOUNT), url);
    assert.ok(!/[?&](volume|qty|amount|value|price)=/i.test(url), url);
  }
  assert.ok(calls.every((u) => /^https:\/\/(www\.cnb\.cz|www\.cashmarket\.deutsche-boerse\.com|www\.justetf\.com|query1\.finance\.yahoo\.com)\//.test(u)));

  // Second run is incremental: no Xetra list / profile re-download, prices from last date − 7 days
  calls.length = 0;
  await updateMarketData(db, http, { today: '2025-01-14' });
  assert.ok(!calls.some((u) => u.includes('allTradableInstruments') || u.includes('etf-profile')));
  assert.ok(calls.some((u) => u.includes('performance-chart') && u.includes('dateFrom=2025-01-06')));
});

test('manual overrides win and failures become warnings', async () => {
  const db = seed();
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch((u) => (u.includes('finance.yahoo.com') ? new Response('', { status: 429 }) : routes(u))) });
  const r = await updateMarketData(db, http, {
    today: '2025-01-13',
    config: { 'ETFA.DE': { countries: { DE: 100 }, priceSource: 'none' }, 'STK.US': { country: 'CZ' } },
  });
  assert.deepEqual(r.instruments.map((i) => [i.ticker, i.priceSource, i.countrySource]), [
    ['ETFA.DE', 'none', 'manual'],
    ['STK.US', 'yahoo', 'manual'],
  ]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /STK\.US.*HTTP 429/);
});

test('analyze values holdings at newer market prices, splits by country and builds history', async () => {
  const db = seed();
  await updateMarketData(db, new Http({ minIntervalMs: 0, fetch: fakeFetch(routes) }), { today: '2025-01-13' });
  const a = analyze(db, { today: '2025-01-13' });

  const etf = a.holdings.find((h) => h.ticker === 'ETFA.DE')!;
  assert.deepEqual([etf.lots[0]!.valueSource, etf.lots[0]!.valueDate, etf.value.native.EUR], ['market', '2025-01-13', 1200]);
  const stk = a.holdings.find((h) => h.ticker === 'STK.US')!;
  assert.equal(stk.lots[0]!.valueSource, 'market');
  assert.equal(stk.value.czk, 2 * 75 * 25); // USD price → CZK at 25 CZK/USD
  assert.equal(a.summary.valueDate, '2025-01-13');

  assert.deepEqual(
    a.geography.map((g) => [g.country, Math.round(g.share * 10) / 10]),
    // ETF 1200 EUR × 25 = 30 000 Kč (60 % US, 10 % JP, 30 % other), stock 150 USD × 25 = 3 750 Kč (US exchange)
    [['US', 64.4], ['XX', 26.7], ['JP', 8.9]],
  );
  assert.deepEqual(a.history.map((h) => h.date), ['2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10', '2025-01-11', '2025-01-12', '2025-01-13']);
  assert.equal(a.history.at(-1)!.valueCzk, 1200 * 25 + 150 * 25);
  assert.deepEqual(a.instruments['ETFA.DE']!.prices, [['2025-01-06', 100], ['2025-01-13', 120]]);
});

test('geography puts holdings without composition into "??"', () => {
  const t = (czk: number) => ({ czk, eur: czk / 25, native: { EUR: czk / 25 } });
  const g = geography([
    { value: t(750), countries: [{ country: 'US', weight: 100 }] },
    { value: t(250), countries: [] },
  ]);
  assert.deepEqual(g.map((s) => [s.country, s.share]), [['US', 75], ['??', 25]]);
});
