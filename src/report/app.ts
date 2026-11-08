// Browser app of the HTML report. Inlined into the report after type stripping:
// only type imports and the crypto/breakdown/live helpers (concatenated by the build) may be used.
// All DOM is built with createElement/textContent – never innerHTML – so data cannot inject markup.
import type { Analysis, Holding, HoldingLot, RealizedInstrument, RealizedLot, TaxYear, DividendSummary } from '../analysis/portfolio.ts';
import type { Money, Percent, Totals } from '../analysis/fx.ts';
import type { HistoryPoint } from '../analysis/market.ts';
import { decryptPayload, type EncryptedPayload } from './crypto.ts';
import { applyLive, fetchLive, type LiveSources } from './live.ts';
import { SALES_LIMIT_CZK, lossOffsetPlan, taxReturnGuide, type TaxReturnGuide } from '../analysis/tax.ts';

type Cur = 'czk' | 'eur';
type Child = Node | string | null | undefined | false;
type ChartMode = { kind: 'portfolio' } | { kind: 'instrument'; ticker: string; view: 'price' | 'value' };
type Point = [x: number, y: number];

const RANGES: [label: string, days: number | null][] = [
  ['1M', 31], ['3M', 92], ['6M', 183], ['1R', 366], ['3R', 1096], ['Vše', null],
];
const CUSTOM = 'Vlastní';
const PALETTE = ['#3d6bff', '#12a17d', '#f0a020', '#e5486a', '#8a63e8', '#1aa3c8', '#9aa63a', '#f07a3c', '#5d6f94', '#c2559e', '#3f9c4a', '#b08a5a'];

/** Instrument left at the price from the last report build, with the reason and that price's date. */
type LiveGap = { ticker: string; name: string | null; reason: string; date: string | null };
type Live = { status: 'idle' | 'loading' | 'live' | 'stale' | 'offline'; date: string | null; updated: number; total: number; missing?: LiveGap[]; notice?: string; alert?: string };

/** Rows a long list loads at once while scrolling (and shows before "Zobrazit zbývajících"). */
const LIST_STEP = 10;
type ListKey = 'holdings' | 'realized' | 'upcoming' | 'lookThrough';

const state = {
  data: null as Analysis | null,
  /** Decrypted snapshot; live prices are always applied to a fresh copy of it. */
  base: null as Analysis | null,
  live: { status: 'idle', date: null, updated: 0, total: 0 } as Live,
  liveRun: 0,
  cur: 'czk' as Cur,
  tab: 'portfolio' as 'portfolio' | 'sold',
  range: 'Vše',
  /** Own range (ISO dates, inclusive) used when range === CUSTOM; null = from the start / up to the last day. */
  custom: { from: null as string | null, to: null as string | null },
  chart: { kind: 'portfolio' } as ChartMode,
  open: new Set<string>(),
  intro: true,
  colors: new Map<string, string>(),
  /** "Bez daně k datu" (ISO date); null = list of upcoming dates. */
  taxFreeDate: null as string | null,
  /** Year whose tax-return guide is open in "Daně podle let". */
  taxGuideYear: null as number | null,
  /** Long lists: expanded into a scroll box (`open`) and how many rows are loaded there (`n`). */
  lists: {} as Partial<Record<ListKey, { open: boolean; n: number }>>,
  /** Inner scroll positions kept across re-renders (lists, tax years). */
  scroll: {} as Record<string, number>,
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
function fmtFixed(v: number, digits: number): string {
  return fmt(`f${digits}`, () => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })).format(v);
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

/** Coloured change pill (percent), optional absolute amount as a tooltip. */
function chip(text: string, value: number | null | undefined, title?: string): HTMLElement {
  return h('span', { class: `chip num ${sign(value)}`, title }, text);
}

/** Last ~3 months of the instrument price, coloured by direction. */
function sparkline(ticker: string): SVGElement | HTMLElement {
  const all = state.data!.instruments[ticker]?.prices ?? [];
  const pts = all.slice(-66);
  if (pts.length < 2) return h('span', { class: 'spark' });
  const W = 120, H = 36;
  let lo = Infinity, hi = -Infinity;
  for (const [, c] of pts) { if (c < lo) lo = c; if (c > hi) hi = c; }
  const y = (c: number) => (H - 3 - ((c - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1);
  const d = pts.map(([, c], i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * W).toFixed(1)},${y(c)}`).join('');
  const up = pts.at(-1)![1] >= pts[0]![1];
  return s('svg', { viewBox: `0 0 ${W} ${H}`, class: `spark ${up ? 'pos' : 'neg'}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Cena za 3 měsíce ${up ? 'roste' : 'klesá'}` },
    s('title', {}, 'Vývoj ceny za poslední 3 měsíce'), s('path', { d }));
}

const SECTOR_NAMES: Record<string, string> = {
  technology: 'Technologie a komunikace', financials: 'Finance', health: 'Zdravotnictví', industrials: 'Průmysl',
  consumer: 'Spotřební zboží', energy: 'Energie', materials: 'Suroviny', utilities: 'Veřejné služby',
  real_estate: 'Nemovitosti', other: 'Ostatní a hotovost', '??': 'Neznámé složení',
};
const SECTOR_COLORS: Record<string, string> = {
  technology: '#3d6bff', financials: '#12a17d', health: '#e5486a', industrials: '#f0a020', consumer: '#8a63e8',
  energy: '#f07a3c', materials: '#9aa63a', utilities: '#1aa3c8', real_estate: '#c2559e', other: '#9aa3b2', '??': '#cfd5de',
};
const sectorName = (k: string) => SECTOR_NAMES[k] ?? k;
/** What a coarse sector contains (tooltip in "Podle sektorů"). */
const SECTOR_INFO: Record<string, string> = {
  technology: 'Software, polovodiče, hardware, internet, telekomunikace a média',
  financials: 'Banky, pojišťovny, správci majetku, burzy a platební firmy',
  health: 'Farmacie, biotechnologie, zdravotnická technika a služby',
  industrials: 'Strojírenství, letectví a obrana, doprava, stavebnictví a služby firmám',
  consumer: 'Auta, obchody, oblečení, restaurace a cestování i potraviny, nápoje a drogerie',
  energy: 'Těžba, zpracování a doprava ropy, plynu a uhlí',
  materials: 'Chemie, kovy a těžba, stavební materiály a obaly',
  utilities: 'Výroba a rozvod elektřiny, plynu a vody',
  real_estate: 'Realitní firmy a nemovitostní fondy (REIT)',
  other: 'Hotovost ve fondech, deriváty a firmy, u kterých zdroj sektor neuvádí',
  '??': 'Instrumenty, u kterých se sektory nepodařilo zjistit',
};

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
      : h('span', {}, czDate(l.taxFreeFrom), h('small', {}, inDays(l.daysUntilTaxFree))));
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
    state.base = state.data = JSON.parse(json) as Analysis;
    assignColors(state.data);
    render();
    void refreshLive();
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

// ---------------------------------------------------------------- live prices

/** Fetches current quotes (only ISINs and currency codes leave the browser); the snapshot stays on any failure. */
async function refreshLive(): Promise<void> {
  const base = state.base;
  if (!base) return;
  const run = ++state.liveRun;
  const total = base.holdings.length;
  const gaps = (list: { ticker: string; reason: string }[]): LiveGap[] => list.map(({ ticker, reason }) => {
    const x = base.holdings.find((y) => y.ticker === ticker);
    return { ticker, reason, name: x?.name ?? null, date: x?.lots.find((l) => l.valueDate)?.valueDate ?? null };
  });
  state.live = { status: 'loading', date: null, updated: 0, total };
  render();
  let next: Live;
  try {
    const { czkPer, quotes, sources } = await fetchLive(base);
    if (run !== state.liveRun || state.base !== base) return;
    const alert = sources.unsafe.length
      ? `Bezpečnostní kontrola zahodila podezřelá data (${sources.unsafe.join(', ')}). Nic z nich se nepoužilo ani nezobrazilo; dotčené hodnoty jsou z výpisu nebo ze záložního zdroje.`
      : undefined;
    if (sources.errors.length) console.warn('Stockera – zdroj živých dat selhal:', sources.errors.join('; '));
    if (czkPer) {
      const r = applyLive(base, czkPer, quotes);
      state.data = r.analysis;
      next = { status: r.updated.length ? 'live' : 'stale', date: r.date, updated: r.updated.length, total, missing: gaps(r.missing), notice: fallbackNotice(sources, total), alert };
    } else {
      state.data = base;
      next = { status: 'offline', date: null, updated: 0, total, alert };
    }
  } catch {
    if (run !== state.liveRun || state.base !== base) return;
    state.data = base;
    next = { status: 'offline', date: null, updated: 0, total };
  }
  state.live = next;
  render();
}

function fallbackNotice(src: LiveSources, total: number): string | undefined {
  const parts: string[] = [];
  const n = src.quoteFallback.length;
  if (n) parts.push(`${n === total ? 'Všechny ceny jsou' : `${n} z ${total} cen je`} ze záložního zdroje Tradegate.`);
  if (src.fxFallback) parts.push('Kurzy jsou ze záložního zdroje ECB.');
  if (!parts.length) return undefined;
  const failed = [src.quoteFallback.length ? 'onvista' : null, src.fxFallback ? 'Frankfurter' : null].filter(Boolean).join(' a ');
  return `Hlavní zdroj (${failed}) teď nefunguje. ${parts.join(' ')}`;
}

/** Status line above the portfolio value: where the prices come from; orange with a list when some are missing. */
function liveStatus(valueDate: string | null): HTMLElement {
  const snap = valueDate ? ` k ${czDate(valueDate)}` : '';
  const l = state.live;
  const missing = l.missing ?? [];
  const built = 'z posledního vytvoření reportu';
  const text = (() => {
    switch (l.status) {
      case 'loading': return `Hodnota portfolia${snap}, načítám aktuální ceny…`;
      case 'live': return missing.length
        ? `Aktuální ceny k ${czDate(l.date!)} – u ${missing.length} z ${l.total} instrumentů chybí, mají cenu ${built}`
        : `Aktuální ceny k ${czDate(l.date!)}`;
      case 'stale': return missing.length
        ? `Hodnota portfolia${snap} – novější ceny nejsou, u ${missing.length} z ${l.total} instrumentů je nejde zjistit`
        : `Hodnota portfolia${snap} – novější ceny zatím nejsou`;
      case 'offline': return `Hodnota portfolia${snap} – aktuální ceny se nepodařilo načíst (bez internetu?), ceny jsou ${built}`;
      default: return `Hodnota portfolia${snap}`;
    }
  })();
  const warn = l.status === 'offline' || ((l.status === 'live' || l.status === 'stale') && missing.length > 0);
  const el = h('div', { class: `eyebrow live-${l.status}${warn ? ' live-warn' : ''}`, role: 'status' }, text);
  if (!missing.length || (l.status !== 'live' && l.status !== 'stale')) return el;
  const tip = h('div', { class: 'tip live-tip', role: 'tooltip', id: 'live-tip' },
    h('b', {}, `Bez aktuální ceny (použitá cena ${built}):`),
    h('ul', {}, ...missing.map((m) => h('li', {},
      h('span', { class: 'ticker' }, m.ticker), ' ', m.name ?? '',
      h('div', { class: 'muted' }, `${m.reason}${m.date ? `; cena k ${czDate(m.date)}` : ''}`)))));
  const info = h('span', { class: 'live-info', tabindex: '0', 'aria-describedby': 'live-tip', 'aria-label': 'Které instrumenty' }, 'ⓘ', tip);
  el.append(' ', info);
  return el;
}

// ---------------------------------------------------------------- layout

function render(): void {
  const a = state.data!;
  const scrollY = window.scrollY;
  document.getElementById('app')!.replaceChildren(
    header(a),
    h('main', {}, state.tab === 'portfolio' ? portfolioTab(a) : soldTab(a)),
    h('footer', {},
      h('span', {}, `Poslední transakce ve výpisech ${a.lastTransactionDate ? czDate(a.lastTransactionDate) : '—'}`),
      h('span', {}, `Výpis XTB k ${czDate(a.snapshotAsOf)}`),
      h('span', {}, `Vygenerováno ${new Date(a.generatedAt).toLocaleString('cs-CZ')}`),
      h('span', {}, 'Zpracováno jen na tvém počítači')),
  );
  window.scrollTo(0, scrollY);
  state.intro = false;
}

function header(a: Analysis): HTMLElement {
  return h('header', {},
    h('div', { class: 'brand' }, logo(), h('span', {}, 'Stockera')),
    h('nav', { class: 'tabs' }, ...([['portfolio', 'Portfolio', null], ['sold', 'Prodané', a.realized.length || null]] as const).map(([t, label, count]) => {
      const b = button(h('span', {}, label, count ? h('span', { class: 'count' }, String(count)) : null), () => {
        state.tab = t;
        render();
        window.scrollTo(0, 0);
      }, state.tab === t ? 'on' : '');
      if (state.tab === t) b.setAttribute('aria-current', 'page');
      return b;
    })),
    h('div', { class: 'tools' },
      segmented([['czk', 'Kč'], ['eur', '€']], state.cur, (c) => { state.cur = c; render(); }, 'cur'),
      refreshButton(),
      themeButton(),
      lockButton(() => {
        state.data = state.base = null;
        state.liveRun++;
        state.live = { status: 'idle', date: null, updated: 0, total: 0 };
        state.open.clear();
        state.lists = {};
        state.scroll = {};
        state.chart = { kind: 'portfolio' };
        state.intro = true;
        renderLogin();
      })),
  );
}

/** Header button with text on wide screens and only an icon on phones (the label stays for screen readers). */
function toolButton(text: string, icon: SVGElement, onClick: () => void, cls: string, title: string): HTMLButtonElement {
  const b = button(h('span', {}, icon, h('span', { class: 'wide' }, text)), onClick, `ghost tool ${cls}`, title);
  b.setAttribute('aria-label', text);
  return b;
}

function toolIcon(...d: string[]): SVGElement {
  const svg = s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'tool-icon' });
  for (const p of d) svg.append(s('path', { d: p }));
  return svg;
}

function lockButton(onClick: () => void): HTMLButtonElement {
  return toolButton('Zamknout', toolIcon('M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'), onClick, 'lock', 'Zahodit dešifrovaná data a zamknout');
}

function refreshButton(): HTMLButtonElement {
  const loading = state.live.status === 'loading';
  const b = toolButton(loading ? 'Aktualizuji ceny…' : 'Aktualizovat ceny', toolIcon('M19 12a7 7 0 1 1-2.05-4.95', 'M19 4.5V8h-3.5'),
    () => void refreshLive(), loading ? 'refresh loading' : 'refresh',
    'Stáhne aktuální ceny a kurzy. Odesílají se jen ISINy a kódy měn, nikdy tvoje počty kusů ani hodnoty.');
  b.disabled = loading;
  return b;
}

// ---------------------------------------------------------------- theme

type Theme = 'auto' | 'light' | 'dark';
const THEME_KEY = 'stockera-theme';
const THEMES: Record<Theme, { label: string; next: Theme }> = {
  auto: { label: 'Vzhled: podle systému', next: 'light' },
  light: { label: 'Vzhled: světlý', next: 'dark' },
  dark: { label: 'Vzhled: tmavý', next: 'auto' },
};

function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto'; // storage can be blocked for files opened from disk
  }
}

function applyTheme(t: Theme): void {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t);
  } catch { /* the choice then lasts until the page is closed */ }
}

function themeIcon(t: Theme): SVGElement {
  const svg = s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  if (t === 'light') {
    svg.append(s('circle', { cx: 12, cy: 12, r: 4 }));
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      svg.append(s('path', { d: `M${12 + Math.cos(a) * 7} ${12 + Math.sin(a) * 7}L${12 + Math.cos(a) * 9.5} ${12 + Math.sin(a) * 9.5}` }));
    }
  } else if (t === 'dark') svg.append(s('path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }));
  else svg.append(s('circle', { cx: 12, cy: 12, r: 8 }), s('path', { d: 'M12 4a8 8 0 0 1 0 16z', class: 'fill' }));
  return svg;
}

function themeButton(): HTMLButtonElement {
  const t = savedThemeState.current;
  const b = button(themeIcon(t), () => {
    savedThemeState.current = THEMES[t].next;
    applyTheme(savedThemeState.current);
    render();
  }, 'ghost theme', `${THEMES[t].label} (kliknutím přepneš)`);
  b.setAttribute('aria-label', `${THEMES[t].label}, přepnout`);
  return b;
}

const savedThemeState = { current: savedTheme() };

function panel(title: string | null, ...children: Child[]): HTMLElement {
  return h('section', { class: 'panel' }, title ? h('h2', {}, title) : null, ...children);
}

/** FIRE: monthly income if 4 % of today's portfolio value were withdrawn each year. */
const FIRE_RATE = 0.04;
function fireStat(value: Totals): HTMLElement {
  const v = totalsValue(value);
  const el = stat('FIRE renta', v == null ? '—' : fmtMoney((v * FIRE_RATE) / 12, curCode()), 'měsíčně, výběr 4 % ročně');
  el.title = 'Pravidlo 4 %: kolik by šlo vybírat měsíčně, kdybys každý rok prodal 4 % dnešní hodnoty portfolia (před daní).';
  return el;
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
      fireStat(s.value),
    ),
    h('div', { class: 'grid2' }, allocationPanel(a), geographyPanel(a)),
    sectorsPanel(a),
    lookThroughPanel(a),
    panel(null,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Pozice'), h('span', { class: 'muted' }, `${a.holdings.length} instrumentů, ${lots.length} nákupů`)),
      ...lazyList('holdings', h('div', { class: 'acc-list' }), a.holdings, holdingRow)),
    upcomingPanel(a),
    checksPanel(a),
    validationPanel(a),
  );
}

function instrumentName(ticker: string, name: string | null, quantity: number): HTMLElement {
  return h('div', { class: 'iname' }, h('b', { title: name ?? ticker }, name || ticker), h('span', {}, h('span', { class: 'ticker' }, ticker), `${fmtNum(quantity, 4)} ks`));
}

const platformOf = (account: string) => (account.startsWith('T212-') ? 'Trading 212' : 'XTB');
const platformsOf = (accounts: string[]) => [...new Set(accounts.map(platformOf))].sort().reverse();
const brokers = (a: Analysis) => platformsOf(a.cashFlows.map((c) => c.accountNumber)).join(' / ') || 'XTB';

/** Keeps the inner scroll position of `el` across re-renders (restored once the element is in the page). */
function keepScroll<T extends HTMLElement>(el: T, key: string, axis: 'x' | 'y', onScroll?: () => void): T {
  el.addEventListener('scroll', () => {
    state.scroll[key] = axis === 'x' ? el.scrollLeft : el.scrollTop;
    onScroll?.();
  }, { passive: true });
  const pos = state.scroll[key];
  if (pos) requestAnimationFrame(() => { if (axis === 'x') el.scrollLeft = pos; else el.scrollTop = pos; });
  return el;
}

/**
 * One behaviour for every long list: the first `first` rows and "Zobrazit zbývajících N". After that click the list
 * moves into its own scroll box and loads LIST_STEP more rows whenever scrolling nears its end (until all are there);
 * "Zobrazit méně" folds it back. Short lists are shown whole.
 */
function lazyList<T>(key: ListKey, box: HTMLElement, items: T[], row: (x: T, i: number) => HTMLElement, first = LIST_STEP): HTMLElement[] {
  if (items.length <= first) {
    box.append(...items.map(row));
    return [box];
  }
  const st = (state.lists[key] ??= { open: false, n: first });
  const bar = h('div', { class: 'lt-more' });
  const fill = () => {
    const from = box.children.length;
    const n = st.open ? Math.min(st.n, items.length) : first;
    box.append(...items.slice(from, n).map((x, k) => row(x, from + k)));
    box.classList.toggle('scroll-box', st.open);
    const left = items.length - n;
    bar.replaceChildren(
      h('span', { class: 'muted small' }, `Zobrazeno ${n} z ${items.length}${st.open && left > 0 ? ', další se načtou při posunu' : ''}`),
      st.open ? button('Zobrazit méně', collapse, 'ghost') : button(`Zobrazit zbývajících ${left}`, expand, 'ghost'));
  };
  const more = () => {
    if (!st.open || st.n >= items.length || box.scrollTop + box.clientHeight < box.scrollHeight - 240) return;
    st.n = Math.min(st.n + LIST_STEP, items.length);
    fill();
    requestAnimationFrame(more); // the box is not full yet → keep loading
  };
  const expand = () => {
    st.open = true;
    st.n = first + LIST_STEP;
    fill();
    requestAnimationFrame(more);
  };
  const collapse = () => {
    Object.assign(st, { open: false, n: first });
    state.scroll[key] = 0;
    box.replaceChildren();
    fill();
    box.scrollTop = 0;
    bar.scrollIntoView({ block: 'nearest' });
  };
  fill();
  keepScroll(box, key, 'y', more);
  if (st.open) requestAnimationFrame(more);
  return [box, bar];
}

function holdingRow(x: Holding): HTMLElement {
  const freeShare = x.quantity > 0 ? x.taxFreeQuantity / x.quantity : 0;
  const taxText = freeShare >= 1 - 1e-9
    ? h('span', { class: 'ok-text' }, 'vše bez daně')
    : h('span', {}, x.taxFreeQuantity > 0 ? `${fmtNum(x.taxFreeQuantity, 4)} ks bez daně, ` : '', 'bez daně od ', h('b', {}, czDate(x.nextTaxFreeDate)));
  return accordion(`h:${x.ticker}`, [
    h('div', { class: 'irow' },
      avatar(x.ticker),
      instrumentName(x.ticker, x.name, x.quantity),
      sparkline(x.ticker),
      h('div', { class: 'ival' },
        h('b', { class: 'num' }, totals(x.value)),
        h('div', { class: 'ipl' },
          signed(signedMoney(totals(x.profit), totalsValue(x.profit)), totalsValue(x.profit)),
          chip(pct(x.profitPct), pctValue(x.profitPct)))),
      h('div', { class: 'itax' }, progress(freeShare, freeShare >= 1 - 1e-9 ? 'done' : ''), taxText),
    ),
  ], () => {
    const avg = x.lots.reduce((n, l) => n + l.openPrice * l.quantity, 0) / (x.quantity || 1);
    const last = x.lots.find((l) => l.currentPrice)?.currentPrice;
    const countries = x.countries.slice().sort((p, q) => q.weight - p.weight).slice(0, 3)
      .map((c) => `${countryName(c.country)} ${fmtNum(c.weight, 0)} %`).join(', ');
    const platforms = platformsOf(x.lots.map((l) => l.accountNumber));
    const many = platforms.length > 1;
    return h('div', { class: 'acc-body' },
      h('div', { class: 'meta' },
        h('span', {}, many ? 'Platformy ' : 'Platforma ', h('b', {}, platforms.join(', '))),
        x.isin ? h('span', {}, 'ISIN ', h('b', {}, x.isin)) : null,
        h('span', {}, 'Ø nákup ', h('b', {}, x.lots[0] ? price(avg, x.priceCurrency ?? x.lots[0].cost.currency) : '—')),
        last ? h('span', {}, 'Cena ', h('b', {}, fmtMoney(last.close, last.currency)), ` (${czDate(last.date)})`) : null,
        countries ? h('span', {}, 'Země ', h('b', {}, countries)) : null,
        x.sectors?.length ? h('span', {}, 'Sektory ', h('b', {}, x.sectors.slice(0, 3).map((c) => `${sectorName(c.sector)} ${fmtNum(c.weight, 0)} %`).join(', '))) : null,
        button('Zobrazit graf', () => showInstrument(x.ticker), 'link'),
      ),
      table(['Nákup', ...(many ? ['Platforma'] : []), 'Ks', 'Nákupní cena', 'Investováno', 'Hodnota', 'Zisk', '%', 'Časový test'],
        x.lots.map((l) => h('tr', {},
          h('td', {}, czDate(l.openDate)),
          many ? h('td', {}, platformOf(l.accountNumber)) : null,
          h('td', { class: 'num' }, fmtNum(l.quantity, 4)),
          h('td', { class: 'num' }, price(l.openPrice, x.priceCurrency ?? l.cost.currency)),
          h('td', { class: 'num' }, money(l.cost)),
          h('td', { class: 'num' }, money(l.value)),
          signed(signedMoney(money(l.profit), moneyValue(l.profit)), moneyValue(l.profit), 'td'),
          signed(pct(l.profitPct), pctValue(l.profitPct), 'td'),
          h('td', {}, lotTax(l)),
        )), many ? 2 : 1),
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
  const pending = a.holdings
    .flatMap((x) => x.lots.filter((l) => !l.taxFree).map((l) => ({ x, l })))
    .sort((p, q) => p.l.taxFreeFrom.localeCompare(q.l.taxFreeFrom));
  if (!pending.length && !a.holdings.some((x) => x.lots.length)) return null;
  const dateInput = h('input', { type: 'date', value: state.taxFreeDate ?? '' });
  dateInput.addEventListener('change', () => { state.taxFreeDate = dateInput.value || null; render(); });
  const head = h('div', { class: 'panel-head' },
    h('h2', {}, 'Brzy bez daně'),
    h('div', { class: 'tf-date' },
      h('label', { class: 'date-field' }, h('span', {}, 'Bez daně k datu'), dateInput),
      state.taxFreeDate ? button('Zrušit', () => { state.taxFreeDate = null; render(); }, 'ghost') : null));
  if (state.taxFreeDate) return h('section', { class: 'panel' }, head, taxFreeAtDate(a, state.taxFreeDate));
  if (!pending.length) return h('section', { class: 'panel' }, head, h('p', { class: 'muted' }, 'Všechny držené nákupy už splnily časový test.'));

  const item = ({ x, l }: (typeof pending)[number]) => h('li', {},
    avatar(x.ticker),
    h('div', { class: 'grow' },
      h('div', {}, h('b', {}, x.ticker), h('span', { class: 'muted' }, ` ${fmtNum(l.quantity, 4)} ks z ${czDate(l.openDate)}`)),
      progress(lotProgress(l))),
    h('div', { class: 'right' },
      h('b', {}, czDate(l.taxFreeFrom)),
      h('div', { class: 'muted small' }, `${inDays(l.daysUntilTaxFree)}, zisk `, signed(signedMoney(money(l.profit), moneyValue(l.profit)), moneyValue(l.profit)))));
  return h('section', { class: 'panel' }, head, ...lazyList('upcoming', h('ul', { class: 'upcoming' }), pending, item, 5));
}

/** Last known close on or before `date` (ISO), else null. */
function closeOn(prices: [string, number][] | undefined, date: string): number | null {
  let v: number | null = null;
  for (const [d, c] of prices ?? []) { if (d > date) break; v = c; }
  return v;
}

/**
 * Lots that are past the time test on `date`, per instrument, valued at the price on that date
 * (the latest known price for future dates; converted at today's rate).
 */
function taxFreeAtDate(a: Analysis, date: string): HTMLElement {
  const rows: { ticker: string; name: string | null; qty: number; px: number | null; ccy: string | null; value: number | null; profit: number | null; newQty: number }[] = [];
  for (const x of a.holdings) {
    const lots = x.lots.filter((l) => l.taxFreeFrom <= date);
    if (!lots.length) continue;
    let value: number | null = 0, cost: number | null = 0, px: number | null = null, ccy: string | null = null;
    for (const l of lots) {
      const cur = l.currentPrice;
      const p = cur && date >= cur.date ? cur.close : closeOn(a.instruments[x.ticker]?.prices, date);
      if (cur) [px, ccy] = [p, cur.currency];
      const ratio = cur && p != null ? p / cur.close : null;
      const v = l.value?.[state.cur];
      value = value == null || v == null || ratio == null ? null : value + v * ratio;
      const c = l.cost[state.cur];
      cost = cost == null || c == null ? null : cost + c;
    }
    rows.push({
      ticker: x.ticker, name: x.name, qty: lots.reduce((n, l) => n + l.quantity, 0), px, ccy, value,
      profit: value == null || cost == null ? null : value - cost,
      newQty: lots.filter((l) => !l.taxFree).reduce((n, l) => n + l.quantity, 0),
    });
  }
  if (!rows.length) return h('p', { class: 'muted' }, `K ${czDate(date)} nebude žádný držený nákup po časovém testu.`);
  rows.sort((p, q) => (q.value ?? 0) - (p.value ?? 0));
  const sum = (f: (r: (typeof rows)[number]) => number | null) =>
    rows.reduce<number | null>((n, r) => (n == null || f(r) == null ? null : n + f(r)!), 0);
  const [total, profit] = [sum((r) => r.value), sum((r) => r.profit)];
  const latest = a.holdings.flatMap((x) => x.lots).map((l) => l.currentPrice?.date ?? '').sort().at(-1) ?? '';
  return h('div', {},
    h('p', { class: 'tf-sum' }, `K ${czDate(date)} lze bez daně prodat za `, h('b', {}, fmtMoney(total, curCode())),
      ', zisk ', signed(signedMoney(fmtMoney(profit, curCode()), profit), profit)),
    table(['Instrument', 'Ks bez daně', 'z toho nově', 'Cena k datu', 'Hodnota', 'Zisk'],
      rows.map((r) => h('tr', {},
        h('td', {}, h('b', {}, r.ticker), r.name ? h('span', { class: 'muted' }, ` ${r.name}`) : null),
        h('td', { class: 'num' }, fmtNum(r.qty, 4)),
        h('td', { class: 'num' }, r.newQty ? fmtNum(r.newQty, 4) : '—'),
        h('td', { class: 'num' }, r.px != null && r.ccy ? price(r.px, r.ccy) : '—'),
        h('td', { class: 'num' }, fmtMoney(r.value, curCode())),
        signed(signedMoney(fmtMoney(r.profit, curCode()), r.profit), r.profit, 'td'))), 1),
    h('p', { class: 'hint' }, date > latest
      ? 'Datum je v budoucnu – cena je poslední známá, hodnota v aktuálním kurzu. Počítají se jen dnes držené kusy.'
      : 'Cena je závěrečná k datu (nebo poslední předtím), hodnota v aktuálním kurzu. Počítají se jen dnes držené kusy.'),
  );
}

function checksPanel(a: Analysis): HTMLElement | null {
  const items: string[] = [...a.checks.warnings];
  for (const m of a.checks.fifoMismatches) items.push(`FIFO nesedí: ${JSON.stringify(m)}`);
  if (a.checks.missingRates.length) items.push(`Chybí kurzy ČNB: ${a.checks.missingRates.slice(0, 10).join(', ')}${a.checks.missingRates.length > 10 ? '…' : ''}`);
  const unknown = a.holdings.filter((x) => !x.countries.length).map((x) => x.ticker);
  if (unknown.length) items.push(`Neznámé geografické složení: ${unknown.join(', ')} (doplň data/instruments.json)`);
  const noSector = a.holdings.filter((x) => !x.sectors?.length).map((x) => x.ticker);
  if (noSector.length) items.push(`Neznámé sektory: ${noSector.join(', ')} (doplň "sector" do data/instruments.json)`);
  const noPrice = a.holdings.filter((x) => !(a.instruments[x.ticker]?.prices.length)).map((x) => x.ticker);
  if (noPrice.length) items.push(`Chybí historie cen: ${noPrice.join(', ')}`);
  if (!items.length) return null;
  return h('section', { class: 'notice' }, h('h2', {}, 'K doplnění'), h('ul', {}, ...items.map((t) => h('li', {}, t))));
}

/** Cross-checks of the portfolio value against the XTB export; collapsed when everything passes. */
function validationPanel(a: Analysis): HTMLElement | null {
  const checks = a.checks.validation ?? [];
  if (!checks.length) return null;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const icon = { ok: '✓', warn: '!', info: 'i' } as const;
  return h('section', { class: 'panel' },
    h('details', { class: 'checks', ...(warns ? { open: '' } : {}) },
      h('summary', {},
        h('h2', {}, 'Kontrola dat'),
        h('span', { class: warns ? 'check-sum warn' : 'check-sum ok' }, warns ? `${warns} upozornění z ${checks.length} kontrol` : `Vše v pořádku, ${checks.length} kontrol`)),
      h('p', { class: 'muted hint' }, 'Hodnota portfolia je porovnaná se souhrnem a cenami ve výpisu XTB, kurzy ČNB a párováním prodejů (Trading 212 páruje prodeje tento program sám metodou FIFO).'),
      h('ul', { class: 'check-list' }, ...checks.map((c) => h('li', { class: c.status },
        h('span', { class: 'check-icon', 'aria-hidden': 'true' }, icon[c.status]),
        h('div', {}, h('b', {}, c.title), h('span', { class: 'muted' }, c.detail)))))));
}

// ---------------------------------------------------------------- hero + charts

/** Preset buttons plus "Vlastní" with two date fields; first/last = the dates the current chart has data for. */
function rangeButtons(firstIso: string | undefined, lastIso: string | undefined): HTMLElement {
  const pick = (r: string) => {
    if (r === CUSTOM && state.range !== CUSTOM && lastIso) {
      // start from what is visible now, so switching to "Vlastní" does not jump
      const start = rangeStart(lastIso);
      state.custom = { from: start == null ? null : new Date(start).toISOString().slice(0, 10), to: null };
    }
    state.range = r;
    render();
  };
  const seg = segmented([...RANGES.map(([l]) => [l, l] as [string, string]), [CUSTOM, CUSTOM]], state.range, pick, 'small');
  if (state.range !== CUSTOM) return seg;
  const field = (label: string, key: 'from' | 'to', fallback: string | undefined) => {
    const input = h('input', { type: 'date', min: firstIso, max: lastIso, value: state.custom[key] ?? fallback ?? '' });
    input.addEventListener('change', () => {
      const next = { ...state.custom };
      next[key] = input.value || null;
      let { from, to } = next;
      if (from && to && from > to) [from, to] = [to, from];
      state.custom = { from, to };
      render();
    });
    return h('label', { class: 'date-field' }, h('span', {}, label), input);
  };
  return h('div', { class: 'range-tools' }, seg, h('div', { class: 'range-custom' }, field('Od', 'from', firstIso), field('Do', 'to', lastIso)));
}

/** Start of the visible range in ms (null = from the beginning). */
function rangeStart(lastIso: string): number | null {
  if (state.range === CUSTOM) return state.custom.from ? dayMs(state.custom.from) : null;
  const days = RANGES.find(([l]) => l === state.range)?.[1] ?? null;
  return days == null ? null : dayMs(lastIso) - days * 86_400_000;
}

/** End of the visible range in ms (null = up to the last data point). */
function rangeEnd(): number | null {
  return state.range === CUSTOM && state.custom.to ? dayMs(state.custom.to) : null;
}

function inRangeMs(t: number, start: number | null, end: number | null): boolean {
  return (start == null || t >= start) && (end == null || t <= end);
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
          h('div', { class: 'eyebrow' }, button('Zpět na celé portfolio', () => { state.chart = { kind: 'portfolio' }; render(); }, 'link back')),
          h('div', { class: 'hero-title' }, avatar(mode.ticker), h('div', {}, h('b', {}, mode.ticker), h('span', { class: 'muted' }, name))),
          x ? h('div', { class: 'big' }, totals(x.value)) : h('div', { class: 'big' }, r ? `prodáno za ${totals(r.proceeds)}` : '—'),
          profit ? h('div', { class: 'delta' }, chip(pct(x ? x.profitPct : r!.profitPct), pctValue(x ? x.profitPct : r!.profitPct)),
            signed(signedMoney(totals(profit), totalsValue(profit)), totalsValue(profit)), x ? null : h('span', { class: 'muted' }, 'realizováno')) : null),
        h('div', { class: 'hero-tools' },
          segmented([['price', 'Cena'], ['value', 'Hodnota pozice']], mode.view, (v) => { state.chart = { ...mode, view: v }; render(); }, 'small'),
          rangeButtons(a.instruments[mode.ticker]?.prices[0]?.[0], a.instruments[mode.ticker]?.prices.at(-1)?.[0]))),
      instrumentChart(a, mode.ticker, mode.view),
    );
    return hero;
  }
  const s = a.summary;
  hero.append(
    h('div', { class: 'hero-head' },
      h('div', {},
        liveStatus(s.valueDate),
        state.live.alert ? h('div', { class: 'live-notice danger', role: 'alert' }, state.live.alert) : null,
        state.live.notice ? h('div', { class: 'live-notice', role: 'status' }, state.live.notice) : null,
        h('div', { class: 'big' }, totals(s.value)),
        h('div', { class: 'delta' }, chip(pct(s.unrealizedPct), pctValue(s.unrealizedPct)),
          signed(signedMoney(totals(s.unrealizedProfit), totalsValue(s.unrealizedProfit)), totalsValue(s.unrealizedProfit)), h('span', { class: 'muted' }, 'nerealizovaný zisk')),
        rangeChange(a.history)),
      h('div', { class: 'hero-tools' }, rangeButtons(a.history[0]?.date, a.history.at(-1)?.date))),
    portfolioChart(a.history),
  );
  return hero;
}

function rangeChange(history: HistoryPoint[]): HTMLElement | null {
  if (history.length < 2) return null;
  const start = rangeStart(history.at(-1)!.date);
  const end = rangeEnd();
  if (start == null && end == null) return null;
  const pts = history.filter((p) => inRangeMs(dayMs(p.date), start, end));
  const first = pts[0];
  const last = pts.at(-1);
  if (!first || !last || first === last) return null;
  const gain = (p: HistoryPoint) => (state.cur === 'czk' ? p.valueCzk - p.investedCzk : p.valueEur - p.investedEur);
  const d = gain(last) - gain(first);
  const label = state.range === CUSTOM ? `Od ${czDate(first.date)} do ${czDate(last.date)}: ` : `Za období ${state.range}: `;
  return h('div', { class: 'muted small' }, label, signed(signedMoney(fmtMoney(d, curCode()), d), d), ' zisku');
}

interface Series { name: string; color: string; points: Point[]; dashed?: boolean; area?: boolean }
interface Marker { x: number; y: number; kind: 'buy' | 'sell'; label: string; amount?: string }

function portfolioChart(history: HistoryPoint[]): HTMLElement {
  if (!history.length) return h('p', { class: 'empty' }, 'Historie hodnoty není k dispozici (spusť pnpm market).');
  const start = rangeStart(history.at(-1)!.date);
  const end = rangeEnd();
  const pts = history.filter((p) => inRangeMs(dayMs(p.date), start, end));
  if (!pts.length) return h('p', { class: 'empty' }, 'Ve zvoleném období nejsou žádná data. Uprav datum Od a Do.');
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
      return signed(`Zisk ${signedMoney(fmtMoney(d, curCode(), 0), d)} (${pct(inv(p) ? (d / inv(p)) * 100 : null)})`, d, 'div');
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
  const end = rangeEnd();
  const prices = series.prices.filter(([d]) => inRangeMs(dayMs(d), start, end));
  if (!prices.length) return h('p', { class: 'empty' }, 'Ve zvoleném období nejsou žádné ceny. Uprav datum Od a Do.');
  const inRange = (iso: string) => inRangeMs(dayMs(iso), start, end);
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
    // Markers sit on the position-value line (the trade amount is in the tooltip)
    const valueAt = (iso: string) => pts[nearest(pts, dayMs(iso))]?.[1] ?? 0;
    const markers = tradeMarkers(holding, sold, inRange, fmtP).map((m) => ({ ...m, y: valueAt(new Date(m.x).toISOString()) }));
    return lineChart([{ name: `Hodnota pozice (${currency})`, color, points: pts, area: true }], markers, fmtP, currency);
  }

  const markers = tradeMarkers(holding, sold, inRange, fmtP);
  const lines: Series[] = [{ name: `Cena (${currency})`, color, points: prices.map(([d, c]) => [dayMs(d), c]), area: true }];
  if (holding?.lots.length) {
    const avg = holding.lots.reduce((n, l) => n + l.openPrice * l.quantity, 0) / holding.quantity;
    lines.push({ name: 'Průměrná nákupní cena', color: 'var(--muted)', dashed: true, points: [[dayMs(prices[0]![0]), avg], [dayMs(prices.at(-1)![0]), avg]] });
  }
  const first = prices[0]![1], last = prices.at(-1)![1];
  const wrap = lineChart(lines, markers, fmtP, currency);
  wrap.append(h('p', { class: 'hint' },
    'Cena za zobrazené období ', signed(pct(first ? (last / first - 1) * 100 : null), last - first),
    '. Body: ', h('span', { class: 'dot buy' }), ' nákup, ', h('span', { class: 'dot sell' }), ' prodej (najeď nebo klepni pro částku).'));
  return wrap;
}

/** Buy/sell points with what was paid/received (unit price × quantity, plus the CZK/EUR amount). */
function tradeMarkers(holding: Holding | undefined, sold: RealizedInstrument | undefined, inRange: (iso: string) => boolean, fmtP: (v: number) => string): Marker[] {
  const buy = (l: { openDate: string; openPrice: number; quantity: number; cost: Money }, suffix = ''): Marker => ({
    x: dayMs(l.openDate), y: l.openPrice, kind: 'buy',
    label: `Nákup ${czDate(l.openDate)}${suffix}: ${fmtNum(l.quantity, 4)} ks à ${fmtP(l.openPrice)}`,
    amount: `zaplaceno ${tradeAmount(l.cost)}`,
  });
  return [
    ...(holding?.lots ?? []).filter((l) => inRange(l.openDate)).map((l) => buy(l)),
    ...(sold?.lots ?? []).flatMap((l) => [
      ...(inRange(l.openDate) ? [buy(l, ' (později prodáno)')] : []),
      ...(inRange(l.closeDate) ? [{
        x: dayMs(l.closeDate), y: l.closePrice, kind: 'sell' as const,
        label: `Prodej ${czDate(l.closeDate)}: ${fmtNum(l.quantity, 4)} ks à ${fmtP(l.closePrice)}`,
        amount: `utrženo ${tradeAmount(l.proceeds)}, zisk ${signedMoney(money(l.profit), moneyValue(l.profit))}`,
      }] : []),
    ]),
  ];
}

function tradeAmount(m: Money): string {
  const native = fmtMoney(m.native, m.currency);
  const v = m[state.cur];
  return v != null && curCode() !== m.currency ? `${native} (${fmtMoney(v, curCode())})` : native;
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
    const intro = state.intro && sr === main && !sr.dashed;
    svg.append(paint(s('path', { d, class: `line${sr.dashed ? ' dashed' : ''}${intro ? ' intro' : ''}`, ...(intro ? { pathLength: 1 } : {}) }), { stroke: sr.color }));
  }
  for (const m of markers) {
    svg.append(s('circle', { cx: X(m.x), cy: Y(m.y), r: narrow ? 3.5 : 4.5, class: `marker ${m.kind}` }, s('title', {}, `${m.label}, ${m.amount ?? ''}`)));
  }
  // Trades are shown in the hover tooltip of the nearest chart point (works on touch too)
  const tradesAt = new Map<number, Marker[]>();
  for (const m of markers) {
    const i = nearest(main.points, m.x);
    tradesAt.set(i, [...(tradesAt.get(i) ?? []), m]);
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
    const trades = tradesAt.get(idx) ?? [];
    for (const m of trades.slice(0, 3)) {
      rows.push(h('div', { class: `trade ${m.kind}` }, h('span', { class: `dot ${m.kind}` }), h('b', {}, m.label), m.amount ? h('div', {}, m.amount) : null));
    }
    if (trades.length > 3) rows.push(h('div', { class: 'trade muted' }, `a další obchody: ${trades.length - 3} (viz tabulka nákupů)`));
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
const OTHER_COLOR = '#9aa3b2';
const UNKNOWN_COLOR = '#cfd5de';

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

function sectorsPanel(a: Analysis): HTMLElement | null {
  const items = (a.sectors ?? []).filter((x) => x.share >= 0.05);
  if (!items.length) return null;
  const sorted = [...items].sort((p, q) => (p.sector === 'other' || p.sector === '??' ? 1 : 0) - (q.sector === 'other' || q.sector === '??' ? 1 : 0) || q.share - p.share);
  const colour = (k: string) => SECTOR_COLORS[k] ?? '#9aa3b2';
  const value = (x: (typeof items)[number]) => { const v = x[state.cur]; return v == null ? null : fmtMoney(v, curCode()); };
  const tip = h('div', { class: 'tip sector-tip', role: 'tooltip' });
  const wrap = h('div', { class: 'sector-wrap' });
  const showTip = (x: (typeof items)[number], target: HTMLElement, clientX: number | null) => {
    const v = value(x);
    tip.replaceChildren(
      h('div', {}, paint(h('span', { class: 'dot' }), { background: colour(x.sector) }), ' ', h('b', {}, sectorName(x.sector))),
      h('div', { class: 'muted' }, SECTOR_INFO[x.sector] ?? ''),
      h('div', {}, h('b', {}, `${fmtNum(x.share, 1)} %`), v ? ` portfolia · ${v}` : ' portfolia'));
    const box = wrap.getBoundingClientRect(), t = target.getBoundingClientRect();
    tip.classList.add('show');
    const left = (clientX ?? t.left + t.width / 2) - box.left - tip.offsetWidth / 2;
    paint(tip, { left: `${Math.max(0, Math.min(left, box.width - tip.offsetWidth))}px`, top: `${t.bottom - box.top + 6}px` });
  };
  const hover = <T extends HTMLElement>(el: T, x: (typeof items)[number]): T => {
    el.addEventListener('pointerenter', (e) => showTip(x, el, e.clientX));
    el.addEventListener('pointermove', (e) => showTip(x, el, e.clientX));
    // On touch, pointerleave comes right after the tap: keep the tip until focus moves elsewhere
    el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') tip.classList.remove('show'); });
    el.addEventListener('focus', () => showTip(x, el, null));
    el.addEventListener('blur', () => tip.classList.remove('show'));
    return el;
  };
  wrap.append(
    h('div', { class: 'stackbar', role: 'img', 'aria-label': sorted.map((x) => `${sectorName(x.sector)} ${fmtNum(x.share, 1)} %`).join(', ') },
      ...sorted.map((x) => hover(paint(h('span', { tabindex: '-1' }), { width: `${x.share}%`, background: colour(x.sector) }), x))),
    // Filled column by column: the biggest sectors in the first column
    paint(h('ul', { class: 'sector-list' }, ...sorted.map((x) => hover(h('li', { tabindex: '0' },
      paint(h('i', {}), { background: colour(x.sector) }),
      h('span', { class: 'lname' }, sectorName(x.sector)),
      h('span', { class: 'num muted' }, value(x) ?? ''),
      h('b', { class: 'num' }, `${fmtNum(x.share, 1)} %`)), x))), { '--rows': String(Math.ceil(sorted.length / 2)) }),
    tip);
  return panel('Podle sektorů',
    wrap,
    h('p', { class: 'hint' }, 'ETF jsou rozpočítané podle sektorů firem, do kterých investují (onvista, případně justETF).'),
  );
}

const LT_MAX = 100;

function lookThroughPanel(a: Analysis): HTMLElement | null {
  const lt = a.lookThrough;
  if (!lt?.items.length || !a.holdings.some((x) => x.category === 'ETF')) return null;
  const items = lt.items.slice(0, LT_MAX);
  const etf = new Set(a.holdings.filter((x) => x.category === 'ETF').map((x) => x.ticker));
  const max = Math.max(...items.map((c) => c.share), 0.0001);
  const row = (c: (typeof items)[number], i: number) => {
    const v = c[state.cur];
    const funds = c.via.filter((x) => etf.has(x.ticker));
    const direct = c.via.find((x) => !etf.has(x.ticker));
    const d = h('details', { class: 'lt-row' },
      h('summary', {},
        h('span', { class: 'lt-rank num' }, String(i + 1)),
        h('span', { class: 'lt-name' }, h('b', { title: c.name }, c.name),
          h('small', {}, funds.length ? `${funds.length === 1 ? '1 ETF' : `${funds.length} ETF`}${direct ? ' a přímo' : ''}` : 'jen přímo')),
        h('div', { class: 'bar-track' }, paint(h('div', { class: 'bar' }), { width: `${(c.share / max) * 100}%` })),
        h('span', { class: 'num' }, h('b', {}, `${fmtFixed(c.share, 2)} %`), h('small', {}, v == null ? '' : fmtMoney(v, curCode())))),
      h('ul', { class: 'lt-via' }, ...c.via.map((x) => {
        const hold = a.holdings.find((y) => y.ticker === x.ticker);
        return h('li', {},
          h('span', {}, etf.has(x.ticker) ? h('span', {}, h('span', { class: 'ticker' }, x.ticker), ' ', hold?.name ?? '') : 'Přímo v držení'),
          h('span', { class: 'num' }, `${fmtFixed(x.share, 2)} %`));
      })),
    );
    return h('li', {}, d);
  };
  const missing = lt.missing.length ? ` U ${lt.missing.join(', ')} pozice nejsou známé.` : '';
  return panel(null,
    h('div', { class: 'panel-head' }, h('h2', {}, 'Akcie uvnitř ETF'), h('span', { class: 'muted' }, `Známé pozice tvoří ${fmtNum(lt.coveredShare, 0)} % portfolia`)),
    ...lazyList('lookThrough', h('ol', { class: 'lt-list' }), items, row),
    h('p', { class: 'hint' }, `Stejná akcie z více ETF i z přímého nákupu je sečtená. Procenta jsou z hodnoty celého portfolia. U každého ETF je známých jen 10 největších pozic (justETF, případně onvista), zbytek tvoří menší pozice.${missing}`),
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
      h('div', { class: 'big' }, profit == null ? '—' : signedMoney(fmtMoney(profit, curCode()), profit)),
      h('div', { class: 'delta' }, chip(pct(cost ? ((profit ?? 0) / cost) * 100 : null), profit), h('span', { class: 'muted' }, 'z nákupní ceny prodaného')),
    ),
    h('section', { class: 'stats' },
      stat('Prodáno za', proceeds == null ? '—' : fmtMoney(proceeds, curCode())),
      stat('Nákupní cena prodaného', cost == null ? '—' : fmtMoney(cost, curCode())),
      stat('Počet prodejů', String(sales), `${a.realized.length} instrumentů`),
      stat('Dividendy čistě', totals(a.summary.dividendsNet)),
    ),
    taxYearsPanel(a),
    panel(null,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Prodané instrumenty'), h('span', { class: 'muted' }, 'Po rozbalení jednotlivé prodeje')),
      ...lazyList('realized', h('div', { class: 'acc-list' }), a.realized, realizedRow)),
    dividendsPanel(a.dividends),
  );
}

function taxYearsPanel(a: Analysis): HTMLElement {
  const years = a.taxYears, holdings = a.holdings;
  const yearCard = (y: TaxYear) => {
    const used = y.shortTermProceeds.czk;
    const limit = y.limitStatus === 'within' ? tag('v limitu 100 tis.', 'ok')
      : y.limitStatus === 'exceeded' ? tag('limit překročen', 'bad') : tag('limit neověřen', 'info');
    const open = state.taxGuideYear === y.year;
    return h('div', { class: open ? 'year active' : 'year' },
      h('div', { class: 'year-head' }, h('b', {}, String(y.year)), limit),
      used != null ? progress(used / SALES_LIMIT_CZK, y.limitStatus === 'exceeded' ? 'over' : 'done') : null,
      h('div', { class: 'muted small' }, `Příjmy z prodejů bez časového testu ${fmtMoney(used, 'CZK')} z limitu ${fmtMoney(SALES_LIMIT_CZK, 'CZK')}`),
      h('dl', {},
        h('dt', {}, 'Prodejů'), h('dd', {}, String(y.salesCount)),
        h('dt', {}, 'Osvobozeno časovým testem'), h('dd', {}, totals(y.timeTestedProceeds)),
        h('dt', {}, 'Zdanitelné prodeje'), h('dd', {}, y.taxable.count ? `${y.taxable.count}× za ${totals(y.taxable.proceeds)}` : 'žádné'),
        h('dt', {}, 'Základ daně'), h('dd', {}, fmtMoney(y.taxable.baseCzk, 'CZK')),
        h('dt', {}, 'Daň 15 %'), h('dd', { class: 'strong' }, fmtMoney(y.taxable.taxCzk, 'CZK'))),
      y.year === new Date().getFullYear() && (y.taxable.taxCzk ?? 0) > 0 ? lossOffsetNote(y.taxable.baseCzk!, holdings) : null,
      button(open ? 'Skrýt návod k přiznání' : 'Co vyplnit v přiznání', () => {
        state.taxGuideYear = open ? null : y.year;
        render();
      }, 'ghost'),
    );
  };
  const guideYear = years.find((y) => y.year === state.taxGuideYear);
  return panel('Daně podle let',
    keepScroll(h('div', { class: years.length > 1 ? 'years many' : 'years' }, ...[...years].sort((p, q) => q.year - p.year).map(yearCard)), 'years', 'x'),
    guideYear ? taxGuidePanel(a, guideYear) : null,
    h('p', { class: 'hint' }, 'Orientační výpočet: časový test 3 roky, limit 100 000 Kč hrubých příjmů za rok z prodejů bez časového testu, ztráty se odečtou od zisků téhož roku, sazba 15 % (při vysokých celkových příjmech část 23 %), kurzy ČNB ke dni obchodu. Nenahrazuje daňové poradenství.'),
  );
}

/** What to fill in the Czech tax return (DAP) for one year and what to attach. */
function taxGuidePanel(a: Analysis, y: TaxYear): HTMLElement {
  const lots = a.realized.flatMap((r) => r.lots.map((l) => ({ ticker: r.ticker, name: r.name, priceCurrency: r.priceCurrency, lot: l })));
  const g: TaxReturnGuide = taxReturnGuide(y.year, y.limitStatus === 'exceeded',
    lots.map(({ ticker, lot }) => ({ ticker, closeDate: lot.closeDate, timeTestMet: lot.timeTestMet, proceedsCzk: lot.proceeds.czk, costCzk: lot.cost.czk })),
    a.dividends.map((d) => ({ ticker: d.ticker, year: d.year, grossCzk: d.gross.czk, withholdingCzk: d.withholdingTax.czk == null ? null : -d.withholdingTax.czk })));
  const kc = (v: number) => fmtMoney(v, 'CZK');
  const rowList = (items: [string, string, string?][]) => h('dl', { class: 'dap' },
    ...items.flatMap(([row, label, value]) => [h('dt', {}, h('b', {}, row), ` ${label}`), h('dd', {}, value ?? '')]));
  const ongoing = y.year >= new Date().getFullYear();
  const attach: Child[] = [];
  const parts: Child[] = [
    h('h3', {}, `Daňové přiznání za ${y.year}`),
    h('p', { class: 'muted small' }, ongoing
      ? 'Rok ještě neskončil – čísla se budou měnit.'
      : `Přiznání k dani z příjmů FO (MFin 5405) podej do 1. 4. ${y.year + 1}, elektronicky do 1. 5. ${y.year + 1} (připadne-li termín na víkend či svátek, posouvá se na další pracovní den).`),
  ];
  if (y.limitStatus === 'unknown') parts.push(h('p', { class: 'warn' }, 'U některých prodejů chybí kurz ČNB, limit 100 000 Kč nejde ověřit. Spusť znovu aktualizaci dat.'));
  if (!g.annex2 && !g.annex4) {
    parts.push(h('p', {}, y.limitStatus === 'within'
      ? `Kvůli prodejům přiznání podávat nemusíš: prodeje bez časového testu za ${fmtMoney(y.shortTermProceeds.czk, 'CZK')} jsou v limitu 100 000 Kč a prodeje po časovém testu jsou osvobozené. Pokud přiznání podáváš z jiného důvodu, tyto prodeje do něj neuváděj.`
      : 'Prodeje za tento rok jsou osvobozené, do přiznání se neuvádějí.'));
  }
  if (g.annex2) {
    parts.push(
      h('h4', {}, 'Příloha č. 2 – oddíl 2, ostatní příjmy (§ 10)'),
      table(['Sl. 1 Druh příjmu', 'Sl. 2 Příjmy', 'Sl. 3 Výdaje', 'Sl. 4 Rozdíl', 'Sl. 5 Kód'],
        g.annex2.rows.map((r) => h('tr', {},
          h('td', {}, r.kind),
          h('td', { class: 'num' }, kc(r.incomeCzk)),
          h('td', { class: 'num' }, kc(r.expenseCzk)),
          signed(signedMoney(kc(r.diffCzk), r.diffCzk), r.diffCzk, 'td'),
          h('td', { class: 'num' }, r.code || '—'))), 1),
      rowList([
        ['ř. 207', 'Příjmy podle § 10', kc(g.annex2.r207)],
        ['ř. 208', 'Výdaje podle § 10 (nejvýše do výše příjmů)', kc(g.annex2.r208)],
        ['ř. 209', 'Dílčí základ daně (ř. 207 − ř. 208)', kc(g.annex2.r209)],
        ['DAP ř. 40', 'Dílčí základ daně z ostatních příjmů – přenes z ř. 209', kc(g.annex2.r209)],
      ]),
      h('p', { class: 'muted small' }, `Zahrnuty jsou všechny prodeje bez časového testu (${y.taxable.count}×), i ty ve ztrátě – ztráty se odečtou od zisků. Příjem = prodejní cena, výdaj = nákupní cena prodaných kusů, obojí kurzem ČNB ke dni obchodu. Poplatky za obchody můžeš přičíst k výdajům. Kód „z“ = příjem ze zahraničí (zahraniční cenné papíry).`),
    );
    attach.push(h('li', {}, 'Přehled zdanitelných prodejů (nákup, prodej, kusy, ceny, kurz) – zákon ho jako přílohu nevyžaduje, ale je dobré ho přiložit nebo mít připravený na vyžádání úřadu: ',
      button(`Stáhnout přehled prodejů ${y.year} (CSV)`, () => downloadSalesCsv(y.year, lots), 'link')));
  }
  if (g.annex4) {
    parts.push(
      h('h4', {}, 'Příloha č. 4 – zahraniční dividendy v samostatném základu daně (§ 16a)'),
      rowList([
        ['ř. 401a', 'Příjmy podle § 8 ze zahraničí (hrubé dividendy)', kc(g.annex4.r401a)],
        ['ř. 411', 'Příjmy, u nichž uplatňuješ zápočet daně', kc(g.annex4.r411)],
        ['ř. 412', 'Daň zaplacená v zahraničí (nejvýše podle smlouvy)', kc(g.annex4.r412)],
        ['ř. 414', `Daň po zápočtu (15 % = ${kc(g.annex4.taxCzk)} − zápočet ${kc(g.annex4.creditCzk)}) → přenes na DAP ř. 74a`, kc(g.annex4.r414)],
      ]),
      h('p', { class: 'muted small' }, 'Dividendy z českých akcií jsou zdaněné srážkou a neuvádějí se. Místo přílohy č. 4 lze zahraniční dividendy uvést na ř. 38 a zápočet v příloze č. 3 – pak se zdaní spolu s ostatními příjmy (může vyjít sazba 23 %).'),
    );
    attach.push(h('li', {}, `Doklad o dani sražené v zahraničí z dividend (výpis z ${brokers(a)}; úřad může chtít potvrzení zahraničního správce daně) a u akcií z USA podepsaný formulář W-8BEN pro sazbu 15 %.`));
  }
  if (g.exemptNoticeCzk > 0) {
    attach.push(h('li', {}, `Oznámení o osvobozených příjmech (§ 38v) – osvobozený příjem z jednoho prodeje přesáhl 5 mil. Kč (celkem ${kc(g.exemptNoticeCzk)}). Podává se samostatným tiskopisem ve stejném termínu jako přiznání.`));
  }
  if (y.timeTestCapExceeded) {
    parts.push(h('p', { class: 'warn' }, 'Příjmy z prodejů po časovém testu přesáhly 40 mil. Kč – část nad limitem je zdanitelná a výpočet výše ji nezahrnuje. Obrať se na daňového poradce.'));
  }
  if (g.annex2 || g.annex4) attach.push(h('li', {}, `Roční výpis z ${brokers(a)} si uschovej (přikládat ho není nutné).`));
  if (attach.length) parts.push(h('h4', {}, 'Přiložit / mít připraveno'), h('ul', { class: 'dap-list' }, ...attach));
  if (g.incomplete) parts.push(h('p', { class: 'warn' }, 'Některé částky nemají přepočet do Kč – součty jsou neúplné.'));
  parts.push(h('p', { class: 'hint' }, 'Orientační návod podle tiskopisu MFin 5405. Sazbu 23 %, slevy a celkovou daň dopočítá samotné přiznání. Nenahrazuje daňové poradenství.'));
  return h('div', { class: 'dap-guide' }, ...parts);
}

/** All sales of the year as CSV for the tax office – generated in the browser, nothing is uploaded. */
function downloadSalesCsv(year: number, lots: { ticker: string; name: string | null; priceCurrency: string | null; lot: RealizedLot }[]): void {
  const y = state.data?.taxYears.find((t) => t.year === year);
  const num = (v: number | null, d = 2) => v == null ? '' : v.toFixed(d).replace('.', ',');
  const cell = (s: string) => /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const head = ['Instrument', 'Název', 'Účet', 'Datum nákupu', 'Datum prodeje', 'Kusy', 'Nákupní cena', 'Prodejní cena', 'Měna',
    'Výdaj (Kč)', 'Příjem (Kč)', 'Rozdíl (Kč)', 'Dní držby', 'Časový test', 'Zdanitelné'];
  const rows = lots.filter(({ lot }) => lot.closeDate.startsWith(`${year}-`))
    .sort((p, q) => p.lot.closeTime.localeCompare(q.lot.closeTime))
    .map(({ ticker, name, priceCurrency, lot: l }) => [ticker, name ?? '', l.accountNumber, l.openDate, l.closeDate, num(l.quantity, 4),
      num(l.openPrice, 4), num(l.closePrice, 4), priceCurrency ?? l.proceeds.currency, num(l.cost.czk), num(l.proceeds.czk), num(l.proceeds.czk == null || l.cost.czk == null ? null : l.proceeds.czk - l.cost.czk),
      String(l.holdingDays), l.timeTestMet ? 'splněn' : 'nesplněn', !l.timeTestMet && y?.limitStatus === 'exceeded' ? 'ano' : 'ne']);
  const csv = '\ufeff' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = h('a', { href: url, download: `stockera-prodeje-${year}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** This year's tax can still be lowered by selling held positions at a loss before 31 December. */
function lossOffsetNote(baseCzk: number, holdings: Holding[]): HTMLElement {
  const lots = holdings.flatMap((x) => x.lots.map((l) => ({
    ticker: x.ticker, account: l.accountNumber, openTime: l.openTime, quantity: l.quantity, profitCzk: l.profit?.czk ?? null, taxFree: l.taxFree,
  })));
  const plan = lossOffsetPlan(baseCzk, lots);
  const manyAccounts = new Set(lots.map((l) => l.account)).size > 1;
  const lead = !plan.sales.length
    ? 'Daň by šlo snížit prodejem pozic ve ztrátě, ale teď žádná ztrátová pozice bez časového testu není.'
    : plan.remainingTaxCzk > 0
      ? `Ztrátové pozice pokryjí ${fmtMoney(-plan.lossCzk, 'CZK')} z ${fmtMoney(baseCzk, 'CZK')}. Po jejich prodeji klesne daň na ${fmtMoney(plan.remainingTaxCzk, 'CZK')}.`
      : `Daň vyrovnáš, když letos prodáš se ztrátou alespoň ${fmtMoney(baseCzk, 'CZK')}. Stačí prodat:`;
  return h('div', { class: 'offset' },
    h('p', {}, lead),
    plan.sales.length ? h('ul', {}, ...plan.sales.map((s) => h('li', {},
      h('b', {}, s.ticker), ` ${fmtNum(s.quantity, 4)} ks`, manyAccounts ? h('span', { class: 'muted' }, ` (účet ${s.account})`) : null,
      h('span', { class: 'muted' }, ', ztráta '), h('span', { class: 'neg' }, fmtMoney(s.lossCzk, 'CZK')),
      s.taxFreeQuantity > 0
        ? h('div', { class: 'muted small' }, `včetně ${fmtNum(s.taxFreeQuantity, 4)} ks s časovým testem – při zpětném nákupu poběží 3letý test znovu`)
        : null))) : null,
    h('p', { class: 'muted small' }, 'Prodává se od nejstaršího nákupu. Ztráta z nákupů, které už splnily časový test, se nezapočítá. Podle aktuálních cen.'),
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
        chip(pct(r.profitPct), pctValue(r.profitPct))),
    ),
  ], () => {
    const platforms = platformsOf(r.lots.map((l) => l.accountNumber));
    const many = platforms.length > 1;
    return h('div', { class: 'acc-body' },
    h('div', { class: 'meta' },
      h('span', {}, many ? 'Platformy ' : 'Platforma ', h('b', {}, platforms.join(', '))),
      button('Zobrazit graf', () => showInstrument(r.ticker), 'link')),
    table(['Nákup', 'Prodej', ...(many ? ['Platforma'] : []), 'Ks', 'Nák. cena', 'Prod. cena', 'Náklad', 'Výnos', 'Zisk', '%', 'Držba', 'Časový test'],
      [...r.lots].sort((p, q) => q.closeTime.localeCompare(p.closeTime) || p.openTime.localeCompare(q.openTime)).map((l: RealizedLot) => h('tr', {},
        h('td', {}, czDate(l.openDate)),
        h('td', {}, czDate(l.closeDate)),
        many ? h('td', {}, platformOf(l.accountNumber)) : null,
        h('td', { class: 'num' }, fmtNum(l.quantity, 4)),
        h('td', { class: 'num' }, price(l.openPrice, r.priceCurrency ?? l.cost.currency)),
        h('td', { class: 'num' }, price(l.closePrice, r.priceCurrency ?? l.proceeds.currency)),
        h('td', { class: 'num' }, money(l.cost)),
        h('td', { class: 'num' }, money(l.proceeds)),
        signed(signedMoney(money(l.profit), moneyValue(l.profit)), moneyValue(l.profit), 'td'),
        signed(pct(l.profitPct), pctValue(l.profitPct), 'td'),
        h('td', { class: 'num' }, `${fmtNum(l.holdingDays, 0)} d`),
        h('td', {}, l.timeTestMet ? tag('splněn', 'ok') : tag('nesplněn', 'wait')),
      )),
      many ? 3 : 2));
  });
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
// Open instrument rows stick below the page header; its height changes with wrapping, so measure it.
const headerObserver = new ResizeObserver((entries) => {
  for (const e of entries) document.documentElement.style.setProperty('--header-h', `${Math.ceil((e.target as HTMLElement).offsetHeight)}px`);
});
let observedHeader: Element | null = null;
new MutationObserver(() => {
  const hdr = document.querySelector('header');
  if (hdr && hdr !== observedHeader) {
    if (observedHeader) headerObserver.unobserve(observedHeader);
    headerObserver.observe(hdr);
    observedHeader = hdr;
  }
}).observe(document.getElementById('app')!, { childList: true, subtree: true });
applyTheme(savedThemeState.current);
renderLogin();
