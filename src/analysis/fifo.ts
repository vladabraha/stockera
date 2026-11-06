import type { ClosedLot, OpenLot } from './lots.ts';

export interface LotAllocation {
  positionId: string;
  openTime: string;
  volume: number;
}

export interface FifoMismatch {
  accountNumber: string;
  ticker: string;
  saleTime: string;
  xtb: LotAllocation[];
  fifo: LotAllocation[];
}

const SAME_SALE_WINDOW_MS = 5_000;
const EPS = 1e-6;

/**
 * Compares XTB's pairing of each sale with the FIFO pairing (per account and ticker).
 * After each sale the actual (XTB) consumption is applied, so every mismatch is reported independently.
 */
export function checkFifo(closed: ClosedLot[], open: OpenLot[]): FifoMismatch[] {
  const groups = new Map<string, { closed: ClosedLot[]; open: OpenLot[] }>();
  const group = (acc: string, ticker: string) => {
    const key = `${acc}|${ticker}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { closed: [], open: [] }));
    return g;
  };
  for (const c of closed) group(c.accountNumber, c.ticker).closed.push(c);
  for (const o of open) group(o.accountNumber, o.ticker).open.push(o);

  const mismatches: FifoMismatch[] = [];
  for (const g of groups.values()) {
    const lots = new Map<string, { openTime: string; remaining: number }>();
    const addLot = (pos: string, openTime: string, vol: number) => {
      const l = lots.get(pos);
      if (l) l.remaining += vol;
      else lots.set(pos, { openTime, remaining: vol });
    };
    for (const c of g.closed) addLot(c.positionId, c.openTime, c.volume);
    for (const o of g.open) addLot(o.positionId, o.openTime, o.volume);
    const ordered = [...lots.entries()].sort(([pa, a], [pb, b]) => a.openTime.localeCompare(b.openTime) || pa.localeCompare(pb));

    for (const sale of groupSales(g.closed)) {
      const saleTime = sale[0]!.closeTime;
      const xtb = sale.map((c) => ({ positionId: c.positionId, openTime: c.openTime, volume: c.volume }));
      let need = sale.reduce((a, c) => a + c.volume, 0);
      const fifo: LotAllocation[] = [];
      for (const [pos, l] of ordered) {
        if (need <= EPS) break;
        if (l.remaining <= EPS || l.openTime > saleTime) continue;
        const take = Math.min(l.remaining, need);
        fifo.push({ positionId: pos, openTime: l.openTime, volume: take });
        need -= take;
      }
      if (!sameAllocation(xtb, fifo)) {
        mismatches.push({ accountNumber: sale[0]!.accountNumber, ticker: sale[0]!.ticker, saleTime, xtb, fifo });
      }
      for (const c of sale) lots.get(c.positionId)!.remaining -= c.volume;
    }
  }
  return mismatches.sort((a, b) => a.saleTime.localeCompare(b.saleTime));
}

/** Groups closed lots of one account+ticker into sale events (lots closed within a few seconds). */
function groupSales(closed: ClosedLot[]): ClosedLot[][] {
  const sorted = [...closed].sort((a, b) => a.closeTime.localeCompare(b.closeTime));
  const sales: ClosedLot[][] = [];
  let lastTime = -Infinity;
  for (const c of sorted) {
    const t = Date.parse(c.closeTime);
    if (t - lastTime > SAME_SALE_WINDOW_MS || sales.length === 0) sales.push([c]);
    else sales[sales.length - 1]!.push(c);
    lastTime = t;
  }
  return sales;
}

function sameAllocation(a: LotAllocation[], b: LotAllocation[]): boolean {
  const sum = (xs: LotAllocation[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x.positionId, (m.get(x.positionId) ?? 0) + x.volume);
    return m;
  };
  const ma = sum(a);
  const mb = sum(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (Math.abs(v - (mb.get(k) ?? 0)) > EPS) return false;
  return true;
}
