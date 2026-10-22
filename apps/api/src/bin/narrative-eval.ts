/**
 * Compares models on the one job the narrative pass actually does.
 *
 *   pnpm --filter @psx/api narrative-eval -- --signals 50
 *
 * The question is not "which model is cleverer". The score, the action and the
 * factor weights are computed by deterministic code before any model is
 * called, so the model cannot make a prediction better or worse. The only
 * question is how faithfully it describes a table it has been handed — and
 * that is cheap to measure rather than guess at.
 *
 * Four checks per narrative, all mechanical:
 *
 * 1. The production validator. Contradicting the score, giving advice,
 *    inventing a price target, empty, over-long. This is the gate that decides
 *    whether the prose is stored at all, so its pass rate is the headline.
 *
 * 2. Numeric fidelity. Every number in the prose should trace to a number in
 *    the prompt. An unmatched figure is a number the model produced from
 *    nowhere, which in a finance app is the failure that matters most. Matching
 *    allows for rounding, because "-8.02%" in the table being written "8.0%" in
 *    the prose is correct reporting, not invention.
 *
 * 3. Opposing-factor coverage. The prompt says to mention what argues against
 *    the conclusion. An explanation that lists only supporting evidence is
 *    advocacy, so this checks the strongest opposing factor got a mention.
 *
 * 4. Measured cost. The writer already returns the token counts the API
 *    reported, so this reports real spend per narrative rather than an estimate
 *    from character counts.
 *
 * Every call costs money. The run prints its own bill at the end.
 */

import {
  buildNarrativePrompt,
  summarise,
  validateNarrative,
  type ScoredSignal,
} from '@psx/engine';
import { readFileSync, writeFileSync } from 'node:fs';
import { createNarrativeWriter, type NarrativeWriter } from '../services/narrative.js';
import { computeSignalForSymbol, liquidSymbols } from '../services/signals.js';
import { loadEnv, type Env } from '../env.js';
import { prisma } from '../db/prisma.js';

/** Per million tokens, input / output. From the model catalogue. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

const MODELS = Object.keys(PRICES);

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Numbers a narrative is allowed to contain.
 *
 * Built from the prompt text itself rather than from the signal's fields,
 * because the prompt is literally what the model was shown — anything not
 * derivable from it is unsupported by definition.
 */
function allowedNumbers(promptText: string): number[] {
  const found: number[] = [];
  for (const match of promptText.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/**
 * Numbers in the prose that no number in the prompt can account for.
 *
 * Tolerance is the looser of 0.05 absolute and 1% relative, which covers
 * honest rounding ("-8.02%" written as "8.0%") without admitting a figure that
 * was invented. Sign is ignored: prose routinely says "8.0% below" for -8.02.
 */
function unsupportedNumbers(text: string, allowed: number[]): number[] {
  const unsupported: number[] = [];

  for (const match of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Math.abs(Number(match[0]));
    if (!Number.isFinite(value)) continue;

    // Small integers are ordinals and counts in ordinary prose ("one factor",
    // "the 20, 50 and 200-day averages"); they are never a claim about data on
    // their own, and treating them as fabrications buries the real cases.
    if (Number.isInteger(value) && value <= 3) continue;

    const matched = allowed.some((candidate) => {
      const target = Math.abs(candidate);
      const tolerance = Math.max(0.05, target * 0.01);
      return Math.abs(target - value) <= tolerance;
    });

    if (!matched) unsupported.push(value);
  }

  return [...new Set(unsupported)];
}

/** The factor arguing hardest against the call, if there is one. */
function strongestOpposing(signal: ScoredSignal) {
  const against = signal.factors.filter((factor) =>
    signal.score >= 0 ? factor.contribution < -1 : factor.contribution > 1,
  );
  if (against.length === 0) return null;
  return against.reduce((worst, factor) =>
    Math.abs(factor.contribution) > Math.abs(worst.contribution) ? factor : worst,
  );
}

/**
 * Did the prose mention that factor?
 *
 * The first version matched words from the factor's label against the prose,
 * and it was wrong in both directions. "RSI (14)" has no word of four
 * characters or more, so it returned false however plainly the prose discussed
 * RSI. "Accumulation (OBV)" returned false against "on-balance volume shows
 * distribution", which is the same thing in the words a person would use. And
 * "Volume against average" returned true for any text containing "volume" and
 * "average" anywhere, in unrelated sentences. It scored all three models at
 * about 50%, and what it was measuring was itself.
 *
 * The test is now the factor's own observed value. "RSI 39.5" counts as
 * mentioned if 39.5 appears in the prose; "ADX 20" if 20 does. A number is
 * something the model either carried across or did not, which needs no
 * judgement about vocabulary. Where the reading has no usable number in it —
 * "distributing", "mid-band" — a small synonym list covers the concept, and a
 * label outside that list is reported as unmeasurable rather than counted
 * against the model.
 */
const SYNONYMS: Record<string, readonly string[]> = {
  'Accumulation (OBV)': ['obv', 'on-balance', 'on balance', 'accumulat', 'distribut'],
  'Bollinger band position': ['bollinger', 'band'],
  'Moving average alignment': ['moving average', 'averages are', 'stacked', '20, 50'],
  'Trend strength': ['adx', 'trend strength', 'ranging', 'trending'],
  MACD: ['macd'],
  'RSI (14)': ['rsi'],
  Volatility: ['atr', 'volatil', 'daily range'],
};

type Mention = 'yes' | 'no' | 'unmeasurable';

function mentionsFactor(text: string, label: string, display: string): Mention {
  const lower = text.toLowerCase();

  const inDisplay = [...display.matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((match) => Math.abs(Number(match[0])))
    // Values under 4 are the ordinals and small counts the numeric check also
    // ignores; matching on them would hit any sentence with a digit in it.
    .filter((value) => Number.isFinite(value) && value >= 4);

  if (inDisplay.length > 0) {
    const inProse = [...lower.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) =>
      Math.abs(Number(match[0])),
    );
    const hit = inDisplay.some((value) =>
      inProse.some((seen) => Math.abs(seen - value) <= Math.max(0.05, value * 0.01)),
    );
    return hit ? 'yes' : 'no';
  }

  const synonyms = SYNONYMS[label];
  if (synonyms === undefined) return 'unmeasurable';
  return synonyms.some((word) => lower.includes(word)) ? 'yes' : 'no';
}

/**
 * Does the prose present two sides at all?
 *
 * A coarser question than "did it name the strongest opposing factor", and a
 * sound one: an explanation with no contrastive turn in it is listing evidence
 * for a conclusion, which the prompt explicitly asks it not to do.
 */
function isTwoSided(text: string): boolean {
  return /\b(however|although|though|whereas|offset|against it|on the other|while|but )/i.test(
    text,
  );
}

interface Row {
  model: string;
  symbol: string;
  horizon: string;
  ok: boolean;
  failure?: string;
  validatorProblems: string[];
  unsupported: number[];
  opposingLabel: string | null;
  mentionedOpposing: Mention;
  twoSided: boolean;
  /** Kept so a change to the scoring can be re-run without paying again. */
  text: string;
  chars: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

async function main(): Promise<void> {
  // A rescore needs neither the database nor a key, so it runs before either
  // is required.
  const rescoreIndex = process.argv.indexOf('--rescore');
  if (rescoreIndex !== -1) {
    const path = process.argv[rescoreIndex + 1];
    if (path === undefined) {
      console.error('--rescore needs the path to a saved run');
      process.exitCode = 1;
      return;
    }
    rescore(path);
    return;
  }

  const env = loadEnv();
  const wanted = arg('signals', 50);

  if ((env.ANTHROPIC_API_KEY ?? '').trim() === '') {
    console.error('No ANTHROPIC_API_KEY configured; there is nothing to compare.');
    process.exitCode = 1;
    return;
  }

  // Quiet writers: a hundred and fifty startup lines would bury the report.
  const writers = new Map<string, NarrativeWriter>(
    MODELS.map((model) => [
      model,
      createNarrativeWriter({ ...env, NARRATIVE_MODEL: model } as Env, () => {}),
    ]),
  );

  const symbols = (await liquidSymbols(200_000)).slice(0, wanted);
  if (symbols.length === 0) {
    console.error('No liquid symbols stored; run the ingest first.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `Comparing ${MODELS.length} models over ${symbols.length} signals ` +
      `(${symbols.length * MODELS.length} calls). This spends real money.\n`,
  );

  const rows: Row[] = [];
  let done = 0;

  for (const symbol of symbols) {
    // Computed once, with no writer, so all three models describe the exact
    // same factor table. Comparing them on different inputs would measure the
    // inputs.
    const computed = await computeSignalForSymbol(symbol, 'SWING', { persist: false });
    if (!computed.ok) continue;

    const signal = computed.computed.signal;
    const opposing = strongestOpposing(signal);

    // The prompt the models are given, reconstructed here only to score
    // against it. summarise() is unused but proves the fallback still works
    // for this signal.
    void summarise(signal);

    for (const model of MODELS) {
      const writer = writers.get(model)!;
      const started = Date.now();
      const outcome = await writer.write({ signal });
      const ms = Date.now() - started;

      if (!outcome.ok) {
        rows.push({
          model,
          symbol,
          horizon: 'SWING',
          ok: false,
          failure: outcome.reason,
          validatorProblems: [],
          unsupported: [],
          opposingLabel: opposing?.label ?? null,
          mentionedOpposing: 'unmeasurable',
          twoSided: false,
          text: '',
          chars: 0,
          inputTokens: 0,
          outputTokens: 0,
          ms,
        });
        continue;
      }

      const problems = validateNarrative(signal, outcome.text);
      const allowed = allowedNumbers(promptTextFor(signal));

      rows.push({
        model,
        symbol,
        horizon: 'SWING',
        ok: true,
        validatorProblems: problems.map((problem) => problem.code),
        unsupported: unsupportedNumbers(outcome.text, allowed),
        opposingLabel: opposing?.label ?? null,
        mentionedOpposing:
          opposing === null
            ? 'unmeasurable'
            : mentionsFactor(outcome.text, opposing.label, opposing.display),
        twoSided: isTwoSided(outcome.text),
        text: outcome.text,
        chars: outcome.text.length,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        ms,
      });
    }

    done += 1;
    if (done % 5 === 0) console.log(`  ${done}/${symbols.length} signals...`);
  }

  report(rows);

  /*
   * The narratives are written out, not just scored and dropped.
   *
   * The first run's opposing-factor check turned out to be measuring itself,
   * and because the text had been discarded, correcting it meant paying for
   * 150 calls a second time. Keeping the outputs makes a scoring change free
   * to re-run, which is the difference between a measurement you can improve
   * and one you can only repeat.
   */
  const outPath = `narrative-eval-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\n  outputs written to ${outPath} — rescore with --rescore ${outPath}`);

  await prisma.$disconnect();
}

/** Re-scores a saved run. No API calls, so a scoring fix costs nothing. */
function rescore(path: string): void {
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { rows: Row[] };
  console.log(`Re-scoring ${saved.rows.length} saved narratives from ${path}\n`);
  report(saved.rows);
}

/** The prompt as the writer builds it, for scoring only. */
function promptTextFor(signal: ScoredSignal): string {
  // Rebuilt through the engine so it cannot drift from what was actually sent:
  // buildNarrativePrompt is the same function the writer uses.
  const prompt = buildNarrativePrompt(signal);
  return `${prompt.system}\n${prompt.user}`;
}

function report(rows: Row[]): void {
  console.log('\n' + '='.repeat(78));
  console.log('FIDELITY');
  console.log('='.repeat(78));
  console.log(
    'model'.padEnd(20) +
      'n'.padStart(4) +
      'valid'.padStart(8) +
      'numbers'.padStart(10) +
      'opposing'.padStart(10) +
      '2-sided'.padStart(10) +
      'chars'.padStart(7) +
      'secs'.padStart(7),
  );

  let grandTotal = 0;

  for (const model of MODELS) {
    const mine = rows.filter((row) => row.model === model);
    const ok = mine.filter((row) => row.ok);
    if (mine.length === 0) continue;

    const validClean = ok.filter((row) => row.validatorProblems.length === 0).length;
    const numbersClean = ok.filter((row) => row.unsupported.length === 0).length;
    // Only the rows the check could actually decide. Counting the
    // unmeasurable ones as failures is what made the first run's figure
    // meaningless.
    const measurable = ok.filter((row) => row.mentionedOpposing !== 'unmeasurable');
    const opposingOk = measurable.filter((row) => row.mentionedOpposing === 'yes').length;
    const twoSidedOk = ok.filter((row) => row.twoSided).length;
    const avgChars = ok.length === 0 ? 0 : ok.reduce((sum, r) => sum + r.chars, 0) / ok.length;
    const avgSecs = mine.reduce((sum, r) => sum + r.ms, 0) / mine.length / 1000;

    const share = (count: number, of: number) =>
      of === 0 ? '  n/a' : `${((count / of) * 100).toFixed(0)}%`.padStart(5);

    console.log(
      model.padEnd(20) +
        String(ok.length).padStart(4) +
        share(validClean, ok.length).padStart(8) +
        share(numbersClean, ok.length).padStart(10) +
        share(opposingOk, measurable.length).padStart(10) +
        share(twoSidedOk, ok.length).padStart(10) +
        avgChars.toFixed(0).padStart(7) +
        avgSecs.toFixed(1).padStart(7),
    );

    const failures = mine.filter((row) => !row.ok);
    if (failures.length > 0) {
      const byReason = new Map<string, number>();
      for (const row of failures) {
        byReason.set(row.failure ?? '?', (byReason.get(row.failure ?? '?') ?? 0) + 1);
      }
      for (const [reason, count] of byReason) {
        console.log(`${''.padEnd(20)}  ${count} failed: ${reason}`);
      }
    }
  }

  console.log('\n  valid    = passed the production validator, so the prose would be stored');
  console.log('  numbers  = every figure in the prose traces to the factor table');
  console.log('  opposing = carried the observed value of the strongest opposing factor');
  console.log('             (of the rows the check could decide; the rest are excluded)');
  console.log('  2-sided  = the prose has a contrastive turn, rather than listing one side');

  console.log('\n' + '='.repeat(78));
  console.log('MEASURED COST');
  console.log('='.repeat(78));

  for (const model of MODELS) {
    const ok = rows.filter((row) => row.model === model && row.ok);
    if (ok.length === 0) continue;

    const input = ok.reduce((sum, row) => sum + row.inputTokens, 0);
    const output = ok.reduce((sum, row) => sum + row.outputTokens, 0);
    const price = PRICES[model]!;
    const spend = (input / 1e6) * price.input + (output / 1e6) * price.output;
    grandTotal += spend;

    const per = spend / ok.length;
    console.log(
      `${model.padEnd(20)} ${String(input).padStart(7)} in  ${String(output).padStart(6)} out  ` +
        `$${per.toFixed(6)} each  →  $${(per * 2 * 22).toFixed(2)}/month per symbol followed`,
    );
  }

  console.log(`\n  this run cost $${grandTotal.toFixed(4)}`);
  console.log('  monthly figure assumes 2 horizons x 22 trading days per followed symbol');

  // The specifics are what make the percentages actionable: a model with 90%
  // numeric fidelity is only interesting once you can see what the 10% was.
  const slips = rows.filter((row) => row.ok && row.unsupported.length > 0).slice(0, 12);
  if (slips.length > 0) {
    console.log('\n' + '='.repeat(78));
    console.log('UNSUPPORTED NUMBERS (first 12)');
    console.log('='.repeat(78));
    for (const row of slips) {
      console.log(`  ${row.model.padEnd(20)} ${row.symbol.padEnd(8)} ${row.unsupported.join(', ')}`);
    }
  }

  const invalid = rows.filter((row) => row.ok && row.validatorProblems.length > 0).slice(0, 12);
  if (invalid.length > 0) {
    console.log('\n' + '='.repeat(78));
    console.log('VALIDATOR REJECTIONS (first 12)');
    console.log('='.repeat(78));
    for (const row of invalid) {
      console.log(
        `  ${row.model.padEnd(20)} ${row.symbol.padEnd(8)} ${row.validatorProblems.join(', ')}`,
      );
    }
  }
}

main().catch(async (error: unknown) => {
  console.error('[narrative-eval] failed:', error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
