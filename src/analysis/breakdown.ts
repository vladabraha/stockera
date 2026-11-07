// Pure helper shared by the analysis and the report frontend (bundled into the HTML by build.ts) – no runtime imports.
import type { Totals } from './fx.ts';

export type Slice = { key: string; czk: number | null; eur: number | null; native: Record<string, number>; share: number };

/** Splits holding values by percentage weights; holdings without weights go to `??`. Sorted by share. */
export function breakdown(holdings: { value: Totals; weights: { key: string; weight: number }[] }[]): Slice[] {
  const slices = new Map<string, Slice>();
  const add = (key: string, t: Totals, f: number) => {
    let s = slices.get(key);
    if (!s) slices.set(key, (s = { key, czk: 0, eur: 0, native: {}, share: 0 }));
    s.czk = s.czk == null || t.czk == null ? null : s.czk + t.czk * f;
    s.eur = s.eur == null || t.eur == null ? null : s.eur + t.eur * f;
    for (const [c, v] of Object.entries(t.native)) s.native[c] = (s.native[c] ?? 0) + v * f;
  };
  for (const h of holdings) {
    const sum = h.weights.reduce((a, c) => a + c.weight, 0);
    if (sum <= 0) add('??', h.value, 1);
    else for (const c of h.weights) add(c.key, h.value, c.weight / sum);
  }
  const all = [...slices.values()];
  const measure = (s: Slice) => s.czk ?? Object.values(s.native).reduce((a, v) => a + v, 0);
  const total = all.reduce((a, s) => a + measure(s), 0);
  for (const s of all) s.share = total ? (measure(s) / total) * 100 : 0;
  return all.sort((a, b) => b.share - a.share);
}

export type Constituent = {
  /** ISIN, or the XTB ticker for a stock without a known ISIN. */
  key: string;
  name: string;
  czk: number | null;
  eur: number | null;
  native: Record<string, number>;
  /** % of the whole portfolio. */
  share: number;
  /** Where the exposure comes from: an ETF ticker or the stock itself, each in % of the whole portfolio. */
  via: { ticker: string; share: number }[];
};
export type LookThrough = {
  items: Constituent[];
  /** % of the portfolio covered by the known positions (all, not only the listed items). */
  coveredShare: number;
  /** ETFs held without known positions. */
  missing: string[];
};

/**
 * Splits ETFs into their largest known positions and sums the same stock (by ISIN) across ETFs and direct holdings.
 * The rest of each ETF (smaller positions the source does not list) stays uncovered.
 */
export function lookThrough(
  holdings: { ticker: string; name: string | null; isin: string | null; category: string | null; value: Totals; topHoldings?: { isin: string; name: string; weight: number }[] }[],
  limit = 100,
): LookThrough {
  const items = new Map<string, Constituent>();
  const missing: string[] = [];
  const add = (key: string, name: string, ticker: string, t: Totals, f: number, preferName: boolean) => {
    let c = items.get(key);
    if (!c) items.set(key, (c = { key, name, czk: 0, eur: 0, native: {}, share: 0, via: [] }));
    else if (preferName) c.name = name;
    c.czk = c.czk == null || t.czk == null ? null : c.czk + t.czk * f;
    c.eur = c.eur == null || t.eur == null ? null : c.eur + t.eur * f;
    for (const [cur, v] of Object.entries(t.native)) c.native[cur] = (c.native[cur] ?? 0) + v * f;
    c.via.push({ ticker, share: f });
  };
  for (const h of holdings) {
    if (h.category === 'ETF') {
      if (!h.topHoldings?.length) missing.push(h.ticker);
      for (const p of h.topHoldings ?? []) add(p.isin, p.name, h.ticker, h.value, p.weight / 100, false);
    } else add(h.isin ?? h.ticker, h.name ?? h.ticker, h.ticker, h.value, 1, true);
  }
  const measure = (t: { czk: number | null; native: Record<string, number> }) => t.czk ?? Object.values(t.native).reduce((a, v) => a + v, 0);
  const total = holdings.reduce((a, h) => a + measure(h.value), 0);
  const value = new Map(holdings.map((h) => [h.ticker, measure(h.value)]));
  const all = [...items.values()];
  for (const c of all) {
    c.share = total ? (measure(c) / total) * 100 : 0;
    c.via = c.via.map((v) => ({ ticker: v.ticker, share: total ? ((value.get(v.ticker) ?? 0) * v.share / total) * 100 : 0 })).sort((a, b) => b.share - a.share);
  }
  all.sort((a, b) => b.share - a.share);
  return { items: all.slice(0, limit), coveredShare: all.reduce((a, c) => a + c.share, 0), missing };
}
