import { addDays, parseIsoDate, toIsoDate, type IsoDate } from '@psx/shared';

/**
 * PSX trading-calendar helpers.
 *
 * There is no published machine-readable holiday calendar, and Pakistan's
 * public holidays include lunar-calendar dates announced only weeks ahead. So
 * the calendar is discovered rather than declared: weekends are skipped
 * arithmetically, and any weekday whose archive file is absent is a non-trading
 * day. A 404 from the portal is therefore data, not an error, which is why the
 * provider returns null for it instead of throwing.
 *
 * Generic date arithmetic lives in @psx/shared; only the exchange-specific part
 * is here.
 */

const MS_PER_DAY = 86_400_000;

export { addDays, parseIsoDate, toIsoDate };

/** PSX trades Monday to Friday. */
export function isWeekend(iso: IsoDate): boolean {
  const day = parseIsoDate(iso).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Yields candidate trading dates from `from` to `to` inclusive, oldest first,
 * with weekends removed. Holidays cannot be excluded up front and fall out of
 * the ingest as absent files.
 */
export function* candidateTradingDays(from: IsoDate, to: IsoDate): Generator<IsoDate> {
  const end = parseIsoDate(to).getTime();
  let cursor = parseIsoDate(from).getTime();
  if (cursor > end) return;
  while (cursor <= end) {
    const iso = toIsoDate(new Date(cursor));
    if (!isWeekend(iso)) yield iso;
    cursor += MS_PER_DAY;
  }
}

export function countCandidateTradingDays(from: IsoDate, to: IsoDate): number {
  let count = 0;
  for (const _day of candidateTradingDays(from, to)) count += 1;
  return count;
}
