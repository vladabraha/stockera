// Browser app of the HTML report. Inlined into the report after type stripping:
// only type imports and the crypto helpers (concatenated by the build) may be used.
// All DOM is built with createElement/textContent – never innerHTML – so data cannot inject markup.
import type { Analysis, Holding, HoldingLot, RealizedInstrument, RealizedLot, TaxYear, DividendSummary } from '../analysis/portfolio.ts';
import type { Money, Percent, Totals } from '../analysis/fx.ts';
import type { HistoryPoint } from '../analysis/market.ts';
import { decryptPayload, type EncryptedPayload } from './crypto.ts';

type Cur = 'czk' | 'eur';
type Child = Node | string | null | undefined | false;
type ChartMode = { kind: 'portfolio' } | { kind: 'instrument'; ticker: string; view: 'price' | 'value' };
type Point = [x: number, y: number];

const RANGES: [label: string, days: number | null][] = [
  ['1M', 31], ['3M', 92], ['6M', 183], ['1R', 366], ['3R', 1096], ['Vše', null],
];
const PALETTE = ['#127a6b', '#e0662b', '#3566c9', '#c23a6b', '#7a9a1f', '#d99a16', '#5a6b80', '#8d4a9e', '#1b8fb0', '#a3442b', '#4f7d4a', '#b38b59'];
const TAX_LIMIT_CZK = 100_000;

const state = {
  data: null as Analysis | null,
  cur: 'czk' as Cur,
  tab: 'portfolio' as 'portfolio' | 'sold',
  range: 'Vše',
  chart: { kind: 'portfolio' } as ChartMode,
  open: new Set<string>(),
  colors: new Map<string, string>(),
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

/** Sets colors through the CSSOM (allowed by the CSP, unlike inline style attributes). */
function paint<T extends HTMLElement | SVGElement>(el: T, props: Record<string, string>): T {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  return el;
}

function button(label: Child, onClick: () => void, cls = '', title?: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, title }, label);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function segmented<T extends string>(options: [T, string][], active: T, onPick: (v: T) => void, cls = ''): HTMLElement {
  return h('div', { class: `seg ${cls}`, role: 'group' },
    ...options.map(([v, label]) => button(label, () => onPick(v), v === active ? 'on' : '')));
}

// ---------------------------------------------------------------- formatting

const nf = new Map<string, Intl.NumberFormat>();
function fmt(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = nf.get(key);
  if (!f) nf.set(key, (f = make()));
  return f;
}
function fmtNum(v: number, digits = 2): string {
  return fmt(`n${digits}`, () => new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: digits })).format(v);
}
function fmtMoney(v: number | null | undefined, currency: string, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = digits ?? (currency === 'CZK' ? 0 : 2);
  if (Math.abs(v) < 0.5 * 10 ** -d) v = 0; // avoid "-0 Kč"
  return fmt(`${currency}${d}`, () => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d })).format(v);
}
function fmtAxis(v: number, currency: string): string {
  return fmt(`axis${currency}`, () => new Intl.NumberFormat('cs-CZ', currency
    ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
    : { notation: 'compact', maximumFractionDigits: 1 })).format(Math.abs(v) < 1e-9 ? 0 : v);
}
const curCode = () => (state.cur === 'czk' ? 'CZK' : 'EUR');
const measure = (t: Totals): number => t[state.cur] ?? Object.values(t.native).reduce((n, v) => n + v, 0);
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
/** Unit price in the instrument's own currency (prices stay native; totals follow the CZK/EUR switch). */
const price = (v: number, currency: string) => fmtMoney(v, currency, Math.abs(v) < 10 ? 4 : 2);
const moneyValue = (m: Money | null) => (m ? (m[state.cur] ?? m.native) : null);
const pctValue = (p: Percent | null): number | null => (p ? (p[state.cur] ?? p.native) : null);
function pct(p: Percent | number | null): string {
  const v = typeof p === 'number' || p === null ? p : pctValue(p);
  return v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${fmtNum(v, 2)} %`;
}
function signedMoney(text: string, v: number | null | undefined): string {
  return v != null && v > 0 && !text.startsWith('+') ? `+${text}` : text;
}
const sign = (v: number | null | undefined) => (v == null || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'pos' : 'neg');
function czDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
}
const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
function inDays(n: number): string {
  if (n <= 0) return 'dnes';
  if (n === 1) return 'zítra';
  if (n < 5) return `za ${n} dny`;
  return `za ${fmtNum(n, 0)} dní`;
}

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

function signed(text: string, value: number | null | undefined, tag: 'span' | 'td' | 'div' | 'b' = 'span', cls = ''): HTMLElement {
  return h(tag, { class: `num ${sign(value)} ${cls}` }, text);
}

// ---------------------------------------------------------------- visual atoms

const colorOf = (ticker: string) => state.colors.get(ticker) ?? '#8a8f98';

function assignColors(a: Analysis): void {
  state.colors.clear();
  const byValue = [...a.holdings].sort((p, q) => (q.value.czk ?? 0) - (p.value.czk ?? 0)).map((x) => x.ticker);
  for (const t of [...byValue, ...a.realized.map((r) => r.ticker)]) {
    if (!state.colors.has(t)) state.colors.set(t, PALETTE[state.colors.size % PALETTE.length]!);
  }
}

function avatar(ticker: string): HTMLElement {
  const label = ticker.split('.')[0]!.slice(0, 4);
  return paint(h('span', { class: `avatar${label.length > 3 ? ' long' : ''}`, 'aria-hidden': 'true' }, label), { background: colorOf(ticker) });
}

function progress(fraction: number, cls = ''): HTMLElement {
  const f = Math.max(0, Math.min(1, fraction));
  return h('div', { class: `progress ${cls}` }, paint(h('div', { class: 'fill' }), { width: `${(f * 100).toFixed(1)}%` }));
}

function logo(): SVGElement {
  return s('svg', { viewBox: '0 0 24 24', width: 26, height: 26, class: 'logo', 'aria-hidden': 'true' },
    s('rect', { width: 24, height: 24, rx: 7, class: 'logo-bg' }),
    s('path', { d: 'M6 16.5l4-4 3 2.5 5-6.5', class: 'logo-line' }),
    s('circle', { cx: 18, cy: 8.5, r: 1.6, class: 'logo-dot' }));
}

function tag(text: string, kind: 'ok' | 'wait' | 'bad' | 'info'): HTMLElement {
  return h('span', { class: `tag ${kind}` }, text);
}

/** Share of the 3-year holding period already elapsed. */
function lotProgress(l: HoldingLot): number {
  const total = (dayMs(l.taxFreeFrom) - dayMs(l.openDate)) / 86_400_000;
  return l.taxFree ? 1 : total > 0 ? 1 - l.daysUntilTaxFree / total : 0;
}

function lotTax(l: HoldingLot): HTMLElement {
  return h('div', { class: 'lot-tax' },
    progress(lotProgress(l), l.taxFree ? 'done' : ''),
    l.taxFree
      ? h('span', { class: 'ok-text' }, 'bez daně')
      : h('span', {}, czDate(l.taxFreeFrom), h('small', {}, ` · ${inDays(l.daysUntilTaxFree)}`)));
}

// ---------------------------------------------------------------- unlock

async function unlock(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector('input')!;
  const msg = form.querySelector('.msg')!;
  const submit = form.querySelector('button')!;
  submit.disabled = true;
  msg.textContent = 'Dešifruji…';
  msg.className = 'msg';
  if (!globalThis.crypto?.subtle || typeof DecompressionStream === 'undefined') {
    msg.textContent = 'Tento prohlížeč report neumí otevřít. Použij aktuální Chrome, Edge, Firefox nebo Safari (případně prohlížeč aktualizuj).';
    msg.className = 'msg err';
    submit.disabled = false;
    return;
  }
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(document.getElementById('payload')!.textContent!) as EncryptedPayload;
  } catch {
    msg.textContent = 'Soubor reportu je poškozený (nejspíš se nezkopíroval celý). Zkopíruj ho znovu z počítače.';
    msg.className = 'msg err';
    submit.disabled = false;
    return;
  }
  try {
    const json = await decryptPayload(payload, input.value);
    input.value = '';
    state.data = JSON.parse(json) as Analysis;
    assignColors(state.data);
    render();
  } catch (e) {
    msg.textContent = e instanceof DOMException && e.name === 'OperationError'
      ? 'Nesprávné heslo. Pozor na velká písmena a českou/anglickou klávesnici.'
      : `Report se nepodařilo otevřít (${(e as Error).message}). Zkus ho na počítači vytvořit znovu.`;
    msg.className = 'msg err';
    submit.disabled = false;
    input.select();
  }
}

function renderLogin(): void {
  const form = h('form', { class: 'login', autocomplete: 'off' },
    h('div', { class: 'login-brand' }, logo(), h('span', {}, 'Stockera')),
    h('h1', {}, 'Tvoje portfolio'),
    h('p', { class: 'muted' }, 'Report je zašifrovaný. Data se odemknou jen v tomto prohlížeči a nikam se neposílají.'),
    h('label', { class: 'field' },
      h('span', {}, 'Heslo'),
      h('input', { type: 'password', required: true, autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false' })),
    h('button', { type: 'submit', class: 'primary' }, 'Odemknout'),
    h('p', { class: 'msg', role: 'status' }),
    h('p', { class: 'muted small' }, 'Zapomenuté heslo? Na počítači spusť znovu aktualizaci a zvol nové.'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void unlock(form);
  });
  document.getElementById('app')!.replaceChildren(h('div', { class: 'login-wrap' }, form));
  form.querySelector('input')!.focus();
}

// ---------------------------------------------------------------- layout

function render(): void {
  const a = state.data!;
  const scrollY = window.scrollY;
  document.getElementById('app')!.replaceChildren(
    header(a),
    h('main', {}, state.tab === 'portfolio' ? portfolioTab(a) : soldTab(a)),
    h('footer', {},
      `Data XTB k ${czDate(a.snapshotAsOf)} · vygenerováno ${new Date(a.generatedAt).toLocaleString('cs-CZ')} · zpracováno lokálně, bez odesílání dat`),
  );
  window.scrollTo(0, scrollY);
}

function header(a: Analysis): HTMLElement {
  return h('header', {},
    h('div', { class: 'brand' }, logo(), h('span', {}, 'Stockera')),
    h('nav', { class: 'tabs' }, segmented([['portfolio', 'Portfolio'], ['sold', `Prodané${a.realized.length ? ` (${a.realized.length})` : ''}`]], state.tab, (t) => {
      state.tab = t;
      render();
      window.scrollTo(0, 0);
    })),
    h('div', { class: 'tools' },
      segmented([['czk', 'Kč'], ['eur', '€']], state.cur, (c) => { state.cur = c; render(); }, 'cur'),
      button('Zamknout', () => {
        state.data = null;
        state.open.clear();
        state.chart = { kind: 'portfolio' };
        renderLogin();
      }, 'ghost', 'Zahodit dešifrovaná data a zamknout')),
  );
}

function panel(title: string | null, ...children: Child[]): HTMLElement {
  return h('section', { class: 'panel' }, title ? h('h2', {}, title) : null, ...children);
}

function stat(label: string, value: string, sub?: Child, cls = ''): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), sub ? h('div', { class: 'sub' }, sub) : null);
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

/** Table that turns into labelled cards on narrow screens (labels via data-label + CSS). */
function table(head: string[], rows: HTMLTableRowElement[], numericFrom = 1): HTMLElement {
  for (const r of rows) [...r.cells].forEach((td, i) => td.setAttribute('data-label', head[i] ?? ''));
  return h('div', { class: 'scroll' }, h('table', { class: 'rtable' },
    h('thead', {}, h('tr', {}, ...head.map((t, i) => h('th', { class: i >= numericFrom ? 'num' : '' }, t)))),
    h('tbody', {}, ...rows),
  ));
}

// ---------------------------------------------------------------- portfolio tab

function portfolioTab(a: Analysis): HTMLElement {
  const s = a.summary;
  const lots = a.holdings.flatMap((x) => x.lots);
  const free = lots.filter((l) => l.taxFree);
  const freeValue = free.reduce((n, l) => n + (moneyValue(l.value) ?? 0), 0);
  return h('div', { class: 'stack' },
    heroPanel(a),
    h('section', { class: 'stats' },
      stat('Investováno', totals(s.cost)),
      stat('Nerealizovaný zisk', signedMoney(totals(s.unrealizedProfit), totalsValue(s.unrealizedProfit)), pct(s.unrealizedPct), sign(totalsValue(s.unrealizedProfit))),
      stat('Realizovaný zisk', signedMoney(totals(s.realizedProfit), totalsValue(s.realizedProfit)), null, sign(totalsValue(s.realizedProfit))),
      stat('Dividendy čistě', totals(s.dividendsNet)),
      stat('Lze prodat bez daně', fmtMoney(freeValue, curCode()), `${free.length} z ${lots.length} nákupů`),
    ),
    h('div', { class: 'grid2' }, allocationPanel(a), geographyPanel(a)),
    upcomingPanel(a),
    panel(null,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Držené instrumenty'), h('span', { class: 'muted' }, `${a.holdings.length} instrumentů · ${lots.length} nákupů`)),
      h('div', { class: 'acc-list' }, ...a.holdings.map(holdingRow))),
    checksPanel(a),
  );
}

function instrumentName(ticker: string, name: string | null, quantity: number): HTMLElement {
  return h('div', { class: 'iname' }, h('b', { title: name ?? ticker }, name || ticker), h('span', {}, `${ticker} · ${fmtNum(quantity, 4)} ks`));
}

function holdingRow(x: Holding): HTMLElement {
  const freeShare = x.quantity > 0 ? x.taxFreeQuantity / x.quantity : 0;
  const taxText = freeShare >= 1 - 1e-9
    ? h('span', { class: 'ok-text' }, 'vše bez daně')
    : h('span', {}, x.taxFreeQuantity > 0 ? `${fmtNum(x.taxFreeQuantity, 4)} ks bez daně · ` : '', 'další ', h('b', {}, czDate(x.nextTaxFreeDate)));
  return accordion(`h:${x.ticker}`, [
    h('div', { class: 'irow' },
      avatar(x.ticker),
      instrumentName(x.ticker, x.name, x.quantity),
      h('div', { class: 'ival' },
        h('b', { class: 'num' }, totals(x.value)),
        signed(`${signedMoney(totals(x.profit), totalsValue(x.profit))} · ${pct(x.profitPct)}`, totalsValue(x.profit))),
      h('div', { class: 'itax' }, progress(freeShare, freeShare >= 1 - 1e-9 ? 'done' : ''), taxText),
    ),
  ], () => {
    const avg = x.lots.reduce((n, l) => n + l.openPrice * l.quantity, 0) / (x.quantity || 1);
    const last = x.lots.find((l) => l.currentPrice)?.currentPrice;
    const countries = x.countries.slice().sort((p, q) => q.weight - p.weight).slice(0, 3)
      .map((c) => `${countryName(c.country)} ${fmtNum(c.weight, 0)} %`).join(', ');
    return h('div', { class: 'acc-body' },
      h('div', { class: 'meta' },
        x.isin ? h('span', {}, 'ISIN ', h('b', {}, x.isin)) : null,
        h('span', {}, 'Ø nákup ', h('b', {}, x.lots[0] ? price(avg, x.lots[0].cost.currency) : '—')),
        last ? h('span', {}, 'Cena ', h('b', {}, fmtMoney(last.close, last.currency)), ` (${czDate(last.date)})`) : null,
        countries ? h('span', {}, countries) : null,
        button('Zobrazit graf', () => showInstrument(x.ticker), 'link'),
      ),
      table(['Nákup', 'Ks', 'Nákupní cena', 'Investováno', 'Hodnota', 'Zisk', '%', 'Časový test'],
        x.lots.map((l) => h('tr', {},
          h('td', {}, czDate(l.openDate)),
          h('td', { class: 'num' }, fmtNum(l.quantity, 4)),
          h('td', { class: 'num' }, price(l.openPrice, l.cost.currency)),
          h('td', { class: 'num' }, money(l.cost)),
          h('td', { class: 'num' }, money(l.value)),
          signed(signedMoney(money(l.profit), moneyValue(l.profit)), moneyValue(l.profit), 'td'),
          signed(pct(l.profitPct), pctValue(l.profitPct), 'td'),
          h('td', {}, lotTax(l)),
        ))),
    );
  });
}

function showInstrument(ticker: string): void {
  state.tab = 'portfolio';
  state.chart = { kind: 'instrument', ticker, view: 'price' };
  render();
  document.getElementById('hero')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function upcomingPanel(a: Analysis): HTMLElement | null {
  const items = a.holdings
    .flatMap((x) => x.lots.filter((l) => !l.taxFree).map((l) => ({ x, l })))
    .sort((p, q) => p.l.taxFreeFrom.localeCompare(q.l.taxFreeFrom))
    .slice(0, 5);
  if (!items.length) return null;
  return panel('Brzy bez daně',
    h('ul', { class: 'upcoming' }, ...items.map(({ x, l }) => h('li', {},
      avatar(x.ticker),
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, x.ticker), h('span', { class: 'muted' }, ` · ${fmtNum(l.quantity, 4)} ks z ${czDate(l.openDate)}`)),
        progress(lotProgress(l))),
      h('div', { class: 'right' },
        h('b', {}, czDate(l.taxFreeFrom)),
        h('div', { class: 'muted small' }, inDays(l.daysUntilTaxFree), ' · ', signed(signedMoney(money(l.profit), moneyValue(l.profit)), moneyValue(l.profit)))),
    ))));
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
  return h('section', { class: 'notice' }, h('h2', {}, 'K doplnění'), h('ul', {}, ...items.map((t) => h('li', {}, t))));
}

// ---------------------------------------------------------------- hero + charts

function rangeButtons(): HTMLElement {
  return segmented(RANGES.map(([l]) => [l, l] as [string, string]), state.range, (r) => { state.range = r; render(); }, 'small');
}

function rangeStart(lastIso: string): number | null {
  const days = RANGES.find(([l]) => l === state.range)?.[1] ?? null;
  return days == null ? null : dayMs(lastIso) - days * 86_400_000;
}

function heroPanel(a: Analysis): HTMLElement {
  const mode = state.chart;
  const hero = h('section', { class: 'panel hero', id: 'hero' });
  if (mode.kind === 'instrument') {
    const x = a.holdings.find((q) => q.ticker === mode.ticker);
    const r = a.realized.find((q) => q.ticker === mode.ticker);
    const name = x?.name ?? r?.name ?? '';
    const profit = x ? x.profit : r?.profit;
    hero.append(
      h('div', { class: 'hero-head' },
        h('div', {},
          h('div', { class: 'eyebrow' }, button('← Celé portfolio', () => { state.chart = { kind: 'portfolio' }; render(); }, 'link')),
          h('div', { class: 'hero-title' }, avatar(mode.ticker), h('div', {}, h('b', {}, mode.ticker), h('span', { class: 'muted' }, name))),
          x ? h('div', { class: 'big' }, totals(x.value)) : h('div', { class: 'big' }, r ? `prodáno za ${totals(r.proceeds)}` : '—'),
          profit ? signed(`${signedMoney(totals(profit), totalsValue(profit))} · ${pct(x ? x.profitPct : r!.profitPct)}${x ? '' : ' realizováno'}`, totalsValue(profit), 'div', 'delta') : null),
        h('div', { class: 'hero-tools' },
          segmented([['price', 'Cena'], ['value', 'Hodnota pozice']], mode.view, (v) => { state.chart = { ...mode, view: v }; render(); }, 'small'),
          rangeButtons())),
      instrumentChart(a, mode.ticker, mode.view),
    );
    return hero;
  }
  const s = a.summary;
  hero.append(
    h('div', { class: 'hero-head' },
      h('div', {},
        h('div', { class: 'eyebrow' }, `Hodnota portfolia${s.valueDate ? ` · ${czDate(s.valueDate)}` : ''}`),
        h('div', { class: 'big' }, totals(s.value)),
        signed(`${signedMoney(totals(s.unrealizedProfit), totalsValue(s.unrealizedProfit))} · ${pct(s.unrealizedPct)}`, totalsValue(s.unrealizedProfit), 'div', 'delta'),
        rangeChange(a.history)),
      h('div', { class: 'hero-tools' }, rangeButtons())),
    portfolioChart(a.history),
  );
  return hero;
}

function rangeChange(history: HistoryPoint[]): HTMLElement | null {
  if (state.range === 'Vše' || history.length < 2) return null;
  const start = rangeStart(history.at(-1)!.date)!;
  const first = history.find((p) => dayMs(p.date) >= start);
  const last = history.at(-1)!;
  if (!first || first === last) return null;
  const gain = (p: HistoryPoint) => (state.cur === 'czk' ? p.valueCzk - p.investedCzk : p.valueEur - p.investedEur);
  const d = gain(last) - gain(first);
  return h('div', { class: 'muted small' }, `Za období ${state.range}: `, signed(signedMoney(fmtMoney(d, curCode()), d), d), ' zisku');
}

interface Series { name: string; color: string; points: Point[]; dashed?: boolean; area?: boolean }
interface Marker { x: number; y: number; kind: 'buy' | 'sell'; label: string }

function portfolioChart(history: HistoryPoint[]): HTMLElement {
  if (!history.length) return h('p', { class: 'empty' }, 'Historie hodnoty není k dispozici (spusť pnpm market).');
  const start = rangeStart(history.at(-1)!.date);
  const pts = start == null ? history : history.filter((p) => dayMs(p.date) >= start);
  const val = (p: HistoryPoint) => (state.cur === 'czk' ? p.valueCzk : p.valueEur);
  const inv = (p: HistoryPoint) => (state.cur === 'czk' ? p.investedCzk : p.investedEur);
  return lineChart(
    [
      { name: 'Hodnota', color: 'var(--accent)', points: pts.map((p) => [dayMs(p.date), val(p)]), area: true },
      { name: 'Investováno', color: 'var(--muted)', points: pts.map((p) => [dayMs(p.date), inv(p)]), dashed: true },
    ],
    [],
    (v) => fmtMoney(v, curCode(), 0),
    curCode(),
    (i) => {
      const p = pts[i]!;
      const d = val(p) - inv(p);
      return signed(`Zisk ${signedMoney(fmtMoney(d, curCode(), 0), d)} · ${pct(inv(p) ? (d / inv(p)) * 100 : null)}`, d, 'div');
    },
  );
}

function instrumentChart(a: Analysis, ticker: string, view: 'price' | 'value'): HTMLElement {
  const series = a.instruments[ticker];
  if (!series?.prices.length) return h('p', { class: 'empty' }, 'Pro tento instrument nejsou stažené ceny. Doplň zdroj v data/instruments.json a spusť pnpm market.');
  const currency = series.currency ?? '';
  const holding = a.holdings.find((x) => x.ticker === ticker);
  const sold = a.realized.find((x) => x.ticker === ticker);
  const start = rangeStart(series.prices.at(-1)![0]);
  const prices = start == null ? series.prices : series.prices.filter(([d]) => dayMs(d) >= start);
  const inRange = (iso: string) => start == null || dayMs(iso) >= start;
  const fmtP = (v: number) => (currency ? fmtMoney(v, currency, 2) : fmtNum(v, 2));
  const color = colorOf(ticker);

  if (view === 'value') {
    const lots: { from: string; to: string | null; qty: number }[] = [
      ...(holding?.lots ?? []).map((l) => ({ from: l.openDate, to: null, qty: l.quantity })),
      ...(sold?.lots ?? []).map((l) => ({ from: l.openDate, to: l.closeDate, qty: l.quantity })),
    ];
    const pts: Point[] = prices.map(([d, c]) => {
      let qty = 0;
      for (const l of lots) if (l.from <= d && (l.to == null || d < l.to)) qty += l.qty;
      return [dayMs(d), qty * c];
    });
    return lineChart([{ name: `Hodnota pozice (${currency})`, color, points: pts, area: true }], [], fmtP, currency);
  }

  const buy = (l: { openDate: string; openPrice: number; quantity: number }, suffix = ''): Marker =>
    ({ x: dayMs(l.openDate), y: l.openPrice, kind: 'buy', label: `Nákup ${czDate(l.openDate)}: ${fmtNum(l.quantity, 4)} ks à ${fmtP(l.openPrice)}${suffix}` });
  const markers: Marker[] = [
    ...(holding?.lots ?? []).filter((l) => inRange(l.openDate)).map((l) => buy(l)),
    ...(sold?.lots ?? []).flatMap((l) => [
      ...(inRange(l.openDate) ? [buy(l, ' (prodáno)')] : []),
      ...(inRange(l.closeDate) ? [{ x: dayMs(l.closeDate), y: l.closePrice, kind: 'sell' as const, label: `Prodej ${czDate(l.closeDate)}: ${fmtNum(l.quantity, 4)} ks à ${fmtP(l.closePrice)}` }] : []),
    ]),
  ];
  const lines: Series[] = [{ name: `Cena (${currency})`, color, points: prices.map(([d, c]) => [dayMs(d), c]), area: true }];
  if (holding?.lots.length) {
    const avg = holding.lots.reduce((n, l) => n + l.openPrice * l.quantity, 0) / holding.quantity;
    lines.push({ name: 'Průměrná nákupní cena', color: 'var(--muted)', dashed: true, points: [[dayMs(prices[0]![0]), avg], [dayMs(prices.at(-1)![0]), avg]] });
  }
  const first = prices[0]![1], last = prices.at(-1)![1];
  const wrap = lineChart(lines, markers, fmtP, currency);
  wrap.append(h('p', { class: 'hint' },
    'Cena za zobrazené období ', signed(pct(first ? (last / first - 1) * 100 : null), last - first),
    '. Body: ', h('span', { class: 'dot buy' }), ' nákup, ', h('span', { class: 'dot sell' }), ' prodej.'));
  return wrap;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(v);
  return ticks;
}

/** Index of the point with x closest to `xv` (points sorted by x). */
function nearest(points: Point[], xv: number): number {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] < xv) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1]![0] - xv) < Math.abs(points[lo]![0] - xv)) lo--;
  return lo;
}

/** Keeps at most ~2 points per pixel column (min and max), so long histories stay fast to draw. */
function decimate(points: Point[], columns: number): Point[] {
  if (points.length <= columns * 2) return points;
  const out: Point[] = [];
  const x0 = points[0]![0], span = points.at(-1)![0] - x0 || 1;
  let col = -1, lo: Point | null = null, hi: Point | null = null;
  const flush = () => {
    if (!lo || !hi) return;
    if (lo === hi) out.push(lo); else if (lo[0] < hi[0]) out.push(lo, hi); else out.push(hi, lo);
  };
  for (const p of points) {
    const c = Math.floor(((p[0] - x0) / span) * columns);
    if (c !== col) { flush(); col = c; lo = hi = p; continue; }
    if (p[1] < lo![1]) lo = p;
    if (p[1] > hi![1]) hi = p;
  }
  flush();
  const lastPoint = points.at(-1)!;
  if (out.at(-1) !== lastPoint) out.push(lastPoint);
  return out;
}

let gradientSeq = 0;

function lineChart(series: Series[], markers: Marker[], fmtY: (v: number) => string, axisCurrency: string, extra?: (i: number) => Child): HTMLElement {
  const wrap = h('div', { class: 'chart' });
  if (series.length > 1) {
    wrap.append(h('div', { class: 'legend' }, ...series.map((sr) =>
      h('span', {}, paint(h('i', { class: sr.dashed ? 'dashed' : '' }), { 'border-color': sr.color }), sr.name))));
  }
  const main = series[0]!;
  if (main.points.length < 2) {
    wrap.append(h('p', { class: 'empty' }, 'Málo dat pro graf v tomto období.'));
    return wrap;
  }
  const W = Math.max(300, Math.min(document.getElementById('app')!.clientWidth - 32, 1200));
  const narrow = W < 600;
  const H = narrow ? 210 : 300;
  const pad = { l: narrow ? 50 : 70, r: 10, t: 12, b: 24 };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const sr of series) for (const [x, y] of sr.points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  for (const m of markers) { if (m.y < y0) y0 = m.y; if (m.y > y1) y1 = m.y; }
  const span = y1 - y0 || Math.abs(y1) || 1;
  y0 -= span * 0.06; y1 += span * 0.06;
  if (y0 < 0 && Math.min(...series.map((sr) => sr.points.reduce((m, p) => Math.min(m, p[1]), Infinity))) >= 0) y0 = 0;
  const ticks = niceTicks(y0, y1).filter((t) => t >= y0 && t <= y1);
  const X = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Graf' });
  const defs = s('defs');
  svg.append(defs);
  for (const t of ticks) {
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t), class: 'grid' }));
    svg.append(s('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end', class: 'axis' }, fmtAxis(t, axisCurrency)));
  }
  const xTickCount = narrow ? 3 : 5;
  const multiYear = x1 - x0 > 400 * 86_400_000;
  for (let i = 0; i <= xTickCount; i++) {
    const v = x0 + ((x1 - x0) * i) / xTickCount;
    const d = new Date(v);
    const label = multiYear ? `${d.getUTCMonth() + 1}/${d.getUTCFullYear()}` : `${d.getUTCDate()}. ${d.getUTCMonth() + 1}.`;
    svg.append(s('text', { x: X(v), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === xTickCount ? 'end' : 'middle', class: 'axis' }, label));
  }
  const columns = W - pad.l - pad.r;
  for (const sr of series) {
    const pts = decimate(sr.points, columns);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    if (sr.area) {
      const id = `g${++gradientSeq}`;
      defs.append(s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
        paint(s('stop', { offset: '0%', 'stop-opacity': 0.28 }), { 'stop-color': sr.color }),
        paint(s('stop', { offset: '100%', 'stop-opacity': 0 }), { 'stop-color': sr.color })));
      svg.append(s('path', { d: `${d}L${X(pts.at(-1)![0]).toFixed(1)},${Y(y0).toFixed(1)}L${X(pts[0]![0]).toFixed(1)},${Y(y0).toFixed(1)}Z`, fill: `url(#${id})`, stroke: 'none' }));
    }
    svg.append(paint(s('path', { d, class: `line${sr.dashed ? ' dashed' : ''}` }), { stroke: sr.color }));
  }
  for (const m of markers) {
    svg.append(s('circle', { cx: X(m.x), cy: Y(m.y), r: narrow ? 3.5 : 4.5, class: `marker ${m.kind}` }, s('title', {}, m.label)));
  }
  const lastMain = main.points.at(-1)!;
  svg.append(paint(s('circle', { cx: X(lastMain[0]), cy: Y(lastMain[1]), r: 4, class: 'end' }), { fill: main.color }));

  const tip = h('div', { class: 'tip' });
  const cursor = s('line', { y1: pad.t, y2: H - pad.b, class: 'cursor', visibility: 'hidden' });
  const dots = series.map((sr) => paint(s('circle', { r: 4.5, class: 'hover-dot', visibility: 'hidden' }), { fill: sr.color }));
  svg.append(cursor, ...dots);

  let frame = 0;
  let lastEvent: PointerEvent | null = null;
  const update = () => {
    frame = 0;
    const ev = lastEvent!;
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const xv = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    const idx = nearest(main.points, xv);
    const [cx] = main.points[idx]!;
    cursor.setAttribute('x1', String(X(cx)));
    cursor.setAttribute('x2', String(X(cx)));
    cursor.setAttribute('visibility', 'visible');
    const rows: (Node | string)[] = [h('div', { class: 'strong' }, czDate(new Date(cx).toISOString()))];
    series.forEach((sr, i) => {
      const p = sr.points[nearest(sr.points, cx)]!;
      const dot = dots[i]!;
      const flat = sr.points.length === 2 && sr.points[0]![1] === sr.points[1]![1];
      const y = flat ? sr.points[0]![1] : p[1];
      if (!flat && Math.abs(p[0] - cx) > 4 * 86_400_000) { dot.setAttribute('visibility', 'hidden'); return; }
      dot.setAttribute('cx', String(X(cx)));
      dot.setAttribute('cy', String(Y(y)));
      dot.setAttribute('visibility', 'visible');
      rows.push(h('div', {}, `${sr.name}: `, h('b', {}, fmtY(y))));
    });
    const ex = extra?.(idx); if (ex) rows.push(ex);
    tip.replaceChildren(...rows);
    tip.classList.add('show');
    const left = (X(cx) / W) * rect.width;
    const tw = tip.offsetWidth;
    tip.style.left = `${left + 14 + tw > rect.width ? Math.max(left - tw - 14, 0) : left + 14}px`;
  };
  const move = (ev: PointerEvent) => {
    lastEvent = ev;
    if (!frame) frame = requestAnimationFrame(update);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    tip.classList.remove('show');
    cursor.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
  });
  wrap.append(h('div', { class: 'plot' }, svg, tip));
  return wrap;
}

function donut(items: { value: number; color: string; title: string }[], label: string, value: string): SVGElement {
  const size = 200, r = 92, inner = 66, c = size / 2, gap = items.length > 1 ? 0.012 : 0;
  const total = items.reduce((n, i) => n + i.value, 0);
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img', 'aria-label': label });
  let angle = -Math.PI / 2;
  for (const it of items) {
    const frac = total ? it.value / total : 0;
    if (frac <= 0) continue;
    if (frac >= 0.9999) {
      svg.append(s('circle', { cx: c, cy: c, r: (r + inner) / 2, fill: 'none', stroke: it.color, 'stroke-width': r - inner }, s('title', {}, it.title)));
      continue;
    }
    const a1 = angle + Math.min(gap, frac * Math.PI), a2 = angle + frac * 2 * Math.PI - Math.min(gap, frac * Math.PI);
    const large = a2 - a1 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
    svg.append(s('path', {
      d: `M${p(r, a1)}A${r},${r} 0 ${large} 1 ${p(r, a2)}L${p(inner, a2)}A${inner},${inner} 0 ${large} 0 ${p(inner, a1)}Z`,
      fill: it.color,
    }, s('title', {}, it.title)));
    angle += frac * 2 * Math.PI;
  }
  svg.append(
    s('text', { x: c, y: c - 6, 'text-anchor': 'middle', class: 'donut-label' }, label),
    s('text', { x: c, y: c + 16, 'text-anchor': 'middle', class: 'donut-value' }, value));
  return svg;
}

function allocationPanel(a: Analysis): HTMLElement {
  const total = a.holdings.reduce((n, x) => n + measure(x.value), 0);
  const items = [...a.holdings].sort((p, q) => measure(q.value) - measure(p.value));
  const max = Math.max(...items.map((x) => measure(x.value)), 1);
  return panel('Složení portfolia',
    h('div', { class: 'bars alloc' }, ...items.map((x) => {
      const v = measure(x.value);
      const row = h('div', { class: 'bar-row', tabindex: '0', role: 'button', title: 'Zobrazit graf' },
        h('span', { class: 'bar-label' }, h('b', {}, x.ticker), h('small', {}, x.name ?? '')),
        h('div', { class: 'bar-track' }, paint(h('div', { class: 'bar' }), { width: `${(v / max) * 100}%`, background: colorOf(x.ticker) })),
        h('span', { class: 'num' }, h('b', {}, `${fmtNum(total ? (v / total) * 100 : 0, 1)} %`), h('small', {}, totals(x.value))));
      row.addEventListener('click', () => showInstrument(x.ticker));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showInstrument(x.ticker); } });
      return row;
    })),
    h('p', { class: 'hint' }, 'Kliknutím na instrument zobrazíš jeho graf.'),
  );
}

const COUNTRY_SLICES = 8;
const OTHER_COLOR = '#a8a29e';
const UNKNOWN_COLOR = '#d6d3d1';

function geographyPanel(a: Analysis): HTMLElement {
  const known = a.geography.filter((g) => g.country !== '??' && g.country !== 'XX');
  const top = known.slice(0, COUNTRY_SLICES);
  const restShare = a.geography.filter((g) => !top.includes(g)).reduce((n, g) => n + g.share, 0);
  const unknown = a.geography.find((g) => g.country === '??')?.share ?? 0;
  const items = top.map((g, i) => ({ value: g.share, color: PALETTE[i % PALETTE.length]!, title: `${countryName(g.country)}: ${fmtNum(g.share, 1)} %`, label: countryName(g.country) }));
  const other = restShare - unknown;
  if (other > 0.05) items.push({ value: other, color: OTHER_COLOR, title: `Ostatní: ${fmtNum(other, 1)} %`, label: 'Ostatní' });
  if (unknown > 0.05) items.push({ value: unknown, color: UNKNOWN_COLOR, title: `Neznámé složení: ${fmtNum(unknown, 1)} %`, label: 'Neznámé složení' });
  if (!items.length) return panel('Podle zemí', h('p', { class: 'empty' }, 'Složení není k dispozici.'));
  const legend = h('ul', { class: 'legend-list static' }, ...items.map((it) => h('li', {},
    paint(h('i', {}), { background: it.color }),
    h('span', { class: 'lname' }, it.label),
    h('span', { class: 'num' }, `${fmtNum(it.value, 1)} %`))));
  return panel('Podle zemí',
    h('div', { class: 'donut-wrap' }, donut(items, 'Největší podíl', top[0] ? `${top[0].country} ${fmtNum(top[0].share, 0)} %` : '—'), legend),
    h('p', { class: 'hint' }, 'ETF jsou rozpočítané podle zemí, do kterých investují (justETF, případně onvista). Menší země jsou v „Ostatní“.'),
  );
}

// ---------------------------------------------------------------- sold tab

function soldTab(a: Analysis): HTMLElement {
  if (!a.realized.length) return panel(null, h('p', { class: 'empty' }, 'Zatím žádné prodeje.'));
  const sum = (f: (r: RealizedInstrument) => Totals) => {
    let v: number | null = 0;
    for (const r of a.realized) { const x = f(r)[state.cur]; v = v == null || x == null ? null : v + x; }
    return v;
  };
  const proceeds = sum((r) => r.proceeds), cost = sum((r) => r.cost), profit = sum((r) => r.profit);
  const sales = a.realized.reduce((n, r) => n + r.lots.length, 0);
  return h('div', { class: 'stack' },
    h('section', { class: 'panel hero' },
      h('div', { class: 'eyebrow' }, 'Realizovaný zisk ze všech prodejů'),
      signed(profit == null ? '—' : signedMoney(fmtMoney(profit, curCode()), profit), profit, 'div', 'big'),
      h('div', { class: 'muted' }, pct(cost ? ((profit ?? 0) / cost) * 100 : null), ' z nákupní ceny'),
    ),
    h('section', { class: 'stats' },
      stat('Prodáno za', proceeds == null ? '—' : fmtMoney(proceeds, curCode())),
      stat('Nákupní cena prodaného', cost == null ? '—' : fmtMoney(cost, curCode())),
      stat('Počet prodejů', String(sales), `${a.realized.length} instrumentů`),
      stat('Dividendy čistě', totals(a.summary.dividendsNet)),
    ),
    taxYearsPanel(a.taxYears),
    panel(null,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Prodané instrumenty'), h('span', { class: 'muted' }, 'rozklikni pro jednotlivé prodeje')),
      h('div', { class: 'acc-list' }, ...a.realized.map(realizedRow))),
    dividendsPanel(a.dividends),
  );
}

function taxYearsPanel(years: TaxYear[]): HTMLElement {
  const yearCard = (y: TaxYear) => {
    const used = y.proceeds.czk;
    const limit = y.limitStatus === 'within' ? tag('v limitu 100 tis.', 'ok')
      : y.limitStatus === 'exceeded' ? tag('limit překročen', 'bad') : tag('limit neověřen', 'info');
    return h('div', { class: 'year' },
      h('div', { class: 'year-head' }, h('b', {}, String(y.year)), limit),
      used != null ? progress(used / TAX_LIMIT_CZK, y.limitStatus === 'exceeded' ? 'over' : 'done') : null,
      h('div', { class: 'muted small' }, `Příjmy z prodejů ${fmtMoney(used, 'CZK')} z limitu ${fmtMoney(TAX_LIMIT_CZK, 'CZK')}`),
      h('dl', {},
        h('dt', {}, 'Prodejů'), h('dd', {}, String(y.salesCount)),
        h('dt', {}, 'Osvobozeno časovým testem'), h('dd', {}, totals(y.timeTestedProceeds)),
        h('dt', {}, 'Zdanitelné prodeje'), h('dd', {}, y.taxable.count ? `${y.taxable.count}× · ${totals(y.taxable.proceeds)}` : 'žádné'),
        h('dt', {}, 'Základ daně'), h('dd', { class: 'strong' }, fmtMoney(y.taxable.baseCzk, 'CZK'))),
    );
  };
  return panel('Daně podle let',
    h('div', { class: 'years' }, ...[...years].sort((p, q) => q.year - p.year).map(yearCard)),
    h('p', { class: 'hint' }, 'Orientační výpočet: časový test 3 roky, limit 100 000 Kč hrubých příjmů za rok, kurzy ČNB ke dni obchodu. Nenahrazuje daňové poradenství.'),
  );
}

function realizedRow(r: RealizedInstrument): HTMLElement {
  return accordion(`r:${r.ticker}`, [
    h('div', { class: 'irow' },
      avatar(r.ticker),
      instrumentName(r.ticker, r.name, r.quantity),
      h('div', { class: 'ival lead' },
        h('b', { class: 'num' }, totals(r.proceeds)),
        h('span', { class: 'muted small' }, r.firstSale === r.lastSale ? czDate(r.lastSale) : `${czDate(r.firstSale)} – ${czDate(r.lastSale)}`)),
      h('div', { class: 'ival' },
        signed(signedMoney(totals(r.profit), totalsValue(r.profit)), totalsValue(r.profit), 'b'),
        signed(pct(r.profitPct), pctValue(r.profitPct), 'span', 'small')),
    ),
  ], () => h('div', { class: 'acc-body' },
    h('div', { class: 'meta' }, button('Zobrazit graf', () => showInstrument(r.ticker), 'link')),
    table(['Nákup', 'Prodej', 'Ks', 'Nák. cena', 'Prod. cena', 'Náklad', 'Výnos', 'Zisk', '%', 'Držba', 'Časový test'],
      [...r.lots].sort((p, q) => q.closeTime.localeCompare(p.closeTime) || p.openTime.localeCompare(q.openTime)).map((l: RealizedLot) => h('tr', {},
        h('td', {}, czDate(l.openDate)),
        h('td', {}, czDate(l.closeDate)),
        h('td', { class: 'num' }, fmtNum(l.quantity, 4)),
        h('td', { class: 'num' }, price(l.openPrice, l.cost.currency)),
        h('td', { class: 'num' }, price(l.closePrice, l.proceeds.currency)),
        h('td', { class: 'num' }, money(l.cost)),
        h('td', { class: 'num' }, money(l.proceeds)),
        signed(signedMoney(money(l.profit), moneyValue(l.profit)), moneyValue(l.profit), 'td'),
        signed(pct(l.profitPct), pctValue(l.profitPct), 'td'),
        h('td', { class: 'num' }, `${fmtNum(l.holdingDays, 0)} d`),
        h('td', {}, l.timeTestMet ? tag('splněn', 'ok') : tag('nesplněn', 'wait')),
      )),
      2),
  ));
}

function dividendsPanel(divs: DividendSummary[]): HTMLElement | null {
  if (!divs.length) return null;
  return panel('Dividendy',
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
