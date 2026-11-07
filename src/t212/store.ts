import type { Db } from '../db/database.ts';
import { T212_PREFIX, buildT212Ledger, isFundName, t212Account, t212Ticker, type Ledger, type T212Export, type T212Row } from './history.ts';

/** Stores raw rows of one export; rows already known from an overlapping export are skipped. */
export function storeT212Rows(db: Db, exp: T212Export, importId: number): { inserted: number; duplicates: number } {
  const insert = db.prepare(
    `INSERT INTO t212_rows (account_number, row_key, action, time_utc, isin, t212_ticker, name, shares, price, price_currency,
       exchange_rate, total, currency, wht, wht_currency, import_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_number, row_key) DO NOTHING`,
  );
  let inserted = 0;
  for (const r of exp.rows) {
    const { changes } = insert.run(
      t212Account(r.currency), r.key, r.action, r.time, r.isin, r.ticker, r.name, r.shares, r.price, r.priceCurrency,
      r.exchangeRate, r.total, r.currency, r.withholdingTax, r.withholdingCurrency, importId,
    );
    inserted += Number(changes);
  }
  return { inserted, duplicates: exp.rows.length - inserted };
}

interface StoredRow extends T212Row {
  importId: number;
}

function loadRows(db: Db): StoredRow[] {
  return (db.prepare('SELECT * FROM t212_rows').all() as Record<string, string | number | null>[]).map((r) => ({
    key: r.row_key as string,
    action: r.action as string,
    time: r.time_utc as string,
    isin: r.isin as string | null,
    ticker: r.t212_ticker as string | null,
    name: r.name as string | null,
    shares: r.shares as number | null,
    price: r.price as number | null,
    priceCurrency: r.price_currency as string | null,
    exchangeRate: r.exchange_rate as number | null,
    total: r.total as number | null,
    currency: r.currency as string,
    withholdingTax: r.wht as number | null,
    withholdingCurrency: r.wht_currency as string | null,
    importId: r.import_id as number,
  }));
}

/**
 * One app ticker per instrument (ISIN): an instrument already known from XTB keeps its XTB ticker, so both brokers'
 * lots end up in one holding; otherwise a ticker is derived from the T212 symbol and price currency.
 */
function tickerResolver(db: Db): { tickerOf: (r: T212Row) => string; resolved: Map<string, { ticker: string; row: T212Row }> } {
  const xtb = new Set(
    (db.prepare(
      `SELECT ticker FROM closed_lots WHERE account_number NOT LIKE '${T212_PREFIX}%'
       UNION SELECT ticker FROM open_lots WHERE account_number NOT LIKE '${T212_PREFIX}%'`,
    ).all() as { ticker: string }[]).map((r) => r.ticker),
  );
  const byIsin = new Map<string, string>();
  for (const r of db.prepare(
    `SELECT ticker, isin FROM instrument_meta WHERE isin IS NOT NULL UNION SELECT ticker, isin FROM instruments WHERE isin IS NOT NULL
     ORDER BY ticker`,
  ).all() as { ticker: string; isin: string }[]) {
    if (xtb.has(r.ticker) && !byIsin.has(r.isin)) byIsin.set(r.isin, r.ticker);
  }
  const resolved = new Map<string, { ticker: string; row: T212Row }>();
  const tickerOf = (r: T212Row): string => {
    const id = r.isin ?? r.ticker ?? '?';
    let hit = resolved.get(id);
    if (!hit) resolved.set(id, (hit = { ticker: (r.isin && byIsin.get(r.isin)) || t212Ticker(r), row: r }));
    return hit.ticker;
  };
  return { tickerOf, resolved };
}

/** Problems found while pairing T212 trades (e.g. a sale without a purchase), for the data check in the report. */
export function t212Warnings(db: Db): string[] {
  const rows = loadRows(db);
  return rows.length ? buildT212Ledger(rows, tickerResolver(db).tickerOf).warnings : [];
}

/**
 * Replaces lots and cash operations of all T212 accounts with ones derived from the stored rows.
 * Idempotent; run after each T212 import and after market data brought ISINs of XTB instruments.
 */
export function rebuildT212(db: Db): Ledger | null {
  const rows = loadRows(db);
  if (!rows.length) return null;
  const { tickerOf, resolved } = tickerResolver(db);
  const ledger = buildT212Ledger(rows, tickerOf);
  const importOf = new Map(rows.map((r) => [r.key, r.importId]));

  for (const table of ['cash_operations', 'closed_lots', 'open_lots']) {
    db.prepare(`DELETE FROM ${table} WHERE account_number LIKE '${T212_PREFIX}%'`).run();
  }
  const upsertInstrument = db.prepare(
    `INSERT INTO instruments (ticker, name, category, isin) VALUES (?, ?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET name = COALESCE(instruments.name, excluded.name),
       category = COALESCE(instruments.category, excluded.category), isin = COALESCE(instruments.isin, excluded.isin)`,
  );
  for (const { ticker, row } of resolved.values()) {
    upsertInstrument.run(ticker, row.name, isFundName(row.name) ? 'ETF' : 'STOCK', row.isin);
  }

  const insertCash = db.prepare(
    `INSERT INTO cash_operations (op_id, account_number, type, ticker, time_utc, amount, comment, import_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of ledger.cash) {
    insertCash.run(c.id, c.account, c.type, c.ticker, c.time, c.amount, c.comment, importOf.get(c.sourceKey)!);
  }
  const insertClosed = db.prepare(
    `INSERT INTO closed_lots (account_number, position_id, ticker, type, volume, open_price, open_time, close_price,
       close_time, purchase_value, sale_value, gross_profit, profit, import_id)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of ledger.closed) {
    const profit = l.saleValue - l.purchaseValue;
    insertClosed.run(
      l.account, l.positionId, l.ticker, l.volume, l.openPrice, l.openTime, l.closePrice, l.closeTime,
      l.purchaseValue, l.saleValue, profit, profit, importOf.get(l.sourceKey)!,
    );
  }
  const insertOpen = db.prepare(
    `INSERT INTO open_lots (account_number, position_id, ticker, type, volume, open_price, open_time, purchase_value)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?)`,
  );
  for (const l of ledger.open) {
    insertOpen.run(l.account, l.positionId, l.ticker, l.volume, l.openPrice, l.openTime, l.purchaseValue);
  }
  return ledger;
}
