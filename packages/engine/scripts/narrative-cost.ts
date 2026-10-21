/**
 * Measures the real narrative prompt and prices it.
 *
 * Builds the actual prompt for every symbol in the fixture, on both horizons,
 * and reports the token profile. Pricing then comes from the measurement rather
 * than from a guess about how big a factor table is.
 *
 * Run with `pnpm --filter @psx/engine narrative-cost`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNarrativePrompt, summarise } from '../src/narrative.js';
import { scoreSignal } from '../src/scoring.js';
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
) as { series: Record<string, FixtureBar[]> };

/**
 * Characters per token for English prose with numbers and tables.
 *
 * A rough divisor, used only because count_tokens needs credentials. It runs
 * a little conservative for text this dense in digits and punctuation, so the
 * figures below lean high rather than flattering.
 */
const CHARS_PER_TOKEN = 3.7;

const estimate = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

const samples: Array<{
  symbol: string;
  horizon: SignalHorizon;
  systemChars: number;
  userChars: number;
  systemTokens: number;
  userTokens: number;
  factors: number;
  deterministicChars: number;
}> = [];

for (const [symbol, series] of Object.entries(fixture.series)) {
  if (series.length === 0) continue;
  for (const horizon of ['SWING', 'LONG_TERM'] as const) {
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
    if (!result.ok) continue;

    const prompt = buildNarrativePrompt(result.signal);
    samples.push({
      symbol,
      horizon,
      systemChars: prompt.system.length,
      userChars: prompt.user.length,
      systemTokens: estimate(prompt.system),
      userTokens: estimate(prompt.user),
      factors: result.signal.factors.length,
      deterministicChars: summarise(result.signal).length,
    });
  }
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const max = (values: number[]) => Math.max(...values);

const systemTokens = max(samples.map((s) => s.systemTokens));
const userTokens = Math.ceil(mean(samples.map((s) => s.userTokens)));
const userTokensMax = max(samples.map((s) => s.userTokens));

// The instruction asks for 3 to 5 sentences of plain prose. The deterministic
// summary is the same shape and length, so it is a fair proxy for the output.
const outputTokens = Math.ceil(mean(samples.map((s) => s.deterministicChars)) / CHARS_PER_TOKEN);

const inputTokens = systemTokens + userTokens;

console.log('MEASURED PROMPT PROFILE');
console.log(`  samples                ${samples.length} (${new Set(samples.map((s) => s.symbol)).size} symbols x 2 horizons)`);
console.log(`  factors per prompt     ${Math.round(mean(samples.map((s) => s.factors)))} average`);
console.log(`  system prompt          ${systemTokens} tokens (identical every call)`);
console.log(`  factor table + header  ${userTokens} tokens average, ${userTokensMax} worst case`);
console.log(`  input per narrative    ${inputTokens} tokens`);
console.log(`  output per narrative   ~${outputTokens} tokens`);
console.log('');

/** $ per million tokens, from the pricing table. */
const MODELS = [
  { name: 'Claude Haiku 5.5', id: 'claude-haiku-5-5', input: 0.1, output: 0.5 },
  { name: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5', input: 2.0, output: 10.0 },
  { name: 'Claude Opus 5.5', id: 'claude-opus-5-5', input: 4.0, output: 20.0 },
];

function costPer(model: { input: number; output: number }, narratives: number, batch: boolean) {
  const discount = batch ? 0.5 : 1;
  const inCost = (narratives * inputTokens * model.input) / 1_000_000;
  const outCost = (narratives * outputTokens * model.output) / 1_000_000;
  return (inCost + outCost) * discount;
}

const SCENARIOS = [
  { label: 'Lazy: ~20 views/day', perDay: 20 },
  { label: 'Watchlist: 30 symbols x 2 horizons nightly', perDay: 60 },
  { label: 'Eager: all 440 signals nightly', perDay: 440 },
];

console.log('MONTHLY COST (30 days)');
console.log('');
for (const scenario of SCENARIOS) {
  const perMonth = scenario.perDay * 30;
  console.log(`  ${scenario.label}  ->  ${perMonth.toLocaleString('en-US')} narratives/month`);
  for (const model of MODELS) {
    const live = costPer(model, perMonth, false);
    const batched = costPer(model, perMonth, true);
    console.log(
      `    ${model.name.padEnd(18)} $${live.toFixed(2).padStart(7)} live   $${batched.toFixed(2).padStart(7)} batched`,
    );
  }
  console.log('');
}

console.log('ONE NARRATIVE');
for (const model of MODELS) {
  console.log(
    `  ${model.name.padEnd(18)} $${costPer(model, 1, false).toFixed(6)}  (${(1 / costPer(model, 1, false)).toFixed(0)} per dollar)`,
  );
}
console.log('');

/**
 * Prompt caching does not apply here, and it is worth showing why rather than
 * assuming the usual 90% saving.
 */
console.log('PROMPT CACHING');
console.log(`  shared prefix (system prompt) is ${systemTokens} tokens`);
console.log('  minimum cacheable prefix is 512-4096 tokens depending on the model');
console.log('  => the prefix is too small to cache; no saving available');
console.log(`  the volatile part (the factor table) is ${Math.round((userTokens / inputTokens) * 100)}% of the input anyway`);
