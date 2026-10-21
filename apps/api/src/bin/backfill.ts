/**
 * Backfills price history.
 *
 *   pnpm --filter @psx/api backfill 2025-10-01 2026-10-21
 *   pnpm --filter @psx/api backfill --days 400
 *
 * Run once when setting up, to give the engine the 200 sessions its long-term
 * trend factors need. Already-ingested days are skipped, so it is safe to
 * re-run after an interruption and will pick up where it stopped.
 *
 * Deliberately slow. The exchange's archive files are public downloads, but
 * fetching 400 of them as fast as possible is rude and a good way to get an
 * address blocked, so there is a delay between requests.
 */

import { addDays } from '@psx/shared';
import { backfill, coverage } from '../services/ingest.js';
import { loadEnv } from '../env.js';
import { prisma } from '../db/prisma.js';

function parseArgs(): { from: string; to: string } {
  const args = process.argv.slice(2);
  const today = new Date().toISOString().slice(0, 10);

  const daysFlag = args.indexOf('--days');
  if (daysFlag !== -1) {
    const days = Number(args[daysFlag + 1]);
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error('--days needs a positive whole number');
    }
    return { from: addDays(today, -days), to: today };
  }

  const from = args[0];
  const to = args[1] ?? today;
  if (from === undefined) {
    throw new Error(
      'Usage: backfill <from YYYY-MM-DD> [to YYYY-MM-DD]  |  backfill --days <n>',
    );
  }
  return { from, to };
}

async function main(): Promise<void> {
  loadEnv();
  const { from, to } = parseArgs();

  console.log(`[backfill] ${from} to ${to}`);
  const started = Date.now();

  let written = 0;
  let holidays = 0;
  let failures = 0;

  const results = await backfill(from, to, {
    delayMs: 300,
    skipExisting: true,
    onProgress: (result, index, total) => {
      if (result.status === 'FAILED') {
        console.log(`[backfill] ${result.tradingDay}: FAILED ${result.error}`);
      } else if (index % 20 === 0 || result.actionsDetected > 0) {
        console.log(
          `[backfill] ${result.tradingDay} (${index}/${total}): ${result.status}, ` +
            `${result.barsWritten} bars` +
            (result.actionsDetected > 0 ? `, ${result.actionsDetected} action(s)` : ''),
        );
      }
    },
  });

  for (const result of results) {
    written += result.barsWritten;
    if (result.status === 'NO_FILE') holidays += 1;
    if (result.status === 'FAILED') failures += 1;
  }

  const report = await coverage();

  console.log('');
  console.log(`[backfill] done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log(`[backfill] ${results.length} dates processed, ${written} bars written`);
  console.log(`[backfill] ${holidays} non-trading weekdays, ${failures} failures`);
  console.log('');
  console.log(`[backfill] coverage: ${report.firstDay} to ${report.lastDay}`);
  console.log(
    `[backfill] ${report.tradingDaysStored} trading days, ${report.securities} securities, ` +
      `${report.barRows} bar rows`,
  );
  if (report.missingDays.length > 0) {
    console.log(
      `[backfill] ${report.missingDays.length} unexplained gap(s): ` +
        `${report.missingDays.slice(0, 10).join(', ')}${report.missingDays.length > 10 ? ' ...' : ''}`,
    );
  }

  await prisma.$disconnect();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  console.error('[backfill] failed:', error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
