import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockedRequestError, Http, HttpError, MAX_BODY_BYTES } from '../src/net/http.ts';
import { fakeFetch } from './helpers/fakeFetch.ts';
import {
  countryCode, exchangeCountry, parseCnbYear, parseJustEtfProfile, parseXetraInstruments, parseYahooChart, yahooSymbol,
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

test('parseJustEtfProfile extracts name and country weights', () => {
  const row = (n: string, p: string) =>
    `<tr><td data-testid="tl_etf-holdings_countries_value_name">${n}</td><td><div><span data-testid="tl_etf-holdings_countries_value_percentage">${p}%</span></div></td></tr>`;
  const html = `<meta property="og:title" content="S&amp;P 500 ETF | SPYL | IE000XZSV718" />${row('United States', '97.58')}${row('Other', '2.42')}`;
  assert.deepEqual(parseJustEtfProfile(html), {
    name: 'S&P 500 ETF',
    countries: [
      { name: 'United States', weight: 97.58 },
      { name: 'Other', weight: 2.42 },
    ],
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
