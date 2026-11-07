import type { Db } from '../db/database.ts';

export type ValueSource = 'cash-operation' | 'xtb-column' | 'price';

export interface ClosedLot {
  accountNumber: string;
  currency: string;
  positionId: string;
  ticker: string;
  volume: number;
  openPrice: number;
  openTime: string;
  closePrice: number;
  closeTime: string;
  /** Purchase cost of this lot in account currency. */
  cost: number;
  costSource: ValueSource;
  /** Sale proceeds of this lot in account currency. */
  proceeds: number;
  proceedsSource: ValueSource;
  xtbProfit: number;
}

export interface OpenLot {
  accountNumber: string;
  currency: string;
  positionId: string;
  ticker: string;
  volume: number;
  openPrice: number;
  openTime: string;
  cost: number;
  costSource: ValueSource | 'xtb-profit';
  currentPrice: number | null;
  /** Market value in account currency as of the snapshot. */
  value: number | null;
}

export interface LoadedLots {
  closed: ClosedLot[];
  open: OpenLot[];
  snapshotAsOf: string | null;
  warnings: string[];
}

const QTY_EPS = 1e-9;
const SELL_MATCH_WINDOW_MS = 60_000;

export function loadLots(db: Db): LoadedLots {
  const warnings: string[] = [];
  const currencies = new Map<string, string>();
  for (const a of db.prepare('SELECT account_number, currency FROM accounts').all() as {
    account_number: string;
    currency: string | null;
  }[]) {
    if (!a.currency) warnings.push(`Účet ${a.account_number}: neznámá měna účtu – částky nelze převést.`);
    currencies.set(a.account_number, a.currency ?? '???');
  }
  const currencyOf = (acc: string): string => currencies.get(acc) ?? '???';

  // Purchase cost per unit from actual cash movements (account currency).
  const purchases = new Map<string, { amount: number; qty: number }>();
  for (const p of db
    .prepare(
      `SELECT account_number, position_id, amount, trade_qty FROM cash_operations
       WHERE trade_action = 'OPEN' AND position_id IS NOT NULL AND trade_qty > 0`,
    )
    .all() as { account_number: string; position_id: string; amount: number; trade_qty: number }[]) {
    const key = `${p.account_number}|${p.position_id}`;
    const prev = purchases.get(key) ?? { amount: 0, qty: 0 };
    purchases.set(key, { amount: prev.amount + Math.abs(p.amount), qty: prev.qty + p.trade_qty });
  }
  const unitCost = (acc: string, pos: string): number | null => {
    const p = purchases.get(`${acc}|${pos}`);
    return p && p.qty > 0 ? p.amount / p.qty : null;
  };

  const sells = db
    .prepare(
      `SELECT op_id, account_number, position_id, time_utc, amount, trade_qty FROM cash_operations
       WHERE trade_action = 'CLOSE' AND position_id IS NOT NULL`,
    )
    .all() as { op_id: string; account_number: string; position_id: string; time_utc: string; amount: number; trade_qty: number }[];
  const usedSells = new Set<string>();
  const findSell = (acc: string, pos: string, volume: number, closeTime: string): number | null => {
    const t = Date.parse(closeTime);
    let best: (typeof sells)[number] | undefined;
    let bestDiff = Infinity;
    for (const s of sells) {
      if (usedSells.has(s.op_id) || s.account_number !== acc || s.position_id !== pos) continue;
      if (Math.abs(s.trade_qty - volume) > QTY_EPS) continue;
      const diff = Math.abs(Date.parse(s.time_utc) - t);
      if (diff <= SELL_MATCH_WINDOW_MS && diff < bestDiff) {
        best = s;
        bestDiff = diff;
      }
    }
    if (!best) return null;
    usedSells.add(best.op_id);
    return best.amount;
  };

  const closedRows = db
    .prepare(
      `SELECT account_number, position_id, ticker, volume, open_price, open_time, close_price, close_time,
              purchase_value, sale_value, profit, open_conversion_rate, close_conversion_rate
       FROM closed_lots ORDER BY close_time, position_id`,
    )
    .all() as {
    account_number: string;
    position_id: string;
    ticker: string;
    volume: number;
    open_price: number;
    open_time: string;
    close_price: number;
    close_time: string;
    purchase_value: number | null;
    sale_value: number | null;
    profit: number;
    open_conversion_rate: number | null;
    close_conversion_rate: number | null;
  }[];

  const closed: ClosedLot[] = closedRows.map((r) => {
    let cost: number;
    let costSource: ValueSource;
    const uc = unitCost(r.account_number, r.position_id);
    if (uc != null) [cost, costSource] = [uc * r.volume, 'cash-operation'];
    else if (r.purchase_value != null && r.purchase_value > 0) [cost, costSource] = [r.purchase_value, 'xtb-column'];
    else [cost, costSource] = [r.volume * r.open_price * (r.open_conversion_rate ?? 1), 'price'];

    let proceeds: number;
    let proceedsSource: ValueSource;
    const sold = findSell(r.account_number, r.position_id, r.volume, r.close_time);
    if (sold != null) [proceeds, proceedsSource] = [sold, 'cash-operation'];
    else if (r.sale_value != null && r.sale_value > 0) [proceeds, proceedsSource] = [r.sale_value, 'xtb-column'];
    else [proceeds, proceedsSource] = [r.volume * r.close_price * (r.close_conversion_rate ?? 1), 'price'];

    const computed = proceeds - cost;
    if (Math.abs(computed - r.profit) > Math.max(0.05, cost * 0.005)) {
      warnings.push(
        `${r.ticker} lot ${r.position_id} (prodej ${r.close_time.slice(0, 10)}): vypočtený zisk ${computed.toFixed(2)} ` +
          `nesedí se ziskem XTB ${r.profit.toFixed(2)} (nákup: ${costSource}, prodej: ${proceedsSource}).`,
      );
    }
    return {
      accountNumber: r.account_number,
      currency: currencyOf(r.account_number),
      positionId: r.position_id,
      ticker: r.ticker,
      volume: r.volume,
      openPrice: r.open_price,
      openTime: r.open_time,
      closePrice: r.close_price,
      closeTime: r.close_time,
      cost,
      costSource,
      proceeds,
      proceedsSource,
      xtbProfit: r.profit,
    };
  });

  const openRows = db
    .prepare(
      `SELECT account_number, position_id, ticker, volume, open_price, open_time, current_price, value, gross_profit,
              purchase_value
       FROM open_lots ORDER BY open_time, position_id`,
    )
    .all() as {
    account_number: string;
    position_id: string;
    ticker: string;
    volume: number;
    open_price: number;
    open_time: string;
    current_price: number | null;
    value: number | null;
    gross_profit: number | null;
    purchase_value: number | null;
  }[];

  const open: OpenLot[] = openRows.map((r) => {
    let cost: number;
    let costSource: OpenLot['costSource'];
    const uc = unitCost(r.account_number, r.position_id);
    if (uc != null) [cost, costSource] = [uc * r.volume, 'cash-operation'];
    else if (r.purchase_value != null && r.purchase_value > 0) [cost, costSource] = [r.purchase_value, 'xtb-column'];
    else if (r.value != null && r.gross_profit != null) [cost, costSource] = [r.value - r.gross_profit, 'xtb-profit'];
    else [cost, costSource] = [r.volume * r.open_price, 'price'];
    return {
      accountNumber: r.account_number,
      currency: currencyOf(r.account_number),
      positionId: r.position_id,
      ticker: r.ticker,
      volume: r.volume,
      openPrice: r.open_price,
      openTime: r.open_time,
      cost,
      costSource,
      currentPrice: r.current_price,
      value: r.value,
    };
  });

  const snap = db.prepare('SELECT MIN(as_of) as_of FROM open_snapshots').get() as { as_of: string | null };
  return { closed, open, snapshotAsOf: snap.as_of, warnings };
}
