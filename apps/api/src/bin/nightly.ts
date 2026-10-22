/**
 * The nightly job.
 *
 * Four steps in order, because each depends on the one before: ingest the
 * day's prices, check the armed stop rules against them, recompute signals
 * from the new history, then settle any prediction whose horizon has now
 * elapsed.
 *
 * Stops come before signals deliberately. A breached stop is the only thing
 * here the user may need to act on tomorrow morning, so it is evaluated while
 * the run is certain to get that far, rather than after a few hundred symbols
 * of scoring that could time out or fail.
 *
 *   pnpm --filter @psx/api nightly
 *
 * A plain script rather than a queued worker. The work is one run a day over a
 * few hundred symbols, which does not need Redis, a scheduler process or
 * retries-with-backoff to be reliable; it needs to be idempotent, which it is.
 * Schedule it with cron or Windows Task Scheduler after the market closes
 * (PSX closes at 15:30 PKT, and the archive appears in the evening).
 *
 * Exits non-zero if the ingest failed, so a scheduler can alert on it.
 */

import { ingestLatest } from '../services/ingest.js';
import { refreshSignals, settleDueSignals } from '../services/signals.js';
import { evaluateArmedRules } from '../services/stops.js';
import { loadEnv } from '../env.js';
import { prisma } from '../db/prisma.js';

async function main(): Promise<void> {
  loadEnv();
  const started = Date.now();
  let failed = false;

  console.log(`[nightly] starting at ${new Date().toISOString()}`);

  // 1. Prices.
  const ingest = await ingestLatest();
  console.log(
    `[nightly] ingest ${ingest.tradingDay}: ${ingest.status}, ${ingest.barsWritten} bars, ` +
      `${ingest.securitiesCreated} new securities, ${ingest.rowsSkipped} rows skipped, ` +
      `${ingest.warningCount} warnings (${ingest.durationMs}ms)`,
  );

  if (ingest.status === 'FAILED') {
    console.error(`[nightly] ingest failed: ${ingest.error}`);
    failed = true;
  }

  for (const description of ingest.actionDescriptions) {
    console.log(`[nightly] corporate action: ${description}`);
  }
  if (ingest.actionsDetected > 0) {
    console.log(
      `[nightly] ${ingest.actionsDetected} action(s) recorded as DETECTED and awaiting ` +
        `confirmation before they touch any cost basis`,
    );
  }

  /*
   * 2. Stops.
   *
   * Run whatever the ingest did. The evaluator replays from each rule's own
   * `lastCheckedOn`, so a day the ingest failed is caught up on the next run
   * rather than skipped — and a stop breached while the job was down is still
   * reported, with that day's numbers.
   */
  const stops = await evaluateArmedRules();
  console.log(
    `[nightly] stops: ${stops.rulesChecked} checked, ${stops.triggered} triggered, ` +
      `${stops.moved} trailed up, ${stops.expired} expired, ${stops.skipped} skipped`,
  );
  for (const note of stops.notes) {
    console.log(`[nightly]   ${note}`);
  }

  // 3. Signals, only if there is new price data to compute them from.
  if (ingest.status === 'SUCCESS') {
    const refresh = await refreshSignals();
    console.log(
      `[nightly] signals: ${refresh.computed} computed, ${refresh.refused} refused`,
    );

    const byCode = new Map<string, number>();
    for (const refusal of refresh.refusals) {
      byCode.set(refusal.code, (byCode.get(refusal.code) ?? 0) + 1);
    }
    for (const [code, count] of byCode) {
      console.log(`[nightly]   refused ${count} as ${code}`);
    }
  } else {
    console.log('[nightly] skipping signals: no new prices');
  }

  // 4. Judge the predictions whose time is up.
  const settled = await settleDueSignals();
  console.log(
    `[nightly] settled ${settled.settled}: ${settled.hits} hit, ${settled.misses} missed, ` +
      `${settled.neutral} neutral`,
  );

  console.log(`[nightly] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await prisma.$disconnect();

  if (failed) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  console.error('[nightly] failed:', error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
