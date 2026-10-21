import { describe, expect, it } from 'vitest';
import { ALL_FACTORS, groupByCategory, scoreSignal, settleSignal } from '../src/scoring.js';
import { HORIZON_WEIGHTS } from '../src/weights.js';
import type { EngineContext, Fundamentals } from '../src/factors/types.js';
import { choppy, datesFor, downtrend, makeBars, uptrend } from './helpers.js';
import type { Bar } from '../src/patterns/candles.js';

function context(bars: Bar[], overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    symbol: 'TEST',
    bars,
    dates: datesFor(bars),
    horizon: 'SWING',
    ...overrides,
  };
}

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

function expectOk(result: ReturnType<typeof scoreSignal>) {
  if (!result.ok) throw new Error(`expected a signal, got refusal: ${result.reason}`);
  return result.signal;
}

describe('refusals', () => {
  /**
   * A system that always produces an answer teaches the user to ignore it. The
   * engine refuses when the data cannot support a view, and says why.
   */
  it('refuses a series too short for the indicators', () => {
    const result = scoreSignal(context(uptrend(20)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INSUFFICIENT_HISTORY');
    expect(result.reason).toContain('30');
  });

  it('refuses an empty series', () => {
    const result = scoreSignal(context([]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INSUFFICIENT_HISTORY');
  });

  /**
   * Several hundred PSX listings go days without trading. Indicators computed
   * across those gaps describe the gaps, not the stock.
   */
  it('refuses a stock that barely trades', () => {
    const bars = makeBars({ length: 60, driftPct: 0.2, volume: 0 });
    const result = scoreSignal(context(bars));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ILLIQUID');
    expect(result.reason).toContain('traded on only');
  });

  it('accepts a stock trading on most sessions', () => {
    const bars = uptrend(120).map((bar, i) => ({ ...bar, volume: i % 5 === 0 ? 0 : bar.volume }));
    expect(scoreSignal(context(bars)).ok).toBe(true);
  });
});

describe('direction', () => {
  it('scores a sustained uptrend bullish', () => {
    const signal = expectOk(scoreSignal(context(uptrend(260))));
    expect(signal.score).toBeGreaterThan(0);
    expect(['BUY', 'STRONG_BUY']).toContain(signal.action);
  });

  it('scores a sustained downtrend bearish', () => {
    const signal = expectOk(scoreSignal(context(downtrend(260))));
    expect(signal.score).toBeLessThan(0);
    expect(['SELL', 'STRONG_SELL']).toContain(signal.action);
  });

  /** A ranging stock should not read as a strong anything. */
  it('scores a sideways market near neutral', () => {
    const signal = expectOk(scoreSignal(context(choppy(260))));
    expect(Math.abs(signal.score)).toBeLessThan(50);
    expect(['STRONG_BUY', 'STRONG_SELL']).not.toContain(signal.action);
  });

  it('keeps the score inside its stated range', () => {
    for (const bars of [uptrend(260), downtrend(260), choppy(260)]) {
      const signal = expectOk(scoreSignal(context(bars)));
      expect(signal.score).toBeGreaterThanOrEqual(-100);
      expect(signal.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('arithmetic', () => {
  const signal = expectOk(scoreSignal(context(uptrend(260), { fundamentals: FUNDAMENTALS })));

  it('sums the contributions to the overall score', () => {
    const summed = signal.factors.reduce((total, factor) => total + factor.contribution, 0);
    expect(summed).toBeCloseTo(signal.score, 1);
  });

  /** Renormalisation: the reporting factors carry the whole decision. */
  it('normalises the reporting weights to one', () => {
    const summed = signal.factors.reduce((total, factor) => total + factor.weight, 0);
    expect(summed).toBeCloseTo(1, 3);
  });

  it('makes each contribution the product of its score and weight', () => {
    for (const factor of signal.factors) {
      expect(factor.contribution).toBeCloseTo(factor.score * factor.weight, 1);
    }
  });

  it('keeps every factor score inside the required range', () => {
    for (const factor of signal.factors) {
      expect(factor.score).toBeGreaterThanOrEqual(-100);
      expect(factor.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(factor.score)).toBe(true);
    }
  });

  it('orders factors by how much they decided', () => {
    const magnitudes = signal.factors.map((factor) => Math.abs(factor.contribution));
    const sorted = [...magnitudes].sort((a, b) => b - a);
    expect(magnitudes).toEqual(sorted);
  });
});

/**
 * The core promise of the design: every prediction can explain itself, because
 * the score and its explanation come from the same code and the same numbers.
 */
describe('explainability', () => {
  const signal = expectOk(scoreSignal(context(uptrend(260), { fundamentals: FUNDAMENTALS })));

  it('gives every factor a readable reason', () => {
    for (const factor of signal.factors) {
      expect(factor.reason.length).toBeGreaterThan(20);
      expect(factor.reason.trim()).toBe(factor.reason);
      // A sentence, not a label.
      expect(factor.reason).toMatch(/[.!?]$/);
    }
  });

  it('gives every factor a label and a short observed value', () => {
    for (const factor of signal.factors) {
      expect(factor.label.length).toBeGreaterThan(2);
      expect(factor.display.length).toBeGreaterThan(0);
      expect(factor.display.length).toBeLessThan(40);
      expect(factor.key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('quotes the observed number in the reason where there is one', () => {
    const rsi = signal.factors.find((factor) => factor.key === 'rsi_14');
    expect(rsi).toBeDefined();
    expect(rsi!.value).not.toBeNull();
    expect(rsi!.reason).toContain(rsi!.value!.toFixed(1));
  });

  it('points at the candles a pattern fired on', () => {
    const bars = [
      ...uptrend(250),
      // A decisive bearish engulfing to close the series.
      { open: 100, high: 101, low: 80, close: 82, volume: 500_000 },
    ];
    const withPattern = expectOk(scoreSignal(context(bars)));
    const pattern = withPattern.factors.find((factor) => factor.key === 'candlestick');
    if (pattern !== undefined) {
      expect(pattern.barIndices).toBeDefined();
      for (const index of pattern.barIndices!) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(bars.length);
      }
    }
  });

  it('groups the breakdown by category, biggest group first', () => {
    const groups = groupByCategory(signal);
    expect(groups.length).toBeGreaterThan(3);
    const magnitudes = groups.map((group) => Math.abs(group.contribution));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));

    const total = groups.reduce((sum, group) => sum + group.contribution, 0);
    expect(total).toBeCloseTo(signal.score, 1);
  });
});

/**
 * Missing data must not become a neutral vote. Seven silent fundamental
 * factors scoring zero would be more than half the long-term weight and would
 * drag every signal towards HOLD.
 */
describe('missing data', () => {
  it('still produces a signal without fundamentals, and says how many were missing', () => {
    const signal = expectOk(scoreSignal(context(uptrend(260), { horizon: 'LONG_TERM' })));
    expect(signal.missingFactors).toBeGreaterThan(0);
    expect(signal.coverage).toBeLessThan(1);
    expect(signal.factors.every((factor) => factor.category !== 'VALUATION')).toBe(true);
  });

  it('does not drag the score towards neutral when fundamentals are absent', () => {
    const without = expectOk(scoreSignal(context(uptrend(260), { horizon: 'LONG_TERM' })));
    // The technical picture is strongly bullish, and that must survive the
    // absence of earnings data rather than being diluted by it.
    expect(without.score).toBeGreaterThan(20);
  });

  it('reports higher coverage once fundamentals are supplied', () => {
    const without = expectOk(scoreSignal(context(uptrend(260), { horizon: 'LONG_TERM' })));
    const with_ = expectOk(
      scoreSignal(context(uptrend(260), { horizon: 'LONG_TERM', fundamentals: FUNDAMENTALS })),
    );
    expect(with_.coverage).toBeGreaterThan(without.coverage);
    expect(with_.missingFactors).toBeLessThan(without.missingFactors);
    expect(with_.factors.length).toBeGreaterThan(without.factors.length);
  });

  it('omits a ratio that cannot be computed from a loss-making company', () => {
    const signal = expectOk(
      scoreSignal(
        context(uptrend(260), {
          horizon: 'LONG_TERM',
          fundamentals: { ...FUNDAMENTALS, eps: -5 },
        }),
      ),
    );
    // A negative P/E is arithmetic, not analysis, so the factor withholds.
    expect(signal.factors.find((factor) => factor.key === 'pe_vs_sector')).toBeUndefined();
  });

  it('drops the relative-strength factor with no index series', () => {
    const signal = expectOk(scoreSignal(context(uptrend(260))));
    expect(signal.factors.find((factor) => factor.key === 'relative_strength')).toBeUndefined();
  });

  it('includes relative strength once an index is given', () => {
    const signal = expectOk(
      scoreSignal(context(uptrend(260), { marketBars: choppy(260) })),
    );
    const factor = signal.factors.find((f) => f.key === 'relative_strength');
    expect(factor).toBeDefined();
    // The stock trends up while the index goes nowhere, so it is outperforming.
    expect(factor!.score).toBeGreaterThan(0);
  });
});

/**
 * The two horizons must be genuinely different, not one number relabelled.
 */
describe('horizons', () => {
  it('weights the horizons differently', () => {
    const swingWeights = HORIZON_WEIGHTS.SWING;
    const longWeights = HORIZON_WEIGHTS.LONG_TERM;
    expect(swingWeights.macd!).toBeGreaterThan(longWeights.macd!);
    expect(longWeights.eps_growth!).toBeGreaterThan(swingWeights.eps_growth!);
    expect(longWeights.pe_vs_sector!).toBeGreaterThan(swingWeights.pe_vs_sector!);
  });

  it('reaches different conclusions from the same data', () => {
    // Strong chart, poor business: the horizons should disagree.
    const poorFundamentals: Fundamentals = {
      eps: 2,
      sectorPe: 8,
      epsGrowthPct: -25,
      revenueGrowthPct: -18,
      roePct: 2,
      debtToEquity: 2.4,
      bookValuePerShare: 10,
    };
    const bars = uptrend(260);
    const swing = expectOk(
      scoreSignal(context(bars, { horizon: 'SWING', fundamentals: poorFundamentals })),
    );
    const long = expectOk(
      scoreSignal(context(bars, { horizon: 'LONG_TERM', fundamentals: poorFundamentals })),
    );

    expect(swing.score).toBeGreaterThan(long.score);
  });

  it('gives the swing horizon more technical factors by weight', () => {
    const swing = expectOk(
      scoreSignal(context(uptrend(260), { horizon: 'SWING', fundamentals: FUNDAMENTALS })),
    );
    const long = expectOk(
      scoreSignal(context(uptrend(260), { horizon: 'LONG_TERM', fundamentals: FUNDAMENTALS })),
    );

    const technicalWeight = (signal: typeof swing) =>
      signal.factors
        .filter((factor) => !['VALUATION', 'GROWTH', 'QUALITY', 'LEVERAGE'].includes(factor.category))
        .reduce((sum, factor) => sum + factor.weight, 0);

    expect(technicalWeight(swing)).toBeGreaterThan(technicalWeight(long));
  });
});

describe('confidence', () => {
  it('is the product of coverage and agreement', () => {
    const signal = expectOk(scoreSignal(context(uptrend(260), { fundamentals: FUNDAMENTALS })));
    expect(signal.confidence).toBeCloseTo(signal.coverage * signal.agreement, 2);
  });

  it('stays within zero and one', () => {
    for (const bars of [uptrend(260), downtrend(260), choppy(260)]) {
      const signal = expectOk(scoreSignal(context(bars)));
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(signal.agreement).toBeGreaterThanOrEqual(0);
      expect(signal.agreement).toBeLessThanOrEqual(1);
    }
  });

  /**
   * Agreement is defined as one minus the weighted mean absolute deviation of
   * the factor scores from the aggregate. Checking the definition directly is
   * more meaningful than comparing two market shapes, because high agreement
   * has two distinct causes: factors all pointing the same way strongly, and
   * factors all reporting "nothing much". A ranging market is the second kind,
   * and reads as confidently neutral, which is the honest answer.
   */
  it('matches its definition against the returned factors', () => {
    for (const bars of [uptrend(260), downtrend(260), choppy(260)]) {
      const signal = expectOk(scoreSignal(context(bars)));
      const deviation = signal.factors.reduce(
        (sum, factor) => sum + factor.weight * Math.abs(factor.score - signal.score),
        0,
      );
      expect(signal.agreement).toBeCloseTo(Math.max(0, 1 - deviation / 100), 2);
    }
  });

  it('reads lower when the factors genuinely pull against each other', () => {
    // A long uptrend, then a violent reversal: the moving averages are still
    // stacked bullishly while momentum, volume and the candles turn bearish.
    const conflicted = [
      ...uptrend(250),
      { open: 300, high: 302, low: 240, close: 243, volume: 4_000_000 },
      { open: 243, high: 246, low: 210, close: 212, volume: 5_000_000 },
    ];
    const aligned = expectOk(scoreSignal(context(makeBars({ length: 260, driftPct: 0.08, noisePct: 0.2 }))));
    const split = expectOk(scoreSignal(context(conflicted)));

    expect(split.agreement).toBeLessThan(aligned.agreement);
  });
});

describe('metadata', () => {
  it('stamps the engine version, so an old signal stays auditable', () => {
    const signal = expectOk(scoreSignal(context(uptrend(260))));
    expect(signal.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('records the date and price it was computed from', () => {
    const bars = uptrend(260);
    const dates = datesFor(bars);
    const signal = expectOk(scoreSignal(context(bars)));
    expect(signal.asOf).toBe(dates[dates.length - 1]);
    expect(signal.priceAtSignal).toBe(bars[bars.length - 1]!.close);
  });

  it('leaves the narrative unset for the narrative layer to fill', () => {
    expect(expectOk(scoreSignal(context(uptrend(260)))).narrative).toBeNull();
  });

  it('is deterministic', () => {
    const bars = uptrend(260);
    const a = expectOk(scoreSignal(context(bars, { fundamentals: FUNDAMENTALS })));
    const b = expectOk(scoreSignal(context(bars, { fundamentals: FUNDAMENTALS })));
    expect(a).toEqual(b);
  });

  it('exposes every factor through ALL_FACTORS with unique keys', () => {
    const keys = ALL_FACTORS.map((factor) => factor.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const factor of ALL_FACTORS) {
      expect(factor.minBars).toBeGreaterThan(0);
    }
  });

  it('gives every weighted factor a definition', () => {
    const defined = new Set(ALL_FACTORS.map((factor) => factor.key));
    for (const horizon of ['SWING', 'LONG_TERM'] as const) {
      for (const key of Object.keys(HORIZON_WEIGHTS[horizon])) {
        expect(defined.has(key), `${key} is weighted but not defined`).toBe(true);
      }
    }
  });
});

/**
 * Settling predictions against outcomes is what turns the engine from an
 * opinion into something measurable, and it is the only honest source of a
 * hit rate.
 */
describe('settleSignal', () => {
  it('counts a rise as a hit for a buy', () => {
    expect(settleSignal({ action: 'BUY' }, 100, 110)).toBe('HIT');
    expect(settleSignal({ action: 'STRONG_BUY' }, 100, 104)).toBe('HIT');
  });

  it('counts a fall as a miss for a buy', () => {
    expect(settleSignal({ action: 'BUY' }, 100, 90)).toBe('MISS');
  });

  it('counts a fall as a hit for a sell', () => {
    expect(settleSignal({ action: 'SELL' }, 100, 90)).toBe('HIT');
    expect(settleSignal({ action: 'STRONG_SELL' }, 100, 110)).toBe('MISS');
  });

  /** Drifting sideways must not flatter a directional call. */
  it('counts a move below the threshold as neutral, whatever the call', () => {
    expect(settleSignal({ action: 'BUY' }, 100, 102)).toBe('NEUTRAL');
    expect(settleSignal({ action: 'SELL' }, 100, 98.5)).toBe('NEUTRAL');
    expect(settleSignal({ action: 'HOLD' }, 100, 101)).toBe('NEUTRAL');
  });

  it('counts a large move as a miss for a hold', () => {
    expect(settleSignal({ action: 'HOLD' }, 100, 130)).toBe('MISS');
    expect(settleSignal({ action: 'HOLD' }, 100, 70)).toBe('MISS');
  });

  it('respects a custom threshold', () => {
    expect(settleSignal({ action: 'BUY' }, 100, 105, 10)).toBe('NEUTRAL');
    expect(settleSignal({ action: 'BUY' }, 100, 115, 10)).toBe('HIT');
  });

  it('refuses to judge against a nonsense entry price', () => {
    expect(settleSignal({ action: 'BUY' }, 0, 100)).toBe('NEUTRAL');
  });
});
