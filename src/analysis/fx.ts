import type { StatementSync } from 'node:sqlite';
import type { Db } from '../db/database.ts';

/** Max age of a rate used for a given day (weekends/holidays use the last published fixing). */
const MAX_RATE_AGE_DAYS = 7;

export interface FxRates {
  /** CZK per 1 unit of `currency` valid on `date` (YYYY-MM-DD), or null if unknown. */
  czkPer(currency: string, date: string): number | null;
}

/** Amount in the account currency plus its CZK/EUR equivalents (null when a rate is missing). */
export interface Money {
  native: number;
  currency: string;
  czk: number | null;
  eur: number | null;
}

/** Sum of Money values: CZK/EUR are null if any component is missing; native is per currency. */
export interface Totals {
  czk: number | null;
  eur: number | null;
  native: Record<string, number>;
}

export class Converter {
  readonly missing = new Set<string>();
  private readonly fx: FxRates;

  constructor(fx: FxRates) {
    this.fx = fx;
  }

  private rate(currency: string, date: string): number | null {
    if (currency === 'CZK') return 1;
    const r = this.fx.czkPer(currency, date);
    if (r == null) this.missing.add(`${currency} ${date}`);
    return r;
  }

  money(native: number, currency: string, date: string): Money {
    const toCzk = this.rate(currency, date);
    const czk = toCzk == null ? null : native * toCzk;
    let eur: number | null;
    if (currency === 'EUR') eur = native;
    else {
      const eurRate = this.rate('EUR', date);
      eur = czk == null || eurRate == null ? null : czk / eurRate;
    }
    return { native, currency, czk, eur };
  }
}

export function sumMoney(items: Money[]): Totals {
  const t: Totals = { czk: 0, eur: 0, native: {} };
  for (const m of items) {
    t.czk = t.czk == null || m.czk == null ? null : t.czk + m.czk;
    t.eur = t.eur == null || m.eur == null ? null : t.eur + m.eur;
    t.native[m.currency] = (t.native[m.currency] ?? 0) + m.native;
  }
  return t;
}

export function subTotals(a: Totals, b: Totals): Totals {
  const native: Record<string, number> = { ...a.native };
  for (const [c, v] of Object.entries(b.native)) native[c] = (native[c] ?? 0) - v;
  return {
    czk: a.czk == null || b.czk == null ? null : a.czk - b.czk,
    eur: a.eur == null || b.eur == null ? null : a.eur - b.eur,
    native,
  };
}

/** Percentage change per display currency (null if not computable). */
export interface Percent {
  czk: number | null;
  eur: number | null;
  native: number | null;
}

export function percent(profit: Totals, cost: Totals): Percent {
  const p = (a: number | null | undefined, b: number | null | undefined): number | null =>
    a == null || b == null || b === 0 ? null : (a / b) * 100;
  const currencies = Object.keys(cost.native);
  const single = currencies.length === 1 ? currencies[0]! : null;
  return {
    czk: p(profit.czk, cost.czk),
    eur: p(profit.eur, cost.eur),
    native: single ? p(profit.native[single], cost.native[single]) : null,
  };
}

export class DbFxRates implements FxRates {
  private readonly stmt: StatementSync;

  constructor(db: Db) {
    this.stmt = db.prepare(
      `SELECT date, czk_per_unit FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
    );
  }

  czkPer(currency: string, date: string): number | null {
    const row = this.stmt.get(currency, date) as { date: string; czk_per_unit: number } | undefined;
    if (!row) return null;
    const age = (Date.parse(date) - Date.parse(row.date)) / 86_400_000;
    return age <= MAX_RATE_AGE_DAYS ? row.czk_per_unit : null;
  }
}
