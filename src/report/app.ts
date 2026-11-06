// Browser app of the HTML report. Inlined into the report after type stripping:
// only type imports and the crypto helpers (concatenated by the build) may be used.
import type { Analysis, Holding, HoldingLot, RealizedInstrument, RealizedLot, TaxYear, DividendSummary } from '../analysis/portfolio.ts';
import type { Money, Percent, Totals } from '../analysis/fx.ts';
import type { HistoryPoint } from '../analysis/market.ts';
import { decryptPayload, type EncryptedPayload } from './crypto.ts';

type Cur = 'czk' | 'eur';
type Child = Node | string | null | undefined | false;
type ChartMode = { kind: 'portfolio' } | { kind: 'instrument'; ticker: string; view: 'price' | 'value' };

const RANGES: [label: string, days: number | null][] = [
  ['1M', 31], ['3M', 92], ['6M', 183], ['1R', 366], ['3R', 1096], ['Vše', null],
];
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#2f4b7c', '#a05195'];

const state = {
  data: null as Analysis | null,
  cur: 'czk' as Cur,
  tab: 'portfolio' as 'portfolio' | 'sold',
  range: 'Vše',
  chart: { kind: 'portfolio' } as ChartMode,
  open: new Set<string>(),
};

// ---------------------------------------------------------------- DOM helpers

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag: string, attrs: Record<string, string | number> = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ---------------------------------------------------------------- formatting

const nf = new Map<string, Intl.NumberFormat>();
function fmtNum(v: number, digits = 2): string {
  const key = `n${digits}`;
  if (!nf.has(key)) nf.set(key, new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: digits }));
  return nf.get(key)!.format(v);
}
function fmtMoney(v: number | null | undefined, currency: string, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = digits ?? (currency === 'CZK' ? 0 : 2);
  if (Math.abs(v) < 0.5 * 10 ** -d) v = 0; // avoid "-0 Kč"
  const key = `${currency}${d}`;
  if (!nf.has(key)) nf.set(key, new Intl.NumberFormat('cs-CZ', { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }));
  return nf.get(key)!.format(v);
}
function fmtAxis(v: number, currency: string): string {
  const key = `axis${currency}`;
  if (!nf.has(key)) {
    nf.set(key, new Intl.NumberFormat('cs-CZ', currency
      ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
      : { notation: 'compact', maximumFractionDigits: 1 }));
  }
  return nf.get(key)!.format(Math.abs(v) < 1e-9 ? 0 : v);
}
const curCode = () => (state.cur === 'czk' ? 'CZK' : 'EUR');
function totals(t: Totals): string {
  const v = t[state.cur];
  if (v != null) return fmtMoney(v, curCode());
  const parts = Object.entries(t.native).map(([c, n]) => fmtMoney(n, c));
  return parts.length ? parts.join(' + ') : '—';
}
const totalsValue = (t: Totals): number | null => t[state.cur];
function money(m: Money | null): string {
  if (!m) return '—';
  const v = m[state.cur];
  return v != null ? fmtMoney(v, curCode()) : fmtMoney(m.native, m.currency);
}
function pctValue(p: Percent | null): number | null {
  return p ? (p[state.cur] ?? p.native) : null;
}
function pct(p: Percent | number | null): string {
  const v = typeof p === 'number' || p === null ? p : pctValue(p);
  return v == null ? '—' : `${v > 0 ? '+' : ''}${fmtNum(v, 2)} %`;
}
const sign = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
function czDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
}
const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  if (code === '??') return 'Neznámé složení';
  if (code === 'XX') return 'Ostatní';
  try {
    regionNames ??= new Intl.DisplayNames(['cs'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function signed(text: string, value: number | null | undefined, tag: 'span' | 'td' = 'span'): HTMLElement {
  return h(tag, { class: `num ${sign(value)}` }, text);
}

// ---------------------------------------------------------------- unlock

async function unlock(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector('input')!;
  const msg = form.querySelector('.msg')!;
  const button = form.querySelector('button')!;
  button.disabled = true;
  msg.textContent = 'Dešifruji…';
  try {
    const payload = JSON.parse(document.getElementById('payload')!.textContent!) as EncryptedPayload;
    const json = await decryptPayload(payload, input.value);
    input.value = '';
    state.data = JSON.parse(json) as Analysis;
    render();
  } catch (e) {
    msg.textContent = e instanceof DOMException && e.name === 'OperationError' ? 'Špatné heslo.' : `Chyba: ${(e as Error).message}`;
    button.disabled = false;
    input.select();
  }
}

function renderLogin(): void {
  const form = h('form', { class: 'login', autocomplete: 'off' },
    h('h1', {}, 'Stockera'),
    h('p', {}, 'Report je zašifrovaný. Zadej heslo – data se dešifrují jen v tomto prohlížeči.'),
    h('input', { type: 'password', placeholder: 'Heslo', autofocus: true, required: true, autocomplete: 'current-password' }),
    h('button', { type: 'submit' }, 'Odemknout'),
    h('p', { class: 'msg' }),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void unlock(form);
  });
  document.getElementById('app')!.replaceChildren(form);
  form.querySelector('input')!.focus();
}

// ---------------------------------------------------------------- layout

function render(): void {
  const a = state.data!;
  const scrollY = window.scrollY;
  const app = document.getElementById('app')!;
  app.replaceChildren(
    header(a),
    h('main', {}, state.tab === 'portfolio' ? portfolioTab(a) : soldTab(a)),
    h('footer', {}, `Vygenerováno ${new Date(a.generatedAt).toLocaleString('cs-CZ')} · data XTB k ${czDate(a.snapshotAsOf)} · vše zpracováno lokálně`),
  );
  window.scrollTo(0, scrollY);
}

function header(a: Analysis): HTMLElement {
  const tab = (id: typeof state.tab, label: string) => {
    const b = h('button', { class: `tab${state.tab === id ? ' active' : ''}`, type: 'button' }, label);
    b.addEventListener('click', () => { state.tab = id; render(); });
    return b;
  };
  const curBtn = (c: Cur) => {
    const b = h('button', { class: state.cur === c ? 'active' : '', type: 'button' }, c === 'czk' ? 'Kč' : '€');
    b.addEventListener('click', () => { state.cur = c; render(); });
    return b;
  };
  const lock = h('button', { class: 'lock', type: 'button', title: 'Zamknout' }, 'Zamknout');
  lock.addEventListener('click', () => { state.data = null; state.open.clear(); renderLogin(); });
  return h('header', {},
    h('div', { class: 'brand' }, 'Stockera', h('small', {}, a.summary.valueDate ? ` ocenění k ${czDate(a.summary.valueDate)}` : '')),
    h('nav', { class: 'tabs' }, tab('portfolio', 'Portfolio'), tab('sold', 'Prodané')),
    h('div', { class: 'tools' }, h('div', { class: 'toggle' }, curBtn('czk'), curBtn('eur')), lock),
  );
}

function card(label: string, value: string, sub?: HTMLElement | string, cls = ''): HTMLElement {
  return h('div', { class: `card ${cls}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

function accordion(key: string, summary: Child[], body: () => HTMLElement): HTMLDetailsElement {
  const d = h('details', { class: 'acc', open: state.open.has(key) }, h('summary', {}, ...summary));
  let filled = false;
  const fill = () => {
    if (!filled && d.open) { d.append(body()); filled = true; }
  };
  fill();
  d.addEventListener('toggle', () => {
    if (d.open) state.open.add(key); else state.open.delete(key);
    fill();
  });
  return d;
}

function table(head: string[], rows: HTMLTableRowElement[], numericFrom = 1): HTMLElement {
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ...head.map((t, i) => h('th', { class: i >= numericFrom ? 'num' : '' }, t)))),
    h('tbody', {}, ...rows),
  ));
}

function badge(text: string, kind: 'ok' | 'wait' | 'bad' | 'info'): HTMLElement {
  return h('span', { class: `badge ${kind}` }, text);
}

function taxBadge(l: HoldingLot): HTMLElement {
  return l.taxFree
    ? badge('bez daně', 'ok')
    : badge(`od ${czDate(l.taxFreeFrom)} (${fmtNum(l.daysUntilTaxFree, 0)} d)`, 'wait');
}

// ---------------------------------------------------------------- portfolio tab

function portfolioTab(a: Analysis): HTMLElement {
  const s = a.summary;
  const free = a.holdings.flatMap((x) => x.lots).filter((l) => l.taxFree);
  const freeValue = free.reduce<number | null>((acc, l) => (acc == null || l.value?.[state.cur] == null ? null : acc + l.value[state.cur]!), 0);
  return h('div', {},
    h('section', { class: 'cards' },
      card('Hodnota portfolia', totals(s.value)),
      card('Investováno', totals(s.cost)),
      card('Nerealizovaný zisk', totals(s.unrealizedProfit), signed(pct(s.unrealizedPct), pctValue(s.unrealizedPct)), sign(totalsValue(s.unrealizedProfit))),
      card('Realizovaný zisk', totals(s.realizedProfit), undefined, sign(totalsValue(s.realizedProfit))),
      card('Dividendy (čisté)', totals(s.dividendsNet)),
      card('Splněný časový test', freeValue == null ? '—' : fmtMoney(freeValue, curCode()), `${free.length} z ${a.holdings.reduce((n, x) => n + x.lots.length, 0)} nákupů`),
    ),
    mainChartPanel(a),
    h('section', { class: 'grid2' }, allocationPanel(a), geographyPanel(a)),
    upcomingPanel(a),
    h('section', { class: 'panel' },
      h('h2', {}, 'Držené instrumenty'),
      h('div', { class: 'acc-list' }, ...a.holdings.map(holdingRow)),
    ),
    checksPanel(a),
  );
}

function holdingRow(x: Holding): HTMLElement {
  const chartBtn = h('button', { class: 'mini', type: 'button', title: 'Zobrazit graf instrumentu' }, 'Graf');
  chartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showInstrument(x.ticker);
  });
  const allFree = x.taxFreeQuantity >= x.quantity - 1e-9;
  const tax = allFree
    ? badge('vše bez daně', 'ok')
    : x.taxFreeQuantity > 0
      ? badge(`${fmtNum(x.taxFreeQuantity, 4)} ks bez daně, další ${czDate(x.nextTaxFreeDate)}`, 'info')
      : badge(`bez daně od ${czDate(x.nextTaxFreeDate)}`, 'wait');
  return accordion(`h:${x.ticker}`, [
    h('div', { class: 'row-main' },
      h('div', { class: 'name' }, h('b', {}, x.ticker), h('span', {}, x.name ?? '')),
      h('div', { class: 'row-nums' },
        h('span', { class: 'num' }, `${fmtNum(x.quantity, 4)} ks`),
        h('span', { class: 'num strong' }, totals(x.value)),
        signed(totals(x.profit), totalsValue(x.profit)),
        signed(pct(x.profitPct), pctValue(x.profitPct)),
      ),
      h('div', { class: 'row-extra' }, tax, chartBtn),
    ),
  ], () => table(
    ['Nákup', 'Ks', 'Nákupní cena', 'Investováno', 'Hodnota', 'Zisk', '%', 'Časový test'],
    x.lots.map((l) => h('tr', {},
      h('td', {}, czDate(l.openDate)),
      h('td', { class: 'num' }, fmtNum(l.quantity, 4)),
      h('td', { class: 'num' }, fmtNum(l.openPrice, 4)),
      h('td', { class: 'num' }, money(l.cost)),
      h('td', { class: 'num' }, money(l.value)),
      signed(money(l.profit), l.profit?.[state.cur] ?? l.profit?.native, 'td'),
      signed(pct(l.profitPct), pctValue(l.profitPct), 'td'),
      h('td', {}, taxBadge(l)),
    )),
  ));
}

function showInstrument(ticker: string): void {
  state.chart = { kind: 'instrument', ticker, view: 'price' };
  render();
  document.getElementById('main-chart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function upcomingPanel(a: Analysis): HTMLElement | null {
  const lots = a.holdings
    .flatMap((x) => x.lots.filter((l) => !l.taxFree).map((l) => ({ x, l })))
    .sort((p, q) => p.l.taxFreeFrom.localeCompare(q.l.taxFreeFrom))
    .slice(0, 6);
  if (!lots.length) return null;
  return h('section', { class: 'panel' },
    h('h2', {}, 'Nejbližší splnění časového testu'),
    table(['Instrument', 'Nákup', 'Ks', 'Hodnota', 'Zisk', 'Bez daně od'], lots.map(({ x, l }) => h('tr', {},
      h('td', {}, h('b', {}, x.ticker)),
      h('td', {}, czDate(l.openDate)),
      h('td', { class: 'num' }, fmtNum(l.quantity, 4)),
      h('td', { class: 'num' }, money(l.value)),
      signed(money(l.profit), l.profit?.[state.cur] ?? l.profit?.native, 'td'),
      h('td', { class: 'num' }, taxBadge(l)),
    )), 2),
  );
}

function checksPanel(a: Analysis): HTMLElement | null {
  const items: string[] = [...a.checks.warnings];
  for (const m of a.checks.fifoMismatches) items.push(`FIFO nesedí: ${JSON.stringify(m)}`);
  if (a.checks.missingRates.length) items.push(`Chybí kurzy ČNB: ${a.checks.missingRates.slice(0, 10).join(', ')}${a.checks.missingRates.length > 10 ? '…' : ''}`);
  const unknown = a.holdings.filter((x) => !x.countries.length).map((x) => x.ticker);
  if (unknown.length) items.push(`Neznámé geografické složení: ${unknown.join(', ')} (doplň data/instruments.json)`);
  const noPrice = a.holdings.filter((x) => !(a.instruments[x.ticker]?.prices.length)).map((x) => x.ticker);
  if (noPrice.length) items.push(`Chybí historie cen: ${noPrice.join(', ')}`);
  if (!items.length) return null;
  return h('section', { class: 'panel warn' }, h('h2', {}, 'Upozornění'), h('ul', {}, ...items.map((t) => h('li', {}, t))));
}

// ---------------------------------------------------------------- charts

function rangeButtons(): HTMLElement {
  return h('div', { class: 'toggle small' }, ...RANGES.map(([label]) => {
    const b = h('button', { type: 'button', class: state.range === label ? 'active' : '' }, label);
    b.addEventListener('click', () => { state.range = label; render(); });
    return b;
  }));
}

function rangeStart(lastIso: string): number | null {
  const days = RANGES.find(([l]) => l === state.range)?.[1] ?? null;
  return days == null ? null : dayMs(lastIso) - days * 86_400_000;
}

function mainChartPanel(a: Analysis): HTMLElement {
  const panel = h('section', { class: 'panel', id: 'main-chart' });
  const mode = state.chart;
  if (mode.kind === 'instrument') {
    const holding = a.holdings.find((x) => x.ticker === mode.ticker);
    const back = h('button', { type: 'button', class: 'mini' }, '← Celé portfolio');
    back.addEventListener('click', () => { state.chart = { kind: 'portfolio' }; render(); });
    const viewBtn = (v: 'price' | 'value', label: string) => {
      const b = h('button', { type: 'button', class: mode.view === v ? 'active' : '' }, label);
      b.addEventListener('click', () => { state.chart = { ...mode, view: v }; render(); });
      return b;
    };
    panel.append(
      h('div', { class: 'panel-head' },
        h('h2', {}, `${mode.ticker} `, h('small', {}, holding?.name ?? '')),
        h('div', { class: 'tools' }, h('div', { class: 'toggle small' }, viewBtn('price', 'Cena'), viewBtn('value', 'Hodnota pozice')), rangeButtons(), back),
      ),
      instrumentChart(a, mode.ticker, mode.view),
    );
  } else {
    panel.append(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Vývoj hodnoty portfolia'), h('div', { class: 'tools' }, rangeButtons())),
      portfolioChart(a.history),
    );
  }
  return panel;
}

interface Series { name: string; color: string; points: [x: number, y: number][]; dashed?: boolean; area?: boolean }
interface Marker { x: number; y: number; color: string; label: string }

function portfolioChart(history: HistoryPoint[]): HTMLElement {
  if (!history.length) return h('p', { class: 'empty' }, 'Historie hodnoty není k dispozici (spusť `pnpm market`).');
  const start = rangeStart(history.at(-1)!.date);
  const pts = history.filter((p) => start == null || dayMs(p.date) >= start);
  const val = (p: HistoryPoint) => (state.cur === 'czk' ? p.valueCzk : p.valueEur);
  const inv = (p: HistoryPoint) => (state.cur === 'czk' ? p.investedCzk : p.investedEur);
  return lineChart(
    [
      { name: 'Hodnota', color: '#4e79a7', points: pts.map((p) => [dayMs(p.date), val(p)]), area: true },
      { name: 'Investováno', color: '#f28e2b', points: pts.map((p) => [dayMs(p.date), inv(p)]), dashed: true },
    ],
    [],
    (v) => fmtMoney(v, curCode(), 0),
    curCode(),
    (i) => {
      const p = pts[i]!;
      const d = val(p) - inv(p);
      return `Zisk ${fmtMoney(d, curCode(), 0)} (${pct(inv(p) ? (d / inv(p)) * 100 : null)})`;
    },
  );
}

function instrumentChart(a: Analysis, ticker: string, view: 'price' | 'value'): HTMLElement {
  const series = a.instruments[ticker];
  if (!series?.prices.length) return h('p', { class: 'empty' }, 'Pro tento instrument nejsou stažené ceny. Doplň zdroj v data/instruments.json a spusť `pnpm market`.');
  const currency = series.currency ?? '';
  const holding = a.holdings.find((x) => x.ticker === ticker);
  const sold = a.realized.find((x) => x.ticker === ticker);
  const start = rangeStart(series.prices.at(-1)![0]);
  const prices = series.prices.filter(([d]) => start == null || dayMs(d) >= start);
  const inRange = (iso: string) => start == null || dayMs(iso) >= start;
  const fmt = (v: number) => (currency ? fmtMoney(v, currency, 2) : fmtNum(v, 2));

  if (view === 'value') {
    const lots: { from: string; to: string | null; qty: number }[] = [
      ...(holding?.lots ?? []).map((l) => ({ from: l.openDate, to: null, qty: l.quantity })),
      ...(sold?.lots ?? []).map((l) => ({ from: l.openDate, to: l.closeDate, qty: l.quantity })),
    ];
    const pts: [number, number][] = prices.map(([d, c]) => {
      const qty = lots.reduce((n, l) => (l.from <= d && (l.to == null || d < l.to) ? n + l.qty : n), 0);
      return [dayMs(d), qty * c];
    });
    return lineChart([{ name: `Hodnota (${currency})`, color: '#59a14f', points: pts, area: true }], [], fmt, currency);
  }

  const markers: Marker[] = [
    ...(holding?.lots ?? []).filter((l) => inRange(l.openDate)).map((l) => ({ x: dayMs(l.openDate), y: l.openPrice, color: '#59a14f', label: `Nákup ${czDate(l.openDate)}: ${fmtNum(l.quantity, 4)} ks à ${fmt(l.openPrice)}` })),
    ...(sold?.lots ?? []).flatMap((l) => [
      ...(inRange(l.openDate) ? [{ x: dayMs(l.openDate), y: l.openPrice, color: '#59a14f', label: `Nákup ${czDate(l.openDate)}: ${fmtNum(l.quantity, 4)} ks à ${fmt(l.openPrice)} (prodáno)` }] : []),
      ...(inRange(l.closeDate) ? [{ x: dayMs(l.closeDate), y: l.closePrice, color: '#e15759', label: `Prodej ${czDate(l.closeDate)}: ${fmtNum(l.quantity, 4)} ks à ${fmt(l.closePrice)}` }] : []),
    ]),
  ];
  const lines: Series[] = [{ name: `Cena (${currency})`, color: '#4e79a7', points: prices.map(([d, c]) => [dayMs(d), c]) }];
  if (holding?.lots.length) {
    const qty = holding.lots.reduce((n, l) => n + l.quantity, 0);
    const avg = holding.lots.reduce((n, l) => n + l.openPrice * l.quantity, 0) / qty;
    lines.push({ name: 'Průměrná nákupní cena', color: '#f28e2b', dashed: true, points: [[dayMs(prices[0]![0]), avg], [dayMs(prices.at(-1)![0]), avg]] });
  }
  const wrap = lineChart(lines, markers, fmt, currency);
  wrap.append(h('p', { class: 'hint' }, 'Zelené body = nákupy, červené = prodeje. Ceny v měně instrumentu.'));
  return wrap;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(v);
  return ticks;
}

function lineChart(series: Series[], markers: Marker[], fmtY: (v: number) => string, axisCurrency: string, extra?: (i: number) => string): HTMLElement {
  const wrap = h('div', { class: 'chart' });
  const tip = h('div', { class: 'tip' });
  const legend = h('div', { class: 'legend' }, ...series.map((sr) => h('span', {}, swatch(sr.color), sr.name)));
  wrap.append(legend);
  const main = series[0]!;
  if (main.points.length < 2) {
    wrap.append(h('p', { class: 'empty' }, 'Málo dat pro graf v tomto období.'));
    return wrap;
  }
  const W = Math.max(320, Math.min(document.getElementById('app')!.clientWidth - 40, 1200));
  const H = W < 600 ? 220 : 300;
  const pad = { l: W < 600 ? 56 : 80, r: 12, t: 10, b: 26 };
  const xs = series.flatMap((sr) => sr.points.map((p) => p[0]));
  const ys = [...series.flatMap((sr) => sr.points.map((p) => p[1])), ...markers.map((m) => m.y)];
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = y1 - y0 || Math.abs(y1) || 1;
  y0 -= span * 0.05; y1 += span * 0.05;
  const ticks = niceTicks(y0, y1);
  y0 = Math.min(y0, ticks[0]!); y1 = Math.max(y1, ticks.at(-1)!);
  const X = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  for (const t of ticks) {
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t), class: 'grid' }));
    svg.append(s('text', { x: pad.l - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'axis' }, fmtAxis(t, axisCurrency)));
  }
  const xTickCount = W < 600 ? 3 : 6;
  for (let i = 0; i <= xTickCount; i++) {
    const v = x0 + ((x1 - x0) * i) / xTickCount;
    const d = new Date(v);
    const label = `${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${String(d.getUTCFullYear()).slice(2)}`;
    svg.append(s('text', { x: X(v), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === xTickCount ? 'end' : 'middle', class: 'axis' }, label));
  }
  for (const sr of series) {
    const d = sr.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    if (sr.area) {
      svg.append(s('path', { d: `${d}L${X(sr.points.at(-1)![0]).toFixed(1)},${Y(y0)}L${X(sr.points[0]![0]).toFixed(1)},${Y(y0)}Z`, fill: sr.color, 'fill-opacity': 0.12, stroke: 'none' }));
    }
    svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-dasharray': sr.dashed ? '6 4' : 'none' }));
  }
  for (const m of markers) {
    svg.append(s('circle', { cx: X(m.x), cy: Y(m.y), r: 5, fill: m.color, stroke: '#fff', 'stroke-width': 1.5 }, s('title', {}, m.label)));
  }
  const cursor = s('line', { y1: pad.t, y2: H - pad.b, class: 'cursor', visibility: 'hidden' });
  const dots = series.map((sr) => s('circle', { r: 4, fill: sr.color, visibility: 'hidden' }));
  svg.append(cursor, ...dots);

  const move = (ev: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const xv = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let lo = 0, hi = main.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (main.points[mid]![0] < xv) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(main.points[lo - 1]![0] - xv) < Math.abs(main.points[lo]![0] - xv)) lo--;
    const [px0] = main.points[lo]!;
    cursor.setAttribute('x1', String(X(px0)));
    cursor.setAttribute('x2', String(X(px0)));
    cursor.setAttribute('visibility', 'visible');
    const lines = [czDate(new Date(px0).toISOString())];
    series.forEach((sr, i) => {
      const p = sr.points.find((q) => q[0] === px0) ?? (sr.points.length === 2 ? [px0, sr.points[0]![1]] as [number, number] : null);
      const dot = dots[i]!;
      if (!p) { dot.setAttribute('visibility', 'hidden'); return; }
      dot.setAttribute('cx', String(X(p[0])));
      dot.setAttribute('cy', String(Y(p[1])));
      dot.setAttribute('visibility', 'visible');
      lines.push(`${sr.name}: ${fmtY(p[1])}`);
    });
    if (extra) lines.push(extra(lo));
    tip.replaceChildren(...lines.map((t, i) => h('div', { class: i ? '' : 'strong' }, t)));
    tip.classList.add('show');
    const left = (X(px0) / W) * rect.width;
    tip.style.left = `${Math.min(Math.max(left + 12, 0), rect.width - tip.offsetWidth)}px`;
    if (left + 12 + tip.offsetWidth > rect.width) tip.style.left = `${Math.max(left - tip.offsetWidth - 12, 0)}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => {
    tip.classList.remove('show');
    cursor.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
  });
  wrap.append(h('div', { class: 'plot' }, svg, tip));
  return wrap;
}

function swatch(color: string): SVGElement {
  return s('svg', { width: 12, height: 12, class: 'swatch' }, s('rect', { width: 12, height: 12, rx: 3, fill: color }));
}

function donut(items: { label: string; value: number; color: string; title: string }[], center: string): SVGElement {
  const size = 200, r = 90, inner = 58, c = size / 2;
  const total = items.reduce((n, i) => n + i.value, 0);
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img' });
  let angle = -Math.PI / 2;
  for (const it of items) {
    const frac = total ? it.value / total : 0;
    if (frac <= 0) continue;
    if (frac >= 0.9999) {
      svg.append(s('circle', { cx: c, cy: c, r: (r + inner) / 2, fill: 'none', stroke: it.color, 'stroke-width': r - inner }, s('title', {}, it.title)));
      continue;
    }
    const a2 = angle + frac * 2 * Math.PI;
    const large = frac > 0.5 ? 1 : 0;
    const p = (rad: number, a: number) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
    svg.append(s('path', {
      d: `M${p(r, angle)}A${r},${r} 0 ${large} 1 ${p(r, a2)}L${p(inner, a2)}A${inner},${inner} 0 ${large} 0 ${p(inner, angle)}Z`,
      fill: it.color,
    }, s('title', {}, it.title)));
    angle = a2;
  }
  svg.append(s('text', { x: c, y: c + 5, 'text-anchor': 'middle', class: 'donut-center' }, center));
  return svg;
}

function allocationPanel(a: Analysis): HTMLElement {
  const measure = (t: Totals) => t[state.cur] ?? Object.values(t.native).reduce((n, v) => n + v, 0);
  const total = a.holdings.reduce((n, x) => n + measure(x.value), 0);
  const items = [...a.holdings]
    .sort((p, q) => measure(q.value) - measure(p.value))
    .map((x, i) => ({ label: x.ticker, value: measure(x.value), color: PALETTE[i % PALETTE.length]!, title: `${x.ticker}: ${totals(x.value)}`, x }));
  const legend = h('ul', { class: 'legend-list' }, ...items.map((it) => {
    const li = h('li', { class: 'clickable', title: 'Zobrazit graf' }, swatch(it.color), h('span', { class: 'lname' }, it.label, h('small', {}, ` ${it.x.name ?? ''}`)), h('span', { class: 'num' }, `${fmtNum(total ? (it.value / total) * 100 : 0, 1)} %`));
    li.addEventListener('click', () => showInstrument(it.label));
    return li;
  }));
  return h('section', { class: 'panel' }, h('h2', {}, 'Rozložení podle instrumentů'),
    h('div', { class: 'donut-wrap' }, donut(items, `${a.holdings.length} instr.`), legend));
}

function geographyPanel(a: Analysis): HTMLElement {
  const top = a.geography.slice(0, 12);
  const rest = a.geography.slice(12);
  const restShare = rest.reduce((n, g) => n + g.share, 0);
  const items = top.map((g, i) => ({
    label: countryName(g.country),
    value: g.share,
    color: g.country === '??' ? '#999' : g.country === 'XX' ? '#bbb' : PALETTE[i % PALETTE.length]!,
    title: `${countryName(g.country)}: ${fmtNum(g.share, 1)} %`,
    money: g[state.cur],
  }));
  if (restShare > 0) items.push({ label: `Další země (${rest.length})`, value: restShare, color: '#ccc', title: `Další: ${fmtNum(restShare, 1)} %`, money: null });
  const max = Math.max(...items.map((i) => i.value), 1);
  return h('section', { class: 'panel' }, h('h2', {}, 'Geografické rozložení'),
    items.length
      ? h('div', { class: 'bars' }, ...items.map((it) => {
          const bar = h('div', { class: 'bar' });
          bar.style.width = `${(it.value / max) * 100}%`;
          bar.style.background = it.color;
          return h('div', { class: 'bar-row', title: it.title },
            h('span', { class: 'bar-label' }, it.label),
            h('div', { class: 'bar-track' }, bar),
            h('span', { class: 'num' }, `${fmtNum(it.value, 1)} %`),
          );
        }))
      : h('p', { class: 'empty' }, 'Složení není k dispozici.'),
    h('p', { class: 'hint' }, 'ETF se rozpočítávají podle zemí v jejich složení (zdroj justETF, jen hlavní země; zbytek = „Ostatní“).'),
  );
}

// ---------------------------------------------------------------- sold tab

function soldTab(a: Analysis): HTMLElement {
  const sum = (f: (r: RealizedInstrument) => Totals) => {
    let v: number | null = 0;
    for (const r of a.realized) { const x = f(r)[state.cur]; v = v == null || x == null ? null : v + x; }
    return v;
  };
  const proceeds = sum((r) => r.proceeds), cost = sum((r) => r.cost), profit = sum((r) => r.profit);
  const lots = a.realized.reduce((n, r) => n + r.lots.length, 0);
  if (!a.realized.length) return h('section', { class: 'panel' }, h('p', { class: 'empty' }, 'Zatím žádné prodeje.'));
  return h('div', {},
    h('section', { class: 'cards' },
      card('Prodáno celkem', proceeds == null ? '—' : fmtMoney(proceeds, curCode()), `${lots} prodejů`),
      card('Nákupní cena prodaného', cost == null ? '—' : fmtMoney(cost, curCode())),
      card('Zisk / ztráta', profit == null ? '—' : fmtMoney(profit, curCode()), signed(pct(cost ? ((profit ?? 0) / cost) * 100 : null), profit), sign(profit)),
      card('Dividendy (čisté)', totals(a.summary.dividendsNet)),
    ),
    taxYearsPanel(a.taxYears),
    h('section', { class: 'panel' }, h('h2', {}, 'Prodané instrumenty'), h('div', { class: 'acc-list' }, ...a.realized.map(realizedRow))),
    dividendsPanel(a.dividends),
  );
}

function taxYearsPanel(years: TaxYear[]): HTMLElement {
  const limit = (y: TaxYear) => y.limitStatus === 'within'
    ? badge(`v limitu 100 000 Kč (zbývá ${fmtMoney(y.limitRemainingCzk, 'CZK')})`, 'ok')
    : y.limitStatus === 'exceeded' ? badge('limit 100 000 Kč překročen', 'bad') : badge('limit nelze ověřit', 'info');
  return h('section', { class: 'panel' }, h('h2', {}, 'Daňové roky'),
    table(['Rok', 'Prodejů', 'Příjmy z prodejů', 'Limit', 'Osvobozeno čas. testem', 'Zdanitelné prodeje', 'Zisk zdanitelných', 'Základ daně'],
      [...years].sort((p, q) => q.year - p.year).map((y) => h('tr', {},
        h('td', {}, h('b', {}, String(y.year))),
        h('td', { class: 'num' }, String(y.salesCount)),
        h('td', { class: 'num' }, totals(y.proceeds)),
        h('td', {}, limit(y)),
        h('td', { class: 'num' }, totals(y.timeTestedProceeds)),
        h('td', { class: 'num' }, `${y.taxable.count}× ${totals(y.taxable.proceeds)}`),
        signed(totals(y.taxable.profit), totalsValue(y.taxable.profit), 'td'),
        h('td', { class: 'num strong' }, fmtMoney(y.taxable.baseCzk, 'CZK')),
      ))),
    h('p', { class: 'hint' }, 'Orientační výpočet (časový test 3 roky, limit 100 000 Kč hrubých příjmů za rok, kurzy ČNB ke dni obchodu). Nenahrazuje daňové poradenství.'),
  );
}

function realizedRow(r: RealizedInstrument): HTMLElement {
  const chartBtn = h('button', { class: 'mini', type: 'button' }, 'Graf');
  chartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    state.tab = 'portfolio';
    showInstrument(r.ticker);
  });
  return accordion(`r:${r.ticker}`, [
    h('div', { class: 'row-main' },
      h('div', { class: 'name' }, h('b', {}, r.ticker), h('span', {}, r.name ?? '')),
      h('div', { class: 'row-nums' },
        h('span', { class: 'num' }, `${fmtNum(r.quantity, 4)} ks`),
        h('span', { class: 'num strong' }, `prodáno za ${totals(r.proceeds)}`),
        signed(totals(r.profit), totalsValue(r.profit)),
        signed(pct(r.profitPct), pctValue(r.profitPct)),
      ),
      h('div', { class: 'row-extra' }, h('small', {}, `${czDate(r.firstSale)} – ${czDate(r.lastSale)}`), chartBtn),
    ),
  ], () => table(
    ['Nákup', 'Prodej', 'Ks', 'Nák. cena', 'Prod. cena', 'Náklad', 'Výnos', 'Zisk', '%', 'Držba', 'Časový test'],
    [...r.lots].sort((p, q) => q.closeTime.localeCompare(p.closeTime) || p.openTime.localeCompare(q.openTime)).map((l: RealizedLot) => h('tr', {},
      h('td', {}, czDate(l.openDate)),
      h('td', {}, czDate(l.closeDate)),
      h('td', { class: 'num' }, fmtNum(l.quantity, 4)),
      h('td', { class: 'num' }, fmtNum(l.openPrice, 4)),
      h('td', { class: 'num' }, fmtNum(l.closePrice, 4)),
      h('td', { class: 'num' }, money(l.cost)),
      h('td', { class: 'num' }, money(l.proceeds)),
      signed(money(l.profit), l.profit[state.cur] ?? l.profit.native, 'td'),
      signed(pct(l.profitPct), pctValue(l.profitPct), 'td'),
      h('td', { class: 'num' }, `${fmtNum(l.holdingDays, 0)} d`),
      h('td', {}, l.timeTestMet ? badge('splněn', 'ok') : badge('nesplněn', 'wait')),
    )),
    2,
  ));
}

function dividendsPanel(divs: DividendSummary[]): HTMLElement | null {
  if (!divs.length) return null;
  return h('section', { class: 'panel' }, h('h2', {}, 'Dividendy'),
    table(['Rok', 'Instrument', 'Hrubá', 'Srážková daň', 'Čistá'],
      [...divs].sort((p, q) => q.year - p.year || p.ticker.localeCompare(q.ticker)).map((d) => h('tr', {},
        h('td', {}, String(d.year)),
        h('td', {}, h('b', {}, d.ticker), ` ${d.name ?? ''}`),
        h('td', { class: 'num' }, totals(d.gross)),
        h('td', { class: 'num' }, totals(d.withholdingTax)),
        h('td', { class: 'num strong' }, totals(d.net)),
      )), 2),
  );
}

// ---------------------------------------------------------------- boot

let resizeTimer = 0;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return; // mobile address bar changes only the height
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { if (state.data) render(); }, 200);
});
renderLogin();
