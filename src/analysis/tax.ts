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
