import type { Db } from '../db/database.ts';
import { addDays } from './calendar.ts';
import type { FxRates, Totals } from './fx.ts';

/** Prices older than this are not used for a given day (holidays, gaps). */
const MAX_PRICE_AGE_DAYS = 10;

export interface PriceQuote {
  date: string;
  close: number;
  currency: string;
}

export interface InstrumentMarket {
  isin: string | null;
  priceSource: string | null;
  priceCurrency: string | null;
  countrySource: string | null;
  /** Country weights in % (ISO alpha-2, `XX` = other), sum ≈ 100. */
  countries: { country: string; weight: number }[];
}

/** Read access to downloaded market data (prices, countries, ISINs). */
export interface MarketData {
  price(ticker: string, date: string): PriceQuote | null;
  series(ticker: string): PriceQuote[];
  info(ticker: string): InstrumentMarket;
}

export class DbMarketData implements MarketData {
  private readonly prices = new Map<string, PriceQuote[]>();
  private readonly infos = new Map<string, InstrumentMarket>();

  constructor(db: Db) {
    for (const p of db.prepare('SELECT ticker, date, close, currency FROM prices ORDER BY ticker, date').all() as unknown as (PriceQuote & {
      ticker: string;
    })[]) {
      let arr = this.prices.get(p.ticker);
      if (!arr) this.prices.set(p.ticker, (arr = []));
      arr.push({ date: p.date, close: p.close, currency: p.currency });
    }
    const weights = new Map<string, { country: string; weight: number }[]>();
    for (const w of db.prepare('SELECT ticker, country, weight FROM country_weights ORDER BY weight DESC').all() as {
      ticker: string;
      country: string;
      weight: number;
    }[]) {
      weights.set(w.ticker, [...(weights.get(w.ticker) ?? []), { country: w.country, weight: w.weight }]);
    }
    for (const m of db.prepare('SELECT ticker, isin, price_source, price_currency, country_source FROM instrument_meta').all() as {
      ticker: string;
      isin: string | null;
      price_source: string | null;
      price_currency: string | null;
      country_source: string | null;
    }[]) {
      this.infos.set(m.ticker, {
        isin: m.isin,
        priceSource: m.price_source,
        priceCurrency: m.price_currency,
        countrySource: m.country_source,
        countries: weights.get(m.ticker) ?? [],
      });
    }
  }

  price(ticker: string, date: string): PriceQuote | null {
    const arr = this.prices.get(ticker);
    if (!arr?.length) return null;
    let lo = 0;
    let hi = arr.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.date <= date) [found, lo] = [mid, mid + 1];
      else hi = mid - 1;
    }
    const p = found >= 0 ? arr[found]! : null;
    return p && p.date >= addDays(date, -MAX_PRICE_AGE_DAYS) ? p : null;
  }

  series(ticker: string): PriceQuote[] {
    return this.prices.get(ticker) ?? [];
  }

  info(ticker: string): InstrumentMarket {
    return this.infos.get(ticker) ?? { isin: null, priceSource: null, priceCurrency: null, countrySource: null, countries: [] };
  }
}

export const emptyMarket: MarketData = {
  price: () => null,
  series: () => [],
  info: () => ({ isin: null, priceSource: null, priceCurrency: null, countrySource: null, countries: [] }),
};

/** Converts an amount between currencies through CZK rates of the given day. */
export function crossConvert(fx: FxRates, amount: number, from: string, to: string, date: string): number | null {
  if (from === to) return amount;
  const a = from === 'CZK' ? 1 : fx.czkPer(from, date);
  const b = to === 'CZK' ? 1 : fx.czkPer(to, date);
  return a == null || b == null ? null : (amount * a) / b;
}

export interface GeographySlice {
  /** ISO alpha-2; `XX` = other (as reported by the data source), `??` = unknown composition. */
  country: string;
  czk: number | null;
  eur: number | null;
  native: Record<string, number>;
  /** Share of the portfolio value in %. */
  share: number;
}

/** Splits holding values by country weights. */
export function geography(holdings: { value: Totals; countries: { country: string; weight: number }[] }[]): GeographySlice[] {
  const slices = new Map<string, GeographySlice>();
  const add = (country: string, t: Totals, f: number) => {
    let s = slices.get(country);
    if (!s) slices.set(country, (s = { country, czk: 0, eur: 0, native: {}, share: 0 }));
    s.czk = s.czk == null || t.czk == null ? null : s.czk + t.czk * f;
    s.eur = s.eur == null || t.eur == null ? null : s.eur + t.eur * f;
    for (const [c, v] of Object.entries(t.native)) s.native[c] = (s.native[c] ?? 0) + v * f;
  };
  for (const h of holdings) {
    const sum = h.countries.reduce((a, c) => a + c.weight, 0);
    if (sum <= 0) add('??', h.value, 1);
    else for (const c of h.countries) add(c.country, h.value, c.weight / sum);
  }
  const all = [...slices.values()];
  const measure = (s: GeographySlice) => s.czk ?? Object.values(s.native).reduce((a, v) => a + v, 0);
  const total = all.reduce((a, s) => a + measure(s), 0);
  for (const s of all) s.share = total ? (measure(s) / total) * 100 : 0;
  return all.sort((a, b) => b.share - a.share);
}

export interface HistoryLot {
  ticker: string;
  quantity: number;
  openDate: string;
  /** Exclusive; null while still held. */
  closeDate: string | null;
  /** Purchase cost in account currency and its CZK value at the purchase-date rate. */
  costNative: number;
  costCzk: number | null;
  costEur: number | null;
  currency: string;
}

export interface HistoryPoint {
  date: string;
  valueCzk: number;
  valueEur: number;
  investedCzk: number;
  investedEur: number;
}

/**
 * Daily market value of the lots held on each day vs. their purchase cost.
 * Days with missing exchange rates are skipped; lots without a price are valued at cost.
 */
export function valueHistory(lots: HistoryLot[], market: MarketData, fx: FxRates, to: string): HistoryPoint[] {
  if (!lots.length) return [];
  const points: HistoryPoint[] = [];
  const from = lots.map((l) => l.openDate).sort()[0]!;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const eur = fx.czkPer('EUR', d);
    if (eur == null) continue;
    let value = 0;
    let invested = 0;
    let investedEur = 0;
    let ok = true;
    for (const l of lots) {
      if (l.openDate > d || (l.closeDate != null && l.closeDate <= d)) continue;
      const p = market.price(l.ticker, d);
      const v = p ? crossConvert(fx, l.quantity * p.close, p.currency, 'CZK', d) : crossConvert(fx, l.costNative, l.currency, 'CZK', d);
      if (v == null || l.costCzk == null || l.costEur == null) {
        ok = false;
        break;
      }
      value += v;
      invested += l.costCzk;
      investedEur += l.costEur;
    }
    if (ok) points.push({ date: d, valueCzk: value, valueEur: value / eur, investedCzk: invested, investedEur });
  }
  return points;
}
