import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../db/database.ts';
import { analyze } from '../analysis/portfolio.ts';
import { buildReport } from '../report/build.ts';

const root = resolve(import.meta.dirname, '../..');
const dbPath = join(root, 'data/stockera.db');
const outPath = join(root, 'out/stockera.html');
const MIN_LENGTH = 8;

if (!existsSync(dbPath)) {
  console.error('Databáze neexistuje – nejdřív spusť `pnpm ingest`.');
  process.exit(1);
}

const password = await getPassword();
const db = openDatabase(dbPath);
const analysis = analyze(db);
db.close();

console.log('Šifruji report…');
const html = await buildReport(analysis, password);
mkdirSync(join(root, 'out'), { recursive: true });
writeFileSync(outPath, html);
console.log(`Hotovo: ${outPath} (${(html.length / 1024).toFixed(0)} kB)`);
console.log('Soubor otevři v prohlížeči (funguje offline, i na mobilu). Heslo se nikam neukládá.');

async function getPassword(): Promise<string> {
  const fromEnv = process.env.STOCKERA_PASSWORD;
  if (fromEnv) return check(fromEnv);
  if (!process.stdin.isTTY) {
    console.error('Chybí heslo: spusť příkaz v terminálu, nebo nastav proměnnou STOCKERA_PASSWORD.');
    process.exit(1);
  }
  for (;;) {
    const first = await promptHidden('Heslo pro report: ');
    if (first.length < MIN_LENGTH) {
      console.log(`Heslo musí mít aspoň ${MIN_LENGTH} znaků.`);
      continue;
    }
    const second = await promptHidden('Heslo znovu: ');
    if (first === second) return first;
    console.log('Hesla se neshodují, zkus to znovu.');
  }
}

function check(p: string): string {
  if (p.length < MIN_LENGTH) {
    console.error(`Heslo musí mít aspoň ${MIN_LENGTH} znaků.`);
    process.exit(1);
  }
  return p;
}

/** Reads a line without echoing it (raw mode works in macOS/Linux terminals and Windows Terminal/cmd/PowerShell). */
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
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
