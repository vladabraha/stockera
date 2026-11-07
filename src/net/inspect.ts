// Checks downloaded data for content that has no business in prices, rates or names (code, terminal escapes,
// prototype-pollution keys). Pure and import-free: used by the CLI (http.ts, update.ts) and bundled into the report.

export class UnsafeDataError extends Error {
  readonly source: string;
  readonly reason: string;
  constructor(source: string, reason: string) {
    super(`${source} poslal podezřelá data (${reason}) – zahozena, nic z nich se nepoužilo`);
    this.name = 'UnsafeDataError';
    this.source = source;
    this.reason = reason;
  }
}

const CODE_PATTERNS: [RegExp, string][] = [
  [/<\s*\/?\s*(script|iframe|object|embed|svg|math|form|meta|link|base|style)\b/i, 'HTML/skript'],
  [/<[a-z][^>]*\son[a-z]+\s*=/i, 'HTML s obsluhou události'],
  [/(java|vb)script\s*:/i, 'odkaz se skriptem'],
  [/data\s*:\s*(text\/html|application\/(x-)?javascript|image\/svg)/i, 'vložený dokument'],
];
// ESC and other C0/C1 controls (except tab, CR, LF) can rewrite the terminal; bidi overrides disguise text.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 64;
const MAX_NODES = 2_000_000;

/** Reason why a single string is unsafe, or null. */
export function textThreat(s: string): string | null {
  if (CONTROL.test(s)) return 'řídicí znaky';
  if (BIDI.test(s)) return 'znaky měnící směr textu';
  for (const [re, reason] of CODE_PATTERNS) if (re.test(s)) return reason;
  return null;
}

/** Walks parsed JSON (or any extracted value) and returns the first problem found, or null. */
export function findThreat(value: unknown): string | null {
  let nodes = 0;
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++nodes > MAX_NODES) return 'příliš mnoho položek';
    if (typeof v === 'string') {
      const t = textThreat(v);
      if (t) return t;
    } else if (v instanceof Map) {
      stack.push([[...v], depth + 1]);
    } else if (v && typeof v === 'object') {
      if (depth >= MAX_DEPTH) return 'příliš hluboké zanoření';
      for (const [k, child] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) return `zakázaný klíč "${k}"`;
        const t = textThreat(k);
        if (t) return t;
        stack.push([child, depth + 1]);
      }
    } else if (typeof v === 'number' && !Number.isFinite(v)) return 'neplatné číslo';
  }
  return null;
}

/** Throws {@link UnsafeDataError} when the value contains anything suspicious. */
export function assertSafe<T>(value: T, source: string): T {
  const reason = findThreat(value);
  if (reason) throw new UnsafeDataError(source, reason);
  return value;
}

/** Parses a JSON response and checks it; unsafe data is thrown away (never returned). */
export function parseSafeJson<T = unknown>(text: string, source: string): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${source} vrátil neplatná data (není to JSON)`);
  }
  return assertSafe(data as T, source);
}
