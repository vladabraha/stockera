import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, printChecks } from './friendly.ts';
import { openDatabase } from '../db/database.ts';
import { analyze, type Analysis } from '../analysis/portfolio.ts';
import type { Percent, Totals } from '../analysis/fx.ts';

const root = resolve(import.meta.dirname, '../..');
const dbPath = join(root, 'data/stockera.db');
const outDir = join(root, 'out');

if (!existsSync(dbPath)) {
  fail('Zatím nejsou načtené žádné výpisy z XTB ani Trading 212.', ['Ulož výpis do složky data/input a spusť `pnpm ingest`.']);
}

const db = openDatabase(dbPath);
const a = analyze(db);
db.close();

const jsonPath = join(outDir, 'analysis.json');
print(a);
if (process.argv.includes('--json')) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(a, null, 2), { mode: 0o600 });
  console.log(`\nKompletní výsledek: ${jsonPath}`);
  console.log('⚠ Soubor je NEŠIFROVANÝ (celé portfolio i čísla účtů) – po použití ho smaž.');
} else if (existsSync(jsonPath)) {
  rmSync(jsonPath);
  console.log(`\nSmazán starý nešifrovaný ${jsonPath} (nový vytvoří \`pnpm analyze --json\`).`);
}

function print(a: Analysis): void {
  const asOf = a.summary.valueDate ? ` (ocenění k ${czDate(a.summary.valueDate)})` : '';
  console.log(`\n=== PORTFOLIO${asOf} ===`);
  console.log(`Hodnota ${t(a.summary.value)} | nákup ${t(a.summary.cost)} | zisk ${t(a.summary.unrealizedProfit)} ${pct(a.summary.unrealizedPct)}`);
  console.log(`Realizovaný zisk ${t(a.summary.realizedProfit)} | dividendy ${t(a.summary.dividendsNet)} | vklady ${t(a.summary.deposits)} | výběry ${t(a.summary.withdrawals)}`);

  console.log('\n--- Držené instrumenty ---');
  for (const h of a.holdings) {
    const next = h.nextTaxFreeDate ? `, další bez daně od ${czDate(h.nextTaxFreeDate)}` : '';
    console.log(
      `${h.ticker.padEnd(9)} ${(h.name ?? '').slice(0, 28).padEnd(28)} ${fmt(h.quantity, 4).padStart(10)} ks  ` +
        `hodnota ${t(h.value)}  zisk ${t(h.profit)} ${pct(h.profitPct)}  bez daně ${fmt(h.taxFreeQuantity, 4)} ks${next}`,
    );
  }

  console.log('\n--- Země (podle složení ETF) ---');
  const regionName = new Intl.DisplayNames('cs', { type: 'region' });
  const country = (c: string) => (c === 'XX' ? 'Ostatní' : c === '??' ? 'Neznámé složení' : regionName.of(c) ?? c);
  console.log(a.geography.map((g) => `${country(g.country)} ${fmt(g.share, 1)} %`).join(', '));
  const unknown = a.holdings.filter((h) => !h.countries.length).map((h) => h.ticker);
  if (unknown.length) console.log(`  bez složení: ${unknown.join(', ')} → doplň "countries" do data/instruments.json`);
  if (a.history.length) {
    const last = a.history[a.history.length - 1]!;
    console.log(`Vývoj hodnoty: ${a.history.length} dní od ${czDate(a.history[0]!.date)} do ${czDate(last.date)}`);
  }

  console.log('\n--- Prodané ---');
  for (const r of a.realized) {
    console.log(
      `${r.ticker.padEnd(9)} ${(r.name ?? '').slice(0, 28).padEnd(28)} ${fmt(r.quantity, 4).padStart(8)} ks  ` +
        `prodáno za ${t(r.proceeds)}  zisk ${t(r.profit)} ${pct(r.profitPct)}  (${czDate(r.firstSale)} – ${czDate(r.lastSale)})`,
    );
    for (const l of r.lots) {
      console.log(
        `    ${czDate(l.openDate)} → ${czDate(l.closeDate)}  ${fmt(l.quantity, 4).padStart(8)} ks  ` +
          `${fmt(l.cost.native)} → ${fmt(l.proceeds.native)} ${l.cost.currency}  zisk ${fmt(l.profit.native)} ${pct(l.profitPct)}` +
          `${l.timeTestMet ? '  ✓ časový test' : ''}`,
      );
    }
  }

  console.log('\n--- Daně z prodejů ---');
  for (const y of a.taxYears) {
    const limit = {
      within: `prodeje bez časového testu v limitu 100 000 Kč (zbývá ${fmt(y.limitRemainingCzk ?? 0, 0)} Kč) → osvobozeno`,
      exceeded: 'limit 100 000 Kč překročen',
      unknown: 'limit nelze posoudit – chybí kurzy ČNB',
    }[y.limitStatus];
    console.log(`${y.year}: ${y.salesCount} prodejů, příjmy ${t(y.proceeds)} – ${limit}`);
    if (y.limitStatus === 'exceeded') {
      console.log(`      zdanitelné prodeje ${y.taxable.count}, základ daně ${fmt(y.taxable.baseCzk ?? 0, 0)} Kč, daň 15 % ${fmt(y.taxable.taxCzk ?? 0, 0)} Kč`);
    }
    if (y.timeTestCapExceeded) console.log('      ⚠ překročen strop 40 mil. Kč pro časový test (2025)');
  }

  console.log('\n--- Peněžní toky ---');
  for (const c of a.cashFlows) {
    const kinds = Object.entries(c.byKind).map(([k, v]) => `${k} ${fmt(v.native[c.currency] ?? 0)}`).join(', ');
    console.log(`Účet ${c.accountNumber} (${c.currency}): zůstatek ${fmt(c.balance)} | ${kinds}${c.historyComplete ? '' : ' | ⚠ neúplná historie'}`);
  }

  const { fifoMismatches, missingRates, warnings } = a.checks;
  console.log('\n--- Kontroly ---');
  console.log(fifoMismatches.length ? `⚠ ${fifoMismatches.length} prodejů XTB nespárovalo metodou FIFO:` : '✓ Párování XTB odpovídá FIFO');
  for (const m of fifoMismatches) {
    const lots = (xs: typeof m.xtb) => xs.map((x) => `${x.positionId}×${fmt(x.volume, 4)}`).join(', ');
    console.log(`  ${m.ticker} ${czDate(m.saleTime.slice(0, 10))}: XTB [${lots(m.xtb)}] vs FIFO [${lots(m.fifo)}]`);
  }
  if (missingRates.length) {
    console.log(`⚠ Chybí kurzy ČNB pro ${missingRates.length} dní (doplní fáze 3) – částky v Kč/EUR a daně nejsou k dispozici.`);
  }
  for (const w of warnings) console.log(`⚠ ${w}`);
  printChecks(a.checks.validation);
}

function t(x: Totals): string {
  if (x.czk != null) return `${fmt(x.czk, 0)} Kč / ${fmt(x.eur ?? 0)} €`;
  const parts = Object.entries(x.native).map(([c, v]) => `${fmt(v)} ${c}`);
  return parts.length ? parts.join(' + ') : '0';
}

function pct(p: Percent): string {
  const v = p.czk ?? p.native;
  return v == null ? '' : `(${v >= 0 ? '+' : ''}${fmt(v)} %)`;
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function czDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${Number(day)}. ${Number(m)}. ${y}`;
}
