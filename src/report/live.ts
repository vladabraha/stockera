// Live prices in the opened report. Bundled into the HTML (build.ts) and unit-tested in Node.
// Privacy: requests carry only ISINs and currency codes – never quantities, prices, values or account numbers.
import type { Analysis, Holding, HoldingLot } from '../analysis/portfolio.ts';
import type { Money, Percent, Totals } from '../analysis/fx.ts';
import { breakdown } from '../analysis/breakdown.ts';

export const LIVE_HOSTS = ['https://api.onvista.de', 'https://api.frankfurter.dev'] as const;

export interface LiveQuote {
  price: number;
  currency: string;
  /** YYYY-MM-DD (UTC day of the last trade). */
  date: string;
}

export interface LiveResult {
  analysis: Analysis;
  /** Tickers whose value was recalculated. */
  updated: string[];
  /** Newest quote date used, or null when nothing changed. */
  date: string | null;
}

/** Markets with stale or illiquid quotes (Lang & Schwarz listing, US pink sheets). */
const SKIP_MARKETS = new Set(['_LST', '_PNK']);
const EU_MARKETS = new Set(['_XET', '_GAT', '_FRA', '_STU', '_TRO', '_AMS']);
/** A live price this far from the stored one is a wrong market/unit, not a market move – keep the stored value. */
const MAX_JUMP = 0.5;
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;

export const liveFxUrl = (currencies: string[]) =>
  `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${currencies.filter((c) => /^[A-Z]{3}$/.test(c) && c !== 'EUR').sort().join(',')}`;
export const liveQuoteUrl = (isin: string, etf: boolean) =>
  `https://api.onvista.de/api/v1/${etf ? 'funds' : 'stocks'}/ISIN:${encodeURIComponent(isin)}/snapshot`;

/** CZK per unit from ECB rates with EUR base (`CZK` itself = 1). */
export function parseLiveFx(data: unknown): Record<string, number> {
  const rates = (data as { rates?: Record<string, unknown> } | null)?.rates ?? {};
  const czk = Number(rates.CZK);
  if (!(czk > 0)) throw new Error('Kurzy neobsahují CZK');
  const out: Record<string, number> = { CZK: 1, EUR: czk };
  for (const [c, r] of Object.entries(rates)) if (c !== 'CZK' && Number(r) > 0) out[c] = czk / Number(r);
  return out;
}

interface OnvistaQuote { last?: unknown; isoCurrency?: unknown; datetimeLast?: unknown; market?: { codeMarket?: unknown } }

function toQuote(q: OnvistaQuote | undefined): (LiveQuote & { market: string; time: string }) | null {
  const price = Number(q?.last);
  const time = typeof q?.datetimeLast === 'string' ? q.datetimeLast : '';
  const currency = typeof q?.isoCurrency === 'string' ? q.isoCurrency : '';
  if (!(price > 0) || !/^\d{4}-\d{2}-\d{2}/.test(time) || !/^[A-Z]{3}$/.test(currency)) return null;
  return { price, currency, date: time.slice(0, 10), time, market: String(q?.market?.codeMarket ?? '') };
}

/** ETF: the headline quote. Stock: newest quote in the instrument's currency, else newest major EU market in EUR. */
export function pickLiveQuote(data: unknown, etf: boolean, currency: string | null): LiveQuote | null {
  const d = data as { quote?: OnvistaQuote; quoteList?: { list?: OnvistaQuote[] } } | null;
  const strip = (q: ReturnType<typeof toQuote>): LiveQuote | null => (q ? { price: q.price, currency: q.currency, date: q.date } : null);
  if (etf) return strip(toQuote(d?.quote));
  const all = [...(d?.quoteList?.list ?? []), d?.quote].map(toQuote).filter((q) => q && !SKIP_MARKETS.has(q.market)) as NonNullable<ReturnType<typeof toQuote>>[];
  const newest = (qs: typeof all) => qs.sort((a, b) => b.time.localeCompare(a.time))[0] ?? null;
  return strip(newest(all.filter((q) => q.currency === currency)) ?? newest(all.filter((q) => q.currency === 'EUR' && EU_MARKETS.has(q.market))));
}

/** Instrument quote currency (the one XTB and the stored price series use). */
function instrumentCurrency(a: Analysis, x: Holding): string | null {
  return x.lots[0]?.currentPrice?.currency ?? a.instruments[x.ticker]?.currency ?? null;
}

/** Downloads rates and quotes; any failure just leaves that instrument (or everything) at the stored snapshot. */
export async function fetchLive(a: Analysis, fetchFn: typeof fetch = fetch): Promise<{ czkPer: Record<string, number>; quotes: Record<string, LiveQuote> }> {
  const get = async (url: string): Promise<unknown> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchFn(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const targets = a.holdings.filter((x) => x.isin).map((x) => ({ ticker: x.ticker, isin: x.isin!, etf: x.category === 'ETF', currency: instrumentCurrency(a, x) }));
  const currencies = new Set(['CZK', 'USD', 'GBP', 'CHF']);
  for (const x of a.holdings) for (const l of x.lots) currencies.add(l.cost.currency);
  for (const t of targets) if (t.currency) currencies.add(t.currency);

  const quotes: Record<string, LiveQuote> = {};
  const queue = [...targets];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const q = pickLiveQuote(await get(liveQuoteUrl(t.isin, t.etf)), t.etf, t.currency);
        if (q) quotes[t.ticker] = q;
      } catch { /* keep the stored value */ }
    }
  };
  const [fx] = await Promise.all([get(liveFxUrl([...currencies])), ...Array.from({ length: CONCURRENCY }, worker)]);
  return { czkPer: parseLiveFx(fx), quotes };
}

const sumT = (items: Totals[]): Totals => {
  const t: Totals = { czk: 0, eur: 0, native: {} };
  for (const m of items) {
    t.czk = t.czk == null || m.czk == null ? null : t.czk + m.czk;
    t.eur = t.eur == null || m.eur == null ? null : t.eur + m.eur;
    for (const [c, v] of Object.entries(m.native)) t.native[c] = (t.native[c] ?? 0) + v;
  }
  return t;
};
const moneyT = (m: Money): Totals => ({ czk: m.czk, eur: m.eur, native: { [m.currency]: m.native } });
const subT = (a: Totals, b: Totals): Totals => sumT([a, { czk: b.czk == null ? null : -b.czk, eur: b.eur == null ? null : -b.eur, native: Object.fromEntries(Object.entries(b.native).map(([c, v]) => [c, -v])) }]);
const pctT = (profit: Totals, cost: Totals): Percent => {
  const p = (x: number | null | undefined, y: number | null | undefined) => (x == null || y == null || y === 0 ? null : (x / y) * 100);
  const cs = Object.keys(cost.native);
  return { czk: p(profit.czk, cost.czk), eur: p(profit.eur, cost.eur), native: cs.length === 1 ? p(profit.native[cs[0]!], cost.native[cs[0]!]) : null };
};

/**
 * Revalues held lots with live quotes (in memory, on a copy). Costs, realized sales and taxes stay untouched –
 * they are fixed by the ČNB rate of the trade day. Live values use today's ECB rates.
 */
export function applyLive(base: Analysis, czkPer: Record<string, number>, quotes: Record<string, LiveQuote>): LiveResult {
  const a = structuredClone(base);
  const updated: string[] = [];
  let date: string | null = null;
  const rate = (c: string) => czkPer[c] ?? null;

  for (const x of a.holdings) {
    const q = quotes[x.ticker];
    const ic = instrumentCurrency(a, x);
    if (!q || !ic || rate(q.currency) == null || rate(ic) == null) continue;
    const price = (q.price * rate(q.currency)!) / rate(ic)!;
    const stored = x.lots.find((l) => l.currentPrice)?.currentPrice?.close;
    if (stored && Math.abs(price / stored - 1) > MAX_JUMP) continue;
    let changed = false;
    for (const l of x.lots) {
      if (l.valueDate && q.date < l.valueDate) continue;
      const ac = l.cost.currency;
      if (rate(ac) == null) continue;
      const czk = l.quantity * price * rate(ic)!;
      const value: Money = { native: czk / rate(ac)!, currency: ac, czk, eur: czk / rate('EUR')! };
      const profit: Money = {
        native: value.native - l.cost.native,
        currency: ac,
        czk: l.cost.czk == null ? null : czk - l.cost.czk,
        eur: l.cost.eur == null ? null : value.eur! - l.cost.eur,
      };
      Object.assign(l, {
        value, profit, valueSource: 'market', valueDate: q.date,
        currentPrice: { date: q.date, close: price, currency: ic },
        profitPct: pctT(moneyT(profit), moneyT(l.cost)),
      } satisfies Partial<HoldingLot>);
      changed = true;
    }
    if (!changed) continue;
    updated.push(x.ticker);
    if (!date || q.date > date) date = q.date;
    x.value = sumT(x.lots.flatMap((l) => (l.value ? [moneyT(l.value)] : [])));
    x.profit = subT(x.value, x.cost);
    x.profitPct = pctT(x.profit, x.cost);
    const series = a.instruments[x.ticker];
    if (series && series.currency === ic) {
      const last = series.prices.at(-1);
      if (last?.[0] === q.date) last[1] = price;
      else if (!last || last[0] < q.date) series.prices.push([q.date, price]);
    }
  }
  if (!updated.length) return { analysis: base, updated, date: null };

  const s = a.summary;
  s.value = sumT(a.holdings.map((x) => x.value));
  s.valueDate = date;
  s.unrealizedProfit = subT(s.value, s.cost);
  s.unrealizedPct = pctT(s.unrealizedProfit, s.cost);
  a.geography = breakdown(a.holdings.map((x) => ({ value: x.value, weights: x.countries.map((c) => ({ key: c.country, weight: c.weight })) })))
    .map(({ key, ...r }) => ({ country: key, ...r }));
  a.sectors = breakdown(a.holdings.map((x) => ({ value: x.value, weights: (x.sectors ?? []).map((c) => ({ key: c.sector, weight: c.weight })) })))
    .map(({ key, ...r }) => ({ sector: key, ...r }));

  const last = a.history.at(-1);
  if (last && s.value.czk != null && s.value.eur != null && date! >= last.date) {
    const point = { date: date!, valueCzk: s.value.czk, valueEur: s.value.eur, investedCzk: last.investedCzk, investedEur: last.investedEur };
    if (last.date === date) a.history[a.history.length - 1] = point;
    else a.history.push(point);
  }
  return { analysis: a, updated, date };
}
