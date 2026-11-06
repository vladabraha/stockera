import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkbook } from '../src/xlsx/reader.ts';
import {
  detectExportKind,
  parseAccountHistory,
  parseTradeComment,
  XtbFormatError,
} from '../src/xtb/accountHistory.ts';
import { buildXlsx } from './helpers/xlsxBuilder.ts';
import { fakeXtbSheets, type FakeExport } from './helpers/fakeXtb.ts';

const sample: FakeExport = {
  account: '11111111',
  currency: 'EUR',
  closed: [
    { ticker: 'AAA.DE', volume: 0.3, openPrice: 100, openTime: '2024-01-10T09:00:00Z', closePrice: 110,
      closeTime: '2024-03-01T10:00:00Z', profit: 3, positionId: '500' },
    { ticker: 'AAA.DE', volume: 0.4, openPrice: 100, openTime: '2024-01-10T09:00:00Z', closePrice: 111,
      closeTime: '2024-03-01T10:00:01Z', profit: 4.4, positionId: '500' },
  ],
  cash: [
    { id: '1', type: 'Deposit', time: '2024-01-05T08:00:00Z', amount: 1000, comment: 'deposit' },
    { id: '2', type: 'Stock purchase', ticker: 'AAA.DE', time: '2024-01-10T09:00:00Z', amount: -70,
      comment: 'OPEN BUY 0.7 @ 100.00', positionId: '500' },
    { id: '3', type: 'Stock sell', ticker: 'AAA.DE', time: '2024-03-01T10:00:00Z', amount: 33,
      comment: 'CLOSE BUY 0.3/0.7 @ 110.00', positionId: '500' },
  ],
  openAsOf: '2025-01-15T10:00:00Z',
  open: [
    { ticker: 'BBB.DE', name: 'B Fund', positionId: '600', volume: 2, openPrice: 50, openTime: '2024-02-01T09:00:00Z',
      currentPrice: 55 },
    { ticker: 'BBB.DE', name: 'B Fund', positionId: '601', volume: 1, openPrice: 52, openTime: '2024-06-01T09:00:00Z',
      currentPrice: 55 },
  ],
};

const parse = (e: FakeExport) => parseAccountHistory(readWorkbook(buildXlsx(fakeXtbSheets(e))));

test('parses account metadata', () => {
  const h = parse(sample);
  assert.equal(h.accountNumber, '11111111');
  assert.equal(h.currency, 'EUR');
  assert.equal(h.periodFrom, '2023-12-31T23:00:00.000Z');
  assert.equal(h.periodTo, '2024-12-31T23:00:00.000Z');
  assert.deepEqual(h.warnings, []);
});

test('parses closed lots, keeping partial closes of one position separate', () => {
  const h = parse(sample);
  assert.equal(h.closedPositions.length, 2);
  assert.deepEqual(
    h.closedPositions.map((p) => [p.positionId, p.volume, p.closeTime, p.profit]),
    [
      ['500', 0.3, '2024-03-01T10:00:00.000Z', 3],
      ['500', 0.4, '2024-03-01T10:00:01.000Z', 4.4],
    ],
  );
});

test('parses cash operations and trade comments', () => {
  const h = parse(sample);
  assert.equal(h.cashOperations.length, 3);
  const sell = h.cashOperations.find((o) => o.id === '3')!;
  assert.equal(sell.ticker, 'AAA.DE');
  assert.equal(sell.positionId, '500');
  assert.deepEqual(sell.trade, { action: 'CLOSE', side: 'BUY', quantity: 0.3, totalQuantity: 0.7, price: 110 });
  assert.equal(h.cashOperations.find((o) => o.id === '1')!.trade, null);
});

test('groups open lots under instrument summary rows', () => {
  const h = parse(sample);
  assert.equal(h.openPositions?.asOf, '2025-01-15T10:00:00.000Z');
  assert.deepEqual(
    h.openPositions?.lots.map((l) => [l.positionId, l.ticker, l.volume, l.openPrice]),
    [
      ['600', 'BBB.DE', 2, 50],
      ['601', 'BBB.DE', 1, 52],
    ],
  );
  assert.deepEqual(h.instruments.find((i) => i.ticker === 'BBB.DE'), { ticker: 'BBB.DE', name: 'B Fund', category: 'ETF' });
});

test('warns about unknown cash operation types', () => {
  const h = parse({ ...sample, cash: [{ id: '9', type: 'Corporate action', time: '2024-05-01T00:00:00Z', amount: 0 }] });
  assert.match(h.warnings.join('\n'), /Neznámé typy.*Corporate action/);
});

test('warns when totals do not match', () => {
  const sheets = fakeXtbSheets(sample);
  const cash = sheets.find((s) => s.name === 'Cash Operations')!;
  cash.rows[cash.rows.length - 1]![5] = 999;
  const h = parseAccountHistory(readWorkbook(buildXlsx(sheets)));
  assert.match(h.warnings.join('\n'), /nesedí s řádkem Total/);
});

test('fails loudly when a required column is missing (format change)', () => {
  const sheets = fakeXtbSheets(sample);
  const closed = sheets.find((s) => s.name === 'Closed Positions')!;
  closed.rows[4] = closed.rows[4]!.map((h) => (h === 'Open Price' ? 'Opening Price' : h));
  assert.throws(() => parseAccountHistory(readWorkbook(buildXlsx(sheets))), XtbFormatError);
});

test('fails when Cash Operations sheet is missing', () => {
  const sheets = fakeXtbSheets(sample).filter((s) => s.name !== 'Cash Operations');
  assert.throws(() => parseAccountHistory(readWorkbook(buildXlsx(sheets))), XtbFormatError);
});

test('detects export kinds', () => {
  assert.equal(detectExportKind(readWorkbook(buildXlsx(fakeXtbSheets(sample)))), 'account-history');
  const fiscal = buildXlsx([{ name: 'List1', rows: [[null, null, 'Fiscal Report: 2024/01/01 - 2024/12/31']] }]);
  assert.equal(detectExportKind(readWorkbook(fiscal)), 'fiscal-report');
  assert.equal(detectExportKind(readWorkbook(buildXlsx([{ name: 'X', rows: [['hello']] }]))), 'unknown');
});

test('parseTradeComment', () => {
  assert.deepEqual(parseTradeComment('OPEN BUY 3/4 @ 29.300'), {
    action: 'OPEN', side: 'BUY', quantity: 3, totalQuantity: 4, price: 29.3,
  });
  assert.deepEqual(parseTradeComment('OPEN BUY 9 @ 11.5100'), {
    action: 'OPEN', side: 'BUY', quantity: 9, totalQuantity: null, price: 11.51,
  });
  assert.equal(parseTradeComment('PayPal deposit, id=1'), null);
});
