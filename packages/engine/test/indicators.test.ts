import { describe, expect, it } from 'vitest';
import {
  IndicatorError,
  adx,
  atr,
  atrPercent,
  averageVolume,
  bollinger,
  ema,
  highest,
  historicalVolatility,
  latest,
  lowest,
  macd,
  obv,
  roc,
  rollingStdev,
  rsi,
  sma,
  stochastic,
  tradedDayRatio,
  trueRange,
  volumeRatio,
  vwap,
  wilderSmooth,
} from '../src/indicators/index.js';
import { choppy, uptrend } from './helpers.js';

const rising = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const falling = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const flat = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5];

describe('alignment contract', () => {
  /**
   * Every indicator returns an array the same length as its input, nulls for
   * warm-up. The factor layer relies on index i describing bar i so it can
   * point the chart at the candles behind a score; an indicator that returned a
   * shorter array would shift every highlight.
   */
  it('returns one value per input bar, warm-up as null', () => {
    const values = rising;
    for (const series of [sma(values, 3), ema(values, 3), rsi(values, 3), wilderSmooth(values, 3)]) {
      expect(series).toHaveLength(values.length);
    }
    expect(sma(values, 3).slice(0, 2)).toEqual([null, null]);
    expect(sma(values, 3)[2]).toBe(2);
  });

  it('is all null when there is not enough data', () => {
    expect(sma([1, 2], 5).every((value) => value === null)).toBe(true);
    expect(ema([1, 2], 5).every((value) => value === null)).toBe(true);
  });

  it('rejects a nonsense period', () => {
    expect(() => sma(rising, 0)).toThrow(IndicatorError);
    expect(() => sma(rising, -1)).toThrow(IndicatorError);
    expect(() => sma(rising, 1.5)).toThrow(IndicatorError);
  });
});

describe('sma', () => {
  it('averages the window', () => {
    expect(sma([2, 4, 6, 8], 2)).toEqual([null, 3, 5, 7]);
  });

  it('equals the value itself for a flat series', () => {
    expect(latest(sma(flat, 5))).toBe(5);
  });
});

describe('ema', () => {
  /**
   * Seeded with the SMA of the first `period` values, which is what charting
   * packages do. Seeding from the first price instead makes early values depend
   * on one bar and leaves two implementations disagreeing for a long stretch.
   */
  it('seeds with the SMA of the first window', () => {
    const result = ema([1, 2, 3, 4, 5], 3);
    expect(result[2]).toBe(2);
  });

  it('weights recent values more than an SMA does', () => {
    const values = [10, 10, 10, 10, 20];
    const emaValue = latest(ema(values, 4));
    const smaValue = latest(sma(values, 4));
    expect(emaValue).not.toBeNull();
    expect(smaValue).not.toBeNull();
    expect(emaValue!).toBeGreaterThan(smaValue!);
  });

  it('converges to a constant series', () => {
    expect(latest(ema(flat, 3))).toBeCloseTo(5, 10);
  });
});

describe('wilderSmooth', () => {
  /**
   * Wilder uses k = 1/period, not 2/(period+1). An RSI built on a standard EMA
   * runs several points away from the published value, so thresholds fire on
   * different days than the user's chart shows.
   */
  it('smooths more slowly than the equivalent EMA', () => {
    const values = [10, 10, 10, 10, 10, 20];
    const wilder = latest(wilderSmooth(values, 5));
    const standard = latest(ema(values, 5));
    expect(wilder!).toBeLessThan(standard!);
  });
});

describe('rsi', () => {
  it('is 100 for an unbroken advance', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(latest(rsi(values, 14))).toBe(100);
  });

  it('is 0 for an unbroken decline', () => {
    const values = Array.from({ length: 30 }, (_, i) => 130 - i);
    expect(latest(rsi(values, 14))).toBe(0);
  });

  it('sits near 50 when gains and losses are balanced', () => {
    const values: number[] = [];
    for (let i = 0; i < 60; i += 1) values.push(100 + (i % 2 === 0 ? 0 : 1));
    const value = latest(rsi(values, 14));
    expect(value).toBeGreaterThan(40);
    expect(value).toBeLessThan(60);
  });

  it('stays within 0 and 100 on noisy data', () => {
    for (const value of rsi(uptrend(200).map((bar) => bar.close), 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('first reports at index equal to the period', () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = rsi(values, 14);
    expect(result[13]).toBeNull();
    expect(result[14]).not.toBeNull();
  });

  it('reads high in an uptrend and low in a downtrend', () => {
    const up = latest(rsi(uptrend(120).map((bar) => bar.close), 14));
    const down = latest(rsi(choppy(120).map((bar) => bar.close), 14));
    expect(up!).toBeGreaterThan(down!);
  });
});

describe('macd', () => {
  it('is zero for a flat series', () => {
    const values = new Array(60).fill(100);
    expect(latest(macd(values).macd)).toBeCloseTo(0, 8);
  });

  it('is positive in an advance and negative in a decline', () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i);
    const down = Array.from({ length: 80 }, (_, i) => 200 - i);
    expect(latest(macd(up).macd)!).toBeGreaterThan(0);
    expect(latest(macd(down).macd)!).toBeLessThan(0);
  });

  it('keeps the histogram equal to macd minus signal', () => {
    const values = uptrend(120).map((bar) => bar.close);
    const result = macd(values);
    for (let i = 0; i < values.length; i += 1) {
      const m = result.macd[i];
      const s = result.signal[i];
      const h = result.histogram[i];
      if (m === null || s === null || h === null) continue;
      expect(h).toBeCloseTo(m! - s!, 10);
    }
  });

  /**
   * The signal line is an EMA of the MACD line, which only exists once the slow
   * EMA does. Computing it over the null-padded array would shift it, so this
   * checks it starts later than the MACD line rather than alongside it.
   */
  it('starts the signal line after the macd line', () => {
    const values = uptrend(120).map((bar) => bar.close);
    const result = macd(values);
    const firstMacd = result.macd.findIndex((value) => value !== null);
    const firstSignal = result.signal.findIndex((value) => value !== null);
    expect(firstMacd).toBeGreaterThan(0);
    expect(firstSignal).toBeGreaterThan(firstMacd);
  });

  it('refuses a fast period at or above the slow one', () => {
    expect(() => macd(rising, 26, 12)).toThrow(IndicatorError);
    expect(() => macd(rising, 12, 12)).toThrow(IndicatorError);
  });
});

describe('roc', () => {
  it('reports the percentage change over the window', () => {
    expect(latest(roc([100, 0, 0, 0, 110], 4))).toBeCloseTo(10, 10);
  });

  it('is zero for a flat series', () => {
    expect(latest(roc(flat, 3))).toBe(0);
  });
});

describe('trueRange and atr', () => {
  it('takes the greater of the bar range and either gap', () => {
    // Gaps up from a close of 10 to a range of 12-14: the gap dominates.
    const ranges = trueRange([11, 14], [9, 12], [10, 13]);
    expect(ranges[0]).toBe(2);
    expect(ranges[1]).toBe(4);
  });

  it('averages to the constant range of a regular series', () => {
    const highs = new Array(40).fill(102);
    const lows = new Array(40).fill(98);
    const closes = new Array(40).fill(100);
    expect(latest(atr(highs, lows, closes, 14))).toBeCloseTo(4, 6);
  });

  it('expresses atr as a percentage of price', () => {
    const highs = new Array(40).fill(102);
    const lows = new Array(40).fill(98);
    const closes = new Array(40).fill(100);
    expect(latest(atrPercent(highs, lows, closes, 14))).toBeCloseTo(4, 6);
  });

  it('refuses mismatched input lengths', () => {
    expect(() => atr([1, 2], [1], [1, 2])).toThrow(IndicatorError);
  });
});

describe('bollinger', () => {
  const values = uptrend(120).map((bar) => bar.close);

  it('centres on the simple moving average', () => {
    const result = bollinger(values, 20, 2);
    const middle = result.middle;
    const reference = sma(values, 20);
    for (let i = 0; i < values.length; i += 1) {
      if (middle[i] === null) continue;
      expect(middle[i]).toBeCloseTo(reference[i]!, 10);
    }
  });

  it('spans four standard deviations at a multiplier of two', () => {
    const result = bollinger(values, 20, 2);
    const deviation = rollingStdev(values, 20);
    const i = values.length - 1;
    expect(result.upper[i]! - result.lower[i]!).toBeCloseTo(4 * deviation[i]!, 8);
  });

  it('puts percentB at 0.5 for a flat series', () => {
    const result = bollinger(new Array(40).fill(100), 20, 2);
    expect(latest(result.percentB)).toBe(0.5);
  });

  it('refuses a non-positive multiplier', () => {
    expect(() => bollinger(values, 20, 0)).toThrow(IndicatorError);
  });
});

describe('obv', () => {
  it('adds volume on up days and subtracts on down days', () => {
    const closes = [10, 11, 10, 10, 12];
    const volumes = [100, 200, 300, 400, 500];
    // 0, +200, -300, unchanged, +500
    expect(obv(closes, volumes)).toEqual([0, 200, -100, -100, 400]);
  });

  it('ignores unchanged closes, which showed no conviction', () => {
    expect(latest(obv([10, 10, 10], [100, 100, 100]))).toBe(0);
  });

  it('refuses mismatched lengths', () => {
    expect(() => obv([1, 2], [1])).toThrow(IndicatorError);
  });
});

describe('volumeRatio', () => {
  /**
   * The window excludes the current bar, so an exceptional day is measured
   * against normality rather than being allowed to raise its own benchmark.
   */
  it('compares today against the preceding window, not including today', () => {
    const volumes = [...new Array(20).fill(100), 300];
    expect(latest(volumeRatio(volumes, 20))).toBeCloseTo(3, 10);
  });

  it('is 1 for a steady series', () => {
    expect(latest(volumeRatio(new Array(30).fill(500), 20))).toBeCloseTo(1, 10);
  });

  it('reports null rather than dividing by zero on a dead stock', () => {
    expect(latest(volumeRatio(new Array(30).fill(0), 20))).toBeNull();
  });
});

describe('vwap', () => {
  it('weights price by volume', () => {
    // Two bars: 10 on 100 shares, 20 on 300 shares -> 17.5
    expect(latest(vwap([10, 20], [100, 300], 2))).toBeCloseTo(17.5, 10);
  });

  it('has no value for a window with no trading', () => {
    expect(latest(vwap([10, 20], [0, 0], 2))).toBeNull();
  });
});

describe('tradedDayRatio', () => {
  /** The liquidity gate: several hundred PSX listings go days without a trade. */
  it('measures how many recent sessions actually traded', () => {
    const volumes = [...new Array(10).fill(0), ...new Array(10).fill(1000)];
    expect(latest(tradedDayRatio(volumes, 20))).toBe(0.5);
  });

  it('is 1 for a liquid stock', () => {
    expect(latest(tradedDayRatio(new Array(30).fill(1000), 20))).toBe(1);
  });
});

describe('averageVolume', () => {
  it('is the simple average over the window', () => {
    expect(latest(averageVolume([100, 200, 300], 3))).toBe(200);
  });
});

describe('adx', () => {
  const bars = uptrend(200);

  it('stays within 0 and 100', () => {
    for (const value of adx(
      bars.map((bar) => bar.high),
      bars.map((bar) => bar.low),
      bars.map((bar) => bar.close),
      14,
    )) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  /**
   * The point of including ADX: it is what separates a stock genuinely trending
   * from one drifting under a bullish-looking moving-average stack.
   */
  it('reads higher in a trend than in a chop', () => {
    const trendBars = uptrend(200);
    const chopBars = choppy(200);
    const trending = latest(
      adx(trendBars.map((b) => b.high), trendBars.map((b) => b.low), trendBars.map((b) => b.close), 14),
    );
    const ranging = latest(
      adx(chopBars.map((b) => b.high), chopBars.map((b) => b.low), chopBars.map((b) => b.close), 14),
    );
    expect(trending!).toBeGreaterThan(ranging!);
  });
});

describe('stochastic', () => {
  it('is 100 when the close is at the top of the range', () => {
    const highs = new Array(20).fill(110);
    const lows = new Array(20).fill(90);
    const closes = new Array(20).fill(110);
    expect(latest(stochastic(highs, lows, closes, 14).k)).toBe(100);
  });

  it('is 0 at the bottom of the range', () => {
    const highs = new Array(20).fill(110);
    const lows = new Array(20).fill(90);
    const closes = new Array(20).fill(90);
    expect(latest(stochastic(highs, lows, closes, 14).k)).toBe(0);
  });

  it('is 50 for a flat range rather than dividing by zero', () => {
    const flatSeries = new Array(20).fill(100);
    expect(latest(stochastic(flatSeries, flatSeries, flatSeries, 14).k)).toBe(50);
  });
});

describe('highest and lowest', () => {
  it('report the window extremes', () => {
    expect(latest(highest([1, 5, 3], 3))).toBe(5);
    expect(latest(lowest([4, 2, 8], 3))).toBe(2);
  });
});

describe('historicalVolatility', () => {
  it('is zero for a flat series', () => {
    expect(latest(historicalVolatility(new Array(40).fill(100), 20))).toBeCloseTo(0, 8);
  });

  it('rises with noise', () => {
    const calm = uptrend(120).map((bar) => bar.close);
    const wild = uptrend(120).map((bar, i) => bar.close * (1 + (i % 2 === 0 ? 0.05 : -0.05)));
    expect(latest(historicalVolatility(wild, 20))!).toBeGreaterThan(
      latest(historicalVolatility(calm, 20))!,
    );
  });
});

describe('latest', () => {
  it('finds the last defined value', () => {
    expect(latest([1, 2, null])).toBe(2);
    expect(latest([null, null])).toBeNull();
    expect(latest([])).toBeNull();
  });
});

describe('rollingStdev', () => {
  it('is zero for a constant window', () => {
    expect(latest(rollingStdev(flat, 5))).toBe(0);
  });

  it('uses the population denominator, as Bollinger Bands are defined', () => {
    // Mean 2, deviations -1,0,1 -> sqrt(2/3)
    expect(latest(rollingStdev([1, 2, 3], 3))).toBeCloseTo(Math.sqrt(2 / 3), 10);
  });
});

describe('falling and rising fixtures', () => {
  it('behave as expected on the simple series', () => {
    expect(latest(sma(rising, 10))).toBe(5.5);
    expect(latest(sma(falling, 10))).toBe(5.5);
    expect(latest(roc(rising, 9))).toBeCloseTo(900, 6);
  });
});
