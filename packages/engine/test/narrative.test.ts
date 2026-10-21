import { describe, expect, it } from 'vitest';
import {
  buildNarrativePrompt,
  chooseNarrative,
  renderFactorTable,
  summarise,
  validateNarrative,
} from '../src/narrative.js';
import { scoreSignal, type ScoredSignal } from '../src/scoring.js';
import type { EngineContext, Fundamentals } from '../src/factors/types.js';
import { datesFor, downtrend, uptrend } from './helpers.js';

const FUNDAMENTALS: Fundamentals = {
  eps: 25,
  sectorPe: 11,
  bookValuePerShare: 90,
  dividendPerShare: 8,
  epsGrowthPct: 22,
  revenueGrowthPct: 15,
  roePct: 21,
  debtToEquity: 0.35,
};

function signalFor(bars: ReturnType<typeof uptrend>, overrides: Partial<EngineContext> = {}): ScoredSignal {
  const result = scoreSignal({
    symbol: 'ENGRO',
    bars,
    dates: datesFor(bars),
    horizon: 'SWING',
    ...overrides,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.signal;
}

const bullish = signalFor(uptrend(260), { fundamentals: FUNDAMENTALS });
const bearish = signalFor(downtrend(260), { fundamentals: FUNDAMENTALS });

describe('summarise', () => {
  /**
   * The deterministic path matters more than the LLM one: it means an
   * explanation is never unavailable. An outage or an expired key would
   * otherwise leave a prediction with no reasoning attached, which is the one
   * thing this design exists to prevent.
   */
  it('opens with the conclusion and the score', () => {
    const text = summarise(bullish);
    expect(text).toContain('ENGRO');
    expect(text).toContain(String(bullish.score));
    expect(text.toLowerCase()).toContain('bullish');
  });

  it('names the factors that decided it', () => {
    const text = summarise(bullish);
    const top = bullish.factors[0];
    expect(top).toBeDefined();
    expect(text.toLowerCase()).toContain(top!.label.toLowerCase());
  });

  /**
   * Opposing factors are included deliberately. An explanation that lists only
   * supporting evidence is advocacy, and the user is better served seeing the
   * disagreement.
   */
  it('reports what argues against the conclusion', () => {
    const opposing = bullish.factors.filter((factor) => factor.contribution < -1);
    if (opposing.length > 0) {
      expect(summarise(bullish)).toContain('Against it');
    }
  });

  it('describes a bearish signal as bearish', () => {
    expect(summarise(bearish).toLowerCase()).toContain('bearish');
  });

  it('flags missing data as a caveat', () => {
    const thin = signalFor(uptrend(260), { horizon: 'LONG_TERM' });
    const text = summarise(thin);
    expect(thin.missingFactors).toBeGreaterThan(0);
    expect(text).toContain('Treat this cautiously');
    expect(text).toContain('could not be assessed');
  });

  it('mentions the horizon', () => {
    expect(summarise(bullish)).toContain('weeks');
    const long = signalFor(uptrend(260), { horizon: 'LONG_TERM', fundamentals: FUNDAMENTALS });
    expect(summarise(long)).toContain('quarters');
  });

  it('reads as prose, not a fragment', () => {
    const text = summarise(bullish);
    expect(text.length).toBeGreaterThan(120);
    expect(text).toMatch(/\.$/);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
  });

  it('never tells the reader what to do', () => {
    for (const signal of [bullish, bearish]) {
      const text = summarise(signal).toLowerCase();
      expect(text).not.toContain('you should');
      expect(text).not.toContain('i recommend');
      expect(validateNarrative(signal, summarise(signal))).toEqual([]);
    }
  });
});

describe('buildNarrativePrompt', () => {
  const prompt = buildNarrativePrompt(bullish);

  it('passes the whole factor table as data', () => {
    for (const factor of bullish.factors) {
      expect(prompt.user).toContain(factor.label);
      expect(prompt.user).toContain(factor.display);
    }
  });

  it('states the overall reading and the coverage', () => {
    expect(prompt.user).toContain(`Overall score: ${bullish.score}`);
    expect(prompt.user).toContain(bullish.action);
    expect(prompt.user).toContain('Model coverage');
    expect(prompt.user).toContain('Factors not assessed');
  });

  /** The guardrails are in the prompt as well as in the validator. */
  it('forbids inventing evidence and giving advice', () => {
    expect(prompt.system).toContain('Use only the factors given');
    expect(prompt.system).toContain('Do not contradict');
    expect(prompt.system).toContain('Do not tell the reader what to do');
    expect(prompt.system).toContain('argue against');
  });

  it('asks for plain prose', () => {
    expect(prompt.system).toContain('No markdown');
  });
});

describe('validateNarrative', () => {
  it('accepts a faithful explanation', () => {
    const text =
      'ENGRO reads bullish over the next few weeks. The moving averages are stacked ' +
      'upwards and momentum is positive. Against that, RSI is elevated, so a pause ' +
      'would not be surprising.';
    expect(validateNarrative(bullish, text)).toEqual([]);
  });

  it('rejects an empty narrative', () => {
    expect(validateNarrative(bullish, '   ')).toEqual([
      { code: 'EMPTY', detail: 'Narrative is empty' },
    ]);
  });

  /**
   * Advice and price targets are the difference between presenting analysis and
   * dispensing investment advice, which carries licensing implications in
   * Pakistan.
   */
  it('rejects advice', () => {
    const problems = validateNarrative(bullish, 'The trend is up so you should buy here.');
    expect(problems.map((problem) => problem.code)).toContain('GIVES_ADVICE');
  });

  it('rejects a recommendation in the first person', () => {
    const problems = validateNarrative(bullish, 'I recommend taking a position in this one.');
    expect(problems.map((problem) => problem.code)).toContain('GIVES_ADVICE');
  });

  it('rejects an invented price target', () => {
    const problems = validateNarrative(
      bullish,
      'Momentum is strong and the price target is 420 rupees.',
    );
    expect(problems.map((problem) => problem.code)).toContain('INVENTS_PRICE_TARGET');
  });

  it('rejects a narrative that contradicts the signal', () => {
    const problems = validateNarrative(bullish, 'Everything here is bearish and getting worse.');
    expect(problems.map((problem) => problem.code)).toContain('CONTRADICTS_ACTION');
  });

  /**
   * A bearish factor correctly reported as an opposing point is not a
   * contradiction, so hedged mentions must be allowed or the validator would
   * reject exactly the balanced explanations it is meant to encourage.
   */
  it('allows a bearish factor to be reported when it is hedged', () => {
    const text =
      'The overall reading is positive. However, one factor is bearish: RSI is overbought.';
    expect(validateNarrative(bullish, text)).toEqual([]);
  });

  it('rejects an over-long narrative', () => {
    const problems = validateNarrative(bullish, 'word '.repeat(400));
    expect(problems.map((problem) => problem.code)).toContain('TOO_LONG');
  });

  it('reports several problems at once', () => {
    const problems = validateNarrative(
      bullish,
      'You should buy now, the price target is 500 and it is guaranteed.',
    );
    expect(problems.length).toBeGreaterThan(1);
  });
});

describe('chooseNarrative', () => {
  it('uses the deterministic summary when nothing was generated', () => {
    const chosen = chooseNarrative(bullish, null);
    expect(chosen.source).toBe('deterministic');
    expect(chosen.text).toBe(summarise(bullish));
    expect(chosen.problems).toEqual([]);
  });

  it('uses a generated narrative that passes validation', () => {
    const text =
      'ENGRO reads bullish. The averages are aligned upwards and volume supports the move. ' +
      'However, RSI is elevated.';
    const chosen = chooseNarrative(bullish, text);
    expect(chosen.source).toBe('llm');
    expect(chosen.text).toBe(text);
  });

  /** A bad generation degrades the prose quality and nothing else. */
  it('falls back when the generated text breaks a rule, and says why', () => {
    const chosen = chooseNarrative(bullish, 'You should buy this immediately.');
    expect(chosen.source).toBe('deterministic');
    expect(chosen.text).toBe(summarise(bullish));
    expect(chosen.problems.map((problem) => problem.code)).toContain('GIVES_ADVICE');
  });

  it('trims a valid generation', () => {
    const chosen = chooseNarrative(bullish, '  The reading is positive overall.  ');
    expect(chosen.text).toBe('The reading is positive overall.');
  });
});

describe('renderFactorTable', () => {
  const table = renderFactorTable(bullish.factors);

  it('lists every factor with its numbers', () => {
    for (const factor of bullish.factors) {
      expect(table).toContain(factor.label);
    }
    expect(table).toContain('contrib');
  });

  it('aligns into fixed-width columns', () => {
    const lines = table.split('\n');
    const header = lines[0];
    const separator = lines[1];
    expect(header).toBeDefined();
    expect(separator).toBe('-'.repeat(header!.length));
    // Every row is the same width as the header, so it reads as a table.
    for (const line of lines.slice(2)) {
      expect(line.length).toBe(header!.length);
    }
  });

  it('has one row per factor plus the header and rule', () => {
    expect(table.split('\n')).toHaveLength(bullish.factors.length + 2);
  });
});
