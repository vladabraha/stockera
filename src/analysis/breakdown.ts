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
