/**
 * Builds the real-data test fixture.
 *
 * Downloads a year of PSX daily archives and extracts the price history for a
 * handful of liquid symbols, so the engine can be tested against prices the
 * exchange actually published rather than only against synthetic series.
 *
 * Synthetic data is better for checking that an indicator computes what it
 * claims: the expected value is known. It is worse at catching the things that
 * actually break an engine in production, like a symbol that stops trading
 * mid-series, a corporate action that halves the price overnight, or a stretch
 * of flat closes. Those are in here.
 *
 * Run with `pnpm --filter @psx/engine fixture:fetch`. The result is committed,
 * so the test suite needs no network.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PsxDataPortal, addDays, isWeekend } from '@psx/data';

/**
 * Chosen for liquidity and for variety of behaviour over the period: PRL rose
 * sharply, HBL and LUCK fell, OGDC and FFC rose moderately.
 *
 * Note ENGROH, not ENGRO. Engro Corporation trades as Engro Holdings; there is
 * no ENGRO ticker on the exchange, which is the kind of thing only real data
 * tells you.
 */
const SYMBOLS = ['HBL', 'ENGROH', 'OGDC', 'PRL', 'LUCK', 'FFC'];
const TRADING_DAYS_WANTED = 260;
const END_DATE = '2026-10-21';
const DELAY_MS = 250;

interface FixtureBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ldcp: number | null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const portal = new PsxDataPortal({ timeoutMs: 20_000, maxAttempts: 2 });
  const series = new Map<string, FixtureBar[]>(SYMBOLS.map((symbol) => [symbol, []]));

  let cursor = END_DATE;
  let tradingDays = 0;
  let attempts = 0;
  let holidays = 0;

  process.stdout.write(`Fetching up to ${TRADING_DAYS_WANTED} trading days back from ${END_DATE}\n`);

  while (tradingDays < TRADING_DAYS_WANTED && attempts < 500) {
    attempts += 1;

    if (isWeekend(cursor)) {
      cursor = addDays(cursor, -1);
      continue;
    }

    try {
      const day = await portal.fetchDailyBars(cursor);
      if (day === null) {
        holidays += 1;
      } else {
        tradingDays += 1;
        const bySymbol = new Map(day.bars.map((bar) => [bar.symbol, bar]));
        for (const symbol of SYMBOLS) {
          const bar = bySymbol.get(symbol);
          if (bar === undefined) continue;
          series.get(symbol)?.push({
            date: bar.date,
            open: bar.open / 100,
            high: bar.high / 100,
            low: bar.low / 100,
            close: bar.close / 100,
            volume: bar.volume,
            ldcp: bar.ldcp === null ? null : bar.ldcp / 100,
          });
        }
        if (tradingDays % 20 === 0) {
          process.stdout.write(`  ${tradingDays} trading days collected (at ${cursor})\n`);
        }
      }
    } catch (error) {
      process.stdout.write(
        `  ${cursor}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

    cursor = addDays(cursor, -1);
    await delay(DELAY_MS);
  }

  // Collected newest first; the engine expects oldest first throughout.
  const output = {
    generatedAt: new Date().toISOString(),
    source: 'PSX Data Portal mkt_summary archives',
    endDate: END_DATE,
    tradingDays,
    holidaysSkipped: holidays,
    series: Object.fromEntries(
      [...series.entries()].map(([symbol, bars]) => [symbol, [...bars].reverse()]),
    ),
  };

  const target = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'psx-history.json',
  );
  writeFileSync(target, `${JSON.stringify(output, null, 1)}\n`, 'utf8');

  process.stdout.write(`\nWrote ${target}\n`);
  for (const [symbol, bars] of series) {
    process.stdout.write(`  ${symbol.padEnd(8)} ${bars.length} bars\n`);
  }
  process.stdout.write(`  ${holidays} non-trading weekdays skipped\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
