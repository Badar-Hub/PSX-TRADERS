import { describe, expect, it } from 'vitest';
import { barMetrics, detectAtBar, detectPatterns, priorTrend } from '../src/patterns/candles.js';
import { candle, decliningRun, risingRun } from './helpers.js';

const keysAt = (bars: Parameters<typeof detectAtBar>[0], index: number) =>
  detectAtBar(bars, index).map((match) => match.key);

describe('barMetrics', () => {
  it('measures body and shadows', () => {
    const m = barMetrics(candle(100, 112, 96, 108));
    expect(m.body).toBe(8);
    expect(m.absBody).toBe(8);
    expect(m.range).toBe(16);
    expect(m.upperShadow).toBe(4);
    expect(m.lowerShadow).toBe(4);
    expect(m.isBullish).toBe(true);
    expect(m.isBearish).toBe(false);
  });

  it('reads a bearish bar the other way round', () => {
    const m = barMetrics(candle(108, 112, 96, 100));
    expect(m.isBearish).toBe(true);
    expect(m.upperShadow).toBe(4);
    expect(m.lowerShadow).toBe(4);
  });
});

describe('priorTrend', () => {
  it('measures the run into a bar', () => {
    const bars = decliningRun(7);
    const trend = priorTrend(bars, 6);
    expect(trend).not.toBeNull();
    expect(trend!).toBeLessThan(0);
  });

  it('has no opinion without enough history', () => {
    expect(priorTrend(decliningRun(3), 2)).toBeNull();
  });
});

/**
 * The context requirement is what separates this from shape matching. Each
 * reversal pattern is tested twice: once with the trend it is supposed to
 * reverse, and once without, where it must stay silent.
 */
describe('bullish engulfing', () => {
  const setup = [...decliningRun(6, 120, 2), candle(107, 113, 106, 112)];

  it('fires after a decline', () => {
    const matches = detectAtBar(setup, 6);
    const engulfing = matches.find((match) => match.key === 'bullish_engulfing');
    expect(engulfing).toBeDefined();
    expect(engulfing!.direction).toBe('BULLISH');
    expect(engulfing!.strength).toBe(100);
    expect(engulfing!.barIndices).toEqual([5, 6]);
  });

  it('stays silent after an advance, where the same shape means nothing', () => {
    const noContext = [...risingRun(6, 80, 2), candle(107, 113, 106, 112)];
    expect(keysAt(noContext, 6)).not.toContain('bullish_engulfing');
  });

  it('explains itself with the actual numbers', () => {
    const match = detectAtBar(setup, 6).find((m) => m.key === 'bullish_engulfing');
    expect(match!.description).toContain('2.5x');
    expect(match!.description).toContain('%');
  });

  it('grades a marginal engulfing as weaker than a decisive one', () => {
    const marginal = [...decliningRun(6, 120, 2), candle(107.9, 110.5, 107.5, 110.1)];
    const strong = detectAtBar(setup, 6).find((m) => m.key === 'bullish_engulfing');
    const weak = detectAtBar(marginal, 6).find((m) => m.key === 'bullish_engulfing');
    expect(weak).toBeDefined();
    expect(weak!.strength).toBeLessThan(strong!.strength);
  });
});

describe('bearish engulfing', () => {
  it('fires after an advance', () => {
    const bars = [...risingRun(6, 80, 2), candle(93, 94, 85, 86)];
    const match = detectAtBar(bars, 6).find((m) => m.key === 'bearish_engulfing');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BEARISH');
  });

  it('stays silent after a decline', () => {
    const bars = [...decliningRun(6, 120, 2), candle(93, 94, 85, 86)];
    expect(keysAt(bars, 6)).not.toContain('bearish_engulfing');
  });
});

describe('hammer', () => {
  it('fires after a decline, with a long lower shadow', () => {
    const bars = [...decliningRun(6, 120, 2), candle(108, 109.2, 104, 109)];
    const match = detectAtBar(bars, 6).find((m) => m.key === 'hammer');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BULLISH');
    expect(match!.strength).toBe(100);
    expect(match!.barIndices).toEqual([6]);
  });

  /**
   * The identical candle partway up a rally is just a day with a long lower
   * wick. Reporting it as bullish is how a pattern engine ends up firing
   * constantly and meaning nothing.
   */
  it('is not a hammer in an uptrend', () => {
    const bars = [...risingRun(6, 80, 2), candle(92, 93.2, 88, 93)];
    expect(keysAt(bars, 6)).not.toContain('hammer');
  });

  it('needs the lower shadow to dominate the body', () => {
    const bars = [...decliningRun(6, 120, 2), candle(108, 109.2, 107.5, 109)];
    expect(keysAt(bars, 6)).not.toContain('hammer');
  });
});

describe('shooting star', () => {
  it('fires after an advance, with a long upper shadow', () => {
    const bars = [...risingRun(6, 80, 2), candle(92, 96, 90.8, 91)];
    const match = detectAtBar(bars, 6).find((m) => m.key === 'shooting_star');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BEARISH');
  });

  it('is not a shooting star in a downtrend', () => {
    const bars = [...decliningRun(6, 120, 2), candle(108, 112, 106.8, 107)];
    expect(keysAt(bars, 6)).not.toContain('shooting_star');
  });
});

describe('doji', () => {
  it('reports indecision without a direction', () => {
    const bars = [...decliningRun(6, 120, 2), candle(108, 112, 104, 108.05)];
    const match = detectAtBar(bars, 6).find((m) => m.key === 'doji');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('NEUTRAL');
  });

  /** A tiny bar among tiny bars says nothing; it needs a real range to matter. */
  it('ignores a small bar in an already quiet market', () => {
    const quiet = Array.from({ length: 10 }, () => candle(100, 100.05, 99.95, 100.01));
    expect(keysAt(quiet, 9)).not.toContain('doji');
  });
});

describe('morning star', () => {
  const bars = [
    ...decliningRun(6, 120, 2),
    candle(108, 108.5, 101.5, 102),
    candle(101, 102, 100.5, 101.5),
    candle(102, 107.5, 101.8, 107),
  ];

  it('fires on the three-bar reversal after a decline', () => {
    const match = detectAtBar(bars, 8).find((m) => m.key === 'morning_star');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BULLISH');
    expect(match!.barIndices).toEqual([6, 7, 8]);
  });

  it('needs the middle bar to be small', () => {
    const noHesitation = [
      ...decliningRun(6, 120, 2),
      candle(108, 108.5, 101.5, 102),
      candle(101, 108, 100, 107),
      candle(107, 112, 106, 111),
    ];
    expect(keysAt(noHesitation, 8)).not.toContain('morning_star');
  });

  it('needs the recovery to clear the midpoint of the decline', () => {
    const shortRecovery = [
      ...decliningRun(6, 120, 2),
      candle(108, 108.5, 101.5, 102),
      candle(101, 102, 100.5, 101.5),
      candle(102, 104, 101.8, 103.5),
    ];
    expect(keysAt(shortRecovery, 8)).not.toContain('morning_star');
  });
});

describe('evening star', () => {
  it('fires on the three-bar reversal after an advance', () => {
    const bars = [
      ...risingRun(6, 80, 2),
      candle(92, 98.5, 91.5, 98),
      candle(99, 99.5, 98, 98.5),
      candle(98, 98.2, 92.5, 93),
    ];
    const match = detectAtBar(bars, 8).find((m) => m.key === 'evening_star');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BEARISH');
  });
});

describe('three white soldiers and black crows', () => {
  it('reports three solid higher closes', () => {
    const bars = risingRun(10, 80, 2);
    const match = detectAtBar(bars, 9).find((m) => m.key === 'three_white_soldiers');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BULLISH');
    expect(match!.barIndices).toEqual([7, 8, 9]);
  });

  it('reports three solid lower closes', () => {
    const bars = decliningRun(10, 120, 2);
    const match = detectAtBar(bars, 9).find((m) => m.key === 'three_black_crows');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BEARISH');
  });

  it('ignores three doji in a row', () => {
    const bars = Array.from({ length: 10 }, (_, i) =>
      candle(100 + i, 100.5 + i, 99.5 + i, 100.02 + i),
    );
    expect(keysAt(bars, 9)).not.toContain('three_white_soldiers');
  });
});

describe('marubozu', () => {
  it('reports a body filling the whole range', () => {
    const bars = [...risingRun(10, 80, 2), candle(100, 110, 100, 110)];
    const match = detectAtBar(bars, 10).find((m) => m.key === 'bullish_marubozu');
    expect(match).toBeDefined();
    expect(match!.strength).toBe(100);
  });

  it('reports the bearish version', () => {
    const bars = [...decliningRun(10, 120, 2), candle(110, 110, 100, 100)];
    expect(keysAt(bars, 10)).toContain('bearish_marubozu');
  });

  it('ignores a small full-bodied bar', () => {
    const bars = [...risingRun(10, 80, 2), candle(100, 100.5, 100, 100.5)];
    expect(keysAt(bars, 10)).not.toContain('bullish_marubozu');
  });
});

describe('piercing line and dark cloud cover', () => {
  it('reports a half-recovery through the previous midpoint', () => {
    const bars = [...decliningRun(6, 120, 2), candle(107, 110, 106.5, 109.5)];
    const match = detectAtBar(bars, 6).find((m) => m.key === 'piercing_line');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BULLISH');
    expect(match!.description).toContain('%');
  });

  it('reports the bearish mirror', () => {
    const bars = [...risingRun(6, 80, 2), candle(93, 93.5, 90, 90.5)];
    const match = detectAtBar(bars, 6).find((m) => m.key === 'dark_cloud_cover');
    expect(match).toBeDefined();
    expect(match!.direction).toBe('BEARISH');
  });
});

describe('detectPatterns', () => {
  const bars = [...decliningRun(10, 140, 2), candle(119, 125, 118, 124)];

  it('finds patterns near the end of the series', () => {
    const matches = detectPatterns(bars, { lookback: 3 });
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const lastBar = Math.max(...match.barIndices);
      expect(lastBar).toBeGreaterThanOrEqual(bars.length - 3);
    }
  });

  it('ignores a pattern outside the lookback window', () => {
    const padded = [...bars, ...risingRun(20, 124, 0.1)];
    const matches = detectPatterns(padded, { lookback: 2 });
    for (const match of matches) {
      expect(Math.max(...match.barIndices)).toBeGreaterThanOrEqual(padded.length - 2);
    }
  });

  it('filters out weak matches when asked', () => {
    const all = detectPatterns(bars, { lookback: 5, minStrength: 1 });
    const strong = detectPatterns(bars, { lookback: 5, minStrength: 90 });
    expect(strong.length).toBeLessThanOrEqual(all.length);
    for (const match of strong) expect(match.strength).toBeGreaterThanOrEqual(90);
  });

  it('returns nothing on a series too short to have context', () => {
    expect(detectPatterns(decliningRun(2))).toEqual([]);
  });

  it('carries bar indices in chronological order', () => {
    for (const match of detectPatterns(bars, { lookback: 5 })) {
      const sorted = [...match.barIndices].sort((a, b) => a - b);
      expect(match.barIndices).toEqual(sorted);
    }
  });

  it('is deterministic', () => {
    expect(detectPatterns(bars, { lookback: 5 })).toEqual(detectPatterns(bars, { lookback: 5 }));
  });
});
