import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { HOW_TO_EXPORT, fail, heading, paths, printSteps, root } from './friendly.ts';

/** `pnpm update-data`: guided ingest → market → report, with plain-language status and advice after every step. */

mkdirSync(paths.input, { recursive: true });
const xlsx = readdirSync(paths.input).filter((f) => /\.(xlsx|csv)$/i.test(f) && !f.startsWith('~$'));
const hadDb = existsSync(paths.db);

console.log('Stockera – vytvoření reportu (načtení výpisů, stažení cen, report)');
console.log('Všechny výpočty probíhají jen v tomto počítači. Z internetu se stahují pouze kurzy a ceny.');

if (!xlsx.length && !hadDb) {
  console.log(`\nVe složce ${paths.input} zatím není žádný výpis z XTB ani Trading 212.`);
  printSteps('Jak začít:', [...HOW_TO_EXPORT, 'Spusť znovu 2-vytvorit-report.']);
  process.exit(1);
}

const problems: string[] = [];

heading('Krok 1 ze 3: načítám výpisy z XTB a Trading 212');
if (!xlsx.length) {
  console.log('Žádné výpisy ve složce data/input – použiju data načtená dříve.');
} else if (run('import.ts') !== 0) {
  if (!existsSync(paths.db)) {
    fail('Žádný výpis se nepodařilo načíst, report proto nejde vytvořit.', [
      'Přečti si výše u každého souboru „Důvod“ a „Co dělat“.',
      ...HOW_TO_EXPORT,
    ]);
  }
  problems.push('Některý výpis se nepodařilo načíst – report z něj nebude obsahovat data (podrobnosti v kroku 1).');
}

heading('Krok 2 ze 3: stahuji kurzy ČNB a ceny akcií/ETF');
const market = run('market.ts');
if (market === 2) problems.push('Nešel internet – report používá naposledy stažené ceny. Až bude připojení, spusť znovu 2-vytvorit-report.');
else if (market !== 0) problems.push('Ceny se nepodařilo aktualizovat (podrobnosti v kroku 2) – report používá naposledy stažené ceny.');

heading('Krok 3 ze 3: vytvářím zašifrovaný report');
if (run('report.ts') !== 0) {
  fail('Report se nepodařilo vytvořit.', ['Přečti si hlášku výše v kroku 3 a postupuj podle ní.', 'Pak spusť znovu 2-vytvorit-report.']);
}

heading(problems.length ? 'Hotovo, ale s upozorněním' : 'Hotovo ✓');
for (const p of problems) console.log(`⚠ ${p}`);
printSteps('Co dál:', [
  `Otevři soubor ${paths.report} (dvojklikem – otevře se v prohlížeči) a zadej heslo.`,
  'Na mobil soubor zkopíruj (AirDrop, kabel, cloud) a otevři ho tam – funguje i bez internetu.',
  'Příště stačí přidat nový výpis do data/input a spustit znovu 2-vytvorit-report (staré výpisy tam klidně nech).',
]);

function run(script: string): number {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src/cli', script)], { stdio: 'inherit' });
  return r.status ?? 1;
}
