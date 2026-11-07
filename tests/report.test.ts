import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { openDatabase } from '../src/db/database.ts';
import { importBuffer } from '../src/importer.ts';
import { analyze } from '../src/analysis/portfolio.ts';
import { buildReport, toBrowserScript } from '../src/report/build.ts';
import { decryptPayload, encryptPayload, type EncryptedPayload } from '../src/report/crypto.ts';
import { fakeXtbExport } from './helpers/fakeXtb.ts';

const PASSWORD = 'správné-heslo';
const ITER = 1000; // fast for tests; production default is 600 000

function sampleAnalysis() {
  const db = openDatabase(':memory:');
  importBuffer(db, 'a.xlsx', fakeXtbExport({
    from: '2020-12-31T23:00:00Z',
    cash: [{ id: '1', type: 'Deposit', time: '2021-01-04T08:00:00Z', amount: 1000 }],
    closed: [{ ticker: 'SECRETTICK.DE', volume: 1, openPrice: 10, openTime: '2021-02-01T09:00:00Z', closePrice: 15,
      closeTime: '2024-03-01T10:00:00Z', profit: 5, positionId: '20' }],
    openAsOf: '2024-12-31T10:00:00Z',
    open: [{ ticker: 'SECRETTICK.DE', name: 'Tajny fond', positionId: '10', volume: 2, openPrice: 8,
      openTime: '2021-02-01T09:00:00Z', currentPrice: 16 }],
  }));
  return analyze(db, { today: '2025-01-01', fx: { czkPer: (c) => (c === 'EUR' ? 25 : null) } });
}

function parts(html: string) {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)![1]!;
  const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const payload = JSON.parse(html.match(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/)![1]!) as EncryptedPayload;
  return { csp, style, script, payload };
}

const hash = (t: string) => `'sha256-${createHash('sha256').update(t, 'utf8').digest('base64')}'`;

test('encryptPayload/decryptPayload round trip; wrong password and tampering are rejected', async () => {
  const json = JSON.stringify({ hello: 'světe', n: [1, 2, 3] });
  const p = await encryptPayload(json, PASSWORD, ITER);
  assert.equal(await decryptPayload(p, PASSWORD), json);
  await assert.rejects(decryptPayload(p, 'spatne-heslo'), { name: 'OperationError' });
  const tampered = { ...p, data: (p.data[0] === 'A' ? 'B' : 'A') + p.data.slice(1) };
  await assert.rejects(decryptPayload(tampered, PASSWORD));
  const p2 = await encryptPayload(json, PASSWORD, ITER);
  assert.notEqual(p2.salt, p.salt);
  assert.notEqual(p2.iv, p.iv);
});

test('buildReport embeds only encrypted data that decrypts to the analysis', async () => {
  const a = sampleAnalysis();
  const html = await buildReport(a, PASSWORD, { iterations: ITER });
  const { payload } = parts(html);
  assert.deepEqual(JSON.parse(await decryptPayload(payload, PASSWORD)), JSON.parse(JSON.stringify(a)));
  for (const secret of ['SECRETTICK', 'Tajny fond', a.accounts[0]!.accountNumber]) {
    assert.ok(!html.includes(secret), `plaintext "${secret}" found in HTML`);
  }
});

test('buildReport: CSP allows only the live-price APIs and the inline blocks by hash', async () => {
  const html = await buildReport(sampleAnalysis(), PASSWORD, { iterations: ITER });
  const { csp, style, script } = parts(html);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /(^|; )connect-src https:\/\/api\.onvista\.de https:\/\/api\.frankfurter\.dev(;|$)/);
  for (const d of ["img-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(csp.includes(`script-src ${hash(script)}`));
  assert.ok(csp.includes(`style-src ${hash(style)}`));
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  // No external resources or links except the two price APIs (the SVG namespace is an identifier, not a request).
  const urls = html.match(/https?:\/\/[^\s"'<>`]+/g) ?? [];
  const allowed = /^https:\/\/api\.(onvista\.de|frankfurter\.dev)([/;]|$)/;
  assert.deepEqual(urls.filter((u) => u !== 'http://www.w3.org/2000/svg' && !allowed.test(u)), []);
  assert.ok(!/\sstyle=|\son[a-z]+=|<link|<iframe|<img/i.test(html));
  assert.equal((html.match(/<script/g) ?? []).length, 2);
});

test('frontend script is plain JavaScript without module syntax', async () => {
  const { script } = parts(await buildReport(sampleAnalysis(), PASSWORD, { iterations: ITER }));
  assert.doesNotThrow(() => new Script(script));
  assert.ok(!/^\s*(import|export)\s/m.test(script));
  assert.ok(script.includes('decryptPayload'));
  assert.equal(toBrowserScript("import type { A } from './a.ts';\nexport const x: A = 1;\n").trim(), 'const x    = 1;');
  assert.equal(toBrowserScript("import { a } from './a.ts'\nconst b = a;\n").trim(), 'const b = a;');
  assert.throws(() => toBrowserScript("import {\n  a,\n} from './a.ts';\nconst b = a;\n"), /import\/export/);
});
