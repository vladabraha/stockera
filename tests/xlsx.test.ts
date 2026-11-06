import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkbook, columnIndex } from '../src/xlsx/reader.ts';
import { excelSerialToIso, czechDateTimeToIso } from '../src/util/dates.ts';
import { buildXlsx } from './helpers/xlsxBuilder.ts';

for (const compress of [true, false]) {
  test(`reads sheets, strings, numbers and sparse cells (${compress ? 'deflate' : 'stored'})`, () => {
    const buf = buildXlsx(
      [
        { name: 'První & druhý', rows: [['a', null, 1.5], [], [null, 'x<y> "q"', true]] },
        { name: 'Second', rows: [['only']] },
      ],
      { compress },
    );
    const sheets = readWorkbook(buf);
    assert.deepEqual(sheets.map((s) => s.name), ['První & druhý', 'Second']);
    assert.deepEqual(sheets[0]!.rows, [['a', null, 1.5], [], [null, 'x<y> "q"', true]]);
    assert.deepEqual(sheets[1]!.rows, [['only']]);
  });
}

test('rejects non-XLSX input', () => {
  assert.throws(() => readWorkbook(Buffer.from('not a zip file at all, definitely not')), /Not a ZIP/);
});

test('columnIndex handles multi-letter columns', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('Z9'), 25);
  assert.equal(columnIndex('AA12'), 26);
  assert.equal(columnIndex('AB3'), 27);
});

test('date conversions are UTC based', () => {
  assert.equal(excelSerialToIso(45291.958333333336), '2023-12-31T23:00:00.000Z');
  assert.equal(czechDateTimeToIso('28.05.2024 15:38:45'), '2024-05-28T15:38:45.000Z');
  assert.throws(() => czechDateTimeToIso('2024-05-28'));
});
