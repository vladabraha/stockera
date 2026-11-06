import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    account_number TEXT PRIMARY KEY,
    currency       TEXT
  );

  CREATE TABLE instruments (
    ticker   TEXT PRIMARY KEY,
    name     TEXT,
    category TEXT
  );

  CREATE TABLE imports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name      TEXT NOT NULL,
    file_sha256    TEXT NOT NULL UNIQUE,
    account_number TEXT NOT NULL REFERENCES accounts(account_number),
    period_from    TEXT,
    period_to      TEXT,
    imported_at    TEXT NOT NULL,
    warnings       TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE cash_operations (
    op_id          TEXT PRIMARY KEY,
    account_number TEXT NOT NULL REFERENCES accounts(account_number),
    type           TEXT NOT NULL,
    ticker         TEXT REFERENCES instruments(ticker),
    time_utc       TEXT NOT NULL,
    amount         REAL NOT NULL,
    comment        TEXT,
    position_id    TEXT,
    trade_action   TEXT,
    trade_side     TEXT,
    trade_qty      REAL,
    trade_qty_total REAL,
    trade_price    REAL,
    import_id      INTEGER NOT NULL REFERENCES imports(id)
  );
  CREATE INDEX cash_operations_ticker ON cash_operations(ticker, time_utc);

  CREATE TABLE closed_lots (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number        TEXT NOT NULL REFERENCES accounts(account_number),
    position_id           TEXT NOT NULL,
    ticker                TEXT NOT NULL REFERENCES instruments(ticker),
    type                  TEXT NOT NULL,
    volume                REAL NOT NULL,
    open_price            REAL NOT NULL,
    open_time             TEXT NOT NULL,
    close_price           REAL NOT NULL,
    close_time            TEXT NOT NULL,
    purchase_value        REAL,
    sale_value            REAL,
    gross_profit          REAL,
    profit                REAL NOT NULL,
    commission            REAL,
    swap                  REAL,
    rollover              REAL,
    open_conversion_rate  REAL,
    close_conversion_rate REAL,
    import_id             INTEGER NOT NULL REFERENCES imports(id),
    UNIQUE (account_number, position_id, close_time, volume)
  );
  CREATE INDEX closed_lots_ticker ON closed_lots(ticker, close_time);

  -- Latest known snapshot of open positions per account (replaced by newer exports only)
  CREATE TABLE open_snapshots (
    account_number TEXT PRIMARY KEY REFERENCES accounts(account_number),
    as_of          TEXT NOT NULL,
    value          REAL,
    profit         REAL,
    import_id      INTEGER NOT NULL REFERENCES imports(id)
  );

  CREATE TABLE open_lots (
    account_number TEXT NOT NULL REFERENCES accounts(account_number),
    position_id    TEXT NOT NULL,
    ticker         TEXT NOT NULL REFERENCES instruments(ticker),
    type           TEXT NOT NULL,
    volume         REAL NOT NULL,
    open_price     REAL NOT NULL,
    open_time      TEXT NOT NULL,
    current_price  REAL,
    value          REAL,
    gross_profit   REAL,
    net_profit     REAL,
    PRIMARY KEY (account_number, position_id)
  );
  `,
];

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
