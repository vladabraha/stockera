// Live prices in the opened report. Bundled into the HTML (build.ts) and unit-tested in Node.
// Privacy: requests carry only ISINs and currency codes – never quantities, prices, values or account numbers.
import type { Analysis, Holding, HoldingLot } from '../analysis/portfolio.ts';
import type { Money, Percent, Totals } from '../analysis/fx.ts';
import type { HistoryPoint } from '../analysis/market.ts';
import { breakdown, lookThrough } from '../analysis/breakdown.ts';
import { parseSafeJson, UnsafeDataError } from '../net/inspect.ts';

/** Primary sources first, then their fallbacks (Tradegate for quotes, ECB for rates). */
export const LIVE_HOSTS = ['https://api.onvista.de', 'https://api.frankfurter.dev', 'https://www.tradegatebsx.com', 'https://data-api.ecb.europa.eu'] as const;

export interface LiveQuote {
  price: number;
  currency: string;
  /** YYYY-MM-DD (UTC day of the last trade). */
  date: string;
}

export interface LiveSources {
  /** Rates came from the ECB fallback because Frankfurter failed. */
  fxFallback: boolean;
  /** Tickers priced by the Tradegate fallback because onvista failed. */
  quoteFallback: string[];
  /** Short technical reasons of failed primary requests (no personal data). */
  errors: string[];
  /** Responses discarded by the content check (`source: reason`). */
  unsafe: string[];
}

export interface LiveResult {
  analysis: Analysis;
  /** Tickers whose value was recalculated. */
  updated: string[];
  /** Held instruments left at the stored price although a newer one may exist, with the reason (Czech). */
  missing: { ticker: string; reason: string }[];
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
/** Real responses are a few kB; anything far bigger is not a quote. */
const MAX_BYTES = 2_000_000;
const SOURCE_NAMES: Record<string, string> = {
  'api.onvista.de': 'onvista', 'api.frankfurter.dev': 'Frankfurter', 'www.tradegatebsx.com': 'Tradegate', 'data-api.ecb.europa.eu': 'ECB',
};

export const liveFxUrl = (currencies: string[]) =>
  `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${currencyList(currencies).join(',')}`;
const currencyList = (currencies: string[]) => currencies.filter((c) => /^[A-Z]{3}$/.test(c) && c !== 'EUR').sort();
export const ecbFxUrl = (currencies: string[]) =>
  `https://data-api.ecb.europa.eu/service/data/EXR/D.${currencyList(currencies).join('+')}.EUR.SP00.A?lastNObservations=1&format=jsondata`;
export const tradegateUrl = (isin: string) => `https://www.tradegatebsx.com/refresh.php?isin=${encodeURIComponent(isin)}`;
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

/** ECB SDMX-JSON (`EXR/D.X+Y.EUR.SP00.A`, last observation) → same shape as `parseLiveFx`. */
export function parseEcbFx(data: unknown): Record<string, number> {
  const d = data as { dataSets?: { series?: Record<string, { observations?: Record<string, unknown[]> }> }[]; structure?: { dimensions?: { series?: { id: string; values: { id: string }[] }[] } } } | null;
  const dims = d?.structure?.dimensions?.series ?? [];
  const at = dims.findIndex((x) => x.id === 'CURRENCY');
  const rates: Record<string, number> = {};
  for (const [key, series] of Object.entries(d?.dataSets?.[0]?.series ?? {})) {
    const code = dims[at]?.values[Number(key.split(':')[at])]?.id;
    const obs = Object.values(series.observations ?? {}).at(-1);
    if (code && obs) rates[code] = Number(obs[0]);
  }
  return parseLiveFx({ rates });
}

/** Numbers come as JSON numbers or German strings ("1.234,50"). */
function germanNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  return Number(v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v);
}

/** Last Tradegate trading day (Mon–Fri from 8:00 Berlin time; holidays are not known). */
export function tradegateDay(now: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) < 8) day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Tradegate `refresh.php`: last trade in EUR; the response has no date, so the last trading day is assumed. */
export function parseTradegate(data: unknown, now: Date): LiveQuote | null {
  const price = germanNumber((data as { last?: unknown } | null)?.last);
  return price > 0 ? { price, currency: 'EUR', date: tradegateDay(now) } : null;
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
/** `czkPer` is null when no rates could be loaded – then nothing is revalued (offline). */
export async function fetchLive(a: Analysis, fetchFn: typeof fetch = fetch, now = new Date()): Promise<{ czkPer: Record<string, number> | null; quotes: Record<string, LiveQuote>; sources: LiveSources }> {
  const get = async (url: string): Promise<unknown> => {
    const source = SOURCE_NAMES[new URL(url).hostname] ?? 'neznámý zdroj';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchFn(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (!/json/i.test(r.headers.get('content-type') ?? '')) throw new UnsafeDataError(source, `nečekaný typ ${r.headers.get('content-type') || 'bez typu'}`);
      if (Number(r.headers.get('content-length') ?? 0) > MAX_BYTES) throw new UnsafeDataError(source, 'příliš velká odpověď');
      const text = await r.text();
      if (text.length > MAX_BYTES) throw new UnsafeDataError(source, 'příliš velká odpověď');
      return parseSafeJson(text, source);
    } finally {
      clearTimeout(timer);
    }
  };
  const targets = a.holdings.filter((x) => x.isin).map((x) => ({ ticker: x.ticker, isin: x.isin!, etf: x.category === 'ETF', currency: instrumentCurrency(a, x) }));
  const currencies = new Set(['CZK', 'USD', 'GBP', 'CHF']);
  for (const x of a.holdings) for (const l of x.lots) currencies.add(l.cost.currency);
  for (const t of targets) if (t.currency) currencies.add(t.currency);

  const sources: LiveSources = { fxFallback: false, quoteFallback: [], errors: [], unsafe: [] };
  const fail = (source: string, e: unknown) => {
    if (e instanceof UnsafeDataError) {
      const msg = `${e.source}: ${e.reason}`;
      if (!sources.unsafe.includes(msg)) sources.unsafe.push(msg);
    }
    const msg = `${source}: ${e instanceof Error ? (e.name === 'AbortError' ? 'neodpověděl včas' : e.message) : String(e)}`;
    if (!sources.errors.includes(msg)) sources.errors.push(msg);
  };
  const quotes: Record<string, LiveQuote> = {};
  const queue = [...targets];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const q = pickLiveQuote(await get(liveQuoteUrl(t.isin, t.etf)), t.etf, t.currency);
        if (!q) throw new Error('bez použitelné ceny');
        quotes[t.ticker] = q;
        continue;
      } catch (e) {
        fail('onvista', e);
      }
      try {
        const q = parseTradegate(await get(tradegateUrl(t.isin)), now);
        if (q) {
          quotes[t.ticker] = q;
          sources.quoteFallback.push(t.ticker);
        }
      } catch (e) {
        if (e instanceof UnsafeDataError) fail('Tradegate', e);
      }
    }
  };
  const loadFx = async () => {
    try {
      return parseLiveFx(await get(liveFxUrl([...currencies])));
    } catch (e) {
      fail('Frankfurter', e);
      sources.fxFallback = true;
    }
    try {
      return parseEcbFx(await get(ecbFxUrl([...currencies])));
    } catch (e) {
      fail('ECB', e);
      return null;
    }
  };
  const [czkPer] = await Promise.all([loadFx(), ...Array.from({ length: CONCURRENCY }, worker)]);
  return { czkPer, quotes, sources };
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

const czDay = (iso: string) => { const [y, m, d] = iso.split('-'); return `${Number(d)}. ${Number(m)}. ${y}`; };

/**
 * Revalues held lots with live quotes (in memory, on a copy). Costs, realized sales and taxes stay untouched –
 * they are fixed by the ČNB rate of the trade day. Live values use today's ECB rates.
 */
export function applyLive(base: Analysis, czkPer: Record<string, number>, quotes: Record<string, LiveQuote>): LiveResult {
  const a = structuredClone(base);
  const updated: string[] = [];
  const missing: LiveResult['missing'] = [];
  let date: string | null = null;
  const rate = (c: string) => czkPer[c] ?? null;
  const noRate = (...cs: (string | null)[]) => cs.find((c) => c && rate(c) == null);

  for (const x of a.holdings) {
    const q = quotes[x.ticker];
    const skip = (reason: string) => missing.push({ ticker: x.ticker, reason });
    if (!q) { skip(x.isin ? 'onvista ani Tradegate aktuální cenu nemají' : 'chybí ISIN, podle kterého se aktuální cena hledá'); continue; }
    // without a stored price the quote's own currency works too – the instrument rate cancels out in the value
    const ic = instrumentCurrency(a, x) ?? x.priceCurrency ?? q.currency;
    const fx = noRate(q.currency, ic);
    if (fx) { skip(`chybí aktuální kurz ${fx}`); continue; }
    const price = (q.price * rate(q.currency)!) / rate(ic)!;
    const stored = x.lots.find((l) => l.currentPrice)?.currentPrice?.close;
    if (stored && Math.abs(price / stored - 1) > MAX_JUMP) {
      skip(`aktuální cena se od uložené liší o víc než ${MAX_JUMP * 100} %, proto ji bezpečnostní kontrola zahodila`);
      continue;
    }
    let changed = false;
    let lotFx: string | undefined;
    let newerStored: string | undefined;
    for (const l of x.lots) {
      // the source only has an older price than the stored one – keep the stored price
      if (l.valueDate && q.date < l.valueDate) { newerStored = l.valueDate; continue; }
      const ac = l.cost.currency;
      if (rate(ac) == null) { lotFx = ac; continue; }
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
    if (lotFx) skip(`chybí aktuální kurz ${lotFx}`);
    else if (!changed && newerStored) skip(`zdroj má jen starší cenu (k ${czDay(q.date)}) než report (k ${czDay(newerStored)})`);
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
  if (!updated.length) return { analysis: base, updated, missing, date: null };

  const s = a.summary;
  s.value = sumT(a.holdings.map((x) => x.value));
  s.valueDate = date;
  s.unrealizedProfit = subT(s.value, s.cost);
  s.unrealizedPct = pctT(s.unrealizedProfit, s.cost);
  a.geography = breakdown(a.holdings.map((x) => ({ value: x.value, weights: x.countries.map((c) => ({ key: c.country, weight: c.weight })) })))
    .map(({ key, ...r }) => ({ country: key, ...r }));
  a.sectors = breakdown(a.holdings.map((x) => ({ value: x.value, weights: (x.sectors ?? []).map((c) => ({ key: c.sector, weight: c.weight })) })))
    .map(({ key, ...r }) => ({ sector: key, ...r }));
  a.lookThrough = lookThrough(a.holdings);

  const last = a.history.at(-1);
  if (last && s.value.czk != null && s.value.eur != null && date! >= last.date) {
    const point = { date: date!, valueCzk: s.value.czk, valueEur: s.value.eur, investedCzk: last.investedCzk, investedEur: last.investedEur };
    if (last.date === date) a.history[a.history.length - 1] = point;
    else a.history.push(point);
  }
  return { analysis: a, updated, missing, date };
}

/**
 * Profit made between two history points: the change of the unrealized gain of the held lots plus the realized profit
 * of sales closed after the first point. The history only covers lots held on each day, so without the realized part
 * selling a winner would look like a loss.
 */
export function periodGain(first: HistoryPoint, last: HistoryPoint, sales: { closeDate: string; profit: Money }[], cur: 'czk' | 'eur'): { total: number; realized: number } {
  const gain = (p: HistoryPoint) => (cur === 'czk' ? p.valueCzk - p.investedCzk : p.valueEur - p.investedEur);
  const realized = sales.filter((s) => s.closeDate > first.date && s.closeDate <= last.date).reduce((n, s) => n + (s.profit[cur] ?? 0), 0);
  return { total: gain(last) - gain(first) + realized, realized };
}
