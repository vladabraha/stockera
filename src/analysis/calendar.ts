const pragueFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date (YYYY-MM-DD) in Europe/Prague for an ISO timestamp. */
export function pragueDate(iso: string): string {
  return pragueFormatter.format(new Date(iso));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same calendar day `years` later; 29 Feb falls back to 28 Feb. */
export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return new Date(Date.UTC(y + years, m - 1, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Czech time test for securities: holding must exceed 3 years → first tax-free day is the day after the 3rd anniversary. */
export function taxFreeFrom(openDate: string): string {
  return addDays(addYears(openDate, 3), 1);
}
