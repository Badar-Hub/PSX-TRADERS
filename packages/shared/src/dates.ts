/**
 * Calendar-date helpers.
 *
 * Everything here works on an ISO calendar date ("2026-10-20") and goes through
 * UTC midnight internally. A trading date is a calendar fact, not an instant:
 * using local time would make a holding period change length depending on the
 * machine's timezone, which in turn would move a sale across a capital-gains
 * holding-period boundary.
 */

const MS_PER_DAY = 86_400_000;

export type IsoDate = string;

export function parseIsoDate(iso: IsoDate): Date {
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

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return toIsoDate(new Date(parseIsoDate(iso).getTime() + days * MS_PER_DAY));
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / MS_PER_DAY);
}

export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  // ISO dates sort correctly as strings, which avoids parsing in hot loops.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isValidIsoDate(value: string): boolean {
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}
