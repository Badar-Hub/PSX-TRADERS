/**
 * PSX trading-calendar helpers.
 *
 * There is no published machine-readable holiday calendar, and Pakistan's
 * public holidays include lunar-calendar dates announced only weeks ahead. So
 * the calendar is discovered rather than declared: weekends are skipped
 * arithmetically, and any weekday whose archive file is absent is recorded as a
 * non-trading day. A 404 from the portal is therefore data, not an error, which
 * is why the provider returns null for it instead of throwing.
 */

const MS_PER_DAY = 86_400_000;

/** Parses "2026-10-20" into a UTC-midnight Date, avoiding local-timezone drift. */
export function parseIsoDate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Expected an ISO calendar date, got "${iso}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Not a real calendar date: "${iso}"`);
  }
  return date;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIsoDate(new Date(parseIsoDate(iso).getTime() + days * MS_PER_DAY));
}

/** PSX trades Monday to Friday. */
export function isWeekend(iso: string): boolean {
  const day = parseIsoDate(iso).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Yields candidate trading dates from `from` to `to` inclusive, oldest first,
 * with weekends removed. Holidays cannot be excluded up front and fall out of
 * the ingest as absent files.
 */
export function* candidateTradingDays(from: string, to: string): Generator<string> {
  const end = parseIsoDate(to).getTime();
  let cursor = parseIsoDate(from).getTime();
  if (cursor > end) return;
  while (cursor <= end) {
    const iso = toIsoDate(new Date(cursor));
    if (!isWeekend(iso)) yield iso;
    cursor += MS_PER_DAY;
  }
}

export function countCandidateTradingDays(from: string, to: string): number {
  let count = 0;
  for (const _day of candidateTradingDays(from, to)) count += 1;
  return count;
}
