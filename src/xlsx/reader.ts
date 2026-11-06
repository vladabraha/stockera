import { readZip } from './zip.ts';

export type Cell = string | number | boolean | null;
export type Row = Cell[];
export interface Sheet {
  name: string;
  rows: Row[];
}

/** Reads all sheets of an XLSX workbook into dense row arrays (row 1 = index 0, column A = index 0). */
export function readWorkbook(buf: Buffer): Sheet[] {
  const files = readZip(buf);
  const text = (path: string): string | undefined => files.get(path)?.toString('utf8');

  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) throw new Error('Not an XLSX workbook (xl/workbook.xml missing)');

  const rels = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const sharedStrings = parseSharedStrings(text('xl/sharedStrings.xml') ?? '');

  const sheets: Sheet[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(attr(m[0], 'name') ?? '');
    const rid = attr(m[0], 'r:id');
    const path = rid ? rels.get(rid) : undefined;
    const xml = path ? text(path) : undefined;
    if (!xml) throw new Error(`Sheet "${name}" not found in workbook`);
    sheets.push({ name, rows: parseSheet(xml, sharedStrings) });
  }
  return sheets;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push(textContent((m[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  }
  return out;
}

function parseSheet(xml: string, sharedStrings: string[]): Row[] {
  const rows: Row[] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNum = Number(attr(rm[1] ?? '', 'r') ?? rows.length + 1);
    const row: Row = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? '';
      const ref = attr(attrs, 'r');
      const col = ref ? columnIndex(ref) : row.length;
      row[col] = cellValue(attr(attrs, 't'), cm[2] ?? '', sharedStrings);
    }
    for (let i = 0; i < row.length; i++) row[i] ??= null;
    rows[rowNum - 1] = row;
  }
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  return rows;
}

function cellValue(type: string | undefined, inner: string, sharedStrings: string[]): Cell {
  if (type === 'inlineStr') return textContent(inner);
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (v === undefined) return null;
  switch (type) {
    case 's':
      return sharedStrings[Number(v)] ?? null;
    case 'str':
    case 'e':
      return decodeXml(v);
    case 'b':
      return v === '1';
    default: {
      const n = Number(v);
      return Number.isNaN(n) ? decodeXml(v) : n;
    }
  }
}

function textContent(xml: string): string {
  let s = '';
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += m[1] ?? '';
  return decodeXml(s);
}

export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`).exec(tag)?.[1];
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e] ?? '';
  });
}
