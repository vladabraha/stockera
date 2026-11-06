import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The only hosts the application may contact. Requests carry only tickers, ISINs and dates –
 * never quantities, prices, values or account numbers (see tests/net.test.ts and tests/market.test.ts).
 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'www.cnb.cz', // ČNB exchange rates
  'www.cashmarket.deutsche-boerse.com', // Xetra instrument list (ticker → ISIN)
  'www.justetf.com', // ETF countries and prices
  'query1.finance.yahoo.com', // stock prices
  'query2.finance.yahoo.com',
  'api.onvista.de', // ETF country breakdown fallback (when justETF has none)
]);

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MIN_INTERVAL_MS = 400;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
// Yahoo answers a cookie-less "browser" User-Agent with HTTP 429; a plain one is served normally.
const PLAIN_UA_HOSTS = new Set(['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);
/** Rate limiting / temporary outage → wait and try again (delays in ms). */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [2_000, 5_000];

export interface AuditEntry {
  time: string;
  url: string;
  status: number | 'blocked' | 'error';
  bytes?: number;
  ms?: number;
  error?: string;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status}: ${url}`);
    this.status = status;
  }
}

export class BlockedRequestError extends Error {}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** JSONL audit log path; entries are also kept in `log`. */
  auditLog?: string;
  fetch?: FetchFn;
  minIntervalMs?: number;
  /** Override retry delays (tests use 0). */
  retryDelaysMs?: number[];
}

/** GET-only HTTP client restricted to {@link ALLOWED_HOSTS}; every request (incl. blocked ones) is audited. */
export class Http {
  readonly log: AuditEntry[] = [];
  private readonly opts: HttpOptions;
  private readonly lastRequest = new Map<string, number>();

  constructor(opts: HttpOptions = {}) {
    this.opts = opts;
    if (opts.auditLog) mkdirSync(dirname(opts.auditLog), { recursive: true });
  }

  async getText(url: string, accept = '*/*'): Promise<string> {
    const delays = this.opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.getOnce(url, accept);
      } catch (e) {
        if (!(e instanceof HttpError) || !RETRY_STATUSES.has(e.status) || attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  private async getOnce(url: string, accept: string): Promise<string> {
    const fetchFn = this.opts.fetch ?? fetch;
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.assertAllowed(current);
      await this.throttle(new URL(current).host);
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchFn(current, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { 'User-Agent': PLAIN_UA_HOSTS.has(new URL(current).hostname) ? 'Mozilla/5.0' : USER_AGENT, Accept: accept },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        this.audit({ url: current, status: 'error', error: String(e), ms: Date.now() - started });
        throw e;
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        this.audit({ url: current, status: res.status, ms: Date.now() - started });
        current = new URL(location, current).toString();
        continue;
      }
      const body = await readLimited(res, current);
      this.audit({ url: current, status: res.status, bytes: Buffer.byteLength(body), ms: Date.now() - started });
      if (!res.ok) throw new HttpError(current, res.status);
      return body;
    }
    throw new Error(`Příliš mnoho přesměrování: ${url}`);
  }

  async getJson<T>(url: string): Promise<T> {
    return JSON.parse(await this.getText(url, 'application/json')) as T;
  }

  private assertAllowed(url: string): void {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || u.port !== '' || u.username || u.password) {
      this.audit({ url, status: 'blocked' });
      throw new BlockedRequestError(`Zablokováno – adresa není na seznamu povolených: ${url}`);
    }
  }

  private async throttle(host: string): Promise<void> {
    const min = this.opts.minIntervalMs ?? MIN_INTERVAL_MS;
    const wait = (this.lastRequest.get(host) ?? 0) + min - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest.set(host, Date.now());
  }

  private logRestricted = false;

  private audit(e: Omit<AuditEntry, 'time'>): void {
    const entry: AuditEntry = { time: new Date().toISOString(), ...e };
    this.log.push(entry);
    if (!this.opts.auditLog) return;
    appendFileSync(this.opts.auditLog, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (!this.logRestricted) {
      this.logRestricted = true;
      try {
        chmodSync(this.opts.auditLog, 0o600);
      } catch {
        // best effort (no-op on Windows)
      }
    }
  }
}

/** Reads the body as text, aborting once it exceeds MAX_BODY_BYTES (protects against huge/hostile responses). */
async function readLimited(res: Response, url: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error(`Odpověď je příliš velká (${declared} B): ${url}`);
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      await res.body.cancel().catch(() => {});
      throw new Error(`Odpověď je příliš velká (> ${MAX_BODY_BYTES} B): ${url}`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
