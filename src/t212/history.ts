// Trading 212 "History → Export" CSV: one row per event (buy, sell, dividend, deposit, …) without lot pairing.
// Sales are paired with purchases here (FIFO per account and instrument); the result goes to the same tables
// as XTB data, so the analysis and the report treat both brokers the same way.

export class T212FormatError extends Error {
  override name = 'T212FormatError';
}

export interface T212Row {
  /** Unique per event: the T212 "ID", or a fingerprint of the row when the export has no ID for it (dividends). */
  key: string;
  action: string;
  time: string;
  isin: string | null;
  ticker: string | null;
  name: string | null;
  shares: number | null;
  price: number | null;
  priceCurrency: string | null;
  exchangeRate: number | null;
  /** Cash effect in account currency, fees included (the sign differs between export versions). */
  total: number | null;
  currency: string;
  withholdingTax: number | null;
  withholdingCurrency: string | null;
}

export interface T212Export {
  rows: T212Row[];
  periodFrom: string | null;
  periodTo: string | null;
}

/** RFC 4180 CSV: quoted fields may contain commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) out.push(row);
  return out;
}

const TOTAL_HEADER = /^total( \(([a-z]{3})\))?$/;
const headerOf = (text: string) => (parseCsv(text.split(/\r?\n/, 1)[0] ?? '')[0] ?? []).map((h) => h.trim().toLowerCase());

export function isT212Csv(text: string): boolean {
  const head = headerOf(text);
  return head.includes('action') && head.some((h) => h.startsWith('time')) && head.some((h) => TOTAL_HEADER.test(h));
}

const num = (v: string | undefined): number | null => {
  const t = (v ?? '').trim();
  if (!t || /^not available$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | undefined): string | null => (v ?? '').trim() || null;

/** "2024-03-01 14:22:31(.123)(+00:00)" or "01/03/2024 14:22(:31)" → ISO UTC. */
export function t212Time(v: string): string {
  const t = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}.${(m[7] ?? '0').slice(0, 3).padEnd(3, '0')}`;
    const offset = !m[8] || m[8] === 'Z' ? 'Z' : m[8].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    return offset === 'Z' || offset === '+00:00' || offset === '-00:00' ? `${iso}Z` : new Date(iso + offset).toISOString();
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] ?? '00'}.000Z`;
  throw new T212FormatError(`Neznámý formát času „${t}“.`);
}

export function parseT212Export(csv: string): T212Export {
  const [header, ...lines] = parseCsv(csv);
  if (!header) throw new T212FormatError('Soubor je prázdný.');
  const cols = header.map((h) => h.trim().toLowerCase());
  const col = (name: string) => cols.indexOf(name);
  const totalCol = cols.findIndex((h) => TOTAL_HEADER.test(h));
  // Older exports: "Total (EUR)" – the account currency is in the header instead of a column.
  const fixedCurrency = TOTAL_HEADER.exec(cols[totalCol] ?? '')?.[2]?.toUpperCase() ?? null;
  const c = {
    action: col('action'), time: cols.findIndex((h) => h.startsWith('time')), isin: col('isin'), ticker: col('ticker'),
    name: col('name'), id: col('id'), shares: col('no. of shares'), price: col('price / share'),
    priceCurrency: col('currency (price / share)'), rate: col('exchange rate'), totalCurrency: col('currency (total)'),
    wht: col('withholding tax'), whtCurrency: col('currency (withholding tax)'),
  };
  if (c.action < 0 || c.time < 0 || totalCol < 0) {
    throw new T212FormatError('Chybí sloupce Action, Time nebo Total – nejde o export historie z Trading 212.');
  }
  if (!fixedCurrency && c.totalCurrency < 0) throw new T212FormatError('Chybí sloupec „Currency (Total)“ s měnou účtu.');

  const rows: T212Row[] = [];
  const seen = new Map<string, number>();
  for (const l of lines) {
    const action = str(l[c.action]);
    if (!action) continue;
    const time = t212Time(l[c.time] ?? '');
    const currency = fixedCurrency ?? str(l[c.totalCurrency])?.toUpperCase();
    // T212 also lists zero-amount conversions without a currency; conversions don't enter the ledger anyway.
    if (!currency && t212Kind(action) === 'conversion' && !num(l[totalCol])) continue;
    if (!currency) throw new T212FormatError(`Řádek „${action}“ ${time}: chybí měna.`);
    const r: Omit<T212Row, 'key'> = {
      action,
      time,
      isin: str(l[c.isin])?.toUpperCase() ?? null,
      ticker: str(l[c.ticker])?.toUpperCase() ?? null,
      name: str(l[c.name]),
      shares: num(l[c.shares]),
      price: num(l[c.price]),
      priceCurrency: str(l[c.priceCurrency]) ?? null,
      exchangeRate: num(l[c.rate]),
      total: num(l[totalCol]),
      currency,
      withholdingTax: num(l[c.wht]),
      withholdingCurrency: str(l[c.whtCurrency]) ?? null,
    };
    let key = str(l[c.id]);
    if (!key) {
      // Same row in two overlapping exports → same key; identical rows within one file get a sequence number.
      const base = ['row', action, time, r.isin, r.shares, r.total, currency].join('|');
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      key = n > 1 ? `${base}|${n}` : base;
    }
    rows.push({ key, ...r });
  }
  const times = rows.map((r) => r.time).sort();
  return { rows, periodFrom: times[0] ?? null, periodTo: times[times.length - 1] ?? null };
}

// ------------------------------------------------------------------ ledger -

export type T212Kind =
  | 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdrawal' | 'interest' | 'split-open' | 'split-close' | 'conversion' | 'other';

export function t212Kind(action: string): T212Kind {
  const a = action.trim().toLowerCase();
  if (/stock split open/.test(a)) return 'split-open';
  if (/stock split close/.test(a)) return 'split-close';
  if (/\bbuy$/.test(a)) return 'buy';
  if (/\bsell$/.test(a)) return 'sell';
  if (/^dividend/.test(a)) return 'dividend';
  if (/^deposit/.test(a)) return 'deposit';
  if (/^withdrawal|card debit/.test(a)) return 'withdrawal';
  if (/interest/.test(a)) return 'interest';
  if (/currency conversion/.test(a)) return 'conversion';
  return 'other';
}

export interface LedgerCash {
  id: string;
  sourceKey: string;
  account: string;
  type: string;
  ticker: string | null;
  time: string;
  amount: number;
  comment: string | null;
}

export interface LedgerLot {
  account: string;
  /** Key of the purchase row – the "position" of this lot. */
  positionId: string;
  ticker: string;
  volume: number;
  openPrice: number;
  openTime: string;
  purchaseValue: number;
}

export interface LedgerClosed extends LedgerLot {
  sourceKey: string;
  closePrice: number;
  closeTime: string;
  saleValue: number;
}

export interface Ledger {
  cash: LedgerCash[];
  closed: LedgerClosed[];
  open: LedgerLot[];
  warnings: string[];
}

export const T212_PREFIX = 'T212-';
export const t212Account = (currency: string) => `${T212_PREFIX}${currency}`;

const ORDER: Record<T212Kind, number> = {
  deposit: 0, conversion: 1, buy: 2, 'split-close': 3, 'split-open': 4, sell: 5, dividend: 6, interest: 6, withdrawal: 7, other: 8,
};
const EPS = 1e-6;
/** Prices in pence → pounds, like the downloaded price series (charts compare purchase prices with them). */
const unitPrice = (r: T212Row): number | null =>
  r.price == null ? null : /^GBX$/i.test(r.priceCurrency ?? '') ? r.price / 100 : r.price;
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Withholding tax in account currency; T212 reports it in the dividend's currency next to the net amount. */
function withholdingInAccountCurrency(r: T212Row, net: number): number | null {
  const wht = Math.abs(r.withholdingTax ?? 0);
  if (!wht) return 0;
  if (r.withholdingCurrency?.toUpperCase() === r.currency) return wht;
  if (r.withholdingCurrency !== r.priceCurrency || !r.shares || !r.price) return null;
  const perShare = r.shares * r.price;
  // "Price / share" is the net dividend in current exports, gross in some older ones; the exchange rate is given
  // either way round. Pick the reading that reproduces the net total, else fall back to the implied rate.
  for (const rate of r.exchangeRate ? [r.exchangeRate, 1 / r.exchangeRate] : []) {
    for (const native of [perShare, perShare - wht]) {
      if (Math.abs(native * rate - net) <= Math.max(0.02, net * 0.01)) return wht * rate;
    }
  }
  return wht * (net / perShare);
}

/**
 * Turns T212 events into cash operations and FIFO-paired lots (per account and instrument).
 * `tickerOf` maps an event to the instrument ticker used by the rest of the app (e.g. "VWCE.DE").
 */
export function buildT212Ledger(rows: T212Row[], tickerOf: (r: T212Row) => string): Ledger {
  const warnings: string[] = [];
  const cash: LedgerCash[] = [];
  const closed: LedgerClosed[] = [];
  type Lot = { key: string; ticker: string; time: string; qty: number; cost: number; price: number };
  const lots = new Map<string, Lot[]>();
  const pendingSplit = new Map<string, number>();
  const unknown = new Set<string>();
  const missing = new Map<string, { qty: number; first: string }>();
  const sorted = [...rows].sort((a, b) =>
    a.time.localeCompare(b.time) || ORDER[t212Kind(a.action)] - ORDER[t212Kind(b.action)] || a.key.localeCompare(b.key));

  for (const r of sorted) {
    const kind = t212Kind(r.action);
    const account = t212Account(r.currency);
    const abs = Math.abs(r.total ?? 0);
    const instrument = r.isin ?? r.ticker;
    const ticker = instrument ? tickerOf(r) : null;
    const group = `${account}|${instrument}`;
    const qty = r.shares ?? 0;
    const day = r.time.slice(0, 10);
    const op = (type: string, amount: number, comment: string | null = r.action, suffix = '') =>
      cash.push({ id: `t212:${r.currency}:${r.key}${suffix}`, sourceKey: r.key, account, type, ticker, time: r.time, amount, comment });
    const tradeComment = `${r.action} ${qty} @ ${r.price ?? '?'} ${r.priceCurrency ?? ''}`.trim();

    switch (kind) {
      case 'buy':
      case 'sell': {
        if (!ticker || qty <= 0 || r.total == null) {
          warnings.push(`Trading 212 ${day} ${r.action} ${r.ticker ?? ''}: chybí počet kusů nebo částka – řádek přeskočen.`);
          break;
        }
        if (kind === 'buy') {
          op('Stock purchase', -abs, tradeComment);
          lots.set(group, [...(lots.get(group) ?? []), { key: r.key, ticker, time: r.time, qty, cost: abs, price: unitPrice(r) ?? abs / qty }]);
          break;
        }
        op('Stock sell', abs, tradeComment);
        let need = qty;
        for (const l of lots.get(group) ?? []) {
          if (need <= EPS) break;
          if (l.qty <= EPS) continue;
          const take = Math.min(l.qty, need);
          const cost = l.cost * (take / l.qty);
          closed.push({
            account, positionId: l.key, sourceKey: r.key, ticker, volume: take, openPrice: l.price, openTime: l.time,
            closePrice: unitPrice(r) ?? abs / qty, closeTime: r.time, purchaseValue: cost, saleValue: abs * (take / qty),
          });
          l.qty -= take;
          l.cost -= cost;
          need -= take;
        }
        if (need > EPS) {
          const m = missing.get(ticker) ?? { qty: 0, first: day };
          missing.set(ticker, { qty: m.qty + need, first: m.first });
        }
        break;
      }
      case 'split-close':
        if (instrument && qty > 0) pendingSplit.set(group, qty);
        break;
      case 'split-open': {
        const before = pendingSplit.get(group);
        pendingSplit.delete(group);
        if (!before || qty <= 0) {
          warnings.push(`${ticker}: split ${day} v Trading 212 bez původního počtu kusů – zkontroluj pozici.`);
          break;
        }
        // Cost and purchase dates stay (the time test continues), only the number of shares changes.
        const ratio = qty / before;
        for (const l of lots.get(group) ?? []) {
          l.qty *= ratio;
          l.price /= ratio;
        }
        // Sales before the split too, so they match the split-adjusted price history; amounts (and taxes) stay.
        for (const c of closed) {
          if (c.account !== account || c.ticker !== ticker || c.closeTime >= r.time) continue;
          c.volume *= ratio;
          c.openPrice /= ratio;
          c.closePrice /= ratio;
        }
        break;
      }
      case 'dividend': {
        if (r.total == null) break;
        const tax = withholdingInAccountCurrency(r, abs);
        if (tax == null) {
          warnings.push(`${ticker}: dividenda ${day} z Trading 212 – sraženou daň ${r.withholdingTax} ${r.withholdingCurrency ?? ''} nejde přepočítat, bere se jen čistá částka.`);
        }
        op('Dividend', abs + (tax ?? 0));
        if (tax) op('Withholding tax', -tax, `${Math.abs(r.withholdingTax!)} ${r.withholdingCurrency ?? ''}`.trim(), ':wht');
        break;
      }
      case 'deposit': op('Deposit', abs); break;
      case 'withdrawal': op('Withdrawal', -abs); break;
      case 'interest': op(/lending/i.test(r.action) ? 'Lending interest' : 'Interest on cash', r.total ?? 0); break;
      case 'conversion': break;
      default:
        if (instrument && qty) unknown.add(r.action);
        else if (r.total) op(r.action, r.total);
    }
  }
  for (const [ticker, m] of missing) {
    warnings.push(
      `${ticker}: Trading 212 eviduje prodej ${round(m.qty)} ks (poprvé ${m.first}), ke kterému v nahraných exportech chybí nákup – ` +
        'nahraj exporty za celé období od založení účtu (jeden export může mít nejvýš 12 měsíců). Bez nich chybí tyto prodeje v daních.',
    );
  }
  for (const g of pendingSplit.keys()) warnings.push(`${g.split('|')[1]}: split v Trading 212 bez nových kusů – zkontroluj pozici.`);
  if (unknown.size) warnings.push(`Nezpracované akce Trading 212 s kusy akcií: ${[...unknown].join(', ')} – pozice mohou nesedět.`);

  const open: LedgerLot[] = [];
  for (const [g, ls] of lots) {
    const account = g.slice(0, g.indexOf('|'));
    for (const l of ls) {
      if (l.qty > EPS) open.push({ account, positionId: l.key, ticker: l.ticker, volume: l.qty, openPrice: l.price, openTime: l.time, purchaseValue: l.cost });
    }
  }
  return { cash, closed, open, warnings };
}

// ----------------------------------------------------------------- tickers -

const CURRENCY_EXCHANGE: Record<string, string> = {
  USD: 'US', GBX: 'UK', GBP: 'UK', CZK: 'CZ', CHF: 'CH', PLN: 'PL', DKK: 'DK', SEK: 'SE', NOK: 'NO',
};
const EUR_EXCHANGES = new Set(['DE', 'NL', 'FR', 'BE', 'PT', 'ES', 'IT', 'AT', 'FI']);

/** T212 names funds without "ETF" ("Vanguard FTSE All-World (Acc)"); the share class gives them away. */
export const isFundName = (name: string | null) => /\b(ETF|ETC|UCITS)\b|\((Acc|Dist)\)/i.test(name ?? '');

/**
 * App ticker (XTB style SYMBOL.EXCHANGE) for an instrument not known from XTB. T212 does not say where it trades,
 * so the exchange follows the price currency (EUR: the issuer's home exchange for stocks, Xetra for funds).
 */
export function t212Ticker(r: Pick<T212Row, 'ticker' | 'isin' | 'priceCurrency' | 'name'>): string {
  const symbol = (r.ticker ?? r.isin ?? '?').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const home = r.isin?.slice(0, 2) ?? '';
  const ccy = r.priceCurrency?.toUpperCase() ?? '';
  const exchange = CURRENCY_EXCHANGE[ccy] ?? (ccy === 'EUR' && !isFundName(r.name) && EUR_EXCHANGES.has(home) ? home : ccy === 'EUR' ? 'DE' : 'US');
  return `${symbol}.${exchange}`;
}
