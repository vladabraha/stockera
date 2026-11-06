const MS_PER_DAY = 86_400_000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Excel serial date (interpreted as UTC) → ISO string with millisecond precision. */
export function excelSerialToIso(serial: number): string {
  return new Date(Math.round(EXCEL_EPOCH_MS + serial * MS_PER_DAY)).toISOString();
}

/** "DD.MM.YYYY HH:MM:SS" (UTC) → ISO string. */
export function czechDateTimeToIso(s: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) throw new Error(`Invalid date "${s}"`);
  const [, d, mo, y, h = '0', mi = '0', sec = '0'] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))).toISOString();
}
