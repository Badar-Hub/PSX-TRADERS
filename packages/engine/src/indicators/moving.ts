/**
 * Moving averages and the smoothing they share.
 *
 * Every indicator here returns an array the same length as its input, with
 * `null` for the warm-up bars where there is not yet enough data. That costs a
 * null check at each use and buys index alignment with the candle series: bar
 * `i` of a result always describes bar `i` of the price history, so a factor
 * can point at the exact candles it fired on and the chart can highlight them.
 *
 * The alternative — returning a shorter array that starts at the first valid
 * value — forces every caller to carry an offset, and an off-by-one there
 * silently attributes an indicator reading to the wrong day.
 */

export type Series = ReadonlyArray<number>;
export type IndicatorSeries = ReadonlyArray<number | null>;

export class IndicatorError extends Error {}

export function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new IndicatorError(`${name} must be a positive whole number, got ${period}`);
  }
}

/** Simple moving average. */
export function sma(values: Series, period: number): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values.
 *
 * Seeding matters: starting from the first price instead makes the early values
 * depend heavily on one bar, and two systems that seed differently disagree for
 * a long stretch afterwards. The SMA seed is the convention charting packages
 * use, so a value here matches what the user sees on TradingView.
 */
export function ema(values: Series, period: number): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] ?? 0;
  let previous = seed / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    const value = values[i] ?? 0;
    previous = value * k + previous * (1 - k);
    out[i] = previous;
  }
  return out;
}

/**
 * Wilder's smoothing, used by RSI, ATR and friends.
 *
 * It is an EMA with k = 1/period rather than 2/(period+1), which is why an RSI
 * computed with a standard EMA does not match the published values.
 */
export function wilderSmooth(values: Series, period: number): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] ?? 0;
  let previous = seed / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = (previous * (period - 1) + (values[i] ?? 0)) / period;
    out[i] = previous;
  }
  return out;
}

/** Sample standard deviation over a rolling window. */
export function rollingStdev(values: Series, period: number): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;

  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j] ?? 0;
    const mean = sum / period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = (values[j] ?? 0) - mean;
      variance += diff * diff;
    }
    // Population denominator, which is what Bollinger Bands are defined with.
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

/** The last non-null value of an indicator series, or null if there is none. */
export function latest(series: IndicatorSeries): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** The value `back` bars before the end, or null. */
export function valueAt(series: IndicatorSeries, index: number): number | null {
  if (index < 0 || index >= series.length) return null;
  return series[index] ?? null;
}

/** Highest value in the last `period` bars, inclusive of the final bar. */
export function highest(values: Series, period: number): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    let best = -Infinity;
    for (let j = i - period + 1; j <= i; j += 1) best = Math.max(best, values[j] ?? -Infinity);
    out[i] = best;
  }
  return out;
}

export function lowest(values: Series, period: number): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    let best = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) best = Math.min(best, values[j] ?? Infinity);
    out[i] = best;
  }
  return out;
}
