// Pure helper shared by the analysis and the report frontend (bundled into the HTML by build.ts) – no runtime imports.

/** Annual tax-exempt limit for gross income from selling securities (§4(1)(w) ZDP). */
export const SALES_LIMIT_CZK = 100_000;
/** Basic personal income tax rate; the 23 % band depends on the whole income, which the app does not know. */
export const TAX_RATE = 0.15;

export function incomeTax(baseCzk: number | null): number | null {
  return baseCzk == null ? null : Math.round(Math.max(0, baseCzk) * TAX_RATE);
}

export interface SaleTaxEstimate {
  count: number;
  proceedsCzk: number;
  gainsCzk: number;
  lossesCzk: number;
  /** All sales of the year incl. this one exceed the limit → the short-term result is taxed. */
  limitExceeded: boolean;
  /** Extra tax caused by the sale (negative = the losses lower tax on this year's earlier sales). */
  taxCzk: number;
}

/**
 * Tax if all given lots (not time-tested) were sold now. Gains and losses of these lots are netted together with
 * this year's earlier short-term sales; the 100 000 Kč limit counts all of the year's sales. Null when a CZK value is missing.
 */
export function saleTaxEstimate(
  lots: { valueCzk: number | null; profitCzk: number | null }[],
  year: { proceedsCzk: number | null; shortTermProfitCzk: number | null } = { proceedsCzk: 0, shortTermProfitCzk: 0 },
): SaleTaxEstimate | null {
  if (year.proceedsCzk == null || year.shortTermProfitCzk == null) return null;
  let proceedsCzk = 0, gainsCzk = 0, lossesCzk = 0;
  for (const l of lots) {
    if (l.valueCzk == null || l.profitCzk == null) return null;
    proceedsCzk += l.valueCzk;
    if (l.profitCzk >= 0) gainsCzk += l.profitCzk; else lossesCzk += l.profitCzk;
  }
  const taxFor = (proceeds: number, profit: number) => (proceeds <= SALES_LIMIT_CZK ? 0 : incomeTax(profit)!);
  const before = taxFor(year.proceedsCzk, year.shortTermProfitCzk);
  const allProceeds = year.proceedsCzk + proceedsCzk;
  const after = taxFor(allProceeds, year.shortTermProfitCzk + gainsCzk + lossesCzk);
  return { count: lots.length, proceedsCzk, gainsCzk, lossesCzk, limitExceeded: allProceeds > SALES_LIMIT_CZK, taxCzk: after - before };
}
