import {
  PsxDataPortal,
  candidateTradingDays,
  classifyListing,
  describeAdjustment,
  detectAdjustments,
  isWeekend,
  type MarketDataProvider,
  type PsxDailyBar,
} from '@psx/data';
import { addDays, type IsoDate } from '@psx/shared';
import { conflict } from '../http/errors.js';
import { fromIsoDateColumn, toIsoDateColumn, toPaisa } from '../db/paisa.js';
import { prisma } from '../db/prisma.js';

/**
 * The market-data ingest.
 *
 * Runs once per evening against the exchange's published archive for that
 * trading day, and can be pointed at any past date to backfill.
 *
 * Two properties matter more than speed here.
 *
 * **Idempotent.** Re-running a date replaces that day's bars rather than
 * duplicating or merging them, so a run that failed halfway can simply be run
 * again, and a day the exchange restated can be corrected by re-ingesting it.
 * The alternative — insert-if-absent — leaves a partially written day looking
 * complete forever.
 *
 * **A missing file is data, not an error.** The exchange publishes nothing for
 * weekends and public holidays, and Pakistan's holidays include lunar-calendar
 * dates announced weeks ahead, so there is no calendar to check against. A 404
 * is recorded as NO_FILE and the run reports success.
 */

export interface IngestResult {
  tradingDay: IsoDate;
  status: 'SUCCESS' | 'NO_FILE' | 'FAILED';
  barsWritten: number;
  securitiesCreated: number;
  securitiesUpdated: number;
  rowsSkipped: number;
  warningCount: number;
  actionsDetected: number;
  actionDescriptions: string[];
  error?: string;
  durationMs: number;
}

export interface IngestOptions {
  provider?: MarketDataProvider;
  /** Also refresh names and sectors from the symbol master. Slower. */
  withSymbolMaster?: boolean;
}

export async function ingestTradingDay(
  date: IsoDate,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const started = Date.now();
  const provider = options.provider ?? new PsxDataPortal();

  const base: IngestResult = {
    tradingDay: date,
    status: 'SUCCESS',
    barsWritten: 0,
    securitiesCreated: 0,
    securitiesUpdated: 0,
    rowsSkipped: 0,
    warningCount: 0,
    actionsDetected: 0,
    actionDescriptions: [],
    durationMs: 0,
  };

  // Marked RUNNING first, so a crashed run is distinguishable from one that
  // never started when the history is reviewed later.
  await recordRun(date, 'RUNNING', base);

  try {
    const day = await provider.fetchDailyBars(date);

    if (day === null) {
      const result = { ...base, status: 'NO_FILE' as const, durationMs: Date.now() - started };
      await recordRun(date, 'NO_FILE', result);
      return result;
    }

    const warningCount = day.summary.warnings.length;
    const outsideRange = new Set(
      day.summary.warnings
        .filter((warning) => warning.kind === 'close_outside_range')
        .map((warning) => warning.symbol),
    );

    const securityIds = await upsertSecurities(day.bars, base);

    // Delete and re-insert the day rather than upserting row by row: it is one
    // round trip instead of five hundred, and it guarantees the stored day
    // matches the published file exactly rather than being a merge of two runs.
    const barsWritten = await prisma.$transaction(async (tx) => {
      await tx.dailyBar.deleteMany({ where: { date: fromIsoDateColumn(date) } });
      const created = await tx.dailyBar.createMany({
        data: day.bars.flatMap((bar) => {
          const securityId = securityIds.get(bar.symbol);
          if (securityId === undefined) return [];
          return [
            {
              securityId,
              date: fromIsoDateColumn(bar.date),
              open: BigInt(bar.open),
              high: BigInt(bar.high),
              low: BigInt(bar.low),
              close: BigInt(bar.close),
              volume: bar.volume,
              ldcp: bar.ldcp === null ? null : BigInt(bar.ldcp),
              closeOutsideRange: outsideRange.has(bar.symbol),
            },
          ];
        }),
      });
      return created.count;
    });

    const actions = await detectAndRecordActions(date, day.bars, securityIds);

    const result: IngestResult = {
      ...base,
      status: 'SUCCESS',
      barsWritten,
      rowsSkipped: day.summary.skipped.length,
      warningCount,
      actionsDetected: actions.length,
      actionDescriptions: actions,
      durationMs: Date.now() - started,
    };

    await recordRun(date, 'SUCCESS', result, day.summary.segmentCounts);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: IngestResult = {
      ...base,
      status: 'FAILED',
      error: message,
      durationMs: Date.now() - started,
    };
    await recordRun(date, 'FAILED', result);
    return result;
  }
}

/**
 * Creates or refreshes the Security rows the day's bars refer to.
 *
 * The daily file carries the name and sector, so the instrument master is kept
 * current as a side effect of ingesting prices rather than needing its own job.
 * `firstSeenOn` and `lastSeenOn` come free and are what tells you a listing has
 * gone quiet or been delisted.
 */
async function upsertSecurities(
  bars: readonly PsxDailyBar[],
  counters: IngestResult,
): Promise<Map<string, string>> {
  const symbols = bars.map((bar) => bar.symbol);
  const existing = await prisma.security.findMany({
    where: { symbol: { in: symbols } },
    select: {
      id: true,
      symbol: true,
      name: true,
      sectorCode: true,
      segment: true,
      listing: true,
      baseSymbol: true,
    },
  });
  const bySymbol = new Map(existing.map((row) => [row.symbol, row]));
  const ids = new Map<string, string>();
  const date = bars[0]?.date;
  const dateValue = date === undefined ? null : fromIsoDateColumn(date);

  // Written in bulk rather than row by row. A per-symbol update would be some
  // five hundred statements per trading day, which is tolerable once a night
  // and ruinous across a year's backfill: a hundred thousand round trips where
  // three will do.
  const missing = bars.filter((bar) => !bySymbol.has(bar.symbol));

  if (missing.length > 0) {
    await prisma.security.createMany({
      data: missing.map((bar) => {
        const listing = classifyListing({
          symbol: bar.symbol,
          shortName: bar.companyName,
          fullName: bar.companyName,
        });
        return {
          symbol: bar.symbol,
          name: bar.companyName,
          sectorCode: bar.sectorCode,
          segment: bar.segment,
          listing: listing.kind,
          baseSymbol: listing.base === bar.symbol ? null : listing.base,
          firstSeenOn: dateValue,
          lastSeenOn: dateValue,
        };
      }),
      // Another ingest running concurrently could have created the same symbol.
      skipDuplicates: true,
    });
    counters.securitiesCreated += missing.length;

    const created = await prisma.security.findMany({
      where: { symbol: { in: missing.map((bar) => bar.symbol) } },
      select: { id: true, symbol: true },
    });
    for (const row of created) ids.set(row.symbol, row.id);
  }

  for (const row of existing) ids.set(row.symbol, row.id);

  // Corrections are rare, so these stay individual.
  //
  // The segment matters more than it looks. Recording a trade in a symbol the
  // ingest has not seen yet creates a stub with segment UNKNOWN, and signal
  // generation filters on EQUITY. Without correcting it here, any stock bought
  // before its first ingest stays UNKNOWN forever and silently never gets a
  // prediction. The exchange's own file is authoritative, so it wins.
  for (const bar of bars) {
    const current = bySymbol.get(bar.symbol);
    if (current === undefined) continue;

    const listing = classifyListing({
      symbol: bar.symbol,
      shortName: bar.companyName,
      fullName: bar.companyName,
    });
    const baseSymbol = listing.base === bar.symbol ? null : listing.base;

    const changes = {
      ...(current.name !== bar.companyName ? { name: bar.companyName } : {}),
      ...(current.sectorCode !== bar.sectorCode ? { sectorCode: bar.sectorCode } : {}),
      ...(current.segment !== bar.segment ? { segment: bar.segment } : {}),
      ...(current.listing !== listing.kind ? { listing: listing.kind } : {}),
      ...(current.baseSymbol !== baseSymbol ? { baseSymbol } : {}),
    };

    if (Object.keys(changes).length === 0) continue;

    await prisma.security.update({ where: { id: current.id }, data: changes });
    counters.securitiesUpdated += 1;
  }

  if (dateValue !== null && ids.size > 0) {
    const allIds = [...ids.values()];
    // Guarded so the window only ever widens. A backfill runs oldest first, but
    // a re-ingest of an older date must not drag lastSeenOn backwards.
    await prisma.security.updateMany({
      where: { id: { in: allIds }, OR: [{ lastSeenOn: null }, { lastSeenOn: { lt: dateValue } }] },
      data: { lastSeenOn: dateValue, isActive: true },
    });
    await prisma.security.updateMany({
      where: { id: { in: allIds }, OR: [{ firstSeenOn: null }, { firstSeenOn: { gt: dateValue } }] },
      data: { firstSeenOn: dateValue },
    });
  }

  return ids;
}

/**
 * Compares the day against the previous trading day and records any corporate
 * action the price series implies.
 *
 * Detections land as DETECTED and are never applied automatically. The gap
 * between LDCP and the prior close is strong evidence but not proof, the
 * exchange's announcements remain authoritative, and a mis-applied bonus issue
 * corrupts a cost basis silently. So the user confirms.
 */
async function detectAndRecordActions(
  date: IsoDate,
  bars: readonly PsxDailyBar[],
  securityIds: Map<string, string>,
): Promise<string[]> {
  const previousDate = await previousStoredTradingDay(date);
  if (previousDate === null) return [];

  const previousRows = await prisma.dailyBar.findMany({
    where: { date: fromIsoDateColumn(previousDate) },
    select: { close: true, security: { select: { symbol: true } } },
  });

  if (previousRows.length === 0) return [];

  // detectAdjustments wants PsxDailyBar shapes; only symbol and close are read
  // from the previous day, so the rest is filled with inert values.
  const previousBars: PsxDailyBar[] = previousRows.map((row) => {
    const close = toPaisa(row.close);
    return {
      date: previousDate,
      symbol: row.security.symbol,
      sectorCode: '',
      companyName: '',
      segment: 'EQUITY' as const,
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
      ldcp: null,
    };
  });

  const adjustments = detectAdjustments(previousBars, bars);
  const descriptions: string[] = [];

  for (const adjustment of adjustments) {
    const securityId = securityIds.get(adjustment.symbol);
    if (securityId === undefined) continue;

    const type =
      adjustment.likely === 'SPLIT_OR_BONUS'
        ? 'BONUS'
        : adjustment.likely === 'CASH_DIVIDEND'
          ? 'CASH_DIVIDEND'
          : 'CASH_DIVIDEND';

    const data = {
      securityId,
      type: type as 'BONUS' | 'CASH_DIVIDEND',
      exDate: fromIsoDateColumn(adjustment.date),
      amountPerShare:
        adjustment.dividendPerShare === null ? null : BigInt(adjustment.dividendPerShare),
      bonusRatioBps:
        adjustment.shareRatio === null ? null : Math.round((adjustment.shareRatio - 1) * 10_000),
      detectedFromDelta: BigInt(adjustment.delta),
      detectedRatio: adjustment.impliedRatio,
      isAmbiguous: adjustment.ambiguous,
      detectionNote: describeAdjustment(adjustment),
    };

    // Idempotent: a re-ingest updates the detection rather than adding another,
    // but never overwrites one the user has already confirmed or rejected.
    const existing = await prisma.corporateAction.findUnique({
      where: { securityId_type_exDate: { securityId, type: data.type, exDate: data.exDate } },
      select: { id: true, status: true },
    });

    if (existing === null) {
      await prisma.corporateAction.create({ data });
    } else if (existing.status === 'DETECTED') {
      await prisma.corporateAction.update({ where: { id: existing.id }, data });
    }

    descriptions.push(describeAdjustment(adjustment));
  }

  return descriptions;
}

/** The most recent trading day already in the database before `date`. */
async function previousStoredTradingDay(date: IsoDate): Promise<IsoDate | null> {
  const row = await prisma.dailyBar.findFirst({
    where: { date: { lt: fromIsoDateColumn(date) } },
    orderBy: { date: 'desc' },
    select: { date: true },
  });
  return row === null ? null : toIsoDateColumn(row.date);
}

async function recordRun(
  date: IsoDate,
  status: 'RUNNING' | 'SUCCESS' | 'NO_FILE' | 'FAILED',
  result: IngestResult,
  segmentCounts?: unknown,
): Promise<void> {
  const data = {
    status,
    barsInserted: result.barsWritten,
    rowsSkipped: result.rowsSkipped,
    warningCount: result.warningCount,
    actionsFound: result.actionsDetected,
    detail:
      segmentCounts === undefined
        ? undefined
        : (JSON.parse(JSON.stringify({ segmentCounts })) as object),
    error: result.error ?? null,
    finishedAt: status === 'RUNNING' ? null : new Date(),
  };

  await prisma.ingestRun.upsert({
    where: { tradingDay_source: { tradingDay: fromIsoDateColumn(date), source: 'psx-data-portal' } },
    create: { tradingDay: fromIsoDateColumn(date), source: 'psx-data-portal', ...data },
    update: data,
  });
}

export interface BackfillOptions extends IngestOptions {
  /** Politeness delay between archive requests. */
  delayMs?: number;
  /** Skip dates already ingested successfully. */
  skipExisting?: boolean;
  onProgress?: (result: IngestResult, index: number, total: number) => void;
}

/**
 * Ingests a range of dates, oldest first.
 *
 * Oldest first matters: corporate-action detection compares each day against
 * the previous stored one, so running backwards would compare against a day
 * that is not yet there and find nothing.
 */
export async function backfill(
  from: IsoDate,
  to: IsoDate,
  options: BackfillOptions = {},
): Promise<IngestResult[]> {
  if (from > to) throw conflict(`Backfill range runs backwards: ${from} to ${to}`);

  const delayMs = options.delayMs ?? 300;
  const skipExisting = options.skipExisting ?? true;
  const days = [...candidateTradingDays(from, to)];

  const alreadyDone = skipExisting
    ? new Set(
        (
          await prisma.ingestRun.findMany({
            where: {
              tradingDay: { gte: fromIsoDateColumn(from), lte: fromIsoDateColumn(to) },
              status: { in: ['SUCCESS', 'NO_FILE'] },
            },
            select: { tradingDay: true },
          })
        ).map((row) => toIsoDateColumn(row.tradingDay)),
      )
    : new Set<IsoDate>();

  const results: IngestResult[] = [];
  const provider = options.provider ?? new PsxDataPortal();

  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    if (day === undefined) continue;
    if (alreadyDone.has(day)) continue;

    const result = await ingestTradingDay(day, { ...options, provider });
    results.push(result);
    options.onProgress?.(result, i + 1, days.length);

    if (i < days.length - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return results;
}

/**
 * Ingests whatever the exchange has published most recently.
 *
 * What the nightly job calls. Walks back from today past weekends and holidays
 * until it finds a file, so a run on a Sunday or the day after Eid still picks
 * up the last real session instead of recording a failure.
 */
export async function ingestLatest(
  options: IngestOptions & { maxLookback?: number } = {},
): Promise<IngestResult> {
  const maxLookback = options.maxLookback ?? 10;
  const provider = options.provider ?? new PsxDataPortal();
  let cursor = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < maxLookback; i += 1) {
    if (isWeekend(cursor)) {
      cursor = addDays(cursor, -1);
      continue;
    }
    const result = await ingestTradingDay(cursor, { ...options, provider });
    if (result.status !== 'NO_FILE') return result;
    cursor = addDays(cursor, -1);
  }

  return {
    tradingDay: cursor,
    status: 'FAILED',
    barsWritten: 0,
    securitiesCreated: 0,
    securitiesUpdated: 0,
    rowsSkipped: 0,
    warningCount: 0,
    actionsDetected: 0,
    actionDescriptions: [],
    error: `No archive file found in the last ${maxLookback} candidate days`,
    durationMs: 0,
  };
}

export interface CoverageReport {
  firstDay: IsoDate | null;
  lastDay: IsoDate | null;
  tradingDaysStored: number;
  securities: number;
  barRows: number;
  /** Weekdays in range with no bars and no NO_FILE record: genuine gaps. */
  missingDays: IsoDate[];
}

/**
 * What history is actually present.
 *
 * Worth having as a first-class query: a prediction built on a series with a
 * three-week hole in it is wrong in a way nothing else would reveal.
 */
export async function coverage(): Promise<CoverageReport> {
  const [first, last, securities, barRows] = await Promise.all([
    prisma.dailyBar.findFirst({ orderBy: { date: 'asc' }, select: { date: true } }),
    prisma.dailyBar.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.security.count(),
    prisma.dailyBar.count(),
  ]);

  if (first === null || last === null) {
    return {
      firstDay: null,
      lastDay: null,
      tradingDaysStored: 0,
      securities,
      barRows,
      missingDays: [],
    };
  }

  const firstDay = toIsoDateColumn(first.date);
  const lastDay = toIsoDateColumn(last.date);

  const storedDays = new Set(
    (
      await prisma.dailyBar.findMany({ distinct: ['date'], select: { date: true } })
    ).map((row) => toIsoDateColumn(row.date)),
  );

  const knownNonTrading = new Set(
    (
      await prisma.ingestRun.findMany({
        where: { status: 'NO_FILE' },
        select: { tradingDay: true },
      })
    ).map((row) => toIsoDateColumn(row.tradingDay)),
  );

  const missingDays = [...candidateTradingDays(firstDay, lastDay)].filter(
    (day) => !storedDays.has(day) && !knownNonTrading.has(day),
  );

  return {
    firstDay,
    lastDay,
    tradingDaysStored: storedDays.size,
    securities,
    barRows,
    missingDays,
  };
}
