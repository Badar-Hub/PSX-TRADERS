/**
 * Live check against the PSX Data Portal.
 *
 * Run with `pnpm --filter @psx/data check [date]`. Unlike the unit tests, which
 * run against saved fixtures, this one actually talks to the exchange, so it is
 * the thing to run when the portal changes something and the ingest starts
 * failing. It writes nothing and touches no database.
 */

import { PsxDataPortal } from '../dataPortal.js';
import { detectAdjustments, describeAdjustment } from '../corporateActions.js';
import { candidateTradingDays, addDays } from '../calendar.js';

const portal = new PsxDataPortal();

function mostRecentCandidate(): string {
  const today = new Date().toISOString().slice(0, 10);
  const days = [...candidateTradingDays(addDays(today, -10), today)];
  return days[days.length - 1] ?? today;
}

async function findLatestAvailable(from: string): Promise<string | null> {
  // Walk backwards past weekends and holidays until the exchange has a file.
  let cursor = from;
  for (let i = 0; i < 10; i += 1) {
    const result = await portal.fetchDailyBars(cursor);
    if (result !== null) return cursor;
    console.log(`  no file for ${cursor} (weekend or holiday)`);
    cursor = addDays(cursor, -1);
  }
  return null;
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  const start = requested ?? mostRecentCandidate();

  console.log(`Checking the PSX Data Portal, starting from ${start}\n`);

  const date = await findLatestAvailable(start);
  if (date === null) {
    console.error('No archive file found in the last 10 candidate days. Something is wrong.');
    process.exitCode = 1;
    return;
  }

  const day = await portal.fetchDailyBars(date);
  if (day === null) throw new Error(`unreachable: ${date} resolved then vanished`);

  console.log(`\n=== ${date} ===`);
  console.log(`archive: ${day.raw.length.toLocaleString()} bytes`);
  console.log('boards in the file:', day.summary.segmentCounts);
  console.log(`equity candles: ${day.bars.length}`);
  console.log(`untraded rows skipped: ${day.summary.skipped.length}`);

  const outOfRange = day.summary.warnings.filter((w) => w.kind === 'close_outside_range');
  console.log(`closes outside the day range: ${outOfRange.length} (expected: a handful, thin trades)`);

  const byVolume = [...day.bars].sort((a, b) => b.volume - a.volume).slice(0, 5);
  console.log('\nmost traded:');
  for (const bar of byVolume) {
    const close = (bar.close / 100).toFixed(2);
    console.log(
      `  ${bar.symbol.padEnd(10)} close ${close.padStart(10)}  vol ${bar.volume.toLocaleString()}`,
    );
  }

  const symbols = await portal.fetchSymbolMaster(date);
  console.log(`\nsymbol master: ${symbols === null ? 'not published for this date' : `${symbols.length} listings`}`);

  // The previous trading day, so corporate actions can be detected.
  const previousDate = await findLatestAvailable(addDays(date, -1));
  if (previousDate !== null) {
    const previous = await portal.fetchDailyBars(previousDate);
    if (previous !== null) {
      const adjustments = detectAdjustments(previous.bars, day.bars);
      console.log(`\ncorporate actions detected between ${previousDate} and ${date}: ${adjustments.length}`);
      for (const adjustment of adjustments.slice(0, 10)) {
        console.log(`  ${describeAdjustment(adjustment)}`);
      }
      const unexplained = adjustments.filter((a) => a.likely === 'UNEXPLAINED');
      if (unexplained.length > 0) {
        console.log(`\n  ${unexplained.length} could not be explained; worth investigating.`);
      }
    }
  }

  console.log('\nOK');
}

main().catch((error: unknown) => {
  console.error('\nFAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
