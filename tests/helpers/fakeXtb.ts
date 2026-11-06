import type { Cell } from '../../src/xlsx/reader.ts';
import { buildXlsx, serial, type SheetSpec } from './xlsxBuilder.ts';

// Synthetic data mirroring the layout of the XTB xStation "account history" export (see docs/xtb-format.md).

export interface FakeClosed {
  ticker: string;
  volume: number;
  openPrice: number;
  openTime: string;
  closePrice: number;
  closeTime: string;
  profit: number;
  positionId: string;
}

export interface FakeCash {
  id: string;
  type: string;
  ticker?: string;
  time: string;
  amount: number;
  comment?: string;
  positionId?: string;
}

export interface FakeOpenLot {
  ticker: string;
  name: string;
  positionId: string;
  volume: number;
  openPrice: number;
  openTime: string;
  currentPrice: number;
}

export interface FakeExport {
  account?: string;
  currency?: string;
  from?: string;
  to?: string;
  closed?: FakeClosed[];
  cash?: FakeCash[];
  openAsOf?: string;
  open?: FakeOpenLot[];
}

export function fakeXtbExport(e: FakeExport): Buffer {
  return buildXlsx(fakeXtbSheets(e));
}

export function fakeXtbSheets(e: FakeExport): SheetSpec[] {
  const account = e.account ?? '11111111';
  const from = serial(e.from ?? '2023-12-31T23:00:00Z');
  const to = serial(e.to ?? '2024-12-31T23:00:00Z');
  const closed = e.closed ?? [];
  const cash = e.cash ?? [];
  const open = e.open ?? [];

  const closedRows: Cell[][] = [
    ['Account number', account],
    ['Closed Positions'],
    ['Date from (UTC)', from],
    ['Date to (UTC)', to],
    ['Instrument', 'Ticker', 'Category', 'Type', 'Volume', 'Open Price', 'Open Time (UTC)', 'Close Price',
      'Close Time (UTC)', 'Product', 'Profit/Loss', 'Gross Profit', 'Purchase Value', 'Sale Value', 'Stop Loss',
      'Take Profit', 'Commission', 'Margin', 'Swap', 'Rollover', 'Open Conversion Rate', 'Close Conversion Rate',
      'Close Origin', 'Position ID', 'Comment'],
    ...closed.map((c): Cell[] => [
      `Name ${c.ticker}`, c.ticker, 'ETF', 'BUY', c.volume, c.openPrice, serial(c.openTime), c.closePrice,
      serial(c.closeTime), 'My Trades', c.profit, c.profit, c.volume * c.openPrice, c.volume * c.closePrice, null,
      null, 0, null, null, null, 1, 1, 'xStation5', c.positionId,
    ]),
    ['Profit/loss', null, null, null, null, null, null, null, null, null, closed.reduce((a, c) => a + c.profit, 0)],
  ];

  const cashRows: Cell[][] = [
    ['Account number', account],
    ['Cash Operations'],
    ['Date from (UTC)', from],
    ['Date to (UTC)', to],
    ['Type', 'Instrument', 'Ticker', 'Category', 'Time', 'Amount', 'ID', 'Comment', 'Product', 'Position ID'],
    ...cash.map((c): Cell[] => [
      c.type, c.ticker ? `Name ${c.ticker}` : null, c.ticker ?? null, c.ticker ? 'ETF' : null, serial(c.time),
      c.amount, c.id, c.comment ?? null, 'My Trades', c.positionId ?? null,
    ]),
    ['Total', null, null, null, null, cash.reduce((a, c) => a + c.amount, 0)],
  ];

  const byTicker = new Map<string, FakeOpenLot[]>();
  for (const l of open) byTicker.set(l.ticker, [...(byTicker.get(l.ticker) ?? []), l]);
  const totalValue = open.reduce((a, l) => a + l.volume * l.currentPrice, 0);
  const openRows: Cell[][] = [
    ['Account number', account],
    ['Open Positions'],
    ['Data as of report generated', serial(e.openAsOf ?? '2025-01-15T10:00:00Z')],
    ['Product', 'Metric', 'Amount', 'Currency'],
    ['My Trades', 'Open position value', totalValue, e.currency ?? 'EUR'],
    ['My Trades', 'Open position profit', 0, e.currency ?? 'EUR'],
    [],
    ['Note', 'Summary values and open positions are shown as of the report generation time'],
    ['Product', 'Instrument/Position', 'Ticker', 'Category', 'Type', 'Volume', 'Value', 'Current price', 'Open price',
      'Open time (UTC)', 'Stop Loss', 'Take Profit', 'Net Profit %', 'Net Profit', 'Gross Profit', 'Margin',
      'Open Commission', 'Swap', 'Rollover'],
  ];
  for (const [ticker, lots] of byTicker) {
    const vol = lots.reduce((a, l) => a + l.volume, 0);
    openRows.push(['My Trades', lots[0]!.name, ticker, 'ETF', null, vol, vol * lots[0]!.currentPrice]);
    for (const l of lots) {
      const value = l.volume * l.currentPrice;
      const profit = l.volume * (l.currentPrice - l.openPrice);
      openRows.push([
        'My Trades', l.positionId, ticker, null, 'BUY', l.volume, value, l.currentPrice, l.openPrice,
        serial(l.openTime), null, null, 0, profit, profit,
      ]);
    }
  }

  return [
    { name: 'Closed Positions', rows: closedRows },
    { name: 'Cash Operations', rows: cashRows },
    { name: 'Open Positions', rows: openRows },
  ];
}
