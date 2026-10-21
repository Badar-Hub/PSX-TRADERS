import { IndicatorError, assertPeriod, sma, type IndicatorSeries, type Series } from './moving.js';

/**
 * Volume indicators.
 *
 * Volume is the factor group most worth having on the PSX, where a large part
 * of the board trades thinly. A 5% move on 400 shares is not the same event as
 * a 5% move on four million, and a price-only engine scores them identically.
 * It is also the check that keeps the system from acting on the near-untraded
 * stocks whose closing prices the exchange itself computes oddly.
 */

/** On-Balance Volume: cumulative volume signed by the day's direction. */
export function obv(closes: Series, volumes: Series): IndicatorSeries {
  if (closes.length !== volumes.length) {
    throw new IndicatorError('closes and volumes must be the same length');
  }
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length === 0) return out;

  let total = 0;
  out[0] = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const close = closes[i] ?? 0;
    const previous = closes[i - 1] ?? 0;
    const volume = volumes[i] ?? 0;
    // An unchanged close adds nothing: the day showed no directional conviction.
    if (close > previous) total += volume;
    else if (close < previous) total -= volume;
    out[i] = total;
  }
  return out;
}

/** Average volume over a window. */
export function averageVolume(volumes: Series, period = 20): IndicatorSeries {
  return sma(volumes, period);
}

/**
 * Today's volume as a multiple of its recent average.
 *
 * 1 means an ordinary day, 2 means twice the usual interest. Expressed as a
 * ratio rather than a raw count so it is comparable between a blue chip that
 * trades millions and a small cap that trades thousands.
 */
export function volumeRatio(volumes: Series, period = 20): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(volumes.length).fill(null);
  if (volumes.length <= period) return out;

  for (let i = period; i < volumes.length; i += 1) {
    let sum = 0;
    // The window excludes the current bar, so a huge day is measured against
    // normality rather than being allowed to raise its own benchmark.
    for (let j = i - period; j < i; j += 1) sum += volumes[j] ?? 0;
    const average = sum / period;
    out[i] = average === 0 ? null : (volumes[i] ?? 0) / average;
  }
  return out;
}

/**
 * Volume-weighted average price over a window.
 *
 * Where the average share actually changed hands, as opposed to where the
 * average day closed. Price above it means buyers have been paying up.
 */
export function vwap(closes: Series, volumes: Series, period = 20): IndicatorSeries {
  assertPeriod(period);
  if (closes.length !== volumes.length) {
    throw new IndicatorError('closes and volumes must be the same length');
  }
  const out: Array<number | null> = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i += 1) {
    let valueSum = 0;
    let volumeSum = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const volume = volumes[j] ?? 0;
      valueSum += (closes[j] ?? 0) * volume;
      volumeSum += volume;
    }
    // A window with no trading has no VWAP; reporting the close instead would
    // invent a level nobody traded at.
    out[i] = volumeSum === 0 ? null : valueSum / volumeSum;
  }
  return out;
}

/**
 * How many of the last `period` bars traded at all.
 *
 * A liquidity gate rather than a signal. Several hundred PSX listings go days
 * without a trade, and an indicator computed across those gaps describes the
 * gaps rather than the stock.
 */
export function tradedDayRatio(volumes: Series, period = 20): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(volumes.length).fill(null);
  for (let i = period - 1; i < volumes.length; i += 1) {
    let traded = 0;
    for (let j = i - period + 1; j <= i; j += 1) if ((volumes[j] ?? 0) > 0) traded += 1;
    out[i] = traded / period;
  }
  return out;
}
