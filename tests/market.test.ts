import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Db } from '../src/db/database.ts';
import { importBuffer } from '../src/importer.ts';
import { Http } from '../src/net/http.ts';
import { loadInstrumentConfig, updateMarketData } from '../src/market/update.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/analysis/portfolio.ts';
import { geography, sectorBreakdown } from '../src/analysis/market.ts';
import { fakeXtbExport } from './helpers/fakeXtb.ts';
import { fakeFetch } from './helpers/fakeFetch.ts';
import { lookThrough } from '../src/analysis/breakdown.ts';

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
  '<td data-testid="tl_etf-holdings_countries_value_name">Japan</td><span data-testid="tl_etf-holdings_countries_value_percentage">10.00%</span>' +
  '<tr data-testid="etf-holdings_top-holdings_row"><td><a data-testid="tl_etf-holdings_top-holdings_link_name" href="/en/stock-profiles/US0000000002" title="Stock Inc."><span>Stock Inc.</span></a></td>' +
  '<td><span data-testid="tl_etf-holdings_top-holdings_value_percentage">5.00%</span></td></tr>' +
  '<tr data-testid="etf-holdings_top-holdings_row"><td><a data-testid="tl_etf-holdings_top-holdings_link_name" href="/en/stock-profiles/JP0000000004" title="Toyota &amp; Co"><span>Toyota</span></a></td>' +
  '<td><span data-testid="tl_etf-holdings_top-holdings_value_percentage">3.00%</span></td></tr>';
const chart = JSON.stringify({ series: [{ date: '2025-01-06', value: { raw: 100 } }, { date: '2025-01-13', value: { raw: 120 } }] });
const yahoo = JSON.stringify({
  chart: { result: [{ meta: { currency: 'USD', gmtoffset: -18000 }, timestamp: [1736784000], indicators: { quote: [{ close: [75] }] } }] },
});

const fundBreakdowns = JSON.stringify({ branchBreakdown: { list: [{ nameBreakdown: 'IT/Telekommunikation', investmentPct: 40 }, { nameBreakdown: 'Finanzen', investmentPct: 35 }] } });
const search = JSON.stringify({
  facets: [{ type: 'STOCK', results: [{ name: 'STK', isin: 'US0000000002', additionalData: { countryCode: 'US' } }, { name: 'STK', isin: 'DE0000000003', additionalData: { countryCode: 'DE' } }] }],
});
const snapshot = JSON.stringify({ company: { branch: { name: 'Pharma', sector: { name: 'Gesundheitswesen' } } } });

function routes(u: string): Response | undefined {
  if (u.includes('cnb.cz')) return new Response(cnb);
  if (u.includes('api.onvista.de/api/v1/funds/')) return new Response(fundBreakdowns);
  if (u.includes('api.onvista.de/api/v1/instruments/search')) return new Response(search);
  if (u.includes('api.onvista.de/api/v1/stocks/ISIN:US0000000002/snapshot')) return new Response(snapshot);
  if (u.includes('allTradableInstruments')) return new Response(xetra);
  if (u.includes('etf-profile')) return new Response(profile);
  if (u.includes('performance-chart')) return new Response(chart);
  if (u.includes('finance.yahoo.com')) return new Response(yahoo);
  return undefined;
}

test('updateMarketData stores rates, ISINs, countries, sectors and prices; requests carry no personal data', async () => {
  const db = seed();
  const calls: string[] = [];
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch(routes, calls) });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });

  assert.deepEqual(r.warnings, []);
  // The deposit (2024-12-01) predates the first trade: its year's rates are needed too
  assert.deepEqual(r.fxYears, [2024, 2025]);
  assert.deepEqual(
    r.instruments.map((i) => [i.ticker, i.isin, i.priceSource, i.newPrices, i.countrySource]),
    [
      ['ETFA.DE', 'IE0000000001', 'justetf', 2, 'justetf'],
      ['STK.US', 'US0000000002', 'yahoo', 1, 'isin'],
    ],
  );
  assert.deepEqual(r.instruments.map((i) => i.sectorSource), ['onvista', 'onvista']);
  const sectors = db.prepare(`SELECT ticker, sector, weight FROM sector_weights ORDER BY ticker, weight DESC`).all().map((x) => ({ ...x }));
  assert.deepEqual(sectors, [
    { ticker: 'ETFA.DE', sector: 'technology', weight: 40 },
    { ticker: 'ETFA.DE', sector: 'financials', weight: 35 },
    { ticker: 'ETFA.DE', sector: 'other', weight: 25 },
    { ticker: 'STK.US', sector: 'health', weight: 100 },
  ]);
  assert.deepEqual(db.prepare('SELECT ticker, isin, name, weight FROM fund_holdings ORDER BY weight DESC').all().map((x) => ({ ...x })), [
    { ticker: 'ETFA.DE', isin: 'US0000000002', name: 'Stock Inc.', weight: 5 },
    { ticker: 'ETFA.DE', isin: 'JP0000000004', name: 'Toyota & Co', weight: 3 },
  ]);
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
  assert.ok(calls.every((u) => /^https:\/\/(www\.cnb\.cz|www\.cashmarket\.deutsche-boerse\.com|www\.justetf\.com|api\.onvista\.de|query1\.finance\.yahoo\.com)\//.test(u)));

  // Second run is incremental: no Xetra list / profile re-download, prices from last date − 7 days
  calls.length = 0;
  await updateMarketData(db, http, { today: '2025-01-14' });
  assert.ok(!calls.some((u) => u.includes('allTradableInstruments') || u.includes('etf-profile')));
  assert.ok(calls.some((u) => u.includes('performance-chart') && u.includes('dateFrom=2025-01-06')));
});

test('stock sector falls back to Yahoo when onvista does not list it', async () => {
  const db = seed();
  const http = new Http({
    minIntervalMs: 0,
    fetch: fakeFetch((u) =>
      u.includes('/snapshot') ? new Response('{"company":{}}')
        : u.includes('/v1/finance/search?q=US0000000002') ? new Response('{"quotes":[{"symbol":"STK","quoteType":"EQUITY","sector":"Healthcare"}]}')
          : routes(u)),
  });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.instruments.find((i) => i.ticker === 'STK.US')!.sectorSource, 'yahoo');
  assert.deepEqual(db.prepare(`SELECT sector, weight FROM sector_weights WHERE ticker = 'STK.US'`).all().map((x) => ({ ...x })), [
    { sector: 'health', weight: 100 },
  ]);
});

test('a record on 1 January also downloads the previous year (last fixing before the holiday)', async () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport({
    account: ACCOUNT,
    cash: [{ id: '1', type: 'Free-funds Interest', time: '2025-01-01T22:00:00Z', amount: 1 }],
    openAsOf: '2025-01-10T10:00:00Z',
    open: [{ ticker: 'ETFA.DE', name: 'World', positionId: '1', volume: 1, openPrice: 100, openTime: '2025-01-06T09:00:00Z', currentPrice: 110 }],
  }));
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch(routes) });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });
  assert.deepEqual(r.fxYears, [2024, 2025]);
});

test('ETF without a justETF country breakdown or positions falls back to onvista, sectors fall back to justETF; Yahoo provides stock names', async () => {
  const db = seed();
  const onvista = JSON.stringify({
    countryBreakdown: { list: [{ nameBreakdown: 'Polen', investmentPct: 73 }, { nameBreakdown: 'Ungarn', investmentPct: 20.17 }, { nameBreakdown: 'Tschechien', investmentPct: 6.83 }] },
    fundsHoldingList: { list: [{ instrument: { name: 'Orlen', isin: 'PLPKN0000018' }, investmentPct: 12.5 }, { instrument: { name: 'OTP BANK PLC', isin: '' }, investmentPct: 3 },
      { instrument: { name: 'Carnival Corp Ltd' }, investmentPct: 2 }] },
  });
  // Positions without ISIN are looked up by company name; ADRs are ignored and two Carnival listings are ambiguous.
  const search = JSON.stringify({ facets: [{ type: 'STOCK', results: [
    { name: 'OTP Bank', isin: 'HU0000061726' }, { name: 'OTP BANK ADR', isin: 'US67106E1010' },
    { name: 'Carnival Corp. (AIDA)', isin: 'BMG2004J1036' }, { name: 'Carnival PLC', isin: 'GB0031215220' },
  ] }] });
  const named = yahoo.replace('"currency":"USD"', '"currency":"USD","longName":"Stock Inc."');
  const http = new Http({
    minIntervalMs: 0,
    fetch: fakeFetch((u) =>
      u.includes('etf-profile') ? new Response('<meta property="og:title" content="Swap ETF | X | IE0000000001" />' +
        '<td data-testid="tl_etf-holdings_sectors_value_name">Financials</td><span data-testid="tl_etf-holdings_sectors_value_percentage">55.00%</span>')
        : u.includes('api.onvista.de/api/v1/funds/') ? new Response(onvista)
          : /instruments\/search.*searchValue=(OTP|Carnival|CARNIVAL)/.test(u) ? new Response(search)
          : u.includes('finance.yahoo.com') ? new Response(named)
            : routes(u)),
  });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.instruments[0]!.countrySource, 'onvista');
  assert.equal(r.instruments[0]!.sectorSource, 'justetf');
  assert.deepEqual(db.prepare(`SELECT sector, weight FROM sector_weights WHERE ticker = 'ETFA.DE' ORDER BY weight DESC`).all().map((x) => ({ ...x })), [
    { sector: 'financials', weight: 55 },
    { sector: 'other', weight: 45 },
  ]);
  const weights = db.prepare(`SELECT country, weight FROM country_weights WHERE ticker = 'ETFA.DE' ORDER BY weight DESC`).all().map((x) => ({ ...x }));
  assert.deepEqual(weights, [{ country: 'PL', weight: 73 }, { country: 'HU', weight: 20.17 }, { country: 'CZ', weight: 6.83 }]);
  assert.deepEqual(db.prepare('SELECT isin, name, weight FROM fund_holdings ORDER BY weight DESC').all().map((x) => ({ ...x })), [
    { isin: 'PLPKN0000018', name: 'Orlen', weight: 12.5 },
    { isin: 'HU0000061726', name: 'OTP BANK PLC', weight: 3 },
    { isin: 'name:CARNIVAL', name: 'Carnival Corp Ltd', weight: 2 },
  ]);
  assert.deepEqual(db.prepare('SELECT ticker, name FROM instrument_meta ORDER BY ticker').all().map((x) => ({ ...x })), [
    { ticker: 'ETFA.DE', name: 'Swap ETF' },
    { ticker: 'STK.US', name: 'Stock Inc.' },
  ]);
});

test('ISIN fallbacks: ETF missing from Xetra by onvista symbol, stock without exact name by matching the XTB price', async () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport({
    account: ACCOUNT,
    cash: [{ id: '1', type: 'Deposit', time: '2024-12-01T08:00:00Z', amount: 5000 }],
    openAsOf: '2025-01-10T10:00:00Z',
    open: [
      { ticker: 'LCUW.DE', name: 'MSCI World', positionId: '1', volume: 1, openPrice: 100, openTime: '2025-01-06T09:00:00Z', currentPrice: 110 },
      { ticker: 'KBC.BE', name: 'KBC', positionId: '2', volume: 1, openPrice: 100, openTime: '2025-01-07T09:00:00Z', currentPrice: 118 },
    ],
  }));
  db.prepare(`UPDATE instruments SET category = CASE ticker WHEN 'KBC.BE' THEN 'STOCK' ELSE 'ETF' END`).run();
  const be = (name: string, isin: string) => ({ name, isin, additionalData: { countryCode: 'BE' } });
  const quote = (last: number) => JSON.stringify({ quoteList: { list: [{ last: last * 1.5, market: { isoCountry: 'DE' } }, { last, market: { isoCountry: 'BE' } }] } });
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch((u) =>
    u.includes('searchValue=KBC') ? new Response(JSON.stringify({ facets: [{ type: 'STOCK', results: [be('KBC Group', 'BE0003565737'), be('KBC Ancora', 'BE0003867844'), be('KBCX', 'BE0000000001')] }] }))
      : u.includes('searchValue=LCUW') ? new Response(JSON.stringify({ facets: [{ type: 'ETF', results: [{ name: 'Amundi MSCI World', symbol: 'LCUW', isin: 'LU1781541179' }] }] }))
        : u.includes('ISIN:BE0003565737/snapshot') ? new Response(quote(117.5))
          : u.includes('ISIN:BE0003867844/snapshot') ? new Response(quote(95))
            : routes(u)) });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });
  assert.deepEqual(r.instruments.map((i) => [i.ticker, i.isin]), [['KBC.BE', 'BE0003565737'], ['LCUW.DE', 'LU1781541179']]);
  assert.ok(!r.warnings.some((w) => w.includes('ISIN')), r.warnings.join('\n'));
});

test('Prague stocks: ISIN and Yahoo symbol from the PSE lists by trading/Bloomberg code, else by a unique price match', async () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport({
    account: ACCOUNT,
    cash: [{ id: '1', type: 'Deposit', time: '2024-12-01T08:00:00Z', amount: 5000 }],
    openAsOf: '2025-01-10T10:00:00Z',
    open: [
      { ticker: 'RBAG.CZ', name: 'Erste', positionId: '1', volume: 1, openPrice: 900, openTime: '2025-01-06T09:00:00Z', currentPrice: 1000 },
      { ticker: 'KOMB.CZ', name: 'Komercni', positionId: '2', volume: 1, openPrice: 900, openTime: '2025-01-06T09:00:00Z', currentPrice: 990 },
      { ticker: 'ZZZ.CZ', name: 'Mystery', positionId: '3', volume: 1, openPrice: 100, openTime: '2025-01-06T09:00:00Z', currentPrice: 52 },
    ],
  }));
  db.prepare(`UPDATE instruments SET category = 'STOCK'`).run();
  const row = (name: string, isin: string, price: number) =>
    `<tr><td class="item-title js-item-title" data-title="${name}"><a href="/en/detail/${isin}">${name}</a><div class="isin">\n ${isin}\n</div>\n</td>\n<td sort-by="${price}">CZK ${price}</td></tr>`;
  const detail = (xetra: string, bloomberg: string) =>
    `<tr><td>Ticker Bloomberg</td>\n<td>${bloomberg} CP Equity</td></tr><tr><td>Ticker Reuters</td><td>X.PR</td></tr><tr><td>Ticker Xetra®</td>\n<td>${xetra}</td></tr>`;
  const yahooUrls: string[] = [];
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch((u) => {
    if (u.includes('shares/prime-market')) return new Response(row('ERSTE GROUP BANK', 'AT0000652011', 1010) + row('KOMERČNÍ BANKA', 'CZ0008019106', 995));
    if (u.includes('shares/')) return new Response(row('SOME &amp; CO', 'CZ0000000009', 50));
    if (u.includes('detail/AT0000652011')) return new Response(detail('ERBAG', 'RBAG'));
    if (u.includes('detail/CZ0008019106')) return new Response(detail('KOMB', 'KOMB'));
    if (u.includes('detail/CZ0000000009')) return new Response(detail('SOME', 'SOME'));
    if (u.includes('finance.yahoo.com/v8/finance/chart/')) yahooUrls.push(u);
    return routes(u);
  }) });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });
  assert.deepEqual(r.instruments.map((i) => [i.ticker, i.isin]),
    [['KOMB.CZ', 'CZ0008019106'], ['RBAG.CZ', 'AT0000652011'], ['ZZZ.CZ', 'CZ0000000009']]);
  assert.deepEqual(yahooUrls.map((u) => /chart\/([^?]+)/.exec(u)![1]).sort(), ['ERBAG.PR', 'KOMB.PR', 'SOME.PR']);
  assert.ok(r.warnings.some((w) => w.startsWith('ZZZ.CZ') && w.includes('jen podle ceny')), r.warnings.join('\n'));
  assert.ok(!r.warnings.some((w) => /^(RBAG|KOMB)\.CZ: (ISIN|ceny)/.test(w)), r.warnings.join('\n'));
});

test('XTB digit suffix and names: CEZ1.CZ = ČEZ (PSE code CEZ), Yahoo symbol by ISIN; other exchanges by the XTB name + price', async () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport({
    account: ACCOUNT,
    cash: [{ id: '1', type: 'Deposit', time: '2024-12-01T08:00:00Z', amount: 5000 }],
    openAsOf: '2025-01-10T10:00:00Z',
    open: [
      { ticker: 'CEZ1.CZ', name: 'CEZ', positionId: '1', volume: 1, openPrice: 900, openTime: '2025-01-06T09:00:00Z', currentPrice: 1000 },
      { ticker: 'ABC1.FR', name: 'Alpha Beta', positionId: '2', volume: 1, openPrice: 40, openTime: '2025-01-06T09:00:00Z', currentPrice: 50 },
    ],
  }));
  db.prepare(`UPDATE instruments SET category = 'STOCK'`).run();
  const fr = (name: string, isin: string) => ({ name, isin, additionalData: { countryCode: 'FR' } });
  const quote = (last: number) => JSON.stringify({ quoteList: { list: [{ last, market: { isoCountry: 'FR' } }] } });
  const calls: string[] = [];
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch((u) => {
    if (u.includes('shares/prime-market')) return new Response('<tr><td data-title="ČEZ"><div class="isin">CZ0005112300</div></td><td sort-by="1010">CZK</td></tr>');
    if (u.includes('shares/')) return new Response('');
    if (u.includes('detail/CZ0005112300')) return new Response('<td>Ticker Bloomberg</td><td>CEZ CP Equity</td><td>Ticker Xetra®</td><td>BAACEZ</td>');
    if (u.includes('chart/CEZ1.PR') || u.includes('chart/BAACEZ.PR') || u.includes('chart/CEZ.PR')) return new Response('{}', { status: 404 });
    if (u.includes('finance/search?q=CZ0005112300')) return new Response(JSON.stringify({ quotes: [{ symbol: 'CEZ.F', quoteType: 'EQUITY' }, { symbol: 'CEZP.PR', quoteType: 'EQUITY' }] }));
    if (u.includes('searchValue=Alpha')) return new Response(JSON.stringify({ facets: [{ type: 'STOCK', results: [fr('Alpha Beta SA', 'FR0000000011'), fr('Alpha Beta Holding', 'FR0000000029')] }] }));
    if (u.includes('searchValue=')) return new Response(JSON.stringify({ facets: [] }));
    if (u.includes('ISIN:FR0000000011/snapshot')) return new Response(quote(51));
    if (u.includes('ISIN:FR0000000029/snapshot')) return new Response(quote(12));
    return routes(u);
  }, calls) });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });
  assert.deepEqual(r.instruments.map((i) => [i.ticker, i.isin, i.newPrices > 0]),
    [['ABC1.FR', 'FR0000000011', true], ['CEZ1.CZ', 'CZ0005112300', true]]);
  assert.ok(calls.some((u) => u.includes('chart/CEZP.PR')), 'Yahoo symbol found by ISIN');
  assert.ok(calls.some((u) => u.includes('searchValue=ABC1')) && calls.some((u) => u.includes('searchValue=ABC&')));
  assert.ok(!r.warnings.some((w) => /: (ISIN|ceny)/.test(w)), r.warnings.join('\n'));
});

test('liquidated ETF is reported; compositionIsin takes countries and positions from another ETF, prices stay its own', async () => {
  const seedOne = () => {
    const db = openDatabase(':memory:');
    importBuffer(db, 'a.xlsx', fakeXtbExport({
      account: ACCOUNT,
      cash: [{ id: '1', type: 'Deposit', time: '2024-12-01T08:00:00Z', amount: 5000 }],
      openAsOf: '2025-01-10T10:00:00Z',
      open: [{ ticker: 'OLD.DE', name: 'Old World', positionId: '1', volume: 1, openPrice: 100, openTime: '2025-01-06T09:00:00Z', currentPrice: 110 }],
    }));
    db.prepare(`UPDATE instruments SET category = 'ETF'`).run();
    return db;
  };
  const closed = '<meta property="og:title" content="Old ETF | OLD | LU0000000005" /><p>This fund has been liquidated or merged. Consequently…</p>';
  const calls: string[] = [];
  const fetch = fakeFetch((u) => (u.includes('etf-profile') && u.includes('LU0000000005') ? new Response(closed)
    : u.includes('api.onvista.de/api/v1/funds/') && u.includes('LU0000000005') ? new Response('{}')
      : routes(u)), calls);
  const config = { 'OLD.DE': { isin: 'LU0000000005' } };

  const first = await updateMarketData(seedOne(), new Http({ minIntervalMs: 0, fetch }), { today: '2025-01-13', config });
  assert.ok(first.warnings.some((w) => w.includes('zrušený nebo sloučený') && w.includes('compositionIsin')), first.warnings.join('\n'));

  const db = seedOne();
  calls.length = 0;
  const second = await updateMarketData(db, new Http({ minIntervalMs: 0, fetch }), {
    today: '2025-01-13', config: { 'OLD.DE': { ...config['OLD.DE'], compositionIsin: 'IE0000000001' } },
  });
  assert.ok(!second.warnings.some((w) => w.includes('zrušený')), second.warnings.join('\n'));
  assert.equal((db.prepare(`SELECT weight FROM country_weights WHERE ticker = 'OLD.DE' AND country = 'US'`).get() as { weight: number }).weight, 60);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM fund_holdings WHERE ticker = 'OLD.DE'`).get() as { n: number }).n, 2);
  assert.ok(calls.some((u) => u.includes('etf-profile') && u.includes('IE0000000001')));
  assert.ok(calls.some((u) => u.includes('performance-chart') && u.includes('LU0000000005')));
});

test('sold instruments get prices for the history but no countries, sectors or positions (no needless warnings)', async () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport({
    account: ACCOUNT,
    cash: [{ id: '1', type: 'Deposit', time: '2024-12-01T08:00:00Z', amount: 5000 }],
    closed: [
      { ticker: 'ETFA.DE', volume: 1, openPrice: 100, openTime: '2025-01-06T09:00:00Z', closePrice: 110, closeTime: '2025-01-08T09:00:00Z', profit: 10, positionId: '1' },
      { ticker: 'GONE.BE', volume: 1, openPrice: 10, openTime: '2025-01-06T09:00:00Z', closePrice: 11, closeTime: '2025-01-08T09:00:00Z', profit: 1, positionId: '2' },
    ],
    openAsOf: '2025-01-10T10:00:00Z',
    open: [],
  }));
  db.prepare(`UPDATE instruments SET category = CASE ticker WHEN 'ETFA.DE' THEN 'ETF' ELSE 'STOCK' END`).run();
  const calls: string[] = [];
  const r = await updateMarketData(db, new Http({ minIntervalMs: 0, fetch: fakeFetch(routes, calls) }), { today: '2025-01-13' });
  assert.deepEqual(r.warnings, []);
  assert.ok(calls.some((u) => u.includes('performance-chart') && u.includes('IE0000000001')));
  assert.ok(!calls.some((u) => /etf-profile|onvista/.test(u)), calls.join('\n'));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM country_weights').get() as { n: number }).n, 0);
});

test('manual overrides win and failures become warnings', async () => {
  const db = seed();
  const http = new Http({ minIntervalMs: 0, retryDelaysMs: [0, 0], fetch: fakeFetch((u) => (u.includes('finance.yahoo.com') ? new Response('', { status: 429 }) : routes(u))) });
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

test('suspicious downloads are discarded: warning, audit entry, nothing stored', async () => {
  const db = seed();
  const evil = (u: string) => u.includes('finance.yahoo.com')
    ? new Response(yahoo.replace('"currency":"USD"', '"currency":"USD","longName":"Evil\\u001b]8;;https://x\\u0007"'), { headers: { 'content-type': 'application/json' } })
    : u.includes('etf-profile') ? new Response(profile.replace('World ETF', 'World ETF javascript:alert(1)'), { headers: { 'content-type': 'text/html' } })
    : routes(u);
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch(evil) });
  const r = await updateMarketData(db, http, { today: '2025-01-13' });
  assert.ok(r.warnings.some((w) => /STK\.US.*Yahoo poslal podezřelá data/.test(w)), r.warnings.join('\n'));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prices WHERE ticker = 'STK.US'`).get()!.n, 0);
  const names = db.prepare('SELECT name FROM instrument_meta').all().map((x) => String(x.name));
  assert.ok(names.every((n) => !/<|javascript:|\u001b/.test(n)), names.join());
  assert.deepEqual(http.log.filter((e) => e.status === 'unsafe').map((e) => new URL(e.url).hostname).sort(), ['query1.finance.yahoo.com', 'www.justetf.com']);
});

test('manual sectors win; unknown sector keys are reported', async () => {
  const db = seed();
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch(routes) });
  const r = await updateMarketData(db, http, {
    today: '2025-01-13',
    config: { 'ETFA.DE': { sectors: { energy: 70, health: 30 } }, 'STK.US': { sector: 'defense' } },
  });
  assert.equal(r.instruments[0]!.sectorSource, 'manual');
  assert.deepEqual(db.prepare(`SELECT sector, weight FROM sector_weights WHERE ticker = 'ETFA.DE' ORDER BY weight DESC`).all().map((x) => ({ ...x })), [
    { sector: 'energy', weight: 70 },
    { sector: 'health', weight: 30 },
  ]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /STK\.US: neznámý sektor defense/);
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
  // Look-through: STK.US is 5 % of the ETF (1 500 Kč) plus held directly (3 750 Kč)
  assert.deepEqual(a.lookThrough.items.map((c) => [c.key, c.czk, c.via.map((v) => v.ticker)]), [
    ['US0000000002', 5250, ['STK.US', 'ETFA.DE']],
    ['JP0000000004', 900, ['ETFA.DE']],
  ]);
});

test('geography puts holdings without composition into "??"', () => {
  const t = (czk: number) => ({ czk, eur: czk / 25, native: { EUR: czk / 25 } });
  const g = geography([
    { value: t(750), countries: [{ country: 'US', weight: 100 }] },
    { value: t(250), countries: [] },
  ]);
  assert.deepEqual(g.map((s) => [s.country, s.share]), [['US', 75], ['??', 25]]);
});

test('sectorBreakdown splits values by sector weights', () => {
  const t = (czk: number) => ({ czk, eur: czk / 25, native: { EUR: czk / 25 } });
  const s = sectorBreakdown([
    { value: t(600), sectors: [{ sector: 'technology', weight: 50 }, { sector: 'financials', weight: 50 }] },
    { value: t(400), sectors: [{ sector: 'technology', weight: 100 }] },
  ]);
  assert.deepEqual(s.map((x) => [x.sector, x.czk, x.share]), [['technology', 700, 70], ['financials', 300, 30]]);
});

test('lookThrough sums the same stock across ETFs and direct holdings, lists ETFs without positions', () => {
  const t = (czk: number) => ({ czk, eur: czk / 25, native: { EUR: czk / 25 } });
  const nvda = (weight: number) => ({ isin: 'US67066G1040', name: 'NVIDIA', weight });
  const lt = lookThrough([
    { ticker: 'SPYL.DE', name: 'S&P 500', isin: 'IE1', category: 'ETF', value: t(600), topHoldings: [nvda(10), { isin: 'US0378331005', name: 'Apple', weight: 5 }] },
    { ticker: 'WEBN.DE', name: 'World', isin: 'IE2', category: 'ETF', value: t(300), topHoldings: [nvda(5)] },
    { ticker: 'LEER.DE', name: 'Eastern Europe', isin: 'LU1', category: 'ETF', value: t(50), topHoldings: [] },
    { ticker: 'NVDA.US', name: 'NVIDIA Corporation', isin: 'US67066G1040', category: 'STOCK', value: t(50) },
  ], 1);
  assert.deepEqual(lt.items.map((c) => [c.name, c.czk, c.share, c.via]), [
    ['NVIDIA Corporation', 125, 12.5, [{ ticker: 'SPYL.DE', share: 6 }, { ticker: 'NVDA.US', share: 5 }, { ticker: 'WEBN.DE', share: 1.5 }]],
  ]);
  assert.equal(lt.coveredShare, 15.5); // limit cuts the list, not the coverage
  assert.deepEqual(lt.missing, ['LEER.DE']);
});

test('instruments.json saved by Windows Notepad (UTF-8 BOM) still loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stockera-'));
  try {
    const file = join(dir, 'instruments.json');
    writeFileSync(file, '\uFEFF{"$comment": "x", "CSG.NL": {"country": "CZ"}}');
    assert.deepEqual(loadInstrumentConfig(file), { 'CSG.NL': { country: 'CZ' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
