import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, paths, printChecks } from './friendly.ts';
import { openDatabase } from '../db/database.ts';
import { analyze } from '../analysis/portfolio.ts';
import { buildReport } from '../report/build.ts';

const { db: dbPath, report: outPath } = paths;

if (!existsSync(dbPath)) {
  fail('Zatím nejsou načtené žádné výpisy z XTB ani Trading 212.', ['Ulož výpis do složky data/input a spusť aktualizaci (aktualizovat-windows.cmd / aktualizovat-mac.command).']);
}

const db = openDatabase(dbPath);
const analysis = analyze(db);
db.close();
printChecks(analysis.checks.validation);

const password = await getPassword();

console.log('Šifruji report…');
const html = await buildReport(analysis, password);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
console.log(`✓ Report je uložený: ${outPath} (${(html.length / 1024).toFixed(0)} kB)`);

async function getPassword(): Promise<string> {
  const fromEnv = process.env.STOCKERA_PASSWORD;
  delete process.env.STOCKERA_PASSWORD;
  if (fromEnv) {
    console.warn('⚠ Heslo z proměnné STOCKERA_PASSWORD může zůstat v historii příkazů – bezpečnější je zadat ho interaktivně.');
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    fail('Nejde se zeptat na heslo – program neběží v okně terminálu.', [
      'Spusť aktualizaci dvojklikem na aktualizovat-windows.cmd / aktualizovat-mac.command.',
    ]);
  }
  console.log('\nZvol heslo, kterým budeš report otevírat. Potvrď klávesou Enter.');
  console.log('Heslo si zapamatuj; když ho zapomeneš, stačí znovu spustit aktualizaci a zvolit nové.\n');
  for (;;) {
    const first = await promptHidden('Heslo: ');
    if (!first) {
      console.log('✗ Heslo nesmí být prázdné. Zkus to znovu.\n');
      continue;
    }
    const second = await promptHidden('Pro kontrolu ještě jednou: ');
    if (first === second) return first;
    console.log('✗ Hesla se neshodují (nejspíš překlep). Zadej obě znovu.\n');
  }
}

/** Reads a line, echoing `*` per character (raw mode works in macOS/Linux terminals and Windows Terminal/cmd/PowerShell). */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((done) => {
    let buf = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      done(buf);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf) {
            buf = [...buf].slice(0, -1).join('');
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}
