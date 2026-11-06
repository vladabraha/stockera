import { existsSync, readFileSync } from 'node:fs';
import { transaction, type Db } from '../db/database.ts';
import type { Http } from '../net/http.ts';
import { addDays } from '../analysis/calendar.ts';
import {
  XETRA_INSTRUMENTS_URL, countryCode, exchangeCountry, fetchCnbYear, fetchJustEtfPrices, fetchYahooPrices,
  justEtfProfileUrl, parseJustEtfProfile, parseXetraInstruments, yahooSymbol, type PricePoint, type XetraInstrument,
} from './sources.ts';

/** Manual overrides per XTB ticker (data/instruments.json, see config/instruments.example.json). */
export interface InstrumentOverride {
  isin?: string;
  /** `none` disables price download (value then comes from the XTB export). */
  priceSource?: 'justetf' | 'yahoo' | 'none';
  yahooSymbol?: string;
  /** Single country for a stock (ISO alpha-2). */
  country?: string;
  /** Country weights in % for an ETF (ISO alpha-2, `XX` = other). */
  countries?: Record<string, number>;
}
export type InstrumentConfig = Record<string, InstrumentOverride>;

export function loadInstrumentConfig(path: string): InstrumentConfig {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  const cfg: InstrumentConfig = {};
  for (const [ticker, v] of Object.entries(raw)) if (!ticker.startsWith('$') && v && typeof v === 'object') cfg[ticker] = v as InstrumentOverride;
  return cfg;
}

export interface UpdateOptions {
  today: string;
  config?: InstrumentConfig;
  /** Re-download ETF country data older than this (days). */
  countryMaxAgeDays?: number;
  log?: (msg: string) => void;
}

export interface InstrumentReport {
  ticker: string;
  isin: string | null;
  priceSource: string | null;
  newPrices: number;
  lastPrice: string | null;
  countrySource: string | null;
}

export interface UpdateReport {
  fxYears: number[];
  fxRows: number;
  instruments: InstrumentReport[];
  warnings: string[];
}

const PRICE_OVERLAP_DAYS = 7;
const COUNTRY_MAX_AGE_DAYS = 30;

/** Downloads ČNB rates, prices and country data for all instruments in the DB. Never sends personal data. */
export async function updateMarketData(db: Db, http: Http, opts: UpdateOptions): Promise<UpdateReport> {
  const log = opts.log ?? (() => {});
  const config = opts.config ?? {};
  const warnings: string[] = [];
  const report: UpdateReport = { fxYears: [], fxRows: 0, instruments: [], warnings };

  const tickers = db
    .prepare(
      `SELECT ticker, MIN(open_time) AS first_open FROM (
         SELECT ticker, open_time FROM closed_lots UNION ALL SELECT ticker, open_time FROM open_lots
       ) GROUP BY ticker ORDER BY ticker`,
    )
    .all() as { ticker: string; first_open: string }[];
  const firstDate = tickers.map((t) => t.first_open.slice(0, 10)).sort()[0];
  // One shared, coarse start date for all tickers: price requests then don't reveal when each instrument was bought.
  const priceStart = firstDate ? `${Number(firstDate.slice(0, 4)) - 1}-12-01` : '';

  // --- ČNB rates ------------------------------------------------------------
  if (firstDate) {
    const hasYearEnd = db.prepare(`SELECT 1 FROM fx_rates WHERE currency = 'EUR' AND date >= ? AND date <= ? LIMIT 1`);
    const insert = db.prepare(
      `INSERT INTO fx_rates (currency, date, czk_per_unit, source) VALUES (?, ?, ?, 'cnb')
       ON CONFLICT (currency, date) DO UPDATE SET czk_per_unit = excluded.czk_per_unit, source = excluded.source`,
    );
    const thisYear = Number(opts.today.slice(0, 4));
    for (let year = Number(firstDate.slice(0, 4)); year <= thisYear; year++) {
      if (year < thisYear && hasYearEnd.get(`${year}-12-20`, `${year}-12-31`)) continue;
      log(`Kurzy ČNB ${year}…`);
      try {
        const rows = await fetchCnbYear(http, year);
        if (!rows.length) throw new Error('soubor neobsahuje žádné kurzy');
        transaction(db, () => {
          for (const r of rows) insert.run(r.currency, r.date, r.czkPerUnit);
        });
        report.fxYears.push(year);
        report.fxRows += rows.length;
      } catch (e) {
        warnings.push(`Kurzy ČNB ${year} se nepodařilo stáhnout: ${(e as Error).message}`);
      }
    }
  }

  // --- instruments ------------------------------------------------------------
  const metaStmt = db.prepare('SELECT * FROM instrument_meta WHERE ticker = ?');
  const categoryStmt = db.prepare('SELECT category FROM instruments WHERE ticker = ?');
  const lastPriceStmt = db.prepare('SELECT MAX(date) AS d FROM prices WHERE ticker = ? AND source = ?');
  const insertPrice = db.prepare(
    `INSERT INTO prices (ticker, date, close, currency, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (ticker, date) DO UPDATE SET close = excluded.close, currency = excluded.currency, source = excluded.source`,
  );
  const upsertMeta = db.prepare(
    `INSERT INTO instrument_meta (ticker, isin, name, price_source, price_symbol, price_currency, country_source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ticker) DO UPDATE SET isin = excluded.isin, name = excluded.name, price_source = excluded.price_source,
       price_symbol = excluded.price_symbol, price_currency = excluded.price_currency,
       country_source = excluded.country_source, updated_at = excluded.updated_at`,
  );

  let xetra: Map<string, XetraInstrument> | null | undefined;
  const xetraLookup = async (mnemonic: string): Promise<XetraInstrument | null> => {
    if (xetra === undefined) {
      log('Seznam instrumentů Xetra (ticker → ISIN)…');
      try {
        xetra = parseXetraInstruments(await http.getText(XETRA_INSTRUMENTS_URL, 'text/csv'));
      } catch (e) {
        xetra = null;
        warnings.push(`Seznam instrumentů Xetra se nepodařilo stáhnout: ${(e as Error).message}`);
      }
    }
    return xetra?.get(mnemonic) ?? null;
  };

  for (const { ticker } of tickers) {
    const o = config[ticker] ?? {};
    const prev = metaStmt.get(ticker) as
      | { isin: string | null; name: string | null; price_currency: string | null; country_source: string | null; updated_at: string }
      | undefined;
    const isEtf = (categoryStmt.get(ticker) as { category: string | null } | undefined)?.category === 'ETF';

    let isin = o.isin ?? prev?.isin ?? null;
    let name = prev?.name ?? null;
    if (!isin && ticker.endsWith('.DE')) isin = (await xetraLookup(ticker.slice(0, -3)))?.isin ?? null;
    if (!isin && isEtf) warnings.push(`${ticker}: ISIN nenalezen – doplň "isin" do data/instruments.json (bez něj chybí země a ceny ETF).`);

    // countries
    let countrySource = prev?.country_source ?? null;
    let countries: Record<string, number> | null = null;
    if (o.countries) [countries, countrySource] = [o.countries, 'manual'];
    else if (o.country) [countries, countrySource] = [{ [o.country]: 100 }, 'manual'];
    else if (isEtf && isin) {
      const age = prev?.updated_at && countrySource === 'justetf' ? (Date.parse(opts.today) - Date.parse(prev.updated_at)) / 86_400_000 : Infinity;
      if (age > (opts.countryMaxAgeDays ?? COUNTRY_MAX_AGE_DAYS)) {
        log(`${ticker}: složení podle zemí (justETF)…`);
        try {
          const profile = parseJustEtfProfile(await http.getText(justEtfProfileUrl(isin), 'text/html'));
          name = profile.name ?? name;
          if (!profile.countries.length) throw new Error('stránka neobsahuje rozpad podle zemí');
          countries = {};
          for (const c of profile.countries) {
            const code = countryCode(c.name);
            if (!code) warnings.push(`${ticker}: neznámá země "${c.name}" – započtena jako Ostatní.`);
            countries[code ?? 'XX'] = (countries[code ?? 'XX'] ?? 0) + c.weight;
          }
          countrySource = 'justetf';
        } catch (e) {
          warnings.push(`${ticker}: země z justETF se nepodařilo načíst (${(e as Error).message}).`);
        }
      }
    } else if (!isEtf) {
      const c = isin && /^[A-Z]{2}/.test(isin) && !/^(XS|EU)/.test(isin) ? isin.slice(0, 2) : exchangeCountry(ticker);
      if (c) [countries, countrySource] = [{ [c]: 100 }, isin ? 'isin' : 'exchange'];
    } else if (!countrySource) warnings.push(`${ticker}: chybí složení podle zemí – doplň "countries" do data/instruments.json.`);
    if (countries) {
      const sum = Object.values(countries).reduce((a, b) => a + b, 0);
      if (sum > 100.5 || sum <= 0) warnings.push(`${ticker}: součet vah zemí je ${sum.toFixed(2)} % – použito poměrně.`);
      transaction(db, () => {
        db.prepare('DELETE FROM country_weights WHERE ticker = ?').run(ticker);
        const ins = db.prepare('INSERT INTO country_weights (ticker, country, weight) VALUES (?, ?, ?)');
        for (const [c, w] of Object.entries(countries!)) ins.run(ticker, c.toUpperCase(), w);
        if (sum < 99.5) ins.run(ticker, 'XX', 100 - sum);
      });
    }

    // prices
    const source = o.priceSource ?? (isEtf && isin ? 'justetf' : 'yahoo');
    let symbol: string | null = null;
    let currency = prev?.price_currency ?? null;
    let newPrices = 0;
    if (source !== 'none') {
      symbol = source === 'justetf' ? isin : (o.yahooSymbol ?? yahooSymbol(ticker));
      const last = (lastPriceStmt.get(ticker, source) as { d: string | null }).d;
      const from = last ? addDays(last, -PRICE_OVERLAP_DAYS) : priceStart;
      if (!symbol) warnings.push(`${ticker}: neznámý symbol pro ${source} – doplň do data/instruments.json.`);
      else if (from <= opts.today) {
        log(`${ticker}: ceny (${source}) od ${from}…`);
        try {
          let points: PricePoint[];
          if (source === 'justetf') [points, currency] = [await fetchJustEtfPrices(http, symbol, from, opts.today), 'EUR'];
          else ({ prices: points, currency } = await fetchYahooPrices(http, symbol, from, opts.today));
          transaction(db, () => {
            for (const p of points) insertPrice.run(ticker, p.date, p.close, currency!, source);
          });
          newPrices = points.length;
        } catch (e) {
          warnings.push(`${ticker}: ceny z ${source} se nepodařilo stáhnout (${(e as Error).message}) – použije se hodnota z výpisu XTB.`);
        }
      }
    }

    upsertMeta.run(ticker, isin, name, source, symbol, currency, countrySource, countrySource === prev?.country_source && !countries ? (prev?.updated_at ?? opts.today) : opts.today);
    const lastPrice = (db.prepare('SELECT MAX(date) AS d FROM prices WHERE ticker = ?').get(ticker) as { d: string | null }).d;
    report.instruments.push({ ticker, isin, priceSource: source, newPrices, lastPrice, countrySource });
  }
  return report;
}
