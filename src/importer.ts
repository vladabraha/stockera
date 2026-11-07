import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { transaction, type Db } from './db/database.ts';
import { readWorkbook } from './xlsx/reader.ts';
import { detectExportKind, parseAccountHistory, type AccountHistory } from './xtb/accountHistory.ts';

export interface ImportReport {
  file: string;
  status: 'imported' | 'already-imported' | 'unsupported';
  accountNumber?: string;
  currency?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  cash: { inserted: number; duplicates: number };
  closed: { inserted: number; duplicates: number };
  openPositions: 'replaced' | 'older-than-stored' | 'none';
  warnings: string[];
}

const emptyReport = (file: string, status: ImportReport['status'], warnings: string[] = []): ImportReport => ({
  file,
  status,
  cash: { inserted: 0, duplicates: 0 },
  closed: { inserted: 0, duplicates: 0 },
  openPositions: 'none',
  warnings,
});

export function importFile(db: Db, path: string): ImportReport {
  const buf = readFileSync(path);
  return importBuffer(db, basename(path), buf);
}

export function importBuffer(db: Db, fileName: string, buf: Buffer): ImportReport {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const prior = db.prepare('SELECT id FROM imports WHERE file_sha256 = ?').get(sha256) as { id: number } | undefined;
  if (prior) {
    // Same file again: its records are already in the DB – report how many came from it.
    const r = emptyReport(fileName, 'already-imported');
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE import_id = ?`).get(prior.id) as { n: number }).n;
    r.cash.duplicates = count('cash_operations');
    r.closed.duplicates = count('closed_lots');
    return r;
  }

  const sheets = readWorkbook(buf);
  const kind = detectExportKind(sheets);
  if (kind === 'fiscal-report') {
    return emptyReport(fileName, 'unsupported', [
      'Roční daňový výpis (Fiscal Report) zatím není podporován – použij export historie účtu z xStation.',
    ]);
  }
  if (kind === 'unknown') {
    return emptyReport(fileName, 'unsupported', ['Neznámý formát souboru – nejde o export historie účtu XTB.']);
  }

  const history = parseAccountHistory(sheets);
  return transaction(db, () => store(db, fileName, sha256, history));
}

function store(db: Db, fileName: string, sha256: string, h: AccountHistory): ImportReport {
  const report = emptyReport(fileName, 'imported', [...h.warnings]);
  report.accountNumber = h.accountNumber;
  report.currency = h.currency;
  report.periodFrom = h.periodFrom;
  report.periodTo = h.periodTo;

  const existing = db.prepare('SELECT currency FROM accounts WHERE account_number = ?').get(h.accountNumber) as
    | { currency: string | null }
    | undefined;
  if (existing?.currency && h.currency && existing.currency !== h.currency) {
    throw new Error(`Účet ${h.accountNumber} má v DB měnu ${existing.currency}, ale soubor uvádí ${h.currency}.`);
  }
  db.prepare(
    `INSERT INTO accounts (account_number, currency) VALUES (?, ?)
     ON CONFLICT(account_number) DO UPDATE SET currency = COALESCE(accounts.currency, excluded.currency)`,
  ).run(h.accountNumber, h.currency);

  const upsertInstrument = db.prepare(
    `INSERT INTO instruments (ticker, name, category) VALUES (?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET name = COALESCE(excluded.name, instruments.name),
                                       category = COALESCE(excluded.category, instruments.category)`,
  );
  for (const i of h.instruments) upsertInstrument.run(i.ticker, i.name, i.category);

  const importId = Number(
    db
      .prepare(
        `INSERT INTO imports (file_name, file_sha256, account_number, period_from, period_to, imported_at, warnings)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fileName, sha256, h.accountNumber, h.periodFrom, h.periodTo, new Date().toISOString(), JSON.stringify(h.warnings))
      .lastInsertRowid,
  );

  const insertCash = db.prepare(
    `INSERT INTO cash_operations (op_id, account_number, type, ticker, time_utc, amount, comment, position_id,
       trade_action, trade_side, trade_qty, trade_qty_total, trade_price, import_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(op_id) DO NOTHING`,
  );
  for (const op of h.cashOperations) {
    const { changes } = insertCash.run(
      op.id, h.accountNumber, op.type, op.ticker, op.time, op.amount, op.comment, op.positionId,
      op.trade?.action ?? null, op.trade?.side ?? null, op.trade?.quantity ?? null,
      op.trade?.totalQuantity ?? null, op.trade?.price ?? null, importId,
    );
    if (changes) report.cash.inserted++;
    else report.cash.duplicates++;
  }

  const insertClosed = db.prepare(
    `INSERT INTO closed_lots (account_number, position_id, ticker, type, volume, open_price, open_time, close_price,
       close_time, purchase_value, sale_value, gross_profit, profit, commission, swap, rollover,
       open_conversion_rate, close_conversion_rate, import_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_number, position_id, close_time, volume) DO NOTHING`,
  );
  for (const p of h.closedPositions) {
    const { changes } = insertClosed.run(
      h.accountNumber, p.positionId, p.ticker, p.type, p.volume, p.openPrice, p.openTime, p.closePrice, p.closeTime,
      p.purchaseValue, p.saleValue, p.grossProfit, p.profit, p.commission, p.swap, p.rollover,
      p.openConversionRate, p.closeConversionRate, importId,
    );
    if (changes) report.closed.inserted++;
    else report.closed.duplicates++;
  }

  if (h.openPositions) {
    const stored = db.prepare('SELECT as_of FROM open_snapshots WHERE account_number = ?').get(h.accountNumber) as
      | { as_of: string }
      | undefined;
    if (stored && stored.as_of >= h.openPositions.asOf) {
      report.openPositions = 'older-than-stored';
    } else {
      const s = h.openPositions;
      db.prepare('DELETE FROM open_lots WHERE account_number = ?').run(h.accountNumber);
      db.prepare(
        `INSERT INTO open_snapshots (account_number, as_of, value, profit, import_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_number) DO UPDATE SET as_of = excluded.as_of, value = excluded.value,
           profit = excluded.profit, import_id = excluded.import_id`,
      ).run(h.accountNumber, s.asOf, s.value, s.profit, importId);
      const insertLot = db.prepare(
        `INSERT INTO open_lots (account_number, position_id, ticker, type, volume, open_price, open_time,
           current_price, value, gross_profit, net_profit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of s.lots) {
        insertLot.run(
          h.accountNumber, l.positionId, l.ticker, l.type, l.volume, l.openPrice, l.openTime,
          l.currentPrice, l.value, l.grossProfit, l.netProfit,
        );
      }
      report.openPositions = 'replaced';
    }
  }

  return report;
}
