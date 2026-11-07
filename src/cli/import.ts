import { readdirSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { HOW_TO_EXPORT, errorText, paths, printSteps } from './friendly.ts';
import { openDatabase } from '../db/database.ts';
import { importFile, type ImportReport } from '../importer.ts';
import { XtbFormatError } from '../xtb/accountHistory.ts';
import { T212FormatError } from '../t212/history.ts';

const inputDir = paths.input;
const dbPath = paths.db;

mkdirSync(inputDir, { recursive: true });
const all = readdirSync(inputDir).filter((f) => !f.startsWith('.'));
const files = all.filter((f) => ['.xlsx', '.csv'].includes(extname(f).toLowerCase()) && !f.startsWith('~$')).sort();
const ignored = all.filter((f) => !files.includes(f) && !f.startsWith('~$'));
if (ignored.length) {
  console.log(`Přeskakuji soubory, které nejsou XLSX (XTB) ani CSV (Trading 212): ${ignored.join(', ')}`);
  if (ignored.some((f) => ['.pdf', '.xls'].includes(extname(f).toLowerCase()))) {
    console.log('  (PDF ani starý formát XLS program neumí – z xStation stáhni export historie účtu ve formátu XLSX.)');
  }
}
if (all.some((f) => f.startsWith('~$'))) console.log('Některý výpis je otevřený v Excelu – pro jistotu Excel zavři.');

if (files.length === 0) {
  console.log(`Ve složce ${inputDir} nejsou žádné výpisy (.xlsx z XTB, .csv z Trading 212).`);
  printSteps('Jak výpis získat:', HOW_TO_EXPORT);
  process.exit(0);
}

const db = openDatabase(dbPath);
const before = counts();
const reports: ImportReport[] = [];
const failedFiles: string[] = [];
for (const file of files) {
  try {
    const r = importFile(db, join(inputDir, file));
    reports.push(r);
    printReport(r);
  } catch (e) {
    failedFiles.push(file);
    console.error(`✗ ${file}: soubor se nepodařilo načíst.`);
    console.error(`  Důvod: ${errorText(e)}`);
    console.error(`  Co dělat: ${adviceFor(e)}`);
  }
}

printSummary(reports, failedFiles, before, counts());
db.close();
process.exit(failedFiles.length ? 1 : 0);

function counts(): Record<'accounts' | 'instruments' | 'cash' | 'closed' | 'open', number> {
  return { ...db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM accounts) accounts, (SELECT COUNT(*) FROM instruments) instruments,
              (SELECT COUNT(*) FROM cash_operations) cash, (SELECT COUNT(*) FROM closed_lots) closed,
              (SELECT COUNT(*) FROM open_lots) open`,
    )
    .get() as Record<'accounts' | 'instruments' | 'cash' | 'closed' | 'open', number> };
}

/** Totals over all files so the user can check the import at a glance: what is new, what was already known. */
function printSummary(rs: ImportReport[], failed: string[], b: ReturnType<typeof counts>, a: ReturnType<typeof counts>): void {
  const n = (s: ImportReport['status']) => rs.filter((r) => r.status === s).length;
  const sum = (f: (r: ImportReport) => number) => rs.reduce((x, r) => x + f(r), 0);
  const cashNew = sum((r) => r.cash.inserted);
  const cashDup = sum((r) => r.cash.duplicates);
  const closedNew = sum((r) => r.closed.inserted);
  const closedDup = sum((r) => r.closed.duplicates);
  const snapshot = rs.find((r) => r.openPositions === 'replaced');
  const pad = (s: string) => s.padEnd(20);
  console.log('\nShrnutí importu');
  console.log(`  ${pad('Soubory')}${files.length} celkem: ${n('imported')} nových, ${n('already-imported')} načtených už dříve` +
    `${n('unsupported') ? `, ${n('unsupported')} přeskočených` : ''}${failed.length ? `, ${failed.length} s chybou` : ''}`);
  console.log(`  ${pad('Peněžní operace')}${cashNew} nových, ${cashDup} už v databázi (přepoužito)`);
  console.log(`  ${pad('Prodeje')}${closedNew} nových, ${closedDup} už v databázi (přepoužito)`);
  console.log(`  ${pad('Otevřené pozice')}${snapshot ? `nahrazeny stavem z ${snapshot.file} (${a.open} nákupů, dříve ${b.open})` : `beze změny (${a.open} nákupů)`}`);
  console.log(`  ${pad('V databázi celkem')}účty ${a.accounts}, instrumenty ${a.instruments} (${plus(a.instruments - b.instruments)}), ` +
    `peněžní operace ${a.cash} (${plus(a.cash - b.cash)}), prodeje ${a.closed} (${plus(a.closed - b.closed)}), otevřené nákupy ${a.open}`);
  // Each new row must come from exactly one file; anything else would mean a lost or double-counted record.
  const consistent = a.cash - b.cash === cashNew && a.closed - b.closed === closedNew;
  console.log(consistent
    ? '  ✓ Počty sedí: každý nový záznam je v databázi právě jednou, duplicity z překrývajících se výpisů se přeskočily.'
    : '  ⚠ Počty v databázi nesedí s načtenými soubory – smaž data/stockera.db a spusť aktualizaci znovu (výpisy zůstanou v data/input).');
  if (!n('imported') && !failed.length) console.log('  Nic nového – všechny výpisy už byly načtené dříve.');
}

function plus(d: number): string {
  return d > 0 ? `+${d}` : '±0';
}

function adviceFor(e: unknown): string {
  if (/měnu/.test(errorText(e))) {
    return 'soubor patří k jinému podúčtu se stejným číslem, nebo je upravený. Stáhni ho z xStation znovu; když to nepomůže, soubor ze složky data/input odeber.';
  }
  if (e instanceof T212FormatError) {
    return 'nejde o export historie z Trading 212, nebo je soubor upravený (např. uložený z Excelu). Stáhni export znovu (Historie → Export) a nijak ho neupravuj; ostatní soubory se načetly normálně.';
  }
  if (e instanceof XtbFormatError || /ZIP|XLSX|workbook|Sheet/i.test(errorText(e))) {
    return 'nejde o export historie účtu z xStation, nebo je soubor poškozený či upravený v Excelu. Stáhni export znovu a nijak ho neupravuj; ostatní soubory se načetly normálně.';
  }
  return 'stáhni výpis z xStation znovu a spusť aktualizaci ještě jednou. Ostatní soubory se načetly normálně.';
}

function printReport(r: ImportReport): void {
  const icon = r.status === 'imported' ? '✓' : r.status === 'already-imported' ? '=' : '!';
  const label = { imported: 'importováno', 'already-imported': 'již importováno dříve', unsupported: 'přeskočeno' }[r.status];
  console.log(`${icon} ${r.file}: ${label}`);
  if (r.status === 'imported') {
    console.log(`  účet ${r.accountNumber} (${r.currency ?? 'měna neznámá'}), období ${day(r.periodFrom)} – ${day(r.periodTo)}`);
    console.log(`  peněžní operace: ${r.cash.inserted} nových, ${r.cash.duplicates} duplicitních`);
    console.log(`  uzavřené loty: ${r.closed.inserted} nových, ${r.closed.duplicates} duplicitních`);
    const open = { replaced: 'aktualizovány', 'older-than-stored': 'starší než uložené – ponechány', none: 'v souboru nejsou' };
    console.log(`  otevřené pozice: ${open[r.openPositions]}`);
  }
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  if (r.status === 'unsupported') console.log('  Tento soubor můžeš ze složky data/input odebrat – program ho nepotřebuje.');
}

function day(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' }) : '?';
}
