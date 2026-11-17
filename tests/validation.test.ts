import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodGaps, validatePortfolio, type ValidationInput } from '../src/analysis/validation.ts';
import type { OpenLot } from '../src/analysis/lots.ts';

const lot = (ticker: string, value: number, cost: number, currentPrice: number): OpenLot => ({
  accountNumber: 'A', currency: 'EUR', positionId: ticker, ticker, volume: 1, openPrice: cost, openTime: '2025-01-02T10:00:00Z',
  cost, costSource: 'cash-operation', currentPrice, value,
});

const base = (over: Partial<ValidationInput> = {}): ValidationInput => ({
  today: '2025-03-12',
  snapshots: [{ accountNumber: 'A', currency: 'EUR', asOf: '2025-03-10T18:00:00Z', value: 300, profit: 50 }],
  open: [lot('ETF.DE', 200, 160, 20), lot('STK.US', 100, 90, 100)],
  priceAt: (t) => ({ date: '2025-03-10', close: t === 'ETF.DE' ? 20.2 : 99, currency: 'EUR' }),
  xtbValueCzk: 7500,
  currentValueCzk: 7600,
  currentValueDate: '2025-03-11',
  missingRates: 0,
  fifoMismatches: 0,
  incompleteAccounts: [],
  ...over,
});
const statuses = (v: ValidationInput) => Object.fromEntries(validatePortfolio(v).map((c) => [c.title, c.status]));

test('validatePortfolio passes consistent data', () => {
  const checks = validatePortfolio(base());
  assert.deepEqual(checks.filter((c) => c.status === 'warn'), []);
  assert.ok(checks.some((c) => c.title === 'Pozice sedí se souhrnem XTB'));
  assert.ok(checks.some((c) => c.title === 'Změna hodnoty od výpisu' && c.status === 'info'));
});

test('validatePortfolio flags mismatched totals, wrong prices and stale exports', () => {
  const s = statuses(base({
    today: '2025-05-01',
    snapshots: [{ accountNumber: 'A', currency: 'EUR', asOf: '2025-03-10T18:00:00Z', value: 320, profit: 50 }],
    // pence/pound mix-up: 100× the XTB price
    priceAt: (t) => (t === 'STK.US' ? { date: '2025-03-10', close: 9900, currency: 'GBp' } : null),
    currentValueCzk: 10_000,
    missingRates: 2,
    incompleteAccounts: ['A'],
  }));
  assert.equal(s['Pozice nesedí se souhrnem XTB'], 'warn');
  assert.equal(s['Nákupní ceny nesedí s XTB'], 'warn');
  assert.equal(s['Stažené ceny nesedí s XTB'], 'warn');
  assert.equal(s['Bez stažené ceny ke dni výpisu'], 'info');
  assert.equal(s['Starý výpis'], 'warn');
  assert.equal(s['Velká změna hodnoty od výpisu'], 'warn');
  assert.equal(s['Chybí kurzy ČNB'], 'warn');
  assert.equal(s['Neúplná historie účtu'], 'warn');
});

test('periodGaps merges overlapping and adjacent exports and reports only uncovered days', () => {
  const r = periodGaps([
    { from: '2024-06-01T00:00:00Z', to: '2024-12-31T12:00:00Z' },
    { from: '2022-12-31T23:00:00Z', to: '2023-12-31T22:00:00Z' }, // Prague 1 Jan 2023 – 31 Dec 2023
    { from: '2023-06-01T10:00:00Z', to: '2024-02-29T10:00:00Z' }, // overlaps the first one
    { from: '2025-01-01T10:00:00Z', to: '2025-03-01T10:00:00Z' }, // starts the day after the previous one ends
  ]);
  assert.deepEqual(r, { from: '2023-01-01', to: '2025-03-01', gaps: [{ from: '2024-03-01', to: '2024-05-31' }] });
});

test('export periods: XTB gaps warn per account, Trading 212 gaps are only a hint above 60 days', () => {
  const checks = validatePortfolio(base({
    exportPeriods: [
      { source: 'xtb', account: 'A', from: '2023-01-01T10:00:00Z', to: '2023-12-31T10:00:00Z' },
      { source: 'xtb', account: 'A', from: '2024-03-01T10:00:00Z', to: '2025-03-10T10:00:00Z' },
      { source: 'xtb', account: 'B', from: '2024-01-01T10:00:00Z', to: '2025-03-10T10:00:00Z' },
      { source: 't212', account: 'Trading 212', from: '2024-01-05T10:00:00Z', to: '2024-02-01T10:00:00Z' },
      { source: 't212', account: 'Trading 212', from: '2024-03-15T10:00:00Z', to: '2024-04-01T10:00:00Z' },
    ],
  }));
  const find = (t: string) => checks.find((c) => c.title === t);
  assert.equal(find('Mezera ve výpisech XTB (účet A)')?.status, 'warn');
  assert.match(find('Mezera ve výpisech XTB (účet A)')!.detail, /Chybí 1\. 1\. 2024 – 29\. 2\. 2024\./);
  assert.equal(find('Výpisy XTB navazují (účet B)')?.status, 'ok');
  assert.equal(find('Výpisy Trading 212 bez delších mezer')?.status, 'ok'); // 42 days without rows is normal

  const t212 = validatePortfolio(base({ exportPeriods: [
    { source: 't212', account: 'Trading 212', from: '2024-01-05T10:00:00Z', to: '2024-02-01T10:00:00Z' },
    { source: 't212', account: 'Trading 212', from: '2024-06-01T10:00:00Z', to: '2024-07-01T10:00:00Z' },
  ] })).find((c) => c.title === 'Možná mezera ve výpisech Trading 212');
  assert.equal(t212?.status, 'info');
  assert.match(t212!.detail, /2\. 2\. 2024 – 31\. 5\. 2024/);
});
