import { readdirSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { HOW_TO_EXPORT, errorText, paths, printSteps } from './friendly.ts';
import { openDatabase } from '../db/database.ts';
import { importFile, type ImportReport } from '../importer.ts';
import { XtbFormatError } from '../xtb/accountHistory.ts';

const inputDir = paths.input;
const dbPath = paths.db;

mkdirSync(inputDir, { recursive: true });
const all = readdirSync(inputDir).filter((f) => !f.startsWith('.'));
const files = all.filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$')).sort();
const ignored = all.filter((f) => !files.includes(f) && !f.startsWith('~$'));
if (ignored.length) {
  console.log(`Přeskakuji soubory, které nejsou XLSX: ${ignored.join(', ')}`);
  if (ignored.some((f) => ['.pdf', '.xls', '.csv'].includes(extname(f).toLowerCase()))) {
    console.log('  (PDF, CSV ani starý formát XLS program neumí – z xStation stáhni export historie účtu ve formátu XLSX.)');
  }
}
if (all.some((f) => f.startsWith('~$'))) console.log('Některý výpis je otevřený v Excelu – pro jistotu Excel zavři.');

if (files.length === 0) {
  console.log(`Ve složce ${inputDir} nejsou žádné výpisy (.xlsx).`);
  printSteps('Jak výpis získat:', HOW_TO_EXPORT);
  process.exit(0);
}

const db = openDatabase(dbPath);
let failed = false;
for (const file of files) {
  try {
    printReport(importFile(db, join(inputDir, file)));
  } catch (e) {
    failed = true;
    console.error(`✗ ${file}: soubor se nepodařilo načíst.`);
    console.error(`  Důvod: ${errorText(e)}`);
    console.error(`  Co dělat: ${adviceFor(e)}`);
  }
}

const totals = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM accounts) accounts, (SELECT COUNT(*) FROM instruments) instruments,
            (SELECT COUNT(*) FROM cash_operations) cash, (SELECT COUNT(*) FROM closed_lots) closed,
            (SELECT COUNT(*) FROM open_lots) open`,
  )
  .get() as Record<string, number>;
console.log(
  `\nV databázi je: účty ${totals.accounts}, instrumenty ${totals.instruments}, ` +
    `peněžní operace ${totals.cash}, uzavřené loty ${totals.closed}, otevřené loty ${totals.open}`,
);
db.close();
process.exit(failed ? 1 : 0);

function adviceFor(e: unknown): string {
  if (/měnu/.test(errorText(e))) {
    return 'soubor patří k jinému podúčtu se stejným číslem, nebo je upravený. Stáhni ho z xStation znovu; když to nepomůže, soubor ze složky data/input odeber.';
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
