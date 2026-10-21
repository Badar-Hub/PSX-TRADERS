import type { FactorScore, SignalAction } from '@psx/shared';
import type { ScoredSignal } from './scoring.js';

/**
 * Turning the factor table into prose.
 *
 * The factor table is the source of truth. The narrative is a rendering of it,
 * and it is generated in two ways:
 *
 * 1. `summarise` builds a readable paragraph deterministically, from the same
 *    numbers the score came from. No API, no cost, no network. This is what the
 *    app shows by default, and it means an explanation is never unavailable.
 *
 * 2. `buildNarrativePrompt` produces a prompt for an LLM to write something
 *    more fluent. It is an enhancement, cached per signal so it is not
 *    regenerated per view, and it is checked before being stored.
 *
 * The ordering matters. If the LLM were the only path, an outage or an expired
 * key would leave a prediction with no explanation at all, which is the one
 * thing this design is supposed to prevent.
 */

const ACTION_WORDS: Readonly<Record<SignalAction, string>> = {
  STRONG_BUY: 'strongly bullish',
  BUY: 'bullish',
  HOLD: 'neutral',
  SELL: 'bearish',
  STRONG_SELL: 'strongly bearish',
};

const HORIZON_WORDS = {
  SWING: 'over the next few weeks',
  LONG_TERM: 'over the next several quarters',
} as const;

/**
 * A deterministic explanation.
 *
 * Leads with the conclusion, then the factors that actually decided it, then
 * what argues the other way, then the caveats. Opposing factors are included
 * deliberately: an explanation that only lists supporting evidence is
 * advocacy, and the user is better served by seeing the disagreement.
 */
export function summarise(signal: ScoredSignal): string {
  const direction = ACTION_WORDS[signal.action];
  const horizon = HORIZON_WORDS[signal.horizon];

  const supporting = signal.factors.filter((factor) =>
    signal.score >= 0 ? factor.contribution > 1 : factor.contribution < -1,
  );
  const opposing = signal.factors.filter((factor) =>
    signal.score >= 0 ? factor.contribution < -1 : factor.contribution > 1,
  );

  const parts: string[] = [];

  parts.push(
    `${signal.symbol} scores ${signal.score > 0 ? '+' : ''}${signal.score} ${horizon}, which reads as ${direction}.`,
  );

  if (supporting.length > 0) {
    const top = supporting.slice(0, 3);
    parts.push(
      `The case rests mainly on ${joinWords(top.map((factor) => factor.label.toLowerCase()))}. ` +
        top.map((factor) => factor.reason).join(' '),
    );
  }

  if (opposing.length > 0) {
    const top = opposing.slice(0, 2);
    parts.push(
      `Against it: ${top.map((factor) => factor.reason).join(' ')}`,
    );
  }

  const caveats: string[] = [];
  if (signal.missingFactors > 0) {
    caveats.push(
      `${signal.missingFactors} factor${signal.missingFactors === 1 ? '' : 's'} could not be assessed for want of data`,
    );
  }
  if (signal.agreement < 0.5) {
    caveats.push('the factors disagree sharply with each other');
  }
  if (signal.coverage < 0.6) {
    caveats.push(`only ${Math.round(signal.coverage * 100)}% of the model had data to work with`);
  }
  if (caveats.length > 0) {
    parts.push(`Treat this cautiously: ${joinWords(caveats)}.`);
  }

  return parts.join(' ');
}

function joinWords(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export interface NarrativePrompt {
  system: string;
  user: string;
}

/**
 * Builds the prompt for the LLM pass.
 *
 * The factor table goes in as data and the model is told, in the system
 * prompt, that it may not introduce a factor or contradict a score. That is a
 * guardrail rather than a guarantee, which is why `validateNarrative` checks
 * the result before it is stored.
 */
export function buildNarrativePrompt(signal: ScoredSignal): NarrativePrompt {
  const system = [
    'You explain stock-analysis output to a retail investor in Pakistan.',
    '',
    'You will be given a scored factor table for one stock. Write a short',
    'explanation of what it says, in 3 to 5 sentences of plain prose.',
    '',
    'Rules:',
    '- Use only the factors given. Do not introduce any other evidence,',
    '  news, or opinion, and do not speculate about causes.',
    '- Do not contradict the overall reading or any individual score.',
    '- Mention the factors that argue against the conclusion as well as those',
    '  that support it.',
    '- If factors could not be assessed, say so.',
    '- Do not tell the reader what to do. Describe what the analysis shows.',
    '  Never write "you should buy", "I recommend", or a price target.',
    '- No markdown, no headings, no bullet points. Plain prose only.',
  ].join('\n');

  const table = signal.factors
    .map(
      (factor) =>
        `${factor.label} [${factor.category}] | observed: ${factor.display} | score: ${factor.score} | weight: ${(factor.weight * 100).toFixed(1)}% | contribution: ${factor.contribution} | ${factor.reason}`,
    )
    .join('\n');

  const user = [
    `Symbol: ${signal.symbol}`,
    `Horizon: ${signal.horizon === 'SWING' ? 'swing trade, days to weeks' : 'long term, months to years'}`,
    `As of: ${signal.asOf}`,
    `Overall score: ${signal.score} out of -100 to +100`,
    `Reading: ${signal.action}`,
    `Factor agreement: ${(signal.agreement * 100).toFixed(0)}%`,
    `Model coverage: ${(signal.coverage * 100).toFixed(0)}% of factors had data`,
    `Factors not assessed: ${signal.missingFactors}`,
    '',
    'Factor table:',
    table,
  ].join('\n');

  return { system, user };
}

export interface NarrativeProblem {
  code: 'CONTRADICTS_ACTION' | 'GIVES_ADVICE' | 'TOO_LONG' | 'EMPTY' | 'INVENTS_PRICE_TARGET';
  detail: string;
}

/**
 * Checks a generated narrative before it is stored.
 *
 * The specific risks worth catching: prose that argues the opposite of the
 * score, prose that tells the user what to do, and invented price targets. The
 * first makes the product incoherent; the other two are the difference between
 * presenting analysis and dispensing investment advice, which has licensing
 * implications in Pakistan.
 */
export function validateNarrative(signal: ScoredSignal, narrative: string): NarrativeProblem[] {
  const problems: NarrativeProblem[] = [];
  const text = narrative.trim();

  if (text.length === 0) {
    return [{ code: 'EMPTY', detail: 'Narrative is empty' }];
  }

  if (text.length > 1500) {
    problems.push({ code: 'TOO_LONG', detail: `${text.length} characters; expected under 1500` });
  }

  const lower = text.toLowerCase();

  const advice = [
    'you should buy',
    'you should sell',
    'i recommend',
    'we recommend',
    'my advice',
    'you must buy',
    'you must sell',
    'guaranteed',
  ];
  for (const phrase of advice) {
    if (lower.includes(phrase)) {
      problems.push({ code: 'GIVES_ADVICE', detail: `Contains "${phrase}"` });
    }
  }

  // A target price cannot come from the factor table, so if one appears the
  // model invented it.
  if (/\b(price target|target price|will reach|will hit)\b/i.test(text)) {
    problems.push({
      code: 'INVENTS_PRICE_TARGET',
      detail: 'Mentions a price target, which the factor table does not contain',
    });
  }

  const bullish = signal.action === 'BUY' || signal.action === 'STRONG_BUY';
  const bearish = signal.action === 'SELL' || signal.action === 'STRONG_SELL';

  if (bullish && /\b(bearish|negative outlook|downtrend overall)\b/i.test(text)) {
    // Only flag when the contradiction is about the overall reading, not when
    // a bearish factor is being correctly reported as an opposing point.
    if (!/\b(although|however|against it|one factor|some factors|argues against)\b/i.test(text)) {
      problems.push({
        code: 'CONTRADICTS_ACTION',
        detail: `Signal is ${signal.action} but the narrative reads bearish`,
      });
    }
  }

  if (bearish && /\b(bullish|positive outlook|uptrend overall)\b/i.test(text)) {
    if (!/\b(although|however|against it|one factor|some factors|argues against)\b/i.test(text)) {
      problems.push({
        code: 'CONTRADICTS_ACTION',
        detail: `Signal is ${signal.action} but the narrative reads bullish`,
      });
    }
  }

  return problems;
}

/**
 * The explanation to show, preferring the LLM text when it passes validation.
 *
 * Falls back to the deterministic summary rather than showing nothing, so a
 * failed or unavailable generation degrades the prose quality and nothing else.
 */
export function chooseNarrative(
  signal: ScoredSignal,
  generated: string | null,
): { text: string; source: 'llm' | 'deterministic'; problems: NarrativeProblem[] } {
  if (generated === null) {
    return { text: summarise(signal), source: 'deterministic', problems: [] };
  }

  const problems = validateNarrative(signal, generated);
  if (problems.length > 0) {
    return { text: summarise(signal), source: 'deterministic', problems };
  }

  return { text: generated.trim(), source: 'llm', problems: [] };
}

/** Renders the factor table as plain text, for a "show the numbers" view. */
export function renderFactorTable(factors: readonly FactorScore[]): string {
  const rows = factors.map((factor) => ({
    name: factor.label,
    observed: factor.display,
    score: String(factor.score),
    weight: `${(factor.weight * 100).toFixed(1)}%`,
    contribution: factor.contribution.toFixed(1),
  }));

  const labels = {
    name: 'factor',
    observed: 'observed',
    score: 'score',
    weight: 'weight',
    contribution: 'contrib',
  } as const;

  // Each column is as wide as the longest of its header and its values. Taking
  // a hard-coded minimum instead leaves the header wider than the rows when a
  // label is longer than every value under it.
  const widths = {
    name: Math.max(labels.name.length, ...rows.map((row) => row.name.length)),
    observed: Math.max(labels.observed.length, ...rows.map((row) => row.observed.length)),
    score: Math.max(labels.score.length, ...rows.map((row) => row.score.length)),
    weight: Math.max(labels.weight.length, ...rows.map((row) => row.weight.length)),
    contribution: Math.max(
      labels.contribution.length,
      ...rows.map((row) => row.contribution.length),
    ),
  };

  const header =
    labels.name.padEnd(widths.name) +
    '  ' +
    labels.observed.padEnd(widths.observed) +
    '  ' +
    labels.score.padStart(widths.score) +
    '  ' +
    labels.weight.padStart(widths.weight) +
    '  ' +
    labels.contribution.padStart(widths.contribution);

  const body = rows.map(
    (row) =>
      row.name.padEnd(widths.name) +
      '  ' +
      row.observed.padEnd(widths.observed) +
      '  ' +
      row.score.padStart(widths.score) +
      '  ' +
      row.weight.padStart(widths.weight) +
      '  ' +
      row.contribution.padStart(widths.contribution),
  );

  return [header, '-'.repeat(header.length), ...body].join('\n');
}
