import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Plain-language messages for people who never saw the code. Importing this module also installs a handler that
 * turns unexpected crashes into a short explanation + next steps (the stack trace goes to data/logs/chyby.log).
 */

export const root = resolve(import.meta.dirname, '../..');
export const paths = {
  input: join(root, 'data/input'),
  db: join(root, 'data/stockera.db'),
  config: join(root, 'data/instruments.json'),
  configExample: join(root, 'config/instruments.example.json'),
  networkLog: join(root, 'data/logs/network.log'),
  errorLog: join(root, 'data/logs/chyby.log'),
  report: join(root, 'out/stockera.html'),
};

export const HOW_TO_EXPORT = [
  'V xStation (web nebo aplikace) otevři historii účtu a zvol export do Excelu (XLSX).',
  'Jako období zvol celou dobu od založení účtu (jinak budou chybět starší nákupy).',
  'Má-li účet více podúčtů (EUR, CZK), exportuj každý zvlášť.',
  `Stažené soubory ulož do složky ${paths.input}`,
];

export function heading(text: string): void {
  console.log(`\n━━ ${text} ━━`);
}

/** Prints data-validity checks; returns the number of warnings. */
export function printChecks(checks: { status: 'ok' | 'warn' | 'info'; title: string; detail: string }[]): number {
  console.log('\nKontrola dat:');
  for (const c of checks) console.log(`  ${{ ok: '✓', warn: '⚠', info: 'i' }[c.status]} ${c.title}: ${c.detail}`);
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(warns ? `  → ${warns} upozornění, podrobnosti jsou i v reportu (Portfolio, dole „Kontrola dat“).` : '  → Vše v pořádku.');
  return warns;
}

export function printSteps(title: string, steps: string[], out: (s: string) => void = console.log): void {
  out(`\n${title}`);
  steps.forEach((s, i) => out(`  ${i + 1}. ${s}`));
}

/** Prints the problem and what to do, then exits with code 1. */
export function fail(message: string, steps: string[] = []): never {
  console.error(`\n✗ ${message}`);
  if (steps.length) printSteps('Co dělat:', steps, console.error);
  process.exit(1);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Known system errors → explanation and steps; anything else gets a generic "try again / send the log" advice. */
export function explain(e: unknown): { message: string; steps: string[] } {
  const code = (e as NodeJS.ErrnoException | undefined)?.code ?? '';
  const text = errorText(e);
  if (/database is locked|SQLITE_BUSY/i.test(text) || code === 'EBUSY') {
    return {
      message: 'Databázi právě používá jiný program.',
      steps: ['Zavři ostatní okna, kde běží Stockera (aktualizace), a zkus to znovu.', 'Pokud je složka v OneDrive/iCloudu, počkej na dokončení synchronizace.'],
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      message: 'Program nemá oprávnění zapisovat do své složky.',
      steps: ['Přesuň složku Stockera do svých Dokumentů (ne do Program Files ani na plochu jiného uživatele).', 'Zkus to znovu.'],
    };
  }
  if (code === 'ENOSPC') return { message: 'Na disku není místo.', steps: ['Uvolni místo na disku a zkus to znovu.'] };
  return {
    message: `Nastala neočekávaná chyba: ${text}`,
    steps: [
      'Zkus akci spustit znovu.',
      `Když se chyba opakuje, pošli tomu, kdo ti program připravil, soubor ${paths.errorLog} (je v něm jen technický popis chyby – před odesláním si ho můžeš přečíst).`,
    ],
  };
}

export function logError(e: unknown): void {
  try {
    mkdirSync(dirname(paths.errorLog), { recursive: true });
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    appendFileSync(paths.errorLog, `[${new Date().toISOString()}] ${process.argv.slice(1).join(' ')}\n${detail}\n\n`, { mode: 0o600 });
  } catch {
    // logging must never hide the original problem
  }
}

process.on('uncaughtException', (e) => {
  logError(e);
  const { message, steps } = explain(e);
  fail(message, steps);
});
