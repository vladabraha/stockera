import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Db } from '../src/db/database.ts';
import { importBuffer } from '../src/importer.ts';
import { buildXlsx } from './helpers/xlsxBuilder.ts';
import { fakeXtbExport, type FakeCash, type FakeExport } from './helpers/fakeXtb.ts';

const deposit = (id: string, time: string): FakeCash => ({ id, type: 'Deposit', time, amount: 100 });

const base: FakeExport = {
  cash: [deposit('1', '2024-01-05T08:00:00Z'), deposit('2', '2024-02-05T08:00:00Z')],
  closed: [
    { ticker: 'AAA.DE', volume: 1, openPrice: 10, openTime: '2024-01-10T09:00:00Z', closePrice: 12,
      closeTime: '2024-03-01T10:00:00Z', profit: 2, positionId: '500' },
  ],
  openAsOf: '2025-01-15T10:00:00Z',
  open: [{ ticker: 'BBB.DE', name: 'B', positionId: '600', volume: 2, openPrice: 50, openTime: '2024-02-01T09:00:00Z',
    currentPrice: 55 }],
};

const count = (db: Db, table: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

test('imports an account history export', () => {
  const db = openDatabase(':memory:');
  const r = importBuffer(db, 'a.xlsx', fakeXtbExport(base));
  assert.equal(r.status, 'imported');
  assert.deepEqual([r.cash, r.closed, r.openPositions], [
    { inserted: 2, duplicates: 0 },
    { inserted: 1, duplicates: 0 },
    'replaced',
  ]);
  assert.deepEqual({ ...db.prepare('SELECT account_number, currency FROM accounts').get() }, {
    account_number: '11111111',
    currency: 'EUR',
  });
  assert.equal(count(db, 'open_lots'), 1);
});

test('re-importing the same file is a no-op', () => {
  const db = openDatabase(':memory:');
  const buf = fakeXtbExport(base);
  importBuffer(db, 'a.xlsx', buf);
  const r = importBuffer(db, 'a-copy.xlsx', buf);
  assert.equal(r.status, 'already-imported');
  assert.deepEqual(r.cash, { inserted: 0, duplicates: 2 });
  assert.equal(count(db, 'cash_operations'), 2);
  assert.equal(count(db, 'imports'), 1);
});

test('overlapping exports do not create duplicates', () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport(base));
  const r = importBuffer(
    db,
    'b.xlsx',
    fakeXtbExport({ ...base, cash: [...base.cash!, deposit('3', '2024-03-05T08:00:00Z')], openAsOf: '2025-02-01T10:00:00Z' }),
  );
  assert.deepEqual(r.cash, { inserted: 1, duplicates: 2 });
  assert.deepEqual(r.closed, { inserted: 0, duplicates: 1 });
  assert.equal(count(db, 'cash_operations'), 3);
  assert.equal(count(db, 'closed_lots'), 1);
});

test('open positions are replaced only by a newer snapshot', () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'new.xlsx', fakeXtbExport({ ...base, openAsOf: '2025-06-01T00:00:00Z' }));
  const older = importBuffer(
    db,
    'old.xlsx',
    fakeXtbExport({ ...base, cash: [deposit('9', '2024-01-01T00:00:00Z')], openAsOf: '2025-01-01T00:00:00Z', open: [] }),
  );
  assert.equal(older.openPositions, 'older-than-stored');
  assert.equal(count(db, 'open_lots'), 1);

  const newer = importBuffer(
    db,
    'newer.xlsx',
    fakeXtbExport({ ...base, cash: [deposit('10', '2024-01-01T00:00:00Z')], openAsOf: '2025-07-01T00:00:00Z', open: [] }),
  );
  assert.equal(newer.openPositions, 'replaced');
  assert.equal(count(db, 'open_lots'), 0);
});

test('currency conflict aborts the import without partial writes', () => {
  const db = openDatabase(':memory:');
  importBuffer(db, 'eur.xlsx', fakeXtbExport(base));
  assert.throws(
    () => importBuffer(db, 'czk.xlsx', fakeXtbExport({ ...base, currency: 'CZK', cash: [deposit('77', '2024-05-01T00:00:00Z')] })),
    /měnu EUR/,
  );
  assert.equal(count(db, 'imports'), 1);
  assert.equal(count(db, 'cash_operations'), 2);
});

test('fiscal reports are skipped as unsupported', () => {
  const db = openDatabase(':memory:');
  const fiscal = buildXlsx([{ name: 'List1', rows: [[null, null, 'Fiscal Report: 2024/01/01 - 2024/12/31']] }]);
  const r = importBuffer(db, 'fiscal.xlsx', fiscal);
  assert.equal(r.status, 'unsupported');
  assert.equal(count(db, 'imports'), 0);
});
