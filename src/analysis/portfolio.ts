import type { Db } from '../db/database.ts';
import { addDays, daysBetween, pragueDate, taxFreeFrom } from './calendar.ts';
import { checkFifo, type FifoMismatch } from './fifo.ts';
import { t212Warnings } from '../t212/store.ts';
import { Converter, DbFxRates, percent, subTotals, sumMoney, type FxRates, type Money, type Percent, type Totals } from './fx.ts';
import { loadLots, type ValueSource } from './lots.ts';
import { validatePortfolio, type DataCheck } from './validation.ts';
import { lookThrough, type LookThrough } from './breakdown.ts';
import {
  DbMarketData, crossConvert, geography, sectorBreakdown, valueHistory, type GeographySlice, type SectorSlice, type HistoryLot, type HistoryPoint,
  type MarketData,
} from './market.ts';

import { SALES_LIMIT_CZK, incomeTax } from './tax.ts';
/** 2025 only: cap on income exempted by the time test. */
export const TIME_TEST_CAP_CZK = 40_000_000;
export const TIME_TEST_CAP_YEARS = new Set([2025]);

export interface HoldingLot {
  accountNumber: string;
  positionId: string;
  openTime: string;
  openDate: string;
  quantity: number;
  openPrice: number;
  cost: Money;
  costSource: ValueSource | 'xtb-profit';
  value: Money | null;
  /**
   * `market` = downloaded price, `xtb` = value from the XTB export snapshot,
   * `cost` = no price at all (e.g. Trading 212 without market data) – valued at purchase cost like the history chart, profit unknown.
   */
  valueSource: 'market' | 'xtb' | 'cost' | null;
  valueDate: string | null;
  currentPrice: { date: string; close: number; currency: string } | null;
  profit: Money | null;
  profitPct: Percent | null;
  taxFreeFrom: string;
  taxFree: boolean;
  daysUntilTaxFree: number;
}

export interface Holding {
  ticker: string;
  name: string | null;
  category: string | null;
  /** Currency of per-share prices (downloaded quotes); null = unknown, prices then follow the account currency. */
  priceCurrency: string | null;
  isin: string | null;
  countries: { country: string; weight: number }[];
  countrySource: string | null;
  sectors: { sector: string; weight: number }[];
  /** ETF only: largest positions in % of the fund (onvista top 10). */
  topHoldings: { isin: string; name: string; weight: number }[];
  quantity: number;
  cost: Totals;
  value: Totals;
  profit: Totals;
  profitPct: Percent;
  taxFreeQuantity: number;
  nextTaxFreeDate: string | null;
  lots: HoldingLot[];
}

export interface RealizedLot {
  accountNumber: string;
  positionId: string;
  quantity: number;
  openTime: string;
  closeTime: string;
  openDate: string;
  closeDate: string;
  openPrice: number;
  closePrice: number;
  holdingDays: number;
  timeTestMet: boolean;
  cost: Money;
  proceeds: Money;
  profit: Money;
  profitPct: Percent;
  xtbProfit: number;
}

export interface RealizedInstrument {
  ticker: string;
  name: string | null;
  category: string | null;
  /** Currency of per-share prices (downloaded quotes); null = unknown, prices then follow the account currency. */
  priceCurrency: string | null;
  quantity: number;
  cost: Totals;
  proceeds: Totals;
  profit: Totals;
  profitPct: Percent;
  firstSale: string;
  lastSale: string;
  lots: RealizedLot[];
}

export interface TaxYear {
  year: number;
  salesCount: number;
  /** Gross proceeds of all sales. */
  proceeds: Totals;
  /** Gross proceeds of sales without the time test – only these count towards the 100 000 Kč limit (§4(1)(w) ZDP). */
  shortTermProceeds: Totals;
  limitStatus: 'within' | 'exceeded' | 'unknown';
  limitRemainingCzk: number | null;
  timeTestedProceeds: Totals;
  /** Sales that are neither time-tested nor covered by the limit. */
  taxable: { count: number; proceeds: Totals; cost: Totals; profit: Totals; baseCzk: number | null; taxCzk: number | null };
  /** Net result of all sales without the time test, regardless of the limit (for "what if I sell now"). */
  shortTermProfitCzk: number | null;
  timeTestCapExceeded: boolean | null;
}

export type CashKind =
  | 'deposit' | 'withdrawal' | 'dividend' | 'withholding-tax' | 'interest' | 'interest-tax' | 'fee' | 'trade' | 'other';

export interface CashFlow {
  accountNumber: string;
  currency: string;
  firstOperation: string | null;
  lastOperation: string | null;
  /** Cash operations cover the whole history (start before the first known purchase). */
  historyComplete: boolean;
  balance: number;
  byKind: Partial<Record<CashKind, Totals>>;
}

export interface DividendSummary {
  ticker: string;
  name: string | null;
  year: number;
  gross: Totals;
  withholdingTax: Totals;
  net: Totals;
}

export interface Summary {
  value: Totals;
  /** Latest date the holdings are valued at. */
  valueDate: string | null;
  cost: Totals;
  unrealizedProfit: Totals;
  unrealizedPct: Percent;
  realizedProfit: Totals;
  dividendsNet: Totals;
  deposits: Totals;
  withdrawals: Totals;
}

export interface Analysis {
  generatedAt: string;
  today: string;
  snapshotAsOf: string | null;
  /** Prague date of the newest trade or cash operation in the imported statements. */
  lastTransactionDate: string | null;
  accounts: { accountNumber: string; currency: string | null }[];
  summary: Summary;
  holdings: Holding[];
  geography: GeographySlice[];
  sectors: SectorSlice[];
  /** Single stocks inside ETFs plus directly held stocks, summed by ISIN (top 100). */
  lookThrough: LookThrough;
  history: HistoryPoint[];
  /** Price series per instrument for charts (from ~1 month before the first purchase). */
  instruments: Record<string, InstrumentSeries>;
  realized: RealizedInstrument[];
  taxYears: TaxYear[];
  dividends: DividendSummary[];
  cashFlows: CashFlow[];
  checks: { fifoMismatches: FifoMismatch[]; missingRates: string[]; warnings: string[]; validation: DataCheck[] };
}

export interface InstrumentSeries {
  isin: string | null;
  priceSource: string | null;
  currency: string | null;
  prices: [date: string, close: number][];
}

export interface AnalyzeOptions {
  /** Reference day (YYYY-MM-DD, Prague) for time-test countdowns. Defaults to today. */
  today?: string;
  fx?: FxRates;
  market?: MarketData;
}

export function analyze(db: Db, options: AnalyzeOptions = {}): Analysis {
  const today = options.today ?? pragueDate(new Date().toISOString());
  const fx = options.fx ?? new DbFxRates(db);
  const conv = new Converter(fx);
  const market = options.market ?? new DbMarketData(db);
  const loaded = loadLots(db);
  const warnings = [...loaded.warnings, ...t212Warnings(db)];

  const instruments = new Map(
    // Full fund/company name from market data (justETF, Yahoo) beats XTB's short index-style name.
    (db.prepare(
      `SELECT i.ticker, COALESCE(NULLIF(m.name, ''), i.name) AS name, i.category
       FROM instruments i LEFT JOIN instrument_meta m ON m.ticker = i.ticker`,
    ).all() as {
      ticker: string;
      name: string | null;
      category: string | null;
    }[]).map((i) => [i.ticker, i]),
  );
  const info = (ticker: string) => ({
    name: instruments.get(ticker)?.name ?? null,
    category: instruments.get(ticker)?.category ?? null,
  });

  // Lot prices are per share in the instrument's trading currency (not the account currency)
  const quoteCurrency = (ticker: string) => market.series(ticker).at(-1)?.currency ?? null;

  // --- holdings -------------------------------------------------------------
  const valueDate = loaded.snapshotAsOf ? pragueDate(loaded.snapshotAsOf) : today;
  const holdingLots = new Map<string, HoldingLot[]>();
  const unpriced = new Set<string>();
  for (const l of loaded.open) {
    const openDate = pragueDate(l.openTime);
    const free = taxFreeFrom(openDate);
    const cost = conv.money(l.cost, l.currency, openDate);
    let value: Money | null = null;
    let valueSource: HoldingLot['valueSource'] = null;
    let lotValueDate: string | null = null;
    const quote = market.price(l.ticker, today);
    // XTB values positions as of its snapshot; Trading 212 positions have no snapshot value, only market prices.
    if (quote && (quote.date > valueDate || l.value == null)) {
      const native = crossConvert(fx, l.volume * quote.close, quote.currency, l.currency, quote.date);
      if (native != null) [value, valueSource, lotValueDate] = [conv.money(native, l.currency, quote.date), 'market', quote.date];
    }
    if (!value && l.value != null) [value, valueSource, lotValueDate] = [conv.money(l.value, l.currency, valueDate), 'xtb', valueDate];
    if (!value) {
      // no price: count it at cost (as the chart does) instead of 0, which would show a fake −100 % loss
      [value, valueSource] = [cost, 'cost'];
      unpriced.add(l.ticker);
    }
    const profit = valueSource === 'cost' ? null : diffMoney(value, cost);
    const lot: HoldingLot = {
      accountNumber: l.accountNumber,
      positionId: l.positionId,
      openTime: l.openTime,
      openDate,
      quantity: l.volume,
      openPrice: l.openPrice,
      cost,
      costSource: l.costSource,
      value,
      valueSource,
      valueDate: lotValueDate,
      currentPrice: quote,
      profit,
      profitPct: profit ? percent(sumMoney([profit]), sumMoney([cost])) : null,
      taxFreeFrom: free,
      taxFree: today >= free,
      daysUntilTaxFree: Math.max(0, daysBetween(today, free)),
    };
    holdingLots.set(l.ticker, [...(holdingLots.get(l.ticker) ?? []), lot]);
  }
  const holdings: Holding[] = [...holdingLots.entries()].map(([ticker, lots]) => {
    const cost = sumMoney(lots.map((l) => l.cost));
    const value = sumMoney(lots.flatMap((l) => (l.value ? [l.value] : [])));
    const profit = subTotals(value, cost);
    const pending = lots.filter((l) => !l.taxFree).map((l) => l.taxFreeFrom).sort();
    const m = market.info(ticker);
    return {
      ticker,
      ...info(ticker),
      priceCurrency: quoteCurrency(ticker),
      isin: m.isin,
      countries: m.countries,
      countrySource: m.countrySource,
      sectors: m.sectors,
      topHoldings: m.topHoldings,
      quantity: lots.reduce((a, l) => a + l.quantity, 0),
      cost,
      value,
      profit,
      profitPct: percent(profit, cost),
      taxFreeQuantity: lots.filter((l) => l.taxFree).reduce((a, l) => a + l.quantity, 0),
      nextTaxFreeDate: pending[0] ?? null,
      lots: lots.sort((a, b) => a.openTime.localeCompare(b.openTime)),
    };
  });
  holdings.sort((a, b) => nativeTotal(b.value) - nativeTotal(a.value));

  // --- realized -------------------------------------------------------------
  const realizedLots = new Map<string, RealizedLot[]>();
  for (const c of loaded.closed) {
    const openDate = pragueDate(c.openTime);
    const closeDate = pragueDate(c.closeTime);
    const cost = conv.money(c.cost, c.currency, openDate);
    const proceeds = conv.money(c.proceeds, c.currency, closeDate);
    const profit = diffMoney(proceeds, cost);
    realizedLots.set(c.ticker, [
      ...(realizedLots.get(c.ticker) ?? []),
      {
        accountNumber: c.accountNumber,
        positionId: c.positionId,
        quantity: c.volume,
        openTime: c.openTime,
        closeTime: c.closeTime,
        openDate,
        closeDate,
        openPrice: c.openPrice,
        closePrice: c.closePrice,
        holdingDays: daysBetween(openDate, closeDate),
        timeTestMet: closeDate >= taxFreeFrom(openDate),
        cost,
        proceeds,
        profit,
        profitPct: percent(sumMoney([profit]), sumMoney([cost])),
        xtbProfit: c.xtbProfit,
      },
    ]);
  }
  const realized: RealizedInstrument[] = [...realizedLots.entries()].map(([ticker, lots]) => {
    lots.sort((a, b) => b.closeTime.localeCompare(a.closeTime) || a.openTime.localeCompare(b.openTime));
    const cost = sumMoney(lots.map((l) => l.cost));
    const proceeds = sumMoney(lots.map((l) => l.proceeds));
    const profit = subTotals(proceeds, cost);
    return {
      ticker,
      ...info(ticker),
      priceCurrency: quoteCurrency(ticker),
      quantity: lots.reduce((a, l) => a + l.quantity, 0),
      cost,
      proceeds,
      profit,
      profitPct: percent(profit, cost),
      firstSale: lots[lots.length - 1]!.closeDate,
      lastSale: lots[0]!.closeDate,
      lots,
    };
  });
  realized.sort((a, b) => b.lastSale.localeCompare(a.lastSale));

  const taxYears = computeTaxYears(realized.flatMap((r) => r.lots));

  // --- cash flows & dividends ----------------------------------------------
  const ops = db
    .prepare(
      `SELECT o.account_number, a.currency, o.type, o.ticker, o.time_utc, o.amount
       FROM cash_operations o JOIN accounts a USING (account_number) ORDER BY o.time_utc`,
    )
    .all() as { account_number: string; currency: string | null; type: string; ticker: string | null; time_utc: string; amount: number }[];

  const earliestLot = new Map<string, string>();
  for (const l of [...loaded.open, ...loaded.closed]) {
    const prev = earliestLot.get(l.accountNumber);
    if (!prev || l.openTime < prev) earliestLot.set(l.accountNumber, l.openTime);
  }

  const flows = new Map<string, { currency: string; ops: typeof ops; byKind: Map<CashKind, Money[]> }>();
  const dividendParts = new Map<string, { ticker: string; year: number; gross: Money[]; tax: Money[] }>();
  for (const o of ops) {
    const currency = o.currency ?? '???';
    let f = flows.get(o.account_number);
    if (!f) flows.set(o.account_number, (f = { currency, ops: [], byKind: new Map() }));
    f.ops.push(o);
    const kind = classifyCashOperation(o.type);
    const date = pragueDate(o.time_utc);
    const m = conv.money(o.amount, currency, date);
    f.byKind.set(kind, [...(f.byKind.get(kind) ?? []), m]);
    if ((kind === 'dividend' || kind === 'withholding-tax') && o.ticker) {
      const year = Number(date.slice(0, 4));
      const key = `${o.ticker}|${year}`;
      let d = dividendParts.get(key);
      if (!d) dividendParts.set(key, (d = { ticker: o.ticker, year, gross: [], tax: [] }));
      (kind === 'dividend' ? d.gross : d.tax).push(m);
    }
  }
  const cashFlows: CashFlow[] = [...flows.entries()].map(([accountNumber, f]) => {
    const first = f.ops[0]?.time_utc ?? null;
    const lotStart = earliestLot.get(accountNumber);
    const historyComplete = first != null && (!lotStart || first <= lotStart);
    if (!historyComplete) {
      warnings.push(
        `Účet ${accountNumber}: peněžní operace začínají ${first ? pragueDate(first) : '?'}, ale nejstarší nákup je ` +
          `${lotStart ? pragueDate(lotStart) : '?'} – nahraj export za celé období, jinak vklady a zůstatek nesedí.`,
      );
    }
    return {
      accountNumber,
      currency: f.currency,
      firstOperation: first,
      lastOperation: f.ops[f.ops.length - 1]?.time_utc ?? null,
      historyComplete,
      balance: f.ops.reduce((a, o) => a + o.amount, 0),
      byKind: Object.fromEntries([...f.byKind.entries()].map(([k, v]) => [k, sumMoney(v)])),
    };
  });
  const dividends: DividendSummary[] = [...dividendParts.values()]
    .map((d) => {
      const gross = sumMoney(d.gross);
      const withholdingTax = sumMoney(d.tax);
      return { ticker: d.ticker, name: info(d.ticker).name, year: d.year, gross, withholdingTax, net: addTotals(gross, withholdingTax) };
    })
    .sort((a, b) => b.year - a.year || a.ticker.localeCompare(b.ticker));

  const unsupported = new Set(ops.filter((o) => classifyCashOperation(o.type) === 'other').map((o) => o.type));
  if (unpriced.size) {
    warnings.push(`Bez tržní ceny i hodnoty z výpisu: ${[...unpriced].sort().join(', ')} – počítá se nákupní cenou (zisk 0), dokud se cenu nepodaří stáhnout.`);
  }
  if (unsupported.size) warnings.push(`Nezpracované typy peněžních operací: ${[...unsupported].join(', ')}`);

  // --- summary --------------------------------------------------------------
  const all = (f: (h: Holding) => Totals) => holdings.map(f).reduce(addTotals, emptyTotals());
  const kindTotal = (k: CashKind) => cashFlows.map((c) => c.byKind[k] ?? emptyTotals()).reduce(addTotals, emptyTotals());
  const value = all((h) => h.value);
  const cost = all((h) => h.cost);
  const unrealizedProfit = subTotals(value, cost);
  const valueDates = holdings.flatMap((h) => h.lots.flatMap((l) => (l.valueDate ? [l.valueDate] : []))).sort();
  const summary: Summary = {
    value,
    valueDate: valueDates[valueDates.length - 1] ?? null,
    cost,
    unrealizedProfit,
    unrealizedPct: percent(unrealizedProfit, cost),
    realizedProfit: realized.map((r) => r.profit).reduce(addTotals, emptyTotals()),
    dividendsNet: dividends.map((d) => d.net).reduce(addTotals, emptyTotals()),
    deposits: kindTotal('deposit'),
    withdrawals: kindTotal('withdrawal'),
  };

  function historyLots(): HistoryLot[] {
    const lot = (l: (typeof loaded.open)[number], closeDate: string | null): HistoryLot => {
      const openDate = pragueDate(l.openTime);
      const c = conv.money(l.cost, l.currency, openDate);
      return { ticker: l.ticker, quantity: l.volume, openDate, closeDate, costNative: l.cost, costCzk: c.czk, costEur: c.eur, currency: l.currency };
    };
    return [...loaded.open.map((l) => lot(l, null)), ...loaded.closed.map((c) => lot({ ...c, costSource: c.costSource, currentPrice: null, value: null }, pragueDate(c.closeTime)))];
  }

  function instrumentSeries(): Record<string, InstrumentSeries> {
    const firstOpen = new Map<string, string>();
    for (const l of [...loaded.open, ...loaded.closed]) {
      const d = pragueDate(l.openTime);
      if (!firstOpen.has(l.ticker) || d < firstOpen.get(l.ticker)!) firstOpen.set(l.ticker, d);
    }
    const out: Record<string, InstrumentSeries> = {};
    for (const [ticker, first] of [...firstOpen.entries()].sort()) {
      const from = addDays(first, -31);
      const m = market.info(ticker);
      const prices = market.series(ticker).filter((p) => p.date >= from);
      out[ticker] = {
        isin: m.isin,
        priceSource: m.priceSource,
        currency: prices[0]?.currency ?? m.priceCurrency,
        prices: prices.map((p) => [p.date, p.close]),
      };
    }
    return out;
  }

  const fifoMismatches = checkFifo(loaded.closed, loaded.open);
  const snapshots = (db.prepare(
    `SELECT s.account_number, a.currency, s.as_of, s.value, s.profit FROM open_snapshots s JOIN accounts a USING (account_number)`,
  ).all() as { account_number: string; currency: string | null; as_of: string; value: number | null; profit: number | null }[])
    .map((s) => ({ accountNumber: s.account_number, currency: s.currency ?? '???', asOf: s.as_of, value: s.value, profit: s.profit }));
  // Only accounts with an export snapshot (XTB) can be compared; Trading 212 positions have no export value.
  const snapAsOf = new Map(snapshots.map((s) => [s.accountNumber, s.asOf]));
  const xtbValues = loaded.open.filter((l) => snapAsOf.has(l.accountNumber))
    .map((l) => (l.value == null ? null : conv.money(l.value, l.currency, pragueDate(snapAsOf.get(l.accountNumber)!)).czk));
  const xtbLots = holdings.flatMap((x) => x.lots).filter((l) => snapAsOf.has(l.accountNumber));
  const xtbCurrent = xtbLots.map((l) => l.value?.czk ?? null);
  const xtbCurrentDate = xtbLots.flatMap((l) => (l.valueDate ? [l.valueDate] : [])).sort().at(-1) ?? null;
  const validation = validatePortfolio({
    today,
    snapshots,
    open: loaded.open,
    priceAt: (ticker, date) => market.price(ticker, date),
    xtbValueCzk: xtbValues.some((x) => x == null) ? null : xtbValues.reduce((a: number, x) => a + x!, 0),
    currentValueCzk: xtbCurrent.some((x) => x == null) ? null : xtbCurrent.reduce((a: number, x) => a + x!, 0),
    currentValueDate: xtbCurrentDate,
    missingRates: conv.missing.size,
    fifoMismatches: fifoMismatches.length,
    incompleteAccounts: cashFlows.filter((c) => !c.historyComplete).map((c) => c.accountNumber),
  });

  const lastTransaction = (db.prepare(`SELECT max(t) AS t FROM (
        SELECT max(time_utc) AS t FROM cash_operations
        UNION ALL SELECT max(open_time) FROM open_lots
        UNION ALL SELECT max(close_time) FROM closed_lots)`).get() as { t: string | null }).t;

  return {
    generatedAt: new Date().toISOString(),
    today,
    snapshotAsOf: loaded.snapshotAsOf,
    lastTransactionDate: lastTransaction ? pragueDate(lastTransaction) : null,
    accounts: db.prepare('SELECT account_number AS accountNumber, currency FROM accounts').all().map((a) => ({ ...a })) as {
      accountNumber: string;
      currency: string | null;
    }[],
    summary,
    holdings,
    geography: geography(holdings),
    sectors: sectorBreakdown(holdings),
    lookThrough: lookThrough(holdings),
    history: valueHistory(historyLots(), market, fx, today),
    instruments: instrumentSeries(),
    realized,
    taxYears,
    dividends,
    cashFlows,
    checks: {
      fifoMismatches,
      missingRates: [...conv.missing].sort(),
      warnings,
      validation,
    },
  };
}

export function computeTaxYears(lots: RealizedLot[]): TaxYear[] {
  const byYear = new Map<number, RealizedLot[]>();
  for (const l of lots) {
    const y = Number(l.closeDate.slice(0, 4));
    byYear.set(y, [...(byYear.get(y) ?? []), l]);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, ls]) => {
      const proceeds = sumMoney(ls.map((l) => l.proceeds));
      const timeTested = ls.filter((l) => l.timeTestMet);
      const timeTestedProceeds = sumMoney(timeTested.map((l) => l.proceeds));
      // Time-tested sales are exempt under §4(1)(x) and don't count towards the 100k limit
      const shortTerm = ls.filter((l) => !l.timeTestMet);
      const shortTermProceeds = sumMoney(shortTerm.map((l) => l.proceeds));
      const used = shortTermProceeds.czk;
      const limitStatus = used == null ? 'unknown' : used <= SALES_LIMIT_CZK ? 'within' : 'exceeded';
      const taxableLots = limitStatus === 'within' ? [] : shortTerm;
      const tCost = sumMoney(taxableLots.map((l) => l.cost));
      const tProceeds = sumMoney(taxableLots.map((l) => l.proceeds));
      const tProfit = subTotals(tProceeds, tCost);
      const baseCzk = limitStatus === 'unknown' || tProfit.czk == null ? null : Math.max(0, tProfit.czk);
      return {
        year,
        salesCount: ls.length,
        proceeds,
        shortTermProceeds,
        limitStatus,
        limitRemainingCzk: used == null ? null : SALES_LIMIT_CZK - used,
        timeTestedProceeds,
        taxable: {
          count: taxableLots.length,
          proceeds: tProceeds,
          cost: tCost,
          profit: tProfit,
          baseCzk,
          taxCzk: incomeTax(baseCzk),
        },
        shortTermProfitCzk: subTotals(shortTermProceeds, sumMoney(shortTerm.map((l) => l.cost))).czk,
        timeTestCapExceeded: !TIME_TEST_CAP_YEARS.has(year)
          ? false
          : timeTestedProceeds.czk == null
            ? null
            : timeTestedProceeds.czk > TIME_TEST_CAP_CZK,
      };
    });
}

export function classifyCashOperation(type: string): CashKind {
  const t = type.trim().toLowerCase();
  if (/interest tax/.test(t)) return 'interest-tax';
  if (/interest/.test(t)) return 'interest';
  if (/withholding/.test(t)) return 'withholding-tax';
  if (/divid/.test(t)) return 'dividend';
  if (/deposit/.test(t)) return 'deposit';
  if (/withdraw/.test(t)) return 'withdrawal';
  if (/^stock (purchase|sell)$/.test(t)) return 'trade';
  if (/fee|commission|swap|rollover/.test(t)) return 'fee';
  return 'other';
}

function diffMoney(a: Money, b: Money): Money {
  return {
    native: a.native - b.native,
    currency: a.currency,
    czk: a.czk == null || b.czk == null ? null : a.czk - b.czk,
    eur: a.eur == null || b.eur == null ? null : a.eur - b.eur,
  };
}

function emptyTotals(): Totals {
  return { czk: 0, eur: 0, native: {} };
}

function addTotals(a: Totals, b: Totals): Totals {
  const native = { ...a.native };
  for (const [c, v] of Object.entries(b.native)) native[c] = (native[c] ?? 0) + v;
  return {
    czk: a.czk == null || b.czk == null ? null : a.czk + b.czk,
    eur: a.eur == null || b.eur == null ? null : a.eur + b.eur,
    native,
  };
}

function nativeTotal(t: Totals): number {
  return t.czk ?? Object.values(t.native).reduce((a, v) => a + v, 0);
}
