import { daysBetween, pragueDate } from './calendar.ts';
import type { OpenLot } from './lots.ts';
import type { PriceQuote } from './market.ts';

/** One data-validity check shown in the terminal and in the report. `info` = nothing wrong, just context. */
export interface DataCheck {
  status: 'ok' | 'warn' | 'info';
  title: string;
  detail: string;
}

export interface ValidationInput {
  today: string;
  /** XTB summary of open positions per account ("Open position value/profit"). */
  snapshots: { accountNumber: string; currency: string; asOf: string; value: number | null; profit: number | null }[];
  open: OpenLot[];
  priceAt: (ticker: string, date: string) => PriceQuote | null;
  /** Portfolio value in CZK from the XTB export alone vs. with downloaded prices (null = unknown). */
  xtbValueCzk: number | null;
  currentValueCzk: number | null;
  currentValueDate: string | null;
  missingRates: number;
  fifoMismatches: number;
  incompleteAccounts: string[];
}

/** XTB rounds to cents; anything beyond this is a real difference, not rounding. */
const SUM_TOLERANCE = (x: number) => Math.max(0.05, Math.abs(x) * 0.001);
const COST_TOLERANCE = (x: number) => Math.max(1, Math.abs(x) * 0.005);
/** Downloaded price vs. XTB price on the export day – larger gaps mean a wrong symbol, currency or pence/pound mix-up. */
export const PRICE_TOLERANCE_PCT = 5;
const STALE_EXPORT_DAYS = 31;
const BIG_MOVE_PCT = 15;

export function validatePortfolio(v: ValidationInput): DataCheck[] {
  const out: DataCheck[] = [];
  const num = (n: number, d = 2) => n.toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });
  const day = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${Number(d)}. ${Number(m)}. ${y}`;
  };

  for (const s of v.snapshots) {
    const lots = v.open.filter((l) => l.accountNumber === s.accountNumber);
    const acc = v.snapshots.length > 1 ? ` (účet ${s.accountNumber})` : '';
    const lotSum = lots.reduce((a, l) => a + (l.value ?? 0), 0);
    if (s.value == null) {
      out.push({ status: 'info', title: `Souhrn pozic${acc}`, detail: 'Výpis XTB neobsahuje souhrnnou hodnotu otevřených pozic, nejde ji porovnat.' });
    } else if (Math.abs(lotSum - s.value) <= SUM_TOLERANCE(s.value)) {
      out.push({ status: 'ok', title: `Pozice sedí se souhrnem XTB${acc}`, detail: `Součet ${lots.length} nákupů ${num(lotSum)} ${s.currency} = hodnota otevřených pozic ve výpisu.` });
    } else {
      out.push({
        status: 'warn',
        title: `Pozice nesedí se souhrnem XTB${acc}`,
        detail: `Součet nákupů ${num(lotSum)} ${s.currency}, souhrn výpisu ${num(s.value)} ${s.currency} (rozdíl ${num(lotSum - s.value)}). ` +
          'Výpis je nejspíš neúplný nebo upravený v Excelu – stáhni ho z xStation znovu.',
      });
    }
    if (s.value != null && s.profit != null) {
      const cost = lots.reduce((a, l) => a + l.cost, 0);
      const xtbCost = s.value - s.profit;
      const diff = cost - xtbCost;
      out.push(Math.abs(diff) <= COST_TOLERANCE(xtbCost)
        ? { status: 'ok', title: `Nákupní ceny sedí s XTB${acc}`, detail: `Investováno ${num(cost)} ${s.currency}, podle XTB ${num(xtbCost)} ${s.currency}.` }
        : {
          status: 'warn',
          title: `Nákupní ceny nesedí s XTB${acc}`,
          detail: `Spočteno ${num(cost)} ${s.currency}, podle XTB ${num(xtbCost)} ${s.currency} (rozdíl ${num(diff)}). ` +
            'Rozdíl bývá v poplatcích za konverzi měny; jinak chybí v historii část nákupů – nahraj export za celé období.',
        });
    }
  }

  // Downloaded prices vs. XTB's own price on the export day.
  const xtbPrices = new Map<string, { price: number; date: string }>();
  for (const l of v.open) {
    const snap = v.snapshots.find((s) => s.accountNumber === l.accountNumber);
    if (l.currentPrice != null && snap) xtbPrices.set(l.ticker, { price: l.currentPrice, date: pragueDate(snap.asOf) });
  }
  const off: string[] = [];
  const missing: string[] = [];
  let maxDev = 0;
  for (const [ticker, x] of [...xtbPrices.entries()].sort()) {
    const q = v.priceAt(ticker, x.date);
    if (!q) {
      missing.push(ticker);
      continue;
    }
    const dev = (q.close / x.price - 1) * 100;
    maxDev = Math.max(maxDev, Math.abs(dev));
    if (Math.abs(dev) > PRICE_TOLERANCE_PCT) off.push(`${ticker} ${num(q.close)} ${q.currency} vs XTB ${num(x.price)} (${dev > 0 ? '+' : ''}${num(dev, 1)} %)`);
  }
  if (off.length) {
    out.push({
      status: 'warn',
      title: 'Stažené ceny nesedí s XTB',
      detail: `${off.join('; ')}. Nejspíš špatný symbol nebo měna – oprav "yahooSymbol" / "isin" v data/instruments.json, nebo nastav "priceSource": "none".`,
    });
  } else if (xtbPrices.size > missing.length) {
    out.push({
      status: 'ok',
      title: 'Stažené ceny sedí s XTB',
      detail: `${xtbPrices.size - missing.length} instrumentů, odchylka od ceny ve výpisu nejvýš ${num(maxDev, 1)} %.`,
    });
  }
  if (missing.length) {
    out.push({
      status: 'info',
      title: 'Bez stažené ceny ke dni výpisu',
      detail: `${missing.join(', ')} – hodnota se bere z výpisu XTB a nejde ověřit proti burze.`,
    });
  }

  const asOf = v.snapshots.map((s) => pragueDate(s.asOf)).sort()[0];
  if (asOf) {
    const age = daysBetween(asOf, v.today);
    out.push(age > STALE_EXPORT_DAYS
      ? { status: 'warn', title: 'Starý výpis', detail: `Pozice jsou podle výpisu z ${day(asOf)} (před ${age} dny). Nákupy a prodeje od té doby v reportu nejsou – stáhni nový export.` }
      : { status: 'ok', title: 'Výpis je aktuální', detail: `Pozice podle výpisu z ${day(asOf)}${v.currentValueDate ? `, ceny k ${day(v.currentValueDate)}` : ''}.` });
  }

  if (v.xtbValueCzk != null && v.currentValueCzk != null && v.xtbValueCzk > 0 && asOf && v.currentValueDate && v.currentValueDate > asOf) {
    const move = (v.currentValueCzk / v.xtbValueCzk - 1) * 100;
    const detail = `Podle výpisu ${num(v.xtbValueCzk, 0)} Kč, podle stažených cen ${num(v.currentValueCzk, 0)} Kč (${move > 0 ? '+' : ''}${num(move, 1)} %).`;
    out.push(Math.abs(move) > BIG_MOVE_PCT
      ? { status: 'warn', title: 'Velká změna hodnoty od výpisu', detail: `${detail} Zkontroluj, jestli to odpovídá trhu; jinak je chyba ve stažených cenách.` }
      : { status: 'info', title: 'Změna hodnoty od výpisu', detail });
  }

  out.push(v.missingRates
    ? { status: 'warn', title: 'Chybí kurzy ČNB', detail: `Pro ${v.missingRates} dní chybí kurz – částky v Kč/€ a daně jsou neúplné. Spusť 2-vytvorit-report s připojením k internetu.` }
    : { status: 'ok', title: 'Kurzy ČNB kompletní', detail: 'Každý nákup i prodej má kurz ČNB ke dni obchodu.' });
  out.push(v.fifoMismatches
    ? { status: 'warn', title: 'Párování prodejů nesedí s FIFO', detail: `${v.fifoMismatches} prodejů XTB spárovalo jinak než metodou FIFO – zkontroluj daně u těchto prodejů.` }
    : { status: 'ok', title: 'Párování prodejů odpovídá FIFO', detail: 'XTB prodává nejstarší kusy jako první, výpočet daní to předpokládá.' });
  out.push(v.incompleteAccounts.length
    ? { status: 'warn', title: 'Neúplná historie účtu', detail: `Účet ${v.incompleteAccounts.join(', ')}: peněžní operace začínají až po prvním nákupu – nahraj export za celé období.` }
    : { status: 'ok', title: 'Historie účtu je úplná', detail: 'Peněžní operace pokrývají celé období od prvního nákupu.' });
  return out;
}
