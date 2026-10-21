import {
  IndicatorError,
  assertPeriod,
  rollingStdev,
  sma,
  wilderSmooth,
  type IndicatorSeries,
  type Series,
} from './moving.js';

/**
 * Volatility: true range, ATR and Bollinger Bands.
 *
 * ATR earns its place twice over. As a factor it says whether a move is large
 * relative to how the stock normally moves, which is what distinguishes a
 * breakout from noise. As a tool it is the right unit for a stop: a stop placed
 * two ATR below entry adapts to the stock, where a flat 5% stop is far too
 * tight on a volatile small cap and far too loose on a utility.
 */

/** True range per bar: the greater of the bar's range and either gap. */
export function trueRange(highs: Series, lows: Series, closes: Series): IndicatorSeries {
  if (highs.length !== lows.length || lows.length !== closes.length) {
    throw new IndicatorError('highs, lows and closes must be the same length');
  }
  const out: Array<number | null> = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    const high = highs[i] ?? 0;
    const low = lows[i] ?? 0;
    if (i === 0) {
      // No previous close to gap from, so the bar's own range is all there is.
      out[i] = high - low;
      continue;
    }
    const previousClose = closes[i - 1] ?? 0;
    out[i] = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  }
  return out;
}

/** Average True Range, Wilder-smoothed. */
export function atr(highs: Series, lows: Series, closes: Series, period = 14): IndicatorSeries {
  assertPeriod(period);
  const ranges = trueRange(highs, lows, closes).map((value) => value ?? 0);
  // The first true range has no previous close behind it, so it is dropped
  // rather than being allowed to bias the seed.
  const smoothed = wilderSmooth(ranges.slice(1), period);
  const out: Array<number | null> = new Array(closes.length).fill(null);
  for (let i = 0; i < smoothed.length; i += 1) out[i + 1] = smoothed[i] ?? null;
  return out;
}

/** ATR as a percentage of price, which is comparable across stocks. */
export function atrPercent(
  highs: Series,
  lows: Series,
  closes: Series,
  period = 14,
): IndicatorSeries {
  const ranges = atr(highs, lows, closes, period);
  return ranges.map((value, i) => {
    const close = closes[i] ?? 0;
    if (value === null || value === undefined || close === 0) return null;
    return (value / close) * 100;
  });
}

export interface BollingerResult {
  upper: IndicatorSeries;
  middle: IndicatorSeries;
  lower: IndicatorSeries;
  /** (upper - lower) / middle, as a percentage. Low values mean a squeeze. */
  bandwidth: IndicatorSeries;
  /** Where price sits in the band: 0 at the lower, 1 at the upper. */
  percentB: IndicatorSeries;
}

export function bollinger(values: Series, period = 20, multiplier = 2): BollingerResult {
  assertPeriod(period);
  if (multiplier <= 0) throw new IndicatorError(`multiplier must be positive, got ${multiplier}`);

  const middle = sma(values, period);
  const deviation = rollingStdev(values, period);

  const upper: Array<number | null> = new Array(values.length).fill(null);
  const lower: Array<number | null> = new Array(values.length).fill(null);
  const bandwidth: Array<number | null> = new Array(values.length).fill(null);
  const percentB: Array<number | null> = new Array(values.length).fill(null);

  for (let i = 0; i < values.length; i += 1) {
    const mid = middle[i];
    const dev = deviation[i];
    if (mid === null || mid === undefined || dev === null || dev === undefined) continue;

    const up = mid + multiplier * dev;
    const down = mid - multiplier * dev;
    upper[i] = up;
    lower[i] = down;
    bandwidth[i] = mid === 0 ? null : ((up - down) / mid) * 100;

    const span = up - down;
    // A zero-width band means a dead flat stretch; the close is at the middle
    // by definition, so 0.5 is the honest reading rather than a divide by zero.
    percentB[i] = span === 0 ? 0.5 : ((values[i] ?? 0) - down) / span;
  }

  return { upper, middle, lower, bandwidth, percentB };
}

/**
 * Historical volatility: the standard deviation of daily returns, annualised.
 *
 * Used for position sizing rather than scoring. 252 trading days is the
 * conventional annualisation factor and close enough for the PSX, which trades
 * roughly 245 days a year once its holidays are counted.
 */
export function historicalVolatility(closes: Series, period = 20): IndicatorSeries {
  assertPeriod(period);
  const returns: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i += 1) {
    const previous = closes[i - 1] ?? 0;
    returns[i] = previous === 0 ? 0 : Math.log((closes[i] ?? 0) / previous);
  }
  const deviation = rollingStdev(returns.slice(1), period);
  const out: Array<number | null> = new Array(closes.length).fill(null);
  for (let i = 0; i < deviation.length; i += 1) {
    const value = deviation[i];
    out[i + 1] = value === null || value === undefined ? null : value * Math.sqrt(252) * 100;
  }
  return out;
}
