import type { Http } from '../net/http.ts';

export interface PricePoint {
  date: string;
  close: number;
}

export interface FxRow {
  currency: string;
  date: string;
  czkPerUnit: number;
}

// ---------------------------------------------------------------- ČNB ------

export const cnbYearUrl = (year: number) =>
  `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=${year}`;

/** Parses the ČNB yearly file (`Datum|1 EUR|100 JPY…`; the header may repeat when the currency set changes). */
export function parseCnbYear(text: string): FxRow[] {
  const rows: FxRow[] = [];
  let columns: { currency: string; amount: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('|');
    if (cells[0] === 'Datum') {
      columns = cells.slice(1).map((c) => {
        const [amount, currency] = c.trim().split(' ');
        return { currency: currency ?? '', amount: Number(amount) };
      });
      continue;
    }
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(cells[0] ?? '');
    if (!m) continue;
    const date = `${m[3]}-${m[2]}-${m[1]}`;
    cells.slice(1).forEach((v, i) => {
      const col = columns[i];
      const value = Number(v.replace(',', '.'));
      if (col?.currency && col.amount > 0 && v.trim() !== '' && Number.isFinite(value)) {
        rows.push({ currency: col.currency, date, czkPerUnit: Math.round((value / col.amount) * 1e9) / 1e9 });
      }
    });
  }
  return rows;
}

export async function fetchCnbYear(http: Http, year: number): Promise<FxRow[]> {
  return parseCnbYear(await http.getText(cnbYearUrl(year), 'text/plain'));
}

// -------------------------------------------------------------- Xetra ------

export const XETRA_INSTRUMENTS_URL =
  'https://www.cashmarket.deutsche-boerse.com/resource/blob/1528/b52ea43a2edac92e8283d40645d1c076/data/t7-xetr-allTradableInstruments.csv';

export interface XetraInstrument {
  isin: string;
  name: string;
  type: string;
}

/** Xetra "all tradable instruments" CSV → mnemonic (XTB ticker without `.DE`) → ISIN. */
export function parseXetraInstruments(csv: string): Map<string, XetraInstrument> {
  const lines = csv.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => {
    const cells = l.split(';');
    return cells.includes('ISIN') && cells.includes('Mnemonic');
  });
  if (headerIdx < 0) throw new Error('Seznam instrumentů Xetra má neočekávaný formát (chybí sloupce ISIN/Mnemonic).');
  const header = lines[headerIdx]!.split(';');
  const col = (n: string) => header.indexOf(n);
  const [iIsin, iMnemonic, iName, iType, iStatus] = [col('ISIN'), col('Mnemonic'), col('Instrument'), col('Instrument Type'), col('Instrument Status')];
  const map = new Map<string, XetraInstrument>();
  for (const line of lines.slice(headerIdx + 1)) {
    const c = line.split(';');
    const mnemonic = c[iMnemonic]?.trim();
    const isin = c[iIsin]?.trim();
    if (!mnemonic || !isin || (iStatus >= 0 && c[iStatus] !== 'Active' && map.has(mnemonic))) continue;
    map.set(mnemonic, { isin, name: c[iName]?.trim() ?? '', type: c[iType]?.trim() ?? '' });
  }
  return map;
}

// ------------------------------------------------------------ justETF ------

export const justEtfProfileUrl = (isin: string) => `https://www.justetf.com/en/etf-profile.html?isin=${encodeURIComponent(isin)}`;
export const justEtfChartUrl = (isin: string, from: string, to: string, currency = 'EUR') =>
  `https://www.justetf.com/api/etfs/${encodeURIComponent(isin)}/performance-chart?locale=en&currency=${currency}` +
  `&valuesType=MARKET_VALUE&reduceData=false&includeDividends=false&dateFrom=${from}&dateTo=${to}`;

export interface EtfProfile {
  name: string | null;
  /** Top countries by weight (%), remainder reported by justETF as "Other". */
  countries: { name: string; weight: number }[];
  /** Top sectors by weight (%), remainder as "Other". */
  sectors: { name: string; weight: number }[];
}

export function parseJustEtfProfile(html: string): EtfProfile {
  const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  const title = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1];
  const table = (kind: string) => {
    const re = new RegExp(`data-testid="tl_etf-holdings_${kind}_value_name">([^<]+)<[\\s\\S]*?data-testid="tl_etf-holdings_${kind}_value_percentage">([\\d.,]+)%<`, 'g');
    return [...html.matchAll(re)].map((m) => ({ name: decode(m[1]!), weight: Number(m[2]!.replace(',', '')) }));
  };
  return { name: title ? decode(title.split('|')[0]!) : null, countries: table('countries'), sectors: table('sectors') };
}

interface JustEtfChart {
  series: { date: string; value: { raw: number } }[];
}

export async function fetchJustEtfPrices(http: Http, isin: string, from: string, to: string): Promise<PricePoint[]> {
  const data = await http.getJson<JustEtfChart>(justEtfChartUrl(isin, from, to));
  if (!Array.isArray(data.series)) throw new Error(`justETF: neočekávaná odpověď pro ${isin}`);
  return data.series.filter((p) => Number.isFinite(p.value?.raw)).map((p) => ({ date: p.date, close: p.value.raw }));
}

// ------------------------------------------------------------ onvista ------

/** Fallback for ETFs whose justETF profile has no country breakdown (swap ETFs, new funds). Country names are German. */
export const onvistaBreakdownsUrl = (isin: string) => `https://api.onvista.de/api/v1/funds/ISIN:${encodeURIComponent(isin)}/breakdowns`;

type OnvistaList = { list?: { nameBreakdown?: string; investmentPct?: number }[] };
export interface OnvistaBreakdowns {
  countryBreakdown?: OnvistaList;
  branchBreakdown?: OnvistaList;
}

const onvistaList = (l: OnvistaList | undefined) => (l?.list ?? [])
  .filter((c) => c.nameBreakdown && Number.isFinite(c.investmentPct))
  .map((c) => ({ name: c.nameBreakdown!.trim(), weight: c.investmentPct! }));

export const parseOnvistaCountries = (data: OnvistaBreakdowns) => onvistaList(data.countryBreakdown);
/** Fund sectors (German names, complete breakdown – more detailed than justETF's top 4 + Other). */
export const parseOnvistaSectors = (data: OnvistaBreakdowns) => onvistaList(data.branchBreakdown);

/** Instrument search; used only to find the ISIN of a stock from its XTB ticker. */
export const onvistaSearchUrl = (query: string) =>
  `https://api.onvista.de/api/v1/instruments/search/facet?searchValue=${encodeURIComponent(query)}&perType=10`;

interface OnvistaSearch {
  facets?: { type?: string; results?: { name?: string; symbol?: string; isin?: string; additionalData?: { countryCode?: string } }[] }[];
}

/** ISIN of the only stock whose name or symbol equals the ticker and whose company country matches; else null (no guessing). */
export function pickOnvistaStock(data: OnvistaSearch, symbol: string, country: string | null): string | null {
  const s = symbol.toUpperCase();
  const hits = (data.facets ?? []).filter((f) => f.type === 'STOCK').flatMap((f) => f.results ?? [])
    .filter((r) => r.isin && (r.name?.toUpperCase() === s || r.symbol?.toUpperCase() === s))
    .filter((r) => !country || r.additionalData?.countryCode === country);
  const isins = [...new Set(hits.map((r) => r.isin!))];
  return isins.length === 1 ? isins[0]! : null;
}

export const onvistaStockUrl = (isin: string) => `https://api.onvista.de/api/v1/stocks/ISIN:${encodeURIComponent(isin)}/snapshot`;

interface OnvistaStock {
  company?: { branch?: { name?: string; sector?: { name?: string } } };
}

/** Company sector of a stock (German), e.g. "Technologie". */
export function parseOnvistaStockSector(data: OnvistaStock): string | null {
  return data.company?.branch?.sector?.name?.trim() || null;
}

// ------------------------------------------------------------ sectors ------

// Coarse on purpose: sources differ in granularity (onvista often reports "IT/Telekommunikation" and one "Konsumgüter"),
// so technology + communication and cyclical + staples consumer goods are merged to keep ETFs comparable.
export const SECTORS = [
  'technology', 'financials', 'health', 'industrials', 'consumer', 'energy', 'materials', 'utilities', 'real_estate', 'other',
] as const;
export type Sector = (typeof SECTORS)[number];

// Order matters: the first match wins ("Sonstige Technologie" is technology, "Energieversorger" a utility).
const SECTOR_PATTERNS: [RegExp, Sector][] = [
  [/technolog|software|halbleiter|semiconductor|computer|elektronik|\bit\b|telekom|telecom|kommunikation|communication|medien|media/i, 'technology'],
  [/financ|finanz|bank|versicher|insurance/i, 'financials'],
  [/health|gesundheit|pharma|biotech|medizin/i, 'health'],
  [/industr|maschinen|luftfahrt|aerospace|defen[cs]e|rüstung|transport|logistik/i, 'industrials'],
  [/konsum|consumer|einzelhandel|retail|nahrung|food|getränk|zyklisch|cyclical|discretionary|staples/i, 'consumer'],
  [/versorg|utilit/i, 'utilities'],
  [/energ|öl|oil|gas/i, 'energy'],
  [/rohstoff|material|grundstoff|chemie|chemical|bergbau|mining|metal/i, 'materials'],
  [/immobil|real estate/i, 'real_estate'],
  [/sonstig|other|andere|barmittel|cash|liquid|diverse/i, 'other'],
];

/** English (justETF) or German (onvista) sector name → common sector key; null if unknown. */
export function sectorKey(name: string): Sector | null {
  return SECTOR_PATTERNS.find(([re]) => re.test(name))?.[1] ?? null;
}

// -------------------------------------------------------------- Yahoo ------

const YAHOO_SUFFIX: Record<string, string> = {
  US: '', DE: '.DE', UK: '.L', NL: '.AS', FR: '.PA', BE: '.BR', PT: '.LS', ES: '.MC', IT: '.MI', CH: '.SW',
  PL: '.WA', CZ: '.PR', AT: '.VI', DK: '.CO', SE: '.ST', NO: '.OL', FI: '.HE', IE: '.IR',
};

/** XTB `SYMBOL.EXCH` → Yahoo symbol (null if the exchange is unknown). */
export function yahooSymbol(xtbTicker: string): string | null {
  const dot = xtbTicker.lastIndexOf('.');
  if (dot < 0) return null;
  const suffix = YAHOO_SUFFIX[xtbTicker.slice(dot + 1)];
  return suffix == null ? null : xtbTicker.slice(0, dot).replace(/\./g, '-') + suffix;
}

export const yahooChartUrl = (symbol: string, from: string, to: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d` +
  `&period1=${Date.parse(`${from}T00:00:00Z`) / 1000}&period2=${Date.parse(`${to}T23:59:59Z`) / 1000}`;

interface YahooChart {
  chart: {
    result?: {
      meta: { currency: string; gmtoffset?: number; longName?: string; shortName?: string };
      timestamp?: number[];
      indicators: { quote: { close: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

export function parseYahooChart(data: YahooChart): { currency: string; name: string | null; prices: PricePoint[] } {
  const r = data.chart.result?.[0];
  if (!r) throw new Error(`Yahoo: ${data.chart.error?.description ?? 'prázdná odpověď'}`);
  // Minor units (pence, cents) → major units
  const minor: Record<string, string> = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };
  const factor = minor[r.meta.currency] ? 0.01 : 1;
  const offset = r.meta.gmtoffset ?? 0;
  const closes = r.indicators.quote[0]?.close ?? [];
  const prices: PricePoint[] = [];
  (r.timestamp ?? []).forEach((t, i) => {
    const c = closes[i];
    if (c != null) prices.push({ date: new Date((t + offset) * 1000).toISOString().slice(0, 10), close: c * factor });
  });
  return { currency: minor[r.meta.currency] ?? r.meta.currency, name: r.meta.longName ?? r.meta.shortName ?? null, prices };
}

export async function fetchYahooPrices(http: Http, symbol: string, from: string, to: string) {
  return parseYahooChart(await http.getJson<YahooChart>(yahooChartUrl(symbol, from, to)));
}

// ---------------------------------------------------------- countries ------

const ALIASES: Record<string, string> = {
  other: 'XX', others: 'XX', cash: 'XX',
  // German (onvista)
  sonstige: 'XX', andere: 'XX', barmittel: 'XX', kasse: 'XX', 'liquide mittel': 'XX', großbritannien: 'GB',
  'vereinigte staaten': 'US', südkorea: 'KR', 'tschechische republik': 'CZ', 'south korea': 'KR', korea: 'KR', 'hong kong': 'HK', macau: 'MO', macao: 'MO',
  russia: 'RU', 'czech republic': 'CZ', czechia: 'CZ', turkey: 'TR', 'türkiye': 'TR', 'ivory coast': 'CI',
  usa: 'US', 'united states of america': 'US', uk: 'GB', 'great britain': 'GB', taiwan: 'TW', vietnam: 'VN',
};
let byName: Map<string, string> | null = null;

/** English (justETF) or German (onvista) country name → ISO 3166 alpha-2; `XX` = other/cash. */
export function countryCode(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  if (!byName) {
    byName = new Map();
    for (const lang of ['en', 'de']) {
      const dn = new Intl.DisplayNames(lang, { type: 'region', fallback: 'none' });
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const n = dn.of(code);
          if (n && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), code);
        }
      }
    }
  }
  return byName.get(key) ?? null;
}

const EXCHANGE_COUNTRY: Record<string, string> = {
  US: 'US', DE: 'DE', UK: 'GB', NL: 'NL', FR: 'FR', BE: 'BE', PT: 'PT', ES: 'ES', IT: 'IT', CH: 'CH', PL: 'PL',
  CZ: 'CZ', AT: 'AT', DK: 'DK', SE: 'SE', NO: 'NO', FI: 'FI', IE: 'IE',
};

/** Country of the exchange an XTB ticker trades on (rough fallback for stocks). */
export function exchangeCountry(xtbTicker: string): string | null {
  return EXCHANGE_COUNTRY[xtbTicker.slice(xtbTicker.lastIndexOf('.') + 1)] ?? null;
}
