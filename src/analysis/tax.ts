// Pure helper shared by the analysis and the report frontend (bundled into the HTML by build.ts) – no runtime imports.

/** Annual tax-exempt limit for gross income from selling securities (§4(1)(w) ZDP); time-tested sales don't count. */
export const SALES_LIMIT_CZK = 100_000;
/** Basic personal income tax rate; the 23 % band depends on the whole income, which the app does not know. */
export const TAX_RATE = 0.15;

export function incomeTax(baseCzk: number | null): number | null {
  return baseCzk == null ? null : Math.round(Math.max(0, baseCzk) * TAX_RATE);
}

export interface OffsetLot {
  ticker: string;
  account: string;
  openTime: string;
  quantity: number;
  profitCzk: number | null;
  taxFree: boolean;
}

export interface OffsetSale {
  ticker: string;
  account: string;
  quantity: number;
  /** Part of the quantity from old time-tested lots that FIFO sells first (their 3-year test restarts on a buyback). */
  taxFreeQuantity: number;
  /** Taxable loss realized by this sale (negative). */
  lossCzk: number;
}

export interface LossOffset {
  sales: OffsetSale[];
  /** Total taxable loss of the suggested sales (negative). */
  lossCzk: number;
  /** Tax left after the suggested sales (0 = fully offset). */
  remainingTaxCzk: number;
}

const ceilQty = (q: number) => Math.ceil(q * 1e4 - 1e-6) / 1e4;
const taxFreeQty = (lots: OffsetLot[]) => lots.filter((l) => l.taxFree).reduce((a, l) => a + l.quantity, 0);

/**
 * Which held positions to sell at a loss this year so the loss offsets the tax base of earlier sales.
 * Sales are paired FIFO per account and ticker, so only a prefix of the oldest lots can be sold; time-tested lots
 * are exempt (their gains and losses don't count). Positions with the biggest loss go first.
 */
export function lossOffsetPlan(baseCzk: number, lots: OffsetLot[]): LossOffset {
  const groups = new Map<string, OffsetLot[]>();
  for (const l of lots) groups.set(`${l.account}|${l.ticker}`, [...(groups.get(`${l.account}|${l.ticker}`) ?? []), l]);
  const candidates: { lots: OffsetLot[]; loss: number }[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.openTime.localeCompare(b.openTime));
    let cum = 0, best = 0, bestLen = 0;
    for (const [i, l] of g.entries()) {
      if (!l.taxFree && l.profitCzk == null) break;
      cum += l.taxFree ? 0 : l.profitCzk!;
      if (cum < best) { best = cum; bestLen = i + 1; }
    }
    if (best < 0) candidates.push({ lots: g.slice(0, bestLen), loss: best });
  }
  candidates.sort((a, b) => a.loss - b.loss);
  let need = Math.max(0, baseCzk);
  const sales: OffsetSale[] = [];
  for (const c of candidates) {
    if (need <= 0) break;
    const { ticker, account } = c.lots[0]!;
    if (-c.loss <= need) {
      sales.push({ ticker, account, quantity: c.lots.reduce((a, l) => a + l.quantity, 0), taxFreeQuantity: taxFreeQty(c.lots), lossCzk: c.loss });
      need += c.loss;
      continue;
    }
    let cum = 0, qty = 0;
    const whole: OffsetLot[] = [];
    for (const l of c.lots) {
      const p = l.taxFree ? 0 : l.profitCzk!;
      if (p < 0 && cum + p <= -need) { qty += (l.quantity * (-need - cum)) / p; break; }
      cum += p;
      qty += l.quantity;
      whole.push(l);
    }
    sales.push({ ticker, account, quantity: ceilQty(qty), taxFreeQuantity: taxFreeQty(whole), lossCzk: -need });
    need = 0;
  }
  return { sales, lossCzk: sales.reduce((a, s) => a + s.lossCzk, 0), remainingTaxCzk: incomeTax(need)! };
}

/** Exempt income above this (one income) must be reported in a separate notice (§38v ZDP). */
export const EXEMPT_NOTICE_CZK = 5_000_000;

export interface GuideLot {
  ticker: string;
  isin?: string | null;
  closeDate: string;
  timeTestMet: boolean;
  proceedsCzk: number | null;
  costCzk: number | null;
}

export interface GuideDividend {
  ticker: string;
  isin?: string | null;
  year: number;
  grossCzk: number | null;
  /** Tax withheld abroad, positive. */
  withholdingCzk: number | null;
}

/** One line of the table in Příloha č. 2, section 2 (columns 1–5). */
export interface Annex2Row {
  kind: string;
  incomeCzk: number;
  expenseCzk: number;
  diffCzk: number;
  /** Column 5: "z" for income from foreign sources. */
  code: string;
}

export interface TaxReturnGuide {
  year: number;
  /** Příloha č. 2 – taxable sales (§10); null when all sales are exempt. */
  annex2: { rows: Annex2Row[]; r207: number; r208: number; r209: number } | null;
  /** Příloha č. 4 – foreign dividends in the separate tax base (§16a); null when there are none. */
  annex4: { r401a: number; r411: number; r412: number; taxCzk: number; creditCzk: number; r414: number } | null;
  /** Sum of exempt incomes over 5 mil. Kč that need the §38v notice (0 = none). */
  exemptNoticeCzk: number;
  /** Some amounts lack a CZK value, the figures are incomplete. */
  incomplete: boolean;
}

/**
 * Czech source = Czech issuer, told by the ISIN country (Erste, VIG or Photon trade in Prague as .CZ but are foreign).
 * The ticker suffix is only a fallback when the ISIN is unknown.
 */
const isDomestic = (x: { ticker: string; isin?: string | null }) => (x.isin ? /^CZ/i.test(x.isin) : /\.CZ$/i.test(x.ticker));
const kc = (v: number) => Math.round(v);

/**
 * Where the year's sales and dividends go in the Czech personal income tax return (DAP, MFin 5405).
 * Taxable sales: Příloha č. 2, code "D", rows 207–209 → DAP row 40. Foreign dividends: Příloha č. 4 → DAP row 74a.
 * Czech dividends are taxed finally by withholding and are not reported.
 */
export function taxReturnGuide(year: number, limitExceeded: boolean, lots: GuideLot[], dividends: GuideDividend[]): TaxReturnGuide {
  let incomplete = false;
  const val = (v: number | null) => { if (v == null) { incomplete = true; return 0; } return v; };
  const ofYear = lots.filter((l) => l.closeDate.startsWith(`${year}-`));

  let annex2: TaxReturnGuide['annex2'] = null;
  const taxable = limitExceeded ? ofYear.filter((l) => !l.timeTestMet) : [];
  if (taxable.length) {
    const rows: Annex2Row[] = [];
    for (const [domestic, kind, code] of [[false, 'D – prodej cenných papírů (zahraniční)', 'z'], [true, 'D – prodej cenných papírů (tuzemské)', '']] as const) {
      const ls = taxable.filter((l) => isDomestic(l) === domestic);
      if (!ls.length) continue;
      const income = kc(ls.reduce((s, l) => s + val(l.proceedsCzk), 0));
      const expense = kc(ls.reduce((s, l) => s + val(l.costCzk), 0));
      rows.push({ kind, incomeCzk: income, expenseCzk: expense, diffCzk: income - expense, code });
    }
    const r207 = rows.reduce((s, r) => s + r.incomeCzk, 0);
    // Both lines are the same kind (D), so losses offset gains; expenses only up to the income (§10(4)).
    const r208 = Math.min(rows.reduce((s, r) => s + r.expenseCzk, 0), r207);
    annex2 = { rows, r207, r208, r209: r207 - r208 };
  }

  let annex4: TaxReturnGuide['annex4'] = null;
  const foreign = dividends.filter((d) => d.year === year && !isDomestic(d));
  if (foreign.length) {
    const r401a = kc(foreign.reduce((s, d) => s + val(d.grossCzk), 0));
    const withTax = foreign.filter((d) => (d.withholdingCzk ?? 0) > 0);
    const r411 = kc(withTax.reduce((s, d) => s + val(d.grossCzk), 0));
    const r412 = kc(withTax.reduce((s, d) => s + val(d.withholdingCzk), 0));
    const taxCzk = kc(r401a * TAX_RATE);
    const creditCzk = Math.min(r412, kc(r411 * TAX_RATE), taxCzk);
    if (r401a > 0) annex4 = { r401a, r411, r412, taxCzk, creditCzk, r414: taxCzk - creditCzk };
  }

  // §38v: each exempt income is judged separately – one sale = one ticker on one day.
  const exempt = new Map<string, number>();
  for (const l of ofYear) {
    if (!l.timeTestMet && limitExceeded) continue;
    const k = `${l.ticker}|${l.closeDate}`;
    exempt.set(k, (exempt.get(k) ?? 0) + (l.proceedsCzk ?? 0));
  }
  const exemptNoticeCzk = kc([...exempt.values()].filter((v) => v > EXEMPT_NOTICE_CZK).reduce((s, v) => s + v, 0));

  return { year, annex2, annex4, exemptNoticeCzk, incomplete };
}
