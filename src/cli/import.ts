import { readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../db/database.ts';
import { importFile, type ImportReport } from '../importer.ts';

const root = resolve(import.meta.dirname, '../..');
const inputDir = join(root, 'data/input');
const dbPath = join(root, 'data/stockera.db');

mkdirSync(inputDir, { recursive: true });
const files = readdirSync(inputDir)
  .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
  .sort();

if (files.length === 0) {
  console.log(`Ve složce ${inputDir} nejsou žádné .xlsx soubory.`);
  process.exit(0);
}

const db = openDatabase(dbPath);
let failed = false;
for (const file of files) {
  try {
    printReport(importFile(db, join(inputDir, file)));
  } catch (e) {
    failed = true;
    console.error(`✗ ${file}: ${e instanceof Error ? e.message : String(e)}`);
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
  `\nDatabáze ${dbPath}: účty ${totals.accounts}, instrumenty ${totals.instruments}, ` +
    `peněžní operace ${totals.cash}, uzavřené loty ${totals.closed}, otevřené loty ${totals.open}`,
);
db.close();
process.exit(failed ? 1 : 0);

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
}

function day(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' }) : '?';
}
