import { rupeesToPaisa, type Paisa } from '@psx/shared';

/**
 * Parser for the PSX daily market summary, which is the OHLCV source for this
 * system.
 *
 * It arrives as `mkt_summary/<YYYY-MM-DD>.Z` from the PSX Data Portal. Despite
 * the `.Z` extension the payload is a ZIP archive containing a single
 * pipe-delimited file named `closing11.lis`:
 *
 *   20OCT2026|786|0813|786 Invest Ltd|20.99|20.99|20|20.65|77201|20.75|||
 *   DATE     |SYM |SECT|NAME         |OPEN |HIGH |LOW|CLOSE|VOLUME|LDCP
 *
 * ## Why the field order is worth documenting
 *
 * The file has no header row, and fields 7 and 9 are both closing prices: one
 * for this day, one for the day before. Reading them the wrong way round would
 * shift the entire price series by a day. No unit test on a single file could
 * catch that, and every indicator and prediction would silently inherit it.
 *
 * The order above was established by chaining two consecutive trading days:
 * field 9 on 21 Oct equals field 7 on 20 Oct, for every symbol checked
 * (ABL 170.19, ABOT 935.61, AABS 701.71, HBL 286.55, OGDC 300.01). A previous
 * close is by definition the prior day's close, so field 7 is this day's close
 * and field 9 is the one before it. `closingSummary.test.ts` asserts that chain
 * against both fixtures, so a future change to the format breaks a test rather
 * than quietly corrupting history.
 *
 * ## Two things the file does that are easy to mistake for parser bugs
 *
 * 1. It is not equity-only. Roughly half the rows are single-stock and index
 *    futures, plus government debt instruments. They are distinguished by the
 *    sector code, not the symbol: equities carry a 4-digit sector ("0807"),
 *    while futures carry "40", index futures "41", and debt "36". Ingesting
 *    them as equities would list 500-odd contracts such as "AGP-CDEC" as
 *    tradable stocks, and attach futures candles to the underlying's chart.
 *
 * 2. In very thinly traded stocks, the official closing price can fall outside
 *    the day's traded high and low. On 20 Oct this affected 10 equities, each
 *    with a volume between 1 and 80 shares (AL-Noor Sugar closed at 116.00
 *    against a low of 116.50 on 32 shares traded). PSX computes the closing
 *    price by its own methodology rather than taking the last trade, so this is
 *    the exchange's number, not a corruption. Such rows are kept and flagged,
 *    because the exchange's file is the authority on what traded; silently
 *    "repairing" them would put this system's prices out of step with the
 *    user's broker statement.
 */

export class PsxParseError extends Error {}

/**
 * Which board a row belongs to. Only EQUITY rows belong in the price history
 * that feeds charts, indicators and predictions.
 */
export type MarketSegment = 'EQUITY' | 'FUTURE' | 'INDEX_FUTURE' | 'DEBT' | 'UNKNOWN';

export interface PsxDailyBar {
  /** ISO calendar date, e.g. "2026-10-20". */
  date: string;
  symbol: string;
  sectorCode: string;
  companyName: string;
  segment: MarketSegment;
  open: Paisa;
  high: Paisa;
  low: Paisa;
  close: Paisa;
  volume: number;
  /** Previous trading day's close, as published. */
  ldcp: Paisa | null;
}

export type SkipReason =
  | 'too_few_fields'
  | 'bad_date'
  | 'empty_symbol'
  | 'unparseable_price'
  | 'no_trade_prices';

export interface SkippedRow {
  lineNumber: number;
  reason: SkipReason;
  raw: string;
  detail?: string;
}

export type WarningKind = 'close_outside_range' | 'zero_volume' | 'duplicate_symbol';

export interface DataWarning {
  kind: WarningKind;
  symbol: string;
  lineNumber: number;
  detail: string;
}

export interface ClosingSummary {
  /** The trading date every row in the file shares. Null if no row parsed. */
  date: string | null;
  bars: PsxDailyBar[];
  skipped: SkippedRow[];
  /**
   * Rows that parsed but look unusual. Surfaced rather than thrown so an ingest
   * run can be reviewed, and so a change in the exchange's own data quality
   * shows up as a rising count instead of as silence.
   */
  warnings: DataWarning[];
  /** Row counts per segment, for an ingest log worth reading. */
  segmentCounts: Record<MarketSegment, number>;
}

const MONTHS: Readonly<Record<string, string>> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

/** Converts the file's "20OCT2026" into "2026-10-20". */
export function parsePsxDate(raw: string): string {
  const match = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(raw.trim());
  if (!match) throw new PsxParseError(`Unrecognised PSX date: "${raw}"`);

  const day = match[1] ?? '';
  const monthName = (match[2] ?? '').toUpperCase();
  const year = match[3] ?? '';
  const month = MONTHS[monthName];
  if (month === undefined) throw new PsxParseError(`Unknown month in PSX date: "${raw}"`);

  return `${year}-${month}-${day.padStart(2, '0')}`;
}

/**
 * Classifies a row by its sector code, falling back to the symbol shape.
 *
 * The sector code is the reliable signal: on 20 Oct every one of the 507 rows
 * coded "40" had a futures-style symbol, and no 4-digit-sector row did. The
 * symbol pattern is kept only as a backstop in case the exchange reuses a code.
 */
export function classifySegment(sectorCode: string, symbol: string): MarketSegment {
  switch (sectorCode) {
    case '40':
      return 'FUTURE';
    case '41':
      return 'INDEX_FUTURE';
    case '36':
      return 'DEBT';
    default:
      break;
  }
  if (/^\d{4}$/.test(sectorCode)) return 'EQUITY';
  // "AGP-CDEC", "AGHA-OCT", "ZAL-COCT": optional cash-settled "C", a month, an
  // optional board suffix.
  if (/-C?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)B?$/i.test(symbol)) return 'FUTURE';
  if (/^P\d+(GIS|GHS|PIB|TB)/i.test(symbol)) return 'DEBT';
  return 'UNKNOWN';
}

/**
 * Prices in the file sometimes carry more than two decimals, so they are
 * rounded to paisa here rather than rejected. Anything non-numeric is a failure.
 */
function parsePrice(raw: string | undefined, field: string, line: number): Paisa {
  const text = (raw ?? '').trim();
  if (text === '') throw new PsxParseError(`Line ${line}: empty ${field}`);
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new PsxParseError(`Line ${line}: ${field} is not a number ("${text}")`);
  }
  if (value < 0) throw new PsxParseError(`Line ${line}: ${field} is negative ("${text}")`);
  return rupeesToPaisa(value.toFixed(2));
}

function parseVolume(raw: string | undefined, line: number): number {
  const text = (raw ?? '').trim().replace(/,/g, '');
  if (text === '') return 0;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    throw new PsxParseError(`Line ${line}: volume is not a non-negative number ("${text}")`);
  }
  return Math.round(value);
}

export interface ParseOptions {
  /** Keep only these segments. Defaults to every segment. */
  segments?: readonly MarketSegment[];
}

export function parseClosingSummary(content: string, options: ParseOptions = {}): ClosingSummary {
  const wanted = options.segments;
  const bars: PsxDailyBar[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: DataWarning[] = [];
  const seen = new Set<string>();
  const segmentCounts: Record<MarketSegment, number> = {
    EQUITY: 0,
    FUTURE: 0,
    INDEX_FUTURE: 0,
    DEBT: 0,
    UNKNOWN: 0,
  };
  let date: string | null = null;

  // The exchange is not consistent about line endings: this file uses LF, while
  // the price-band export uses bare CR. Splitting on any of the three keeps a
  // CR-only file from arriving as one 200 KB "line".
  const lines = content.split(/\r\n|[\r\n]/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const lineNumber = i + 1;
    // These files carry stray BOM and zero-width marks between fields; stripping
    // them is load-bearing, not cosmetic. Without it symbols arrive with an
    // invisible prefix and never match anything.
    const line = raw.replace(/[﻿​]/g, '').trim();
    if (line === '') continue;

    const fields = line.split('|');
    if (fields.length < 10) {
      skipped.push({ lineNumber, reason: 'too_few_fields', raw: line });
      continue;
    }

    const symbol = (fields[1] ?? '').trim().toUpperCase();
    if (symbol === '') {
      skipped.push({ lineNumber, reason: 'empty_symbol', raw: line });
      continue;
    }

    let rowDate: string;
    try {
      rowDate = parsePsxDate(fields[0] ?? '');
    } catch (error) {
      skipped.push({
        lineNumber,
        reason: 'bad_date',
        raw: line,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const sectorCode = (fields[2] ?? '').trim();
    const segment = classifySegment(sectorCode, symbol);

    let open: Paisa;
    let high: Paisa;
    let low: Paisa;
    let close: Paisa;
    let volume: number;
    let ldcp: Paisa | null;
    try {
      open = parsePrice(fields[4], 'open', lineNumber);
      high = parsePrice(fields[5], 'high', lineNumber);
      low = parsePrice(fields[6], 'low', lineNumber);
      close = parsePrice(fields[7], 'close', lineNumber);
      volume = parseVolume(fields[8], lineNumber);
      const ldcpText = (fields[9] ?? '').trim();
      ldcp = ldcpText === '' ? null : parsePrice(ldcpText, 'ldcp', lineNumber);
    } catch (error) {
      skipped.push({
        lineNumber,
        reason: 'unparseable_price',
        raw: line,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    segmentCounts[segment] += 1;

    if (wanted !== undefined && !wanted.includes(segment)) continue;

    // An untraded listing or futures contract appears with open, high and low
    // all zero while still carrying a reference or settlement close. That is not
    // a candle: feeding it to an indicator manufactures a 100% crash followed by
    // a 100% recovery. 414 of 1033 rows on 20 Oct looked like this.
    if (open === 0 && high === 0 && low === 0) {
      skipped.push({ lineNumber, reason: 'no_trade_prices', raw: line });
      continue;
    }

    if (date === null) date = rowDate;

    if (seen.has(symbol)) {
      warnings.push({
        kind: 'duplicate_symbol',
        symbol,
        lineNumber,
        detail: `${symbol} appears more than once in the file`,
      });
    }
    seen.add(symbol);

    // Expected to fire occasionally on near-untraded equities; see the note at
    // the top of this file. The volume is included because it is what tells a
    // reviewer whether this is the exchange's thin-trade rounding or something
    // genuinely wrong.
    if (close > high || close < low) {
      warnings.push({
        kind: 'close_outside_range',
        symbol,
        lineNumber,
        detail: `close ${close} outside [${low}, ${high}] on volume ${volume}`,
      });
    }

    if (volume === 0) {
      warnings.push({
        kind: 'zero_volume',
        symbol,
        lineNumber,
        detail: 'row has prices but no shares traded',
      });
    }

    bars.push({
      date: rowDate,
      symbol,
      sectorCode,
      companyName: (fields[3] ?? '').trim(),
      segment,
      open,
      high,
      low,
      close,
      volume,
      ldcp,
    });
  }

  return { date, bars, skipped, warnings, segmentCounts };
}
