import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../db/database.ts';
import { Http, ALLOWED_HOSTS } from '../net/http.ts';
import { loadInstrumentConfig, updateMarketData } from '../market/update.ts';
import { pragueDate } from '../analysis/calendar.ts';

const root = resolve(import.meta.dirname, '../..');
const dbPath = join(root, 'data/stockera.db');
const configPath = join(root, 'data/instruments.json');
const auditLog = join(root, 'data/logs/network.log');

if (!existsSync(dbPath)) {
  console.error('Databáze neexistuje – nejdřív spusť `pnpm ingest`.');
  process.exit(1);
}

console.log(`Stahuji tržní data. Povolené servery: ${[...ALLOWED_HOSTS].join(', ')}`);
console.log(`Odesílají se jen tickery, ISINy a data. Log všech požadavků: ${auditLog}\n`);

const db = openDatabase(dbPath);
const http = new Http({ auditLog });
const report = await updateMarketData(db, http, {
  today: pragueDate(new Date().toISOString()),
  config: loadInstrumentConfig(configPath),
  log: (m) => console.log(`  ${m}`),
});
db.close();

console.log(`\nKurzy ČNB: ${report.fxYears.length ? `${report.fxYears.join(', ')} (${report.fxRows} kurzů)` : 'aktuální'}`);
console.log('Instrumenty:');
for (const i of report.instruments) {
  console.log(
    `  ${i.ticker.padEnd(9)} ISIN ${(i.isin ?? '—').padEnd(12)}  ceny ${(i.priceSource ?? '—').padEnd(7)} +${String(i.newPrices).padStart(4)} ` +
      `(poslední ${i.lastPrice ?? '—'})  země: ${i.countrySource ?? '—'}`,
  );
}
for (const w of report.warnings) console.log(`⚠ ${w}`);
console.log(`\nSíťových požadavků: ${http.log.length} (zablokovaných ${http.log.filter((e) => e.status === 'blocked').length})`);
if (!existsSync(configPath)) console.log('Tip: ruční doplnění ISIN/zemí → zkopíruj config/instruments.example.json do data/instruments.json');
