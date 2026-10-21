/**
 * Prints a full explained prediction for a symbol from the test fixture.
 *
 * `pnpm --filter @psx/engine explain [SYMBOL] [swing|long]`
 *
 * This is what the UI will render when the user taps a prediction and asks
 * why: the conclusion, the factor table that produced it, the group totals, and
 * the prose. It exists as a script so the output can be read and judged
 * directly, rather than only inferred from passing tests.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupByCategory, scoreSignal } from '../src/scoring.js';
import { renderFactorTable, summarise } from '../src/narrative.js';
import type { SignalHorizon } from '@psx/shared';

interface FixtureBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'psx-history.json'),
    'utf8',
  ),
) as { series: Record<string, FixtureBar[]>; endDate: string };

const requested = (process.argv[2] ?? '').toUpperCase();
const symbols = requested === '' ? Object.keys(fixture.series) : [requested];
const horizon: SignalHorizon = (process.argv[3] ?? 'swing').toLowerCase().startsWith('long')
  ? 'LONG_TERM'
  : 'SWING';

for (const symbol of symbols) {
  const series = fixture.series[symbol];
  if (series === undefined || series.length === 0) {
    console.log(`\n${symbol}: not in the fixture\n`);
    continue;
  }

  const result = scoreSignal({
    symbol,
    bars: series.map((bar) => ({
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    })),
    dates: series.map((bar) => bar.date),
    horizon,
  });

  const rule = '='.repeat(84);
  console.log(`\n${rule}`);

  if (!result.ok) {
    console.log(`${symbol} (${horizon}) -> NO SIGNAL [${result.code}]`);
    console.log(`  ${result.reason}`);
    continue;
  }

  const signal = result.signal;
  const first = series[0];
  const last = series[series.length - 1];
  const yearChange =
    first === undefined || last === undefined
      ? 0
      : ((last.close - first.close) / first.close) * 100;

  console.log(
    `${symbol} (${horizon === 'SWING' ? 'swing' : 'long term'})  as of ${signal.asOf}  ` +
      `close ${signal.priceAtSignal.toFixed(2)}  (${yearChange >= 0 ? '+' : ''}${yearChange.toFixed(1)}% over the year)`,
  );
  console.log(rule);
  console.log(
    `  ${signal.action}   score ${signal.score > 0 ? '+' : ''}${signal.score}   ` +
      `confidence ${(signal.confidence * 100).toFixed(0)}%  ` +
      `(coverage ${(signal.coverage * 100).toFixed(0)}%, agreement ${(signal.agreement * 100).toFixed(0)}%)  ` +
      `missing ${signal.missingFactors}`,
  );
  console.log('');
  console.log(renderFactorTable(signal.factors));
  console.log('');
  console.log('  by group:');
  for (const group of groupByCategory(signal)) {
    const bar =
      group.contribution >= 0
        ? '+'.repeat(Math.min(30, Math.round(group.contribution)))
        : '-'.repeat(Math.min(30, Math.round(-group.contribution)));
    console.log(
      `    ${group.category.padEnd(12)} ${group.contribution >= 0 ? '+' : ''}${group.contribution.toFixed(1).padStart(6)}  ${bar}`,
    );
  }
  console.log('');
  console.log('  why:');
  for (const line of wrap(summarise(signal), 78)) console.log(`    ${line}`);
}

console.log('');

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === '' ? word : `${current} ${word}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
