import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Db } from '../src/db/database.ts';
import { importBuffer } from '../src/importer.ts';
import { analyze } from '../src/analysis/portfolio.ts';
import type { FxRates } from '../src/analysis/fx.ts';
import { buildT212Ledger, isT212Csv, parseCsv, parseT212Export, t212Ticker, type T212Row } from '../src/t212/history.ts';
import { rebuildT212 } from '../src/t212/store.ts';
import { fakeXtbExport } from './helpers/fakeXtb.ts';

const HEAD = 'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,' +
  'Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)';
type Line = { action: string; time: string; isin?: string; ticker?: string; name?: string; id?: string; shares?: number; price?: number;
  ccy?: string; rate?: number; total: number; wht?: number; whtCcy?: string };
const csv = (lines: Line[]) => [HEAD, ...lines.map((l) => [
  l.action, `${l.time}+00:00`, l.isin ?? '', l.ticker ?? '', l.name ? `"${l.name}"` : '', '', l.id ?? '', l.shares ?? '', l.price ?? '',
  l.ccy ?? '', l.rate ?? '', '', '', l.total, 'CZK', l.wht ?? '', l.whtCcy ?? '', '', '',
].join(','))].join('\r\n');

const ETF = { isin: 'IE00TEST0001', ticker: 'TETF', name: 'Test World (Acc)', ccy: 'EUR' };
const buy = (id: string, time: string, shares: number, total: number): Line => ({ action: 'Limit buy', time, id, shares, price: 40, rate: 0.04, total, ...ETF });
const sell = (id: string, time: string, shares: number, total: number): Line => ({ action: 'Stop sell', time, id, shares, price: 50, rate: 0.04, total, ...ETF });
const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const fx: FxRates = { czkPer: (c) => ({ EUR: 25, USD: 23 })[c] ?? null };

test('CSV parser: quotes, embedded commas and newlines, BOM', () => {
  assert.deepEqual(parseCsv('\uFEFFa,"b,1","c ""x""\nd"\r\n1,,3\n'), [['a', 'b,1', 'c "x"\nd'], ['1', '', '3']]);
});

test('parses current and older T212 export headers', () => {
  const now = parseT212Export(csv([buy('EOF1', '2024-01-02 10:00:00', 2, 2002), { action: 'Deposit', time: '2024-01-01 09:00:00', id: 'D1', total: 5000 }]));
  assert.equal(now.rows.length, 2);
  assert.deepEqual([now.periodFrom, now.periodTo], ['2024-01-01T09:00:00.000Z', '2024-01-02T10:00:00.000Z']);
  assert.equal(now.rows[0]!.currency, 'CZK');

  const old = 'Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result (EUR),Total (EUR),ID\n' +
    'Market buy,20/11/2020 12:08,US0378331005,AAPL,Apple,1.5,100,USD,1.18,,127.12,EOF9\n';
  assert.ok(isT212Csv(old));
  const r = parseT212Export(old).rows[0]!;
  assert.deepEqual([r.time, r.currency, r.shares, r.total, r.key], ['2020-11-20T12:08:00.000Z', 'EUR', 1.5, 127.12, 'EOF9']);
  assert.ok(!isT212Csv('Ticker,Name\nA,B'));
});

test('ledger: FIFO across partial sales, split keeps cost and dates, missing purchases are reported', () => {
  const rows = parseT212Export(csv([
    buy('B1', '2024-01-02 10:00:00', 10, 1000),
    buy('B2', '2024-02-02 10:00:00', 10, 1200),
    sell('S1', '2024-03-02 10:00:00', 4, 600),
    { action: 'Stock split close', time: '2024-04-01 06:00:00', shares: 16, total: 0, ...ETF },
    { action: 'Stock split open', time: '2024-04-01 06:00:00', shares: 32, total: 0, ...ETF },
    sell('S2', '2024-05-02 10:00:00', 20, 2000),
    { action: 'Stop sell', time: '2024-06-01 10:00:00', id: 'S3', shares: 1, price: 300, rate: 0.04, total: 7000, isin: 'US0000000001', ticker: 'OLD', name: 'Old Inc', ccy: 'USD' },
  ])).rows;
  const l = buildT212Ledger(rows, t212Ticker);
  // S1 takes 4 of B1 (cost 400) and is restated in post-split shares (8 @ 20/25) like the split-adjusted prices;
  // S2 = 20 post-split shares = 6 rest of B1 (×2 = 12) + 8 of B2. Amounts never change.
  assert.deepEqual(l.closed.map((c) => [c.positionId, c.sourceKey, c.volume, c.openPrice, c.closePrice, Math.round(c.purchaseValue), Math.round(c.saleValue)]), [
    ['B1', 'S1', 8, 20, 25, 400, 600], ['B1', 'S2', 12, 20, 50, 600, 1200], ['B2', 'S2', 8, 20, 50, 480, 800],
  ]);
  assert.deepEqual(l.open.map((o) => [o.positionId, o.ticker, o.volume, Math.round(o.purchaseValue), o.openTime]),
    [['B2', 'TETF.DE', 12, 720, '2024-02-02T10:00:00.000Z']]);
  assert.equal(l.warnings.length, 1);
  assert.match(l.warnings[0]!, /OLD\.US.*chybí nákup.*celé období/);
});

test('dividend: net total plus withholding tax converted with the row exchange rate', () => {
  const row = (wht: number | undefined, whtCcy: string | undefined, total: number) => parseT212Export(csv([
    { action: 'Dividend (Dividend)', time: '2024-03-14 12:00:00', isin: 'US5949181045', ticker: 'MSFT', name: 'Microsoft', shares: 10, price: 0.6375, ccy: 'USD', rate: 23, total, wht, whtCcy },
  ])).rows;
  // Net 6.375 USD × 23 = 146.63 CZK, 1.125 USD withheld → 25.88 CZK; gross 172.50 CZK
  const l = buildT212Ledger(row(1.125, 'USD', 146.63), t212Ticker);
  assert.deepEqual(l.cash.map((c) => c.type), ['Dividend', 'Withholding tax']);
  assert.ok(Math.abs(l.cash[0]!.amount - 172.505) < 1e-6 && Math.abs(l.cash[1]!.amount + 25.875) < 1e-6, String(l.cash.map((c) => c.amount)));
  // Tax already in account currency
  assert.deepEqual(buildT212Ledger(row(25, 'CZK', 150), t212Ticker).cash.map((c) => c.amount), [175, -25]);
  // No ID: identical rows in two overlapping exports get the same key
  assert.equal(row(undefined, undefined, 10)[0]!.key, row(undefined, undefined, 10)[0]!.key);
});

test('tickers: exchange from price currency, funds on Xetra', () => {
  const t = (ticker: string, isin: string, priceCurrency: string, name: string) => t212Ticker({ ticker, isin, priceCurrency, name } as T212Row);
  assert.equal(t('VUAA', 'IE00BFMXXD54', 'GBX', 'Vanguard S&P 500 (Acc)'), 'VUAA.UK');
  assert.equal(t('VWCE', 'IE00BK5BQT80', 'EUR', 'Vanguard FTSE All-World (Acc)'), 'VWCE.DE');
  assert.equal(t('ASML', 'NL0010273215', 'EUR', 'ASML'), 'ASML.NL');
  assert.equal(t('CEZ', 'CZ0005112300', 'CZK', 'CEZ'), 'CEZ.CZ');
});

test('import: overlapping exports are deduplicated and merged with XTB holdings by ISIN', () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'xtb.xlsx', fakeXtbExport({
    cash: [{ id: '1', type: 'Deposit', time: '2023-01-02T08:00:00Z', amount: 1000 }],
    closed: [],
    openAsOf: '2024-12-31T10:00:00Z',
    open: [{ ticker: 'TETF.NL', name: 'Test World', positionId: '9', volume: 1, openPrice: 40, openTime: '2023-01-10T09:00:00Z', currentPrice: 44 }],
  }));
  db.prepare("INSERT INTO instrument_meta (ticker, isin, updated_at) VALUES ('TETF.NL', 'IE00TEST0001', '2024-01-01')").run();

  const first = importBuffer(db, 't1.csv', Buffer.from(csv([
    { action: 'Deposit', time: '2024-01-01 09:00:00', id: 'D1', total: 5000 },
    buy('B1', '2024-01-02 10:00:00', 10, 1000),
  ])));
  assert.equal(first.status, 'imported');
  assert.equal(first.accountNumber, 'T212-CZK');
  const second = importBuffer(db, 't2.csv', Buffer.from(csv([
    buy('B1', '2024-01-02 10:00:00', 10, 1000),
    sell('S1', '2024-06-02 10:00:00', 4, 600),
  ])));
  assert.deepEqual([second.cash, second.closed], [{ inserted: 1, duplicates: 1 }, { inserted: 1, duplicates: 0 }]);
  assert.equal(importBuffer(db, 't2.csv', Buffer.from(csv([buy('B1', '2024-01-02 10:00:00', 10, 1000), sell('S1', '2024-06-02 10:00:00', 4, 600)]))).status, 'already-imported');
  assert.equal(count(db, "SELECT COUNT(*) n FROM t212_rows"), 3);
  assert.equal(count(db, "SELECT COUNT(*) n FROM open_lots WHERE ticker = 'TETF.NL'"), 2);

  // Idempotent rebuild
  rebuildT212(db);
  assert.equal(count(db, "SELECT COUNT(*) n FROM cash_operations WHERE account_number = 'T212-CZK'"), 3);

  db.prepare("INSERT INTO prices (ticker, date, close, currency, source) VALUES ('TETF.NL', '2025-01-02', 50, 'EUR', 'test')").run();
  const a = analyze(db, { today: '2025-01-03', fx });
  const h = a.holdings.find((x) => x.ticker === 'TETF.NL')!;
  assert.equal(h.quantity, 7);
  const t212Lot = h.lots.find((l) => l.accountNumber === 'T212-CZK')!;
  assert.deepEqual([t212Lot.quantity, t212Lot.cost.czk, t212Lot.valueSource, t212Lot.value?.czk], [6, 600, 'market', 6 * 50 * 25]);
  const sold = a.realized.find((r) => r.ticker === 'TETF.NL')!;
  assert.deepEqual([sold.lots[0]!.cost.czk, sold.lots[0]!.proceeds.czk], [400, 600]);
  assert.ok(!a.checks.warnings.some((w) => /Nezpracované typy/.test(w)), a.checks.warnings.join('\n'));
  // T212 lots don't switch off the XTB check, and only the XTB lot is compared (1 × 44 € → 1 × 50 €).
  const move = a.checks.validation.find((c) => c.title === 'Změna hodnoty od výpisu');
  assert.match(move?.detail ?? '', /výpisu 1\s100 Kč, podle stažených cen 1\s250 Kč/);
});

test('a position without any price is valued at cost (like the chart), not as a −100 % loss', () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 't.csv', Buffer.from(csv([
    { action: 'Deposit', time: '2024-01-01 09:00:00', id: 'D1', total: 5000 },
    buy('B1', '2024-01-02 10:00:00', 10, 1000),
  ])));
  const a = analyze(db, { today: '2024-01-05', fx });
  const lot = a.holdings[0]!.lots[0]!;
  assert.deepEqual([lot.valueSource, lot.value?.czk, lot.profit], ['cost', 1000, null]);
  assert.deepEqual([a.summary.value.czk, a.summary.unrealizedProfit.czk], [1000, 0]);
  assert.deepEqual([a.holdings[0]!.profit.czk, a.holdings[0]!.profitPct.czk], [null, null], 'no priced lot → profit unknown, not 0 %');
  assert.equal(a.history.at(-1)!.valueCzk, a.summary.value.czk, 'chart and headline agree');
  assert.ok(a.checks.warnings.some((w) => w.includes(a.holdings[0]!.ticker) && /nákupní cenou/.test(w)), a.checks.warnings.join('\n'));
});
