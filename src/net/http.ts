import { appendFileSync, mkdirSync } from 'node:fs';
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
]);

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;
const MIN_INTERVAL_MS = 400;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

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
          headers: { 'User-Agent': USER_AGENT, Accept: accept },
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
      const body = await res.text();
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

  private audit(e: Omit<AuditEntry, 'time'>): void {
    const entry: AuditEntry = { time: new Date().toISOString(), ...e };
    this.log.push(entry);
    if (this.opts.auditLog) appendFileSync(this.opts.auditLog, JSON.stringify(entry) + '\n');
  }
}
