import { existsSync, readFileSync } from 'node:fs';
import { transaction, type Db } from '../db/database.ts';
import type { Http } from '../net/http.ts';
import { UnsafeDataError } from '../net/inspect.ts';
import { addDays } from '../analysis/calendar.ts';
import {
  PSE_SHARE_LIST_URLS, XETRA_INSTRUMENTS_URL, countryCode, parsePseDetail, parsePseShareList, pseDetailUrl, exchangeCountry, fetchCnbYear, fetchJustEtfPrices, fetchYahooPrices,
  companySearchQueries, holdingNameKey, justEtfProfileUrl, onvistaBreakdownsUrl, onvistaSearchUrl, pickOnvistaCompany, onvistaStockUrl, parseJustEtfProfile, parseOnvistaCountries, parseOnvistaHoldings, parseOnvistaSectors,
  parseOnvistaStockSector, parseXetraInstruments, pickOnvistaStock, pickOnvistaEtf, onvistaStockCandidates, onvistaHomePrice, sectorKey, SECTORS, yahooSymbol,
  nameKey, pickYahooSymbol, symbolVariants, yahooSearchUrl, type YahooSearch,
  type EtfProfile, type FundHolding, type OnvistaBreakdowns, type OnvistaSearch, type OnvistaStock, type PricePoint, type PseCodes, type PseShare, type Sector, type XetraInstrument,
} from './sources.ts';

/** Manual overrides per XTB ticker (data/instruments.json, see config/instruments.example.json). */
export interface InstrumentOverride {
  isin?: string;
  /** ISIN of another ETF on the same index whose countries, sectors and positions are used (e.g. for a liquidated fund). */
  compositionIsin?: string;
  /** `none` disables price download (value then comes from the XTB export). */
  priceSource?: 'justetf' | 'yahoo' | 'none';
  yahooSymbol?: string;
  /** Single country for a stock (ISO alpha-2). */
  country?: string;
  /** Country weights in % for an ETF (ISO alpha-2, `XX` = other). */
  countries?: Record<string, number>;
  /** Single sector for a stock (see SECTORS in sources.ts, e.g. "industrials"). */
  sector?: string;
  /** Sector weights in % for an ETF (`other` = rest). */
  sectors?: Record<string, number>;
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
  sectorSource: string | null;
}

export interface UpdateReport {
  fxYears: number[];
  fxRows: number;
  instruments: InstrumentReport[];
  warnings: string[];
}

const PRICE_OVERLAP_DAYS = 7;
const COUNTRY_MAX_AGE_DAYS = 30;
/** A stock candidate is accepted when its home-exchange price is within 10 % of the XTB price. */
const PRICE_MATCH_TOLERANCE = 0.1;

/** Downloads ČNB rates, prices and country data for all instruments in the DB. Never sends personal data. */
export async function updateMarketData(db: Db, http: Http, opts: UpdateOptions): Promise<UpdateReport> {
  const log = opts.log ?? (() => {});
  const config = opts.config ?? {};
  const warnings: string[] = [];
  const companyIsins = new Map<string, string | null>();
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
  const categoryStmt = db.prepare('SELECT category, name FROM instruments WHERE ticker = ?');
  const heldStmt = db.prepare('SELECT 1 FROM open_lots WHERE ticker = ? LIMIT 1');
  const refPriceStmt = db.prepare('SELECT MAX(current_price) AS p FROM open_lots WHERE ticker = ?');
  const lastPriceStmt = db.prepare('SELECT MAX(date) AS d FROM prices WHERE ticker = ? AND source = ?');
  const insertPrice = db.prepare(
    `INSERT INTO prices (ticker, date, close, currency, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (ticker, date) DO UPDATE SET close = excluded.close, currency = excluded.currency, source = excluded.source`,
  );
  const upsertMeta = db.prepare(
    `INSERT INTO instrument_meta (ticker, isin, name, price_source, price_symbol, price_currency, country_source, sector_source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ticker) DO UPDATE SET isin = excluded.isin, name = excluded.name, price_source = excluded.price_source,
       price_symbol = excluded.price_symbol, price_currency = excluded.price_currency,
       country_source = excluded.country_source, sector_source = excluded.sector_source, updated_at = excluded.updated_at`,
  );

  let xetra: Map<string, XetraInstrument> | null | undefined;
  const xetraLookup = async (mnemonic: string): Promise<XetraInstrument | null> => {
    if (xetra === undefined) {
      log('Seznam instrumentů Xetra (ticker → ISIN)…');
      try {
        xetra = http.checkExtracted(XETRA_INSTRUMENTS_URL, parseXetraInstruments(await http.getText(XETRA_INSTRUMENTS_URL, 'text/csv')));
      } catch (e) {
        xetra = null;
        warnings.push(`Seznam instrumentů Xetra se nepodařilo stáhnout: ${(e as Error).message}`);
      }
    }
    return xetra?.get(mnemonic) ?? null;
  };

  // Prague: XTB tickers are PSE trading, Bloomberg or Reuters codes (KOMB, MONET, RBAG = Erste Group…)
  let pseShares: PseShare[] | null | undefined;
  const pseCodes = new Map<string, PseCodes | null>();
  const pseDetail = async (isin: string): Promise<PseCodes | null> => {
    if (!pseCodes.has(isin)) {
      try {
        const url = pseDetailUrl(isin);
        pseCodes.set(isin, http.checkExtracted(url, parsePseDetail(await http.getText(url, 'text/html'))));
      } catch {
        pseCodes.set(isin, null);
      }
    }
    return pseCodes.get(isin)!;
  };
  /**
   * Finds the PSE share for an XTB ticker by its codes (incl. the code without XTB's trailing digit), then by the
   * XTB instrument name; a unique price match is the last resort.
   */
  const pseLookup = async (ticker: string, xtbName: string | null, knownIsin: string | null, ref: number | null): Promise<{ isin: string; tradingCode: string | null; byPrice: boolean } | null> => {
    if (pseShares === undefined) {
      log('Seznam akcií BCPP (ticker → ISIN)…');
      const all: PseShare[] = [];
      for (const url of PSE_SHARE_LIST_URLS) {
        try {
          all.push(...http.checkExtracted(url, parsePseShareList(await http.getText(url, 'text/html'))));
        } catch (e) {
          warnings.push(`Seznam akcií BCPP se nepodařilo stáhnout celý: ${(e as Error).message}`);
        }
      }
      pseShares = all.length ? [...new Map(all.map((x) => [x.isin, x])).values()] : null;
    }
    if (!pseShares) return null;
    if (knownIsin) {
      const found = pseShares.some((x) => x.isin === knownIsin);
      return found ? { isin: knownIsin, tradingCode: (await pseDetail(knownIsin))?.tradingCode ?? null, byPrice: false } : null;
    }
    const symbols = symbolVariants(ticker);
    const xtbKey = xtbName ? nameKey(xtbName) : '';
    const priceMatch = (x: PseShare) => ref != null && x.price != null && Math.abs(x.price / ref - 1) <= PRICE_MATCH_TOLERANCE;
    const likely = (x: PseShare) => symbols.includes(nameKey(x.name)) || (xtbKey !== '' && nameKey(x.name) === xtbKey);
    // Likely candidates first, so the usual case needs one or two detail pages
    const ordered = [...pseShares].sort((a, b) => Number(likely(b)) - Number(likely(a)) || Number(priceMatch(b)) - Number(priceMatch(a)));
    log(`${ticker}: ISIN (BCPP)…`);
    const result = async (isin: string, byPrice = false) => ({ isin, tradingCode: (await pseDetail(isin))?.tradingCode ?? null, byPrice });
    for (const symbol of symbols) {
      for (const x of ordered) {
        if ((await pseDetail(x.isin))?.codes.includes(symbol)) return result(x.isin);
      }
    }
    const byName = xtbKey ? pseShares.filter((x) => nameKey(x.name) === xtbKey) : [];
    if (byName.length === 1) return result(byName[0]!.isin);
    const byPrice = pseShares.filter(priceMatch);
    return byPrice.length === 1 ? result(byPrice[0]!.isin, true) : null;
  };

  for (const { ticker } of tickers) {
    const o = config[ticker] ?? {};
    const prev = metaStmt.get(ticker) as
      | { isin: string | null; name: string | null; price_source: string | null; price_symbol: string | null; price_currency: string | null; country_source: string | null; sector_source: string | null; updated_at: string; holdings_updated: string | null }
      | undefined;
    const instrument = categoryStmt.get(ticker) as { category: string | null; name: string | null } | undefined;
    const isEtf = instrument?.category === 'ETF';
    const xtbName = instrument?.name?.trim() || null;
    const ref = (refPriceStmt.get(ticker) as { p: number | null } | undefined)?.p ?? null;
    // Countries, sectors and positions only matter for what is held now; sold instruments need just prices (history)
    const held = heldStmt.get(ticker) != null;

    let isin = o.isin ?? prev?.isin ?? null;
    let name = prev?.name ?? null;
    if (!isin && ticker.endsWith('.DE')) {
      for (const s of symbolVariants(ticker)) isin ??= (await xetraLookup(s))?.isin ?? null;
    }
    // Yahoo symbol from the Prague trading code (RBAG.CZ → ERBAG.PR); looked up until prices come in
    let pseSymbol: string | null = null;
    if (ticker.endsWith('.CZ') && !o.yahooSymbol && (!isin || !(lastPriceStmt.get(ticker, 'yahoo') as { d: string | null }).d)) {
      const found = await pseLookup(ticker, xtbName, isin, ref);
      if (found) {
        isin ??= found.isin;
        if (found.tradingCode) pseSymbol = `${found.tradingCode}.PR`;
        if (found.byPrice) warnings.push(`${ticker}: ISIN ${found.isin} přiřazen jen podle ceny – ověř, případně oprav "isin" v data/instruments.json.`);
      }
    }
    if (!isin && ticker.includes('.') && (isEtf || held)) {
      const country = exchangeCountry(ticker);
      log(`${ticker}: ISIN (onvista)…`);
      try {
        // Exchange code(s) first, then the XTB instrument name (public company name, e.g. "Komercni Banka")
        const queries = [...symbolVariants(ticker), ...(xtbName && !isEtf ? [xtbName] : [])];
        const homePrices = new Map<string, number | null>();
        for (const [qi, query] of [...new Set(queries)].entries()) {
          if (isin) break;
          const found = await http.getJson<OnvistaSearch>(onvistaSearchUrl(query));
          const byName = qi >= symbolVariants(ticker).length;
          const key = byName ? nameKey(query) : query;
          if (isEtf) { isin = pickOnvistaEtf(found, query); continue; }
          if (!byName) isin = pickOnvistaStock(found, query, country);
          // No exact match (onvista lists e.g. "KBC Group", not "KBC"): pick the candidate whose home-exchange price
          // matches the price in the XTB statement – this tells "KBC Group" from "KBC Ancora".
          const candidates = isin || !ref || !country || !key ? [] : onvistaStockCandidates(found, key, country);
          const matching: string[] = [];
          for (const c of candidates) {
            if (!homePrices.has(c)) homePrices.set(c, onvistaHomePrice(await http.getJson<OnvistaStock>(onvistaStockUrl(c)), country!));
            const p = homePrices.get(c);
            if (p && Math.abs(p / ref! - 1) <= PRICE_MATCH_TOLERANCE) matching.push(c);
          }
          if (matching.length === 1) isin = matching[0]!;
        }
      } catch (e) {
        warnings.push(`${ticker}: ISIN se nepodařilo dohledat (${(e as Error).message}).`);
      }
    }
    if (!isin && isEtf) warnings.push(`${ticker}: ISIN nenalezen – doplň "isin" do data/instruments.json (bez něj chybí země a ceny ETF).`);

    // Each source is downloaded at most once per instrument (countries and sectors come from the same response)
    let profile: Promise<EtfProfile> | undefined;
    // Composition (countries, sectors, positions) may come from another ETF on the same index; prices always from this one
    const compIsin = (isEtf && o.compositionIsin) || isin;
    const justEtf = () => (profile ??= http.getText(justEtfProfileUrl(compIsin!), 'text/html')
      .then((html) => http.checkExtracted(justEtfProfileUrl(compIsin!), parseJustEtfProfile(html))));
    let breakdowns: Promise<OnvistaBreakdowns> | undefined;
    const onvista = () => (breakdowns ??= http.getJson<OnvistaBreakdowns>(onvistaBreakdownsUrl(compIsin!)));
    const ageDays = prev?.updated_at ? (Date.parse(opts.today) - Date.parse(prev.updated_at)) / 86_400_000 : Infinity;
    // A newly set compositionIsin must apply right away, so such ETFs are refreshed on every run
    const stale = Boolean(isEtf && o.compositionIsin) || ageDays > (opts.countryMaxAgeDays ?? COUNTRY_MAX_AGE_DAYS);

    // countries
    let countrySource = prev?.country_source ?? null;
    let countries: Record<string, number> | null = null;
    if (o.countries) [countries, countrySource] = [o.countries, 'manual'];
    else if (o.country) [countries, countrySource] = [{ [o.country]: 100 }, 'manual'];
    else if (!held) { /* sold: keep what is stored */ }
    else if (isEtf && compIsin) {
      const age = prev?.updated_at && (countrySource === 'justetf' || countrySource === 'onvista') ? (Date.parse(opts.today) - Date.parse(prev.updated_at)) / 86_400_000 : Infinity;
      if (stale || age > (opts.countryMaxAgeDays ?? COUNTRY_MAX_AGE_DAYS)) {
        log(`${ticker}: složení podle zemí (justETF)…`);
        let raw: { name: string; weight: number }[] = [];
        let rawSource: string | null = null;
        const problems: string[] = [];
        try {
          const p = await justEtf();
          name = p.name ?? name;
          if (p.countries.length) [raw, rawSource] = [p.countries, 'justetf'];
          else problems.push('justETF rozpad podle zemí neuvádí');
        } catch (e) {
          problems.push(`justETF: ${(e as Error).message}`);
        }
        if (!raw.length) {
          log(`${ticker}: složení podle zemí (onvista)…`);
          try {
            raw = parseOnvistaCountries(await onvista());
            if (raw.length) rawSource = 'onvista';
            else problems.push('onvista rozpad podle zemí neuvádí');
          } catch (e) {
            problems.push(`onvista: ${(e as Error).message}`);
          }
        }
        if (raw.length) {
          countries = {};
          for (const c of raw) {
            const code = countryCode(c.name);
            if (!code) warnings.push(`${ticker}: neznámá země "${c.name}" – započtena jako Ostatní.`);
            countries[code ?? 'XX'] = (countries[code ?? 'XX'] ?? 0) + c.weight;
          }
          countrySource = rawSource;
        } else if (!countrySource) {
          warnings.push(`${ticker}: složení podle zemí se nepodařilo zjistit (${problems.join('; ')}) – doplň "countries" do data/instruments.json.`);
        } else {
          warnings.push(`${ticker}: složení podle zemí se nepodařilo aktualizovat (${problems.join('; ')}) – zůstává poslední známé.`);
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

    // sectors
    let sectorSource = prev?.sector_source ?? null;
    let sectors: Partial<Record<Sector, number>> | null = null;
    const addSectors = (raw: { name: string; weight: number }[]) => {
      const out: Partial<Record<Sector, number>> = {};
      for (const r of raw) {
        const key = sectorKey(r.name);
        if (!key) warnings.push(`${ticker}: neznámý sektor "${r.name}" – započten jako Ostatní.`);
        out[key ?? 'other'] = (out[key ?? 'other'] ?? 0) + r.weight;
      }
      return out;
    };
    const manualSectors = o.sectors ?? (o.sector ? { [o.sector]: 100 } : null);
    if (manualSectors) {
      const bad = Object.keys(manualSectors).filter((k) => !(SECTORS as readonly string[]).includes(k));
      if (bad.length) warnings.push(`${ticker}: neznámý sektor ${bad.join(', ')} v data/instruments.json – povolené: ${SECTORS.join(', ')}.`);
      else [sectors, sectorSource] = [manualSectors as Partial<Record<Sector, number>>, 'manual'];
    } else if (!held) { /* sold: keep what is stored */ } else if (compIsin && (!sectorSource || (sectorSource !== 'manual' && stale))) {
      log(`${ticker}: složení podle sektorů…`);
      const problems: string[] = [];
      if (isEtf) {
        try {
          const raw = parseOnvistaSectors(await onvista());
          if (raw.length) [sectors, sectorSource] = [addSectors(raw), 'onvista'];
          else problems.push('onvista sektory neuvádí');
        } catch (e) {
          problems.push(`onvista: ${(e as Error).message}`);
        }
        if (!sectors) {
          try {
            const raw = (await justEtf()).sectors;
            if (raw.length) [sectors, sectorSource] = [addSectors(raw), 'justetf'];
            else problems.push('justETF sektory neuvádí');
          } catch (e) {
            problems.push(`justETF: ${(e as Error).message}`);
          }
        }
      } else {
        try {
          const raw = parseOnvistaStockSector(await http.getJson(onvistaStockUrl(compIsin)));
          if (raw) [sectors, sectorSource] = [addSectors([{ name: raw, weight: 100 }]), 'onvista'];
          else problems.push('onvista sektor firmy neuvádí');
        } catch (e) {
          problems.push(`onvista: ${(e as Error).message}`);
        }
      }
      if (!sectors) warnings.push(`${ticker}: sektory se nepodařilo zjistit (${problems.join('; ')})${sectorSource ? ' – zůstávají poslední známé' : ' – doplň "sector" nebo "sectors" do data/instruments.json'}.`);
    } else if (!isin && !sectorSource) warnings.push(`${ticker}: bez ISIN nelze zjistit sektor – doplň "isin" nebo "sector" do data/instruments.json.`);
    if (sectors) {
      const sum = Object.values(sectors).reduce((a, b) => a + b, 0);
      transaction(db, () => {
        db.prepare('DELETE FROM sector_weights WHERE ticker = ?').run(ticker);
        const ins = db.prepare('INSERT INTO sector_weights (ticker, sector, weight) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET weight = weight + excluded.weight');
        for (const [k, w] of Object.entries(sectors!)) ins.run(ticker, k, w);
        if (sum < 99.5) ins.run(ticker, 'other', 100 - sum);
      });
    }

    // prices
    const source = o.priceSource ?? (isEtf && isin ? 'justetf' : 'yahoo');
    let symbol: string | null = null;
    let currency = prev?.price_currency ?? null;
    let newPrices = 0;
    if (source !== 'none') {
      const known = prev?.price_source === 'yahoo' && source === 'yahoo' ? prev.price_symbol : null;
      symbol = source === 'justetf' ? isin : (o.yahooSymbol ?? pseSymbol ?? known ?? yahooSymbol(ticker));
      const last = (lastPriceStmt.get(ticker, source) as { d: string | null }).d;
      // Until the first prices come in, other Yahoo symbols are tried: the code without XTB's digit (CEZ1.CZ → CEZ.PR)
      // and the symbol Yahoo lists for the ISIN on the same exchange.
      const alternatives = async function* (): AsyncGenerator<string> {
        if (source !== 'yahoo' || o.yahooSymbol || last) return;
        for (const v of symbolVariants(ticker).slice(1)) {
          const s = yahooSymbol(`${v}${ticker.slice(ticker.lastIndexOf('.'))}`);
          if (s) yield s;
        }
        if (isin) {
          try {
            const s = pickYahooSymbol(await http.getJson<YahooSearch>(yahooSearchUrl(isin)), ticker);
            if (s) yield s;
          } catch { /* keep the original error */ }
        }
      };
      const from = last ? addDays(last, -PRICE_OVERLAP_DAYS) : priceStart;
      if (!symbol) warnings.push(`${ticker}: neznámý symbol pro ${source} – doplň do data/instruments.json.`);
      else if (from <= opts.today) {
        log(`${ticker}: ceny (${source}) od ${from}…`);
        try {
          let points: PricePoint[];
          if (source === 'justetf') [points, currency] = [await fetchJustEtfPrices(http, symbol, from, opts.today), 'EUR'];
          else {
            let y: Awaited<ReturnType<typeof fetchYahooPrices>>;
            try {
              y = await fetchYahooPrices(http, symbol, from, opts.today);
            } catch (e) {
              if (e instanceof UnsafeDataError) throw e;
              let found: typeof y | null = null;
              const tried = new Set([symbol]);
              for await (const alt of alternatives()) {
                if (tried.has(alt)) continue;
                tried.add(alt);
                log(`${ticker}: ceny (yahoo) – zkouším ${alt}…`);
                try {
                  found = await fetchYahooPrices(http, alt, from, opts.today);
                  symbol = alt;
                  break;
                } catch { /* next */ }
              }
              if (!found) throw e;
              y = found;
            }
            [points, currency] = [y.prices, y.currency];
            if (!isEtf && y.name) name = y.name;
          }
          transaction(db, () => {
            for (const p of points) insertPrice.run(ticker, p.date, p.close, currency!, source);
          });
          newPrices = points.length;
        } catch (e) {
          warnings.push(`${ticker}: ceny z ${source} se nepodařilo stáhnout (${(e as Error).message}) – použije se hodnota z výpisu XTB.`);
        }
      }
    }

    const refreshed = countries || sectors || countrySource !== prev?.country_source;
    upsertMeta.run(ticker, isin, name, source, symbol, currency, countrySource, sectorSource, refreshed ? opts.today : (prev?.updated_at ?? opts.today));

    // largest positions of an ETF (look-through to single stocks); reuses the justETF/onvista responses from above
    // An ETF without known positions is re-checked on every run (a source may add them), others after 30 days
    const knownHoldings = (db.prepare('SELECT COUNT(*) AS n FROM fund_holdings WHERE ticker = ?').get(ticker) as { n: number }).n > 0;
    const holdingsAge = knownHoldings && prev?.holdings_updated ? (Date.parse(opts.today) - Date.parse(prev.holdings_updated)) / 86_400_000 : Infinity;
    if (held && isEtf && compIsin && (o.compositionIsin || holdingsAge > (opts.countryMaxAgeDays ?? COUNTRY_MAX_AGE_DAYS))) {
      log(`${ticker}: největší pozice ETF…`);
      const problems: string[] = [];
      let failed = false;
      let top: FundHolding[] = [];
      try {
        top = (await justEtf()).holdings;
        if (!top.length) problems.push('justETF je neuvádí');
      } catch (e) {
        [failed] = [true, problems.push(`justETF: ${(e as Error).message}`)];
      }
      if (!top.length) {
        try {
          top = parseOnvistaHoldings(await onvista());
          if (!top.length) problems.push('onvista je neuvádí');
        } catch (e) {
          [failed] = [true, problems.push(`onvista: ${(e as Error).message}`)];
        }
        // onvista lists some funds' positions by name only → find the ISIN by company name (public data only)
        for (const t of top.filter((x) => !x.isin)) {
          let found = companyIsins.get(t.name);
          if (found === undefined) {
            found = null;
            for (const q of companySearchQueries(t.name)) {
              try {
                found = pickOnvistaCompany(await http.getJson<OnvistaSearch>(onvistaSearchUrl(q)), t.name);
              } catch {
                // not found → the position is kept under its name
              }
              if (found) break;
            }
            companyIsins.set(t.name, found);
          }
          t.isin = found ?? holdingNameKey(t.name);
        }
      }
      // "No source lists them" is remembered, so the warning is shown only once
      if (top.length || !failed) {
        transaction(db, () => {
          db.prepare('DELETE FROM fund_holdings WHERE ticker = ?').run(ticker);
          const ins = db.prepare('INSERT INTO fund_holdings (ticker, isin, name, weight) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET weight = weight + excluded.weight');
          for (const t of top) ins.run(ticker, t.isin, t.name, t.weight);
          db.prepare('UPDATE instrument_meta SET holdings_updated = ? WHERE ticker = ?').run(opts.today, ticker);
        });
      }
      if (!top.length && (failed || !prev?.holdings_updated)) {
        warnings.push(failed
          ? `${ticker}: největší pozice ETF se nepodařilo zjistit (${problems.join('; ')})${prev?.holdings_updated ? ' – zůstávají poslední známé' : ' – v přehledu akcií uvnitř ETF zatím chybí, zkusí se to znovu příště'}.`
          : `${ticker}: největší pozice tohoto ETF nezveřejňuje žádný zdroj (justETF ani onvista) – v přehledu akcií uvnitř ETF chybí. Není potřeba nic dělat.`);
      }
    }
    if (held && profile && !o.compositionIsin && (await profile.catch(() => null))?.closed) {
      warnings.push(`${ticker}: fond ${isin} je podle justETF zrušený nebo sloučený, jeho složení už nikdo nezveřejňuje. `
        + 'Do data/instruments.json doplň "compositionIsin" (ISIN jiného ETF na stejný index) nebo ruční "countries" a "sectors".');
    }
    const lastPrice = (db.prepare('SELECT MAX(date) AS d FROM prices WHERE ticker = ?').get(ticker) as { d: string | null }).d;
    report.instruments.push({ ticker, isin, priceSource: source, newPrices, lastPrice, countrySource, sectorSource });
  }
  return report;
}
