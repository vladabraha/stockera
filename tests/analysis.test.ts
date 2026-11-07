import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/database.ts';
import { importBuffer } from '../src/importer.ts';
import { pragueDate, taxFreeFrom } from '../src/analysis/calendar.ts';
import { Converter, DbFxRates, type FxRates, type Money } from '../src/analysis/fx.ts';
import { analyze, classifyCashOperation, computeTaxYears, type RealizedLot } from '../src/analysis/portfolio.ts';
import { fakeXtbExport, type FakeExport } from './helpers/fakeXtb.ts';

const EUR_CZK = 25;
const fixedFx: FxRates = { czkPer: (c) => ({ EUR: EUR_CZK, USD: 20 })[c] ?? null };
const close = (a: number | null | undefined, b: number) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('time test: first tax-free day is the day after the 3rd anniversary (Prague date)', () => {
  assert.equal(taxFreeFrom('2021-03-15'), '2024-03-16');
  assert.equal(taxFreeFrom('2020-02-29'), '2023-03-01');
  assert.equal(pragueDate('2024-03-31T22:30:00Z'), '2024-04-01');
  assert.equal(pragueDate('2024-01-31T22:59:00Z'), '2024-01-31');
});

test('DbFxRates uses the last fixing up to 7 days old', () => {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO fx_rates (currency, date, czk_per_unit, source) VALUES ('EUR', '2024-05-03', 25.1, 'test')`).run();
  const fx = new DbFxRates(db);
  assert.equal(fx.czkPer('EUR', '2024-05-05'), 25.1);
  assert.equal(fx.czkPer('EUR', '2024-05-10'), 25.1);
  assert.equal(fx.czkPer('EUR', '2024-05-11'), null);
  assert.equal(fx.czkPer('EUR', '2024-05-02'), null);
});

test('Converter computes CZK/EUR via cross rates and records missing rates', () => {
  const conv = new Converter(fixedFx);
  assert.deepEqual(conv.money(10, 'USD', '2024-01-02'), { native: 10, currency: 'USD', czk: 200, eur: 8 });
  assert.deepEqual(conv.money(100, 'CZK', '2024-01-02'), { native: 100, currency: 'CZK', czk: 100, eur: 4 });
  assert.deepEqual(conv.money(1, 'GBP', '2024-01-02'), { native: 1, currency: 'GBP', czk: null, eur: null });
  assert.deepEqual([...conv.missing], ['GBP 2024-01-02']);
});

test('classifyCashOperation', () => {
  const kinds = ['Deposit', 'Withdrawal', 'Stock purchase', 'Stock sell', 'Free funds interest', 'Free funds interest tax',
    'DIVIDENT', 'Withholding tax', 'Commission', 'Something new'].map(classifyCashOperation);
  assert.deepEqual(kinds, ['deposit', 'withdrawal', 'trade', 'trade', 'interest', 'interest-tax', 'dividend',
    'withholding-tax', 'fee', 'other']);
});

const czk = (v: number): Money => ({ native: v, currency: 'CZK', czk: v, eur: v / EUR_CZK });
function lot(closeDate: string, cost: number, proceeds: number, timeTestMet = false): RealizedLot {
  return {
    accountNumber: '1', positionId: 'p', quantity: 1, openTime: '', closeTime: '', openDate: '', closeDate,
    openPrice: 0, closePrice: 0, holdingDays: 0, timeTestMet, cost: czk(cost), proceeds: czk(proceeds),
    profit: czk(proceeds - cost), profitPct: { czk: null, eur: null, native: null }, xtbProfit: 0,
  };
}

test('tax years: sales within the 100k limit are exempt', () => {
  const [y] = computeTaxYears([lot('2024-03-01', 40_000, 60_000), lot('2024-05-01', 30_000, 40_000)]);
  assert.equal(y!.limitStatus, 'within');
  assert.equal(y!.limitRemainingCzk, 0);
  assert.equal(y!.taxable.count, 0);
  assert.equal(y!.taxable.baseCzk, 0);
});

test('tax years: above the limit, losses offset gains, time-tested lots excluded, base ≥ 0', () => {
  const [y] = computeTaxYears([
    lot('2024-03-01', 50_000, 70_000),
    lot('2024-04-01', 40_000, 30_000),
    lot('2024-05-01', 1_000, 50_000, true),
  ]);
  assert.equal(y!.limitStatus, 'exceeded');
  assert.equal(y!.taxable.count, 2);
  assert.equal(y!.taxable.baseCzk, 10_000);
  assert.equal(y!.timeTestCapExceeded, false);

  const [loss] = computeTaxYears([lot('2024-03-01', 150_000, 101_000)]);
  assert.equal(loss!.taxable.baseCzk, 0);
});

test('tax years: 40M cap on time-tested income applies only in 2025; missing rates → unknown', () => {
  const big = (d: string) => lot(d, 1, 40_000_001, true);
  assert.deepEqual(computeTaxYears([big('2025-06-01'), big('2026-06-01')]).map((y) => [y.year, y.timeTestCapExceeded]), [
    [2026, false],
    [2025, true],
  ]);
  const unknown = lot('2024-01-01', 1, 1);
  unknown.proceeds = { ...unknown.proceeds, czk: null };
  const [u] = computeTaxYears([unknown]);
  assert.equal(u!.limitStatus, 'unknown');
  assert.equal(u!.taxable.baseCzk, null);
});

const scenario: FakeExport = {
  from: '2020-12-31T23:00:00Z',
  cash: [
    { id: '1', type: 'Deposit', time: '2021-01-04T08:00:00Z', amount: 1000 },
    { id: '2', type: 'Dividend', ticker: 'AAA.DE', time: '2024-06-01T08:00:00Z', amount: 10 },
    { id: '3', type: 'Withholding tax', ticker: 'AAA.DE', time: '2024-06-01T08:00:00Z', amount: -1.5 },
  ],
  closed: [
    // XTB sold the newer lot although an older one is still open → FIFO mismatch
    { ticker: 'AAA.DE', volume: 2, openPrice: 10, openTime: '2022-06-01T09:00:00Z', closePrice: 15,
      closeTime: '2024-03-01T10:00:00Z', profit: 10, positionId: '20' },
  ],
  openAsOf: '2024-12-31T10:00:00Z',
  open: [
    { ticker: 'AAA.DE', name: 'Alpha', positionId: '10', volume: 1, openPrice: 8, openTime: '2021-02-01T09:00:00Z',
      currentPrice: 16 },
    { ticker: 'AAA.DE', name: 'Alpha', positionId: '30', volume: 3, openPrice: 12, openTime: '2023-01-10T09:00:00Z',
      currentPrice: 16 },
  ],
};

test('analyze: holdings, time test, realized, dividends, FIFO check', () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport(scenario));
  const a = analyze(db, { today: '2025-01-01', fx: fixedFx });
  assert.equal(a.lastTransactionDate, '2024-06-01'); // newest of trades and cash operations (the dividend)

  const [h] = a.holdings;
  assert.equal(h!.quantity, 4);
  close(h!.value.native.EUR, 64);
  close(h!.cost.native.EUR, 44);
  close(h!.value.czk, 64 * EUR_CZK);
  close(h!.profitPct.eur, (20 / 44) * 100);
  assert.equal(h!.taxFreeQuantity, 1);
  assert.equal(h!.nextTaxFreeDate, '2026-01-11');
  assert.deepEqual(h!.lots.map((l) => [l.positionId, l.taxFree, l.daysUntilTaxFree]), [
    ['10', true, 0],
    ['30', false, 375],
  ]);

  const [r] = a.realized;
  close(r!.proceeds.native.EUR, 30);
  close(r!.profit.czk, 10 * EUR_CZK);
  assert.equal(r!.lots[0]!.timeTestMet, false);

  assert.equal(a.taxYears[0]!.limitStatus, 'within');
  assert.deepEqual(a.dividends.map((d) => [d.ticker, d.year, d.net.native.EUR]), [['AAA.DE', 2024, 8.5]]);
  close(a.summary.dividendsNet.eur, 8.5);
  close(a.summary.deposits.czk, 1000 * EUR_CZK);

  assert.equal(a.checks.fifoMismatches.length, 1);
  assert.equal(a.checks.validation.find((c) => c.title.startsWith('Párování'))?.status, 'warn');
  assert.deepEqual(a.checks.fifoMismatches[0]!.fifo.map((x) => [x.positionId, x.volume]), [['10', 1], ['20', 1]]);
  assert.deepEqual(a.checks.missingRates, []);
  assert.ok(a.cashFlows[0]!.historyComplete);
});

test('analyze: warns when cash history starts after the first purchase; amounts stay native without rates', () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport({ ...scenario, cash: scenario.cash!.slice(1) }));
  const a = analyze(db, { today: '2025-01-01', fx: { czkPer: () => null } });
  assert.equal(a.cashFlows[0]!.historyComplete, false);
  assert.ok(a.checks.warnings.some((w) => w.includes('nejstarší nákup')));
  assert.equal(a.summary.value.czk, null);
  close(a.summary.value.native.EUR, 64);
  assert.ok(a.checks.missingRates.length > 0);
  assert.equal(a.taxYears[0]!.limitStatus, 'unknown');
});
