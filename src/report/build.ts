import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { Analysis } from '../analysis/portfolio.ts';
import { encryptPayload, PBKDF2_ITERATIONS } from './crypto.ts';
import { LIVE_HOSTS } from './live.ts';

const dir = import.meta.dirname;

/** Type-strips a frontend source file and turns it into plain script code (no imports/exports). */
export function toBrowserScript(source: string): string {
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import\s[^;\n]*\sfrom\s+'[^'\n]+';?[ \t]*$/gm, '')
    .replace(/^export\s+/gm, '');
  if (/^\s*(import|export)\b/m.test(js)) throw new Error('Frontend obsahuje import/export, který nejde převést na skript.');
  return js;
}

/** Bundled frontend: crypto + shared breakdown + content check + live prices + app, wrapped so nothing leaks into the global scope. */
export function frontendScript(): string {
  const parts = ['crypto.ts', '../analysis/breakdown.ts', '../net/inspect.ts', 'live.ts', 'app.ts'].map((f) => toBrowserScript(readFileSync(join(dir, f), 'utf8')));
  return `(() => {\n'use strict';\n${parts.join('\n')}\n})();`;
}

export function frontendStyles(): string {
  return readFileSync(join(dir, 'styles.css'), 'utf8');
}

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

export interface BuildOptions {
  /** Lower only in tests – the default protects against brute force. */
  iterations?: number;
}

/**
 * Builds a single self-contained HTML file. The analysis is gzip-compressed and encrypted
 * (PBKDF2-SHA256 → AES-256-GCM); the page decrypts it in the browser after entering the password.
 * The CSP forbids every network request, so the opened report cannot send data anywhere.
 */
export async function buildReport(analysis: Analysis, password: string, options: BuildOptions = {}): Promise<string> {
  if (!password) throw new Error('Heslo nesmí být prázdné');
  const payload = await encryptPayload(JSON.stringify(analysis), password, options.iterations ?? PBKDF2_ITERATIONS);
  const script = frontendScript();
  const style = frontendStyles();
  const csp = [
    "default-src 'none'",
    `script-src ${sha256(script)}`,
    `style-src ${sha256(style)}`,
    "img-src 'none'",
    // Live prices only: GET with ISIN / currency codes (see live.ts). Nothing else can be contacted.
    `connect-src ${LIVE_HOSTS.join(' ')}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  // Base64 + JSON punctuation only – cannot terminate the <script> element.
  const payloadJson = JSON.stringify(payload);
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Stockera</title>
<style>${style}</style>
</head>
<body>
<div id="app"><noscript>Report se v tomto náhledu nespustil, protože tu nefungují skripty (to dělají např. náhledy souborů v mailu nebo ve Files na iPhonu). Otevři soubor přímo v prohlížeči – Chrome, Edge, Firefox nebo Safari.</noscript></div>
<script type="application/json" id="payload">${payloadJson}</script>
<script>${script}</script>
</body>
</html>
`;
}
