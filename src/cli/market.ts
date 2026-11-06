import { existsSync } from 'node:fs';
import { fail, paths } from './friendly.ts';
import { openDatabase } from '../db/database.ts';
import { Http, ALLOWED_HOSTS } from '../net/http.ts';
import { loadInstrumentConfig, updateMarketData } from '../market/update.ts';
import { pragueDate } from '../analysis/calendar.ts';

const { db: dbPath, config: configPath, networkLog: auditLog } = paths;

if (!existsSync(dbPath)) {
  fail('Zatím nejsou načtené žádné výpisy z XTB.', ['Ulož výpis do složky data/input a spusť aktualizaci (aktualizovat-windows.cmd / aktualizovat-mac.command).']);
}

console.log(`Stahuji tržní data. Povolené servery: ${[...ALLOWED_HOSTS].join(', ')}`);
console.log(`Odesílají se jen tickery, ISINy a data. Log všech požadavků: ${auditLog}\n`);

const db = openDatabase(dbPath);
const http = new Http({ auditLog });
let config;
try {
  config = loadInstrumentConfig(configPath);
} catch (e) {
  fail(`Soubor ${configPath} má chybu a nejde přečíst (${(e as Error).message}).`, [
    'Otevři ho v textovém editoru a oprav chybu – nejčastěji chybějící čárka, uvozovka nebo závorka.',
    `Správný tvar je vidět ve vzoru ${paths.configExample}.`,
    'Případně soubor dočasně přejmenuj – program poběží bez ručních doplnění.',
  ]);
}
const report = await updateMarketData(db, http, {
  today: pragueDate(new Date().toISOString()),
  config,
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
const failedRequests = http.log.filter((e) => e.status === 'error').length;
console.log(`\nSíťových požadavků: ${http.log.length} (zablokovaných ${http.log.filter((e) => e.status === 'blocked').length}, nedostupných ${failedRequests})`);

if (http.log.length > 0 && failedRequests === http.log.length) {
  console.log('\n✗ Nepodařilo se spojit s žádným serverem – nejspíš nejde internet.');
  console.log('  Report se vytvoří s naposledy staženými cenami. Až bude internet, spusť aktualizaci znovu.');
  process.exit(2);
}
if (report.warnings.length) {
  console.log('\nUpozornění výše report neblokují – u dotčených instrumentů jen bude chybět část údajů.');
  console.log('  • „nepodařilo se stáhnout“: server byl dočasně nedostupný → zkus aktualizaci později.');
  console.log(`  • „doplň do data/instruments.json“: údaj se nedá zjistit automaticky → doplň ho ručně podle vzoru ${paths.configExample}`);
  if (!existsSync(configPath)) console.log('    (soubor data/instruments.json zatím neexistuje – zkopíruj vzor a uprav ho).');
}
