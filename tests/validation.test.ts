import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePortfolio, type ValidationInput } from '../src/analysis/validation.ts';
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
