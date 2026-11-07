import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockedRequestError, Http, HttpError, MAX_BODY_BYTES } from '../src/net/http.ts';
import { fakeFetch } from './helpers/fakeFetch.ts';
import { findThreat, parseSafeJson, UnsafeDataError } from '../src/net/inspect.ts';
import {
  countryCode, exchangeCountry, parseCnbYear, parseJustEtfProfile, parseXetraInstruments, parseYahooChart, pickOnvistaStock, sectorKey,
  yahooSymbol, companySearchQueries, holdingNameKey, pickOnvistaCompany,
} from '../src/market/sources.ts';

test('Http blocks hosts outside the allowlist, non-HTTPS and redirects to foreign hosts', async () => {
  const calls: string[] = [];
  const http = new Http({
    minIntervalMs: 0,
    fetch: fakeFetch(
      (u) => (u.includes('redirect') ? new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }) : undefined),
      calls,
    ),
  });
  await assert.rejects(http.getText('https://evil.example/data'), BlockedRequestError);
  await assert.rejects(http.getText('http://www.cnb.cz/x'), BlockedRequestError);
  await assert.rejects(http.getText('https://www.cnb.cz:8443/x'), BlockedRequestError);
  await assert.rejects(http.getText('https://www.cnb.cz/redirect'), BlockedRequestError);
  assert.deepEqual(calls, ['https://www.cnb.cz/redirect']);
  assert.deepEqual(http.log.map((e) => e.status), ['blocked', 'blocked', 'blocked', 302, 'blocked']);
});

test('Http follows allowed redirects, throws on errors and writes the audit log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stockera-'));
  try {
    const auditLog = join(dir, 'logs/network.log');
    const http = new Http({
      auditLog,
      minIntervalMs: 0,
      fetch: fakeFetch((u) =>
        u.endsWith('/a')
          ? new Response(null, { status: 301, headers: { location: '/b' } })
          : u.endsWith('/b')
            ? new Response('ok')
            : undefined,
      ),
    });
    assert.equal(await http.getText('https://www.cnb.cz/a'), 'ok');
    await assert.rejects(http.getText('https://www.cnb.cz/missing'), HttpError);
    const lines = readFileSync(auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { url: string; status: number });
    assert.deepEqual(lines.map((l) => [l.url, l.status]), [
      ['https://www.cnb.cz/a', 301],
      ['https://www.cnb.cz/b', 200],
      ['https://www.cnb.cz/missing', 404],
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('Http retries rate-limited requests and gives Yahoo a plain User-Agent', async () => {
  let n = 0;
  const agents: string[] = [];
  const http = new Http({
    minIntervalMs: 0,
    retryDelaysMs: [0, 0],
    fetch: async (_u, init) => {
      agents.push(new Headers(init.headers).get('user-agent')!);
      return ++n < 3 ? new Response('', { status: 429 }) : new Response('ok');
    },
  });
  assert.equal(await http.getText('https://query1.finance.yahoo.com/x'), 'ok');
  assert.deepEqual(agents, ['Mozilla/5.0', 'Mozilla/5.0', 'Mozilla/5.0']);
  n = -10;
  await assert.rejects(http.getText('https://www.cnb.cz/x'), /HTTP 429/);
  assert.equal(n, -7);
});

test('Http rejects oversized responses even without Content-Length', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const huge = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(chunk);
      },
    });
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch(() => new Response(huge())) });
  await assert.rejects(http.getText('https://www.cnb.cz/huge'), /příliš velká/);
  const declared = new Http({
    minIntervalMs: 0,
    fetch: fakeFetch(() => new Response('x', { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } })),
  });
  await assert.rejects(declared.getText('https://www.cnb.cz/big'), /příliš velká/);
});

test('parseCnbYear handles amounts, decimal commas and repeated headers', () => {
  const text = [
    'Datum|1 EUR|100 JPY|1 USD',
    '02.01.2024|24,685|15,862|22,526',
    '03.01.2024|24,675|15,809|',
    'Datum|1 EUR|1 USD',
    '04.01.2024|24,700|22,600',
  ].join('\n');
  assert.deepEqual(parseCnbYear(text), [
    { currency: 'EUR', date: '2024-01-02', czkPerUnit: 24.685 },
    { currency: 'JPY', date: '2024-01-02', czkPerUnit: 0.15862 },
    { currency: 'USD', date: '2024-01-02', czkPerUnit: 22.526 },
    { currency: 'EUR', date: '2024-01-03', czkPerUnit: 24.675 },
    { currency: 'JPY', date: '2024-01-03', czkPerUnit: 0.15809 },
    { currency: 'EUR', date: '2024-01-04', czkPerUnit: 24.7 },
    { currency: 'USD', date: '2024-01-04', czkPerUnit: 22.6 },
  ]);
});

test('parseXetraInstruments maps mnemonics to ISINs, preferring active instruments', () => {
  const csv = [
    'Market:;XETR',
    'Product Status;Instrument Status;Instrument;ISIN;Product ID;Mnemonic;Instrument Type',
    'Active;Active;ST.S SP5 UE DLA;IE000XZSV718;1;SPYL;ETF',
    'Active;Inactive;OLD;XX0000000001;2;ABC;ETF',
    'Active;Active;NEW;XX0000000002;3;ABC;CS',
  ].join('\n');
  const m = parseXetraInstruments(csv);
  assert.equal(m.get('SPYL')?.isin, 'IE000XZSV718');
  assert.equal(m.get('ABC')?.isin, 'XX0000000002');
  assert.throws(() => parseXetraInstruments('a;b\n1;2'));
});

test('parseJustEtfProfile extracts name, country and sector weights', () => {
  const row = (kind: string, n: string, p: string) =>
    `<tr><td data-testid="tl_etf-holdings_${kind}_value_name">${n}</td><td><div><span data-testid="tl_etf-holdings_${kind}_value_percentage">${p}%</span></div></td></tr>`;
  const html = `<meta property="og:title" content="S&amp;P 500 ETF | SPYL | IE000XZSV718" />${row('countries', 'United States', '97.58')}${row('countries', 'Other', '2.42')}${row('sectors', 'Technology', '33.10')}${row('sectors', 'Other', '66.90')}`;
  assert.deepEqual(parseJustEtfProfile(html), {
    name: 'S&P 500 ETF',
    countries: [
      { name: 'United States', weight: 97.58 },
      { name: 'Other', weight: 2.42 },
    ],
    sectors: [
      { name: 'Technology', weight: 33.1 },
      { name: 'Other', weight: 66.9 },
    ],
    holdings: [],
    closed: false,
  });
});

test('parseYahooChart converts pence and uses exchange-local dates', () => {
  const r = parseYahooChart({
    chart: {
      result: [{ meta: { currency: 'GBp', gmtoffset: 3600, longName: 'Shell plc' }, timestamp: [1704177000, 1704263400], indicators: { quote: [{ close: [1234, null] }] } }],
    },
  });
  assert.deepEqual(r, { currency: 'GBP', name: 'Shell plc', prices: [{ date: '2024-01-02', close: 12.34 }] });
  assert.throws(() => parseYahooChart({ chart: { result: [], error: { description: 'No data' } } }), /No data/);
});

test('ticker, country and exchange mappings', () => {
  assert.deepEqual(['AAPL.US', 'VWRL.UK', 'CSG.NL', 'BRK.B.US', 'X.ZZ'].map(yahooSymbol), ['AAPL', 'VWRL.L', 'CSG.AS', 'BRK-B', null]);
  assert.deepEqual(['United States', 'United Kingdom', 'South Korea', 'Other', 'Atlantis'].map(countryCode), ['US', 'GB', 'KR', 'XX', null]);
  assert.deepEqual(['Polen', 'Tschechien', 'USA', 'Großbritannien', 'Barmittel'].map(countryCode), ['PL', 'CZ', 'US', 'GB', 'XX']);
  assert.equal(exchangeCountry('VWRL.UK'), 'GB');
});

test('sectorKey maps English and German sector names to the coarse taxonomy', () => {
  const cases: [string, string | null][] = [
    ['Technology', 'technology'], ['IT/Telekommunikation', 'technology'], ['Sonstige Technologie', 'technology'],
    ['Telecommunication', 'technology'], ['Financials', 'financials'], ['Finanzen', 'financials'],
    ['Health Care', 'health'], ['Gesundheitswesen', 'health'], ['Konsumgüter zyklisch', 'consumer'],
    ['Consumer Staples', 'consumer'], ['Energieversorger', 'utilities'], ['Energie', 'energy'],
    ['Immobilien', 'real_estate'], ['Other', 'other'], ['Elektrokomponenten', 'technology'], ['Internet Service', 'technology'],
    ['Business Services', 'industrials'], ['Finanzdienstleister', 'financials'], ['Xyz', null],
  ];
  assert.deepEqual(cases.map(([n]) => [n, sectorKey(n)]), cases);
});

test('pickOnvistaStock returns an ISIN only for an unambiguous match', () => {
  const r = (name: string, isin: string, cc: string) => ({ name, isin, additionalData: { countryCode: cc } });
  const data = { facets: [{ type: 'STOCK', results: [r('CSG', 'NL0015073TS8', 'NL'), r('CSG', 'US0000000001', 'US'), r('CSGX', 'NL0000000009', 'NL')] }] };
  assert.equal(pickOnvistaStock(data, 'csg', 'NL'), 'NL0015073TS8');
  assert.equal(pickOnvistaStock(data, 'CSG', null), null);
  assert.equal(pickOnvistaStock({ facets: [{ type: 'FUND', results: [r('CSG', 'NL0015073TS8', 'NL')] }] }, 'CSG', 'NL'), null);
});

test('findThreat flags code, terminal escapes, bidi tricks and prototype keys but passes normal market data', () => {
  for (const bad of [
    '<script>alert(1)</script>', '< SCRIPT src=//x>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', 'data:text/html;base64,PHM+',
    'Apple\u001b[2J', 'abc\u0007', 'Fund\u202egnp.exe', '<svg/onload=x>',
  ]) assert.ok(findThreat({ name: bad }), bad);
  assert.equal(findThreat(JSON.parse('{"__proto__": {"x": 1}}')), 'zakázaný klíč "__proto__"');
  assert.equal(findThreat({ a: [{ constructor: { prototype: 1 } }] }), 'zakázaný klíč "constructor"');
  assert.ok(findThreat(new Map([['DE', '<script>']])));
  let deep: unknown = 1;
  for (let i = 0; i < 100; i++) deep = [deep];
  assert.equal(findThreat(deep), 'příliš hluboké zanoření');
  for (const ok of [
    { name: 'iShares Core S&P 500 UCITS ETF (Acc)', url: 'https://www.ishares.com/x?a=1&b=2', note: 'Rüstung & Verteidigung – Česká zbrojovka', v: [1.5, -2, null, true] },
    { text: 'Zeile 1\nZeile 2\tTab', cmp: 'P/E < 15 and yield > 2 %', pct: '5 %' },
  ]) assert.equal(findThreat(ok), null);
  assert.throws(() => parseSafeJson('{"n":"<script>"}', 'Test'), (e: unknown) => e instanceof UnsafeDataError && e.source === 'Test');
  assert.throws(() => parseSafeJson('<html>', 'Test'), /není to JSON/);
});

test('Http discards suspicious JSON and extracted values and audits them as unsafe', async () => {
  const http = new Http({ minIntervalMs: 0, fetch: fakeFetch(() => Response.json({ chart: { name: 'x<script>steal()</script>' } })) });
  await assert.rejects(http.getJson('https://query1.finance.yahoo.com/v8/finance/chart/X'), (e: unknown) =>
    e instanceof UnsafeDataError && /Yahoo poslal podezřelá data \(HTML\/skript\)/.test(e.message));
  assert.throws(() => http.checkExtracted('https://www.justetf.com/p', { name: 'ETF\u001b]0;pwned\u0007' }), UnsafeDataError);
  assert.deepEqual(http.log.map((e) => [e.status, e.error ?? '']), [[200, ''], ['unsafe', 'HTML/skript'], ['unsafe', 'řídicí znaky']]);
});

test('pickOnvistaCompany: ETF position by company name, ADR/CDR ignored, ambiguous names give null', () => {
  const res = (...r: [string, string][]) => ({ facets: [{ type: 'STOCK', results: r.map(([name, isin]) => ({ name, isin })) }] });
  assert.deepEqual(companySearchQueries('PayPal Holdings Inc'), ['PayPal Holdings', 'PAYPAL']);
  assert.deepEqual(companySearchQueries('ALLEGRO.EU SA'), ['ALLEGRO.EU', 'ALLEGRO']);
  assert.equal(pickOnvistaCompany(res(['Paypal', 'US70450Y1038'], ['PayPal (CDR)', 'CA70452C1095']), 'PayPal Holdings Inc'), 'US70450Y1038');
  assert.equal(pickOnvistaCompany(res(['Allegro.eu', 'LU2237380790'], ['Allegro Microsystems', 'US01749D1054']), 'ALLEGRO.EU SA'), 'LU2237380790');
  assert.equal(pickOnvistaCompany(res(['EQT AB', 'SE0012853455'], ['EQT CORP', 'US26884L1098']), 'EQT Corp'), null);
  assert.equal(holdingNameKey('Hartford Insurance Group Inc/The'), 'name:HARTFORD INSURANCE GROUP');
});
