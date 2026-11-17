import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, paths } from './friendly.ts';
import { openDatabase, transaction } from '../db/database.ts';
import { rebuildT212 } from '../t212/store.ts';
import { Http, ALLOWED_HOSTS } from '../net/http.ts';
import { loadInstrumentConfig, logosEnabled, updateMarketData, type LogoStatus } from '../market/update.ts';
import { pragueDate } from '../analysis/calendar.ts';

const { db: dbPath, config: configPath, networkLog: auditLog, marketLog } = paths;

if (!existsSync(dbPath)) {
  fail('Zatím nejsou načtené žádné výpisy z XTB ani Trading 212.', ['Ulož výpis do složky data/input a spusť 2-vytvorit-nebo-aktualizovat-report-windows.cmd / 2-vytvorit-nebo-aktualizovat-report-mac.command.']);
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
  logos: logosEnabled(configPath),
});
// ISINs of XTB instruments are known now – the same instrument bought at Trading 212 joins the XTB holding.
transaction(db, () => rebuildT212(db));
db.close();

console.log(`\nKurzy ČNB: ${report.fxYears.length ? `${report.fxYears.join(', ')} (${report.fxRows} kurzů)` : 'aktuální'}`);
const SOURCE: Record<string, string> = {
  justetf: 'justETF', yahoo: 'Yahoo Finance', onvista: 'onvista', manual: 'ručně',
  isin: 'podle kódu země v ISIN', exchange: 'podle burzy', none: 'nestahují se',
};
const src = (s: string | null) => (s ? SOURCE[s] ?? s : 'neznámý');
const czDay = (d: string | null) => (d ? d.split('-').reverse().map((x, k) => (k < 2 ? String(Number(x)) : x)).join('. ') : '—');
// Console: one short line per instrument; where each piece of data came from goes to the log only.
const width = Math.max(0, ...report.instruments.map((i) => i.ticker.length));
const LOGO: Record<LogoStatus, string> = {
  downloaded: 'logo staženo', cached: 'logo z cache', missing: 'logo není k dispozici',
  failed: 'logo se nepodařilo stáhnout', off: 'loga vypnutá',
};
console.log(`Instrumenty (ticker, ISIN, poslední cena, logo; zdroje dat v ${marketLog}):`);
for (const i of report.instruments) {
  const price = i.lastPrice ? czDay(i.lastPrice) : 'bez ceny';
  console.log(`  ${i.ticker.padEnd(width)}  ${(i.isin ?? 'ISIN neznámý').padEnd(12)}  ${price.padEnd(11)}  ${LOGO[i.logo]}`);
}
const logoCount = (s: LogoStatus) => report.instruments.filter((i) => i.logo === s).length;
console.log(`Loga: staženo ${logoCount('downloaded')}, z cache ${logoCount('cached')}, není k dispozici ${logoCount('missing')}`
  + `${logoCount('failed') ? `, nepodařilo se stáhnout ${logoCount('failed')} (zkusí se příště)` : ''}`
  + `${logoCount('off') ? ' – stahování vypnuto ("$logos": false v data/instruments.json)' : ''}`);
mkdirSync(dirname(marketLog), { recursive: true });
writeFileSync(marketLog, [
  `Tržní data ${new Date().toISOString()}`,
  ...report.instruments.map((i) => [
    `${i.ticker} (ISIN ${i.isin ?? 'neznámý'})`,
    `  ceny: ${src(i.priceSource)}, staženo ${i.newPrices} denních cen, poslední cena z ${czDay(i.lastPrice)}`,
    `  země: ${src(i.countrySource)} · sektory: ${src(i.sectorSource)} · logo: ${LOGO[i.logo]} (Parqet)`,
  ].join('\n')),
  ...report.warnings.map((w) => `⚠ ${w}`),
].join('\n') + '\n', { mode: 0o600 });
for (const w of report.warnings) console.log(`⚠ ${w}`);
const unsafe = http.log.filter((e) => e.status === 'unsafe');
if (unsafe.length) {
  console.log(`\n⛔ Bezpečnostní kontrola: ${unsafe.length} ${unsafe.length === 1 ? 'odpověď obsahovala' : 'odpovědí obsahovalo'} podezřelý obsah (např. kód) a byly zahozeny:`);
  for (const e of unsafe) console.log(`  • ${new URL(e.url).hostname}: ${e.error}`);
  console.log('  Nic z nich se neuložilo, dotčené instrumenty mají poslední známé údaje nebo hodnotu z výpisu.');
  console.log('  Když se to opakuje, zdroj je nejspíš napadený nebo změnil formát – podrobnosti jsou v data/logs/network.log.');
}
const failedRequests = http.log.filter((e) => e.status === 'error').length;
console.log(`\nSíťových požadavků: ${http.log.length} (zablokovaných ${http.log.filter((e) => e.status === 'blocked').length}, nedostupných ${failedRequests})`);

if (http.log.length > 0 && failedRequests === http.log.length) {
  console.log('\n✗ Nepodařilo se spojit s žádným serverem – nejspíš nejde internet.');
  console.log('  Report se vytvoří s naposledy staženými cenami. Až bude internet, spusť znovu 2-vytvorit-nebo-aktualizovat-report.');
  process.exit(2);
}
if (report.warnings.length) {
  console.log('\nUpozornění výše report neblokují – u dotčených instrumentů jen bude chybět část údajů.');
  console.log('  • „nepodařilo se stáhnout“: server byl dočasně nedostupný → zkus 2-vytvorit-nebo-aktualizovat-report později.');
  console.log(`  • „doplň do data/instruments.json“: údaj se nedá zjistit automaticky → doplň ho ručně podle vzoru ${paths.configExample}`);
  if (!existsSync(configPath)) console.log('    (soubor data/instruments.json zatím neexistuje – zkopíruj vzor a uprav ho).');
}
