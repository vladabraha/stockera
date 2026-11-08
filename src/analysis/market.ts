import type { Db } from '../db/database.ts';
import { addDays } from './calendar.ts';
import { breakdown } from './breakdown.ts';
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
  /** Sector weights in % (keys see SECTORS in market/sources.ts, `other` = rest). */
  sectors: { sector: string; weight: number }[];
  /** ETF only: largest positions in % of the fund. */
  topHoldings: { isin: string; name: string; weight: number }[];
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
    const sectors = new Map<string, { sector: string; weight: number }[]>();
    for (const w of db.prepare('SELECT ticker, sector, weight FROM sector_weights ORDER BY weight DESC').all() as { ticker: string; sector: string; weight: number }[]) {
      sectors.set(w.ticker, [...(sectors.get(w.ticker) ?? []), { sector: w.sector, weight: w.weight }]);
    }
    const top = new Map<string, { isin: string; name: string; weight: number }[]>();
    for (const w of db.prepare('SELECT ticker, isin, name, weight FROM fund_holdings ORDER BY weight DESC').all() as { ticker: string; isin: string; name: string; weight: number }[]) {
      top.set(w.ticker, [...(top.get(w.ticker) ?? []), { isin: w.isin, name: w.name, weight: w.weight }]);
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
        sectors: sectors.get(m.ticker) ?? [],
        topHoldings: top.get(m.ticker) ?? [],
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
    return this.infos.get(ticker) ?? { isin: null, priceSource: null, priceCurrency: null, countrySource: null, countries: [], sectors: [], topHoldings: [] };
  }
}

export const emptyMarket: MarketData = {
  price: () => null,
  series: () => [],
  info: () => ({ isin: null, priceSource: null, priceCurrency: null, countrySource: null, countries: [], sectors: [], topHoldings: [] }),
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
  return breakdown(holdings.map((h) => ({ value: h.value, weights: h.countries.map((c) => ({ key: c.country, weight: c.weight })) })))
    .map(({ key, ...s }) => ({ country: key, ...s }));
}

export interface SectorSlice {
  /** Sector key; `other` = rest reported by the source, `??` = unknown composition. */
  sector: string;
  czk: number | null;
  eur: number | null;
  native: Record<string, number>;
  share: number;
}

/** Splits holding values by sector weights. */
export function sectorBreakdown(holdings: { value: Totals; sectors: { sector: string; weight: number }[] }[]): SectorSlice[] {
  return breakdown(holdings.map((h) => ({ value: h.value, weights: h.sectors.map((c) => ({ key: c.sector, weight: c.weight })) })))
    .map(({ key, ...s }) => ({ sector: key, ...s }));
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
    let valueEur = 0;
    let invested = 0;
    let investedEur = 0;
    let ok = true;
    for (const l of lots) {
      if (l.openDate > d || (l.closeDate != null && l.closeDate <= d)) continue;
      const p = market.price(l.ticker, d);
      // without a price the lot counts at its cost in CZK/EUR of the purchase day, exactly like the headline value
      const v = p ? crossConvert(fx, l.quantity * p.close, p.currency, 'CZK', d) : l.costCzk;
      if (v == null || l.costCzk == null || l.costEur == null) {
        ok = false;
        break;
      }
      value += v;
      valueEur += p ? v / eur : l.costEur;
      invested += l.costCzk;
      investedEur += l.costEur;
    }
    if (ok) points.push({ date: d, valueCzk: value, valueEur, investedCzk: invested, investedEur });
  }
  return points;
}
