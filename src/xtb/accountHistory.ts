import type { Cell, Row, Sheet } from '../xlsx/reader.ts';
import { czechDateTimeToIso, excelSerialToIso } from '../util/dates.ts';

/** Thrown when an XTB export does not match the expected structure (e.g. XTB changed the format). */
export class XtbFormatError extends Error {
  override name = 'XtbFormatError';
}

export interface InstrumentInfo {
  ticker: string;
  name: string | null;
  category: string | null;
}

export interface ClosedPosition {
  positionId: string;
  ticker: string;
  type: string;
  volume: number;
  openPrice: number;
  openTime: string;
  closePrice: number;
  closeTime: string;
  purchaseValue: number | null;
  saleValue: number | null;
  grossProfit: number | null;
  profit: number;
  commission: number | null;
  swap: number | null;
  rollover: number | null;
  openConversionRate: number | null;
  closeConversionRate: number | null;
}

export interface TradeComment {
  action: 'OPEN' | 'CLOSE';
  side: 'BUY' | 'SELL';
  quantity: number;
  totalQuantity: number | null;
  price: number;
}

export interface CashOperation {
  id: string;
  type: string;
  ticker: string | null;
  time: string;
  amount: number;
  comment: string | null;
  positionId: string | null;
  trade: TradeComment | null;
}

export interface OpenLot {
  positionId: string;
  ticker: string;
  type: string;
  volume: number;
  openPrice: number;
  openTime: string;
  currentPrice: number | null;
  value: number | null;
  grossProfit: number | null;
  netProfit: number | null;
}

export interface OpenPositionsSnapshot {
  asOf: string;
  value: number | null;
  profit: number | null;
  lots: OpenLot[];
}

export interface AccountHistory {
  accountNumber: string;
  currency: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  closedPositions: ClosedPosition[];
  cashOperations: CashOperation[];
  openPositions: OpenPositionsSnapshot | null;
  instruments: InstrumentInfo[];
  warnings: string[];
}

export const KNOWN_CASH_TYPES = new Set([
  'stock purchase',
  'stock sell',
  'deposit',
  'withdrawal',
  'free funds interest',
  'free funds interest tax',
  'dividend',
  'divident',
  'withholding tax',
]);

export type ExportKind = 'account-history' | 'fiscal-report' | 'unknown';

export function detectExportKind(sheets: Sheet[]): ExportKind {
  const names = new Set(sheets.map((s) => s.name.trim().toLowerCase()));
  if (names.has('cash operations') || names.has('closed positions') || names.has('open positions')) {
    return 'account-history';
  }
  const fiscal = sheets.some((s) =>
    s.rows.slice(0, 5).some((r) => r.some((c) => typeof c === 'string' && c.startsWith('Fiscal Report'))),
  );
  return fiscal ? 'fiscal-report' : 'unknown';
}

/** Parses the XTB xStation "account history" XLSX export (sheets Closed Positions / Cash Operations / Open Positions). */
export function parseAccountHistory(sheets: Sheet[]): AccountHistory {
  const warnings: string[] = [];
  const instruments = new Map<string, InstrumentInfo>();
  const noteInstrument = (ticker: string | null, name: string | null, category: string | null): void => {
    if (!ticker) return;
    const prev = instruments.get(ticker);
    instruments.set(ticker, { ticker, name: name ?? prev?.name ?? null, category: category ?? prev?.category ?? null });
  };

  const sheet = (name: string): Sheet | undefined => sheets.find((s) => s.name.trim().toLowerCase() === name);
  const closedSheet = sheet('closed positions');
  const cashSheet = sheet('cash operations');
  const openSheet = sheet('open positions');
  if (!cashSheet) throw new XtbFormatError('List "Cash Operations" chybí – nejde o export historie účtu XTB?');
  if (!closedSheet) warnings.push('List "Closed Positions" chybí – uzavřené pozice nebudou importovány.');
  if (!openSheet) warnings.push('List "Open Positions" chybí – otevřené pozice nebudou importovány.');

  const accountNumbers = new Set<string>();
  for (const s of [cashSheet, closedSheet, openSheet]) {
    const acc = s && metaValue(s, 'account number');
    if (acc != null) accountNumbers.add(String(acc));
  }
  const cashAccount = metaValue(cashSheet, 'account number');
  if (cashAccount == null) throw new XtbFormatError('Číslo účtu ("Account number") nenalezeno v listu Cash Operations.');
  const accountNumber = String(cashAccount);
  if (accountNumbers.size > 1) {
    warnings.push(`Listy mají různá čísla účtu (${[...accountNumbers].join(', ')}); použito ${accountNumber}.`);
  }

  const periodFromCell = metaValue(cashSheet, 'date from (utc)');
  const periodToCell = metaValue(cashSheet, 'date to (utc)');

  const cashOperations = parseCashOperations(cashSheet, warnings, noteInstrument);
  const closedPositions = closedSheet ? parseClosedPositions(closedSheet, warnings, noteInstrument) : [];
  const open = openSheet ? parseOpenPositions(openSheet, warnings, noteInstrument) : null;

  return {
    accountNumber,
    currency: open?.currency ?? null,
    periodFrom: periodFromCell == null ? null : toIso(periodFromCell, 'Date from'),
    periodTo: periodToCell == null ? null : toIso(periodToCell, 'Date to'),
    closedPositions,
    cashOperations,
    openPositions: open?.snapshot ?? null,
    instruments: [...instruments.values()],
    warnings,
  };
}

type NoteInstrument = (ticker: string | null, name: string | null, category: string | null) => void;

function parseCashOperations(sheet: Sheet, warnings: string[], noteInstrument: NoteInstrument): CashOperation[] {
  const t = findTable(sheet, ['type', 'time', 'amount', 'id'], ['instrument', 'ticker', 'category', 'comment', 'position id']);
  const ops: CashOperation[] = [];
  const unknownTypes = new Set<string>();
  let total: number | null = null;
  for (const row of t.rows) {
    const type = str(t.get(row, 'type'));
    if (type?.toLowerCase() === 'total') total = optNum(t.get(row, 'amount'));
    if (!type || type.toLowerCase() === 'total') continue;
    const id = str(t.get(row, 'id'));
    if (!id) throw new XtbFormatError(`Cash Operations: operace "${type}" nemá ID.`);
    const ticker = str(t.get(row, 'ticker'));
    const comment = str(t.get(row, 'comment'));
    if (!KNOWN_CASH_TYPES.has(type.toLowerCase())) unknownTypes.add(type);
    noteInstrument(ticker, str(t.get(row, 'instrument')), str(t.get(row, 'category')));
    ops.push({
      id,
      type,
      ticker,
      time: toIso(t.get(row, 'time'), `Cash Operations ${id} Time`),
      amount: num(t.get(row, 'amount'), `Cash Operations ${id} Amount`),
      comment,
      positionId: str(t.get(row, 'position id')),
      trade: comment ? parseTradeComment(comment) : null,
    });
  }
  if (unknownTypes.size) {
    warnings.push(`Neznámé typy peněžních operací (uloženy, ale zatím se nezpracovávají): ${[...unknownTypes].join(', ')}`);
  }
  if (total != null) {
    const sum = ops.reduce((a, o) => a + o.amount, 0);
    if (Math.abs(sum - total) > 0.011) {
      warnings.push(`Cash Operations: součet ${sum.toFixed(2)} nesedí s řádkem Total ${total.toFixed(2)}.`);
    }
  }
  return ops;
}

function parseClosedPositions(sheet: Sheet, warnings: string[], noteInstrument: NoteInstrument): ClosedPosition[] {
  const t = findTable(
    sheet,
    ['ticker', 'type', 'volume', 'open price', 'open time (utc)', 'close price', 'close time (utc)', 'profit/loss', 'position id'],
    ['instrument', 'category', 'gross profit', 'purchase value', 'sale value', 'commission', 'swap', 'rollover',
      'open conversion rate', 'close conversion rate'],
  );
  const out: ClosedPosition[] = [];
  let summaryProfit: number | null = null;
  for (const row of t.rows) {
    const ticker = str(t.get(row, 'ticker'));
    if (!ticker) {
      if (str(row[0])?.toLowerCase() === 'profit/loss') summaryProfit = optNum(t.get(row, 'profit/loss'));
      continue;
    }
    const positionId = str(t.get(row, 'position id'));
    if (!positionId) throw new XtbFormatError(`Closed Positions: řádek ${ticker} nemá Position ID.`);
    const ctx = `Closed Positions ${positionId}`;
    noteInstrument(ticker, str(t.get(row, 'instrument')), str(t.get(row, 'category')));
    out.push({
      positionId,
      ticker,
      type: str(t.get(row, 'type')) ?? '',
      volume: num(t.get(row, 'volume'), `${ctx} Volume`),
      openPrice: num(t.get(row, 'open price'), `${ctx} Open Price`),
      openTime: toIso(t.get(row, 'open time (utc)'), `${ctx} Open Time`),
      closePrice: num(t.get(row, 'close price'), `${ctx} Close Price`),
      closeTime: toIso(t.get(row, 'close time (utc)'), `${ctx} Close Time`),
      purchaseValue: optNum(t.get(row, 'purchase value')),
      saleValue: optNum(t.get(row, 'sale value')),
      grossProfit: optNum(t.get(row, 'gross profit')),
      profit: num(t.get(row, 'profit/loss'), `${ctx} Profit/Loss`),
      commission: optNum(t.get(row, 'commission')),
      swap: optNum(t.get(row, 'swap')),
      rollover: optNum(t.get(row, 'rollover')),
      openConversionRate: optNum(t.get(row, 'open conversion rate')),
      closeConversionRate: optNum(t.get(row, 'close conversion rate')),
    });
  }
  if (summaryProfit != null) {
    const sum = out.reduce((a, p) => a + p.profit, 0);
    if (Math.abs(sum - summaryProfit) > 0.011) {
      warnings.push(`Closed Positions: součet zisků ${sum.toFixed(2)} nesedí se souhrnem ${summaryProfit.toFixed(2)}.`);
    }
  }
  return out;
}

function parseOpenPositions(
  sheet: Sheet,
  warnings: string[],
  noteInstrument: NoteInstrument,
): { snapshot: OpenPositionsSnapshot; currency: string | null } {
  const asOfCell = metaValue(sheet, 'data as of report generated');
  if (asOfCell == null) throw new XtbFormatError('Open Positions: chybí čas vygenerování ("Data as of report generated").');
  const asOf = toIso(asOfCell, 'Open Positions as of');

  let currency: string | null = null;
  let value: number | null = null;
  let profit: number | null = null;
  const summary = tryFindTable(sheet, ['metric', 'amount', 'currency'], []);
  if (summary) {
    for (const row of summary.rows) {
      const metric = str(summary.get(row, 'metric'))?.toLowerCase();
      if (!metric) break;
      if (metric === 'open position value') value = optNum(summary.get(row, 'amount'));
      if (metric === 'open position profit') profit = optNum(summary.get(row, 'amount'));
      currency ??= str(summary.get(row, 'currency'));
    }
  }
  if (!currency) warnings.push('Měna účtu nebyla v exportu nalezena (Open Positions → Currency).');

  const t = findTable(
    sheet,
    ['instrument/position', 'ticker', 'type', 'volume', 'open price', 'open time (utc)'],
    ['category', 'value', 'current price', 'net profit', 'gross profit'],
  );
  const lots: OpenLot[] = [];
  let currentName: string | null = null;
  for (const row of t.rows) {
    const ticker = str(t.get(row, 'ticker'));
    if (!ticker) continue;
    const type = str(t.get(row, 'type'));
    if (!type) {
      // Instrument summary row; the lots of this instrument follow.
      currentName = str(t.get(row, 'instrument/position'));
      noteInstrument(ticker, currentName, str(t.get(row, 'category')));
      continue;
    }
    const positionId = str(t.get(row, 'instrument/position'));
    if (!positionId) throw new XtbFormatError(`Open Positions: lot ${ticker} nemá Position ID.`);
    const ctx = `Open Positions ${positionId}`;
    noteInstrument(ticker, null, null);
    lots.push({
      positionId,
      ticker,
      type,
      volume: num(t.get(row, 'volume'), `${ctx} Volume`),
      openPrice: num(t.get(row, 'open price'), `${ctx} Open price`),
      openTime: toIso(t.get(row, 'open time (utc)'), `${ctx} Open time`),
      currentPrice: optNum(t.get(row, 'current price')),
      value: optNum(t.get(row, 'value')),
      grossProfit: optNum(t.get(row, 'gross profit')),
      netProfit: optNum(t.get(row, 'net profit')),
    });
  }
  return { snapshot: { asOf, value, profit, lots }, currency };
}

/** Parses comments like "OPEN BUY 3/4 @ 29.300" or "CLOSE BUY 0.3/1.3 @ 137.98". */
export function parseTradeComment(comment: string): TradeComment | null {
  const m = /^(OPEN|CLOSE)\s+(BUY|SELL)\s+([\d.]+)(?:\/([\d.]+))?\s*@\s*([\d.]+)/i.exec(comment.trim());
  if (!m) return null;
  return {
    action: m[1]!.toUpperCase() as 'OPEN' | 'CLOSE',
    side: m[2]!.toUpperCase() as 'BUY' | 'SELL',
    quantity: Number(m[3]),
    totalQuantity: m[4] ? Number(m[4]) : null,
    price: Number(m[5]),
  };
}

// --- table helpers ---------------------------------------------------------

interface Table {
  rows: Row[];
  get(row: Row, header: string): Cell;
}

const norm = (c: Cell): string => (typeof c === 'string' ? c.trim().toLowerCase() : '');

function tryFindTable(sheet: Sheet, required: string[], optional: string[]): Table | null {
  for (let i = 0; i < sheet.rows.length; i++) {
    const headers = (sheet.rows[i] ?? []).map(norm);
    if (!required.every((h) => headers.includes(h))) continue;
    const cols = new Map<string, number>();
    for (const h of [...required, ...optional]) {
      const idx = headers.indexOf(h);
      if (idx >= 0) cols.set(h, idx);
    }
    return {
      rows: sheet.rows.slice(i + 1),
      get: (row, header) => {
        const idx = cols.get(header);
        return idx === undefined ? null : (row[idx] ?? null);
      },
    };
  }
  return null;
}

function findTable(sheet: Sheet, required: string[], optional: string[]): Table {
  const t = tryFindTable(sheet, required, optional);
  if (!t) {
    throw new XtbFormatError(
      `List "${sheet.name}": nenalezena hlavička se sloupci ${required.join(', ')}. XTB pravděpodobně změnilo formát exportu.`,
    );
  }
  return t;
}

/** Value to the right of a label in column A (e.g. "Account number" | 123). */
function metaValue(sheet: Sheet, label: string): Cell {
  for (const row of sheet.rows.slice(0, 15)) {
    if (norm(row[0] ?? null) === label) return row[1] ?? null;
  }
  return null;
}

function str(c: Cell | undefined): string | null {
  if (c == null) return null;
  const s = String(c).trim();
  return s === '' ? null : s;
}

function optNum(c: Cell | undefined): number | null {
  if (c == null || c === '') return null;
  if (typeof c === 'number') return c;
  const n = Number(String(c).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function num(c: Cell | undefined, ctx: string): number {
  const n = optNum(c);
  if (n == null) throw new XtbFormatError(`${ctx}: očekáváno číslo, nalezeno "${c ?? ''}".`);
  return n;
}

function toIso(c: Cell | undefined, ctx: string): string {
  if (typeof c === 'number') return excelSerialToIso(c);
  if (typeof c === 'string' && c.trim()) {
    try {
      return czechDateTimeToIso(c);
    } catch {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  throw new XtbFormatError(`${ctx}: neplatné datum "${c ?? ''}".`);
}
