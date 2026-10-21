import {
  IndicatorError,
  assertPeriod,
  ema,
  wilderSmooth,
  type IndicatorSeries,
  type Series,
} from './moving.js';

/**
 * Momentum indicators: RSI, MACD, rate of change and stochastic.
 *
 * All of them are bounded or mean-reverting measures of how fast price has
 * moved, as opposed to the trend indicators that measure direction. The factor
 * engine treats the two groups separately because they disagree usefully: a
 * strong uptrend with an overbought RSI is a different proposition from a
 * strong uptrend with a neutral one.
 */

/**
 * Relative Strength Index, Wilder's original formulation.
 *
 * Uses Wilder smoothing rather than a plain EMA. The difference is not
 * cosmetic: a 14-period RSI built on a standard EMA runs several points away
 * from the published value, so it would disagree with whatever chart the user
 * is looking at, and a 70 threshold would fire on a different day.
 */
export function rsi(values: Series, period = 14): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  const gains: number[] = new Array(values.length).fill(0);
  const losses: number[] = new Array(values.length).fill(0);

  for (let i = 1; i < values.length; i += 1) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  // The first change is at index 1, so the smoothing starts from there.
  const avgGain = wilderSmooth(gains.slice(1), period);
  const avgLoss = wilderSmooth(losses.slice(1), period);

  for (let i = 0; i < avgGain.length; i += 1) {
    const gain = avgGain[i];
    const loss = avgLoss[i];
    if (gain === null || gain === undefined || loss === null || loss === undefined) continue;

    // An unbroken run of gains gives a zero average loss. RSI is defined as 100
    // there rather than dividing by zero.
    out[i + 1] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  return out;
}

export interface MacdResult {
  macd: IndicatorSeries;
  signal: IndicatorSeries;
  /** macd - signal. Its sign change is the cross. */
  histogram: IndicatorSeries;
}

/** Moving Average Convergence Divergence. */
export function macd(values: Series, fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  assertPeriod(fast, 'fast');
  assertPeriod(slow, 'slow');
  assertPeriod(signalPeriod, 'signalPeriod');
  if (fast >= slow) throw new IndicatorError(`fast (${fast}) must be shorter than slow (${slow})`);

  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);

  const macdLine: Array<number | null> = values.map((_, i) => {
    const f = fastEma[i];
    const s = slowEma[i];
    if (f === null || f === undefined || s === null || s === undefined) return null;
    return f - s;
  });

  // The signal line is an EMA of the MACD line, which only exists once the slow
  // EMA does. Feeding the nulls through would shift it, so it is computed on the
  // defined stretch and written back at the right offset.
  const firstDefined = macdLine.findIndex((value) => value !== null);
  const signalLine: Array<number | null> = new Array(values.length).fill(null);

  if (firstDefined !== -1) {
    const defined = macdLine.slice(firstDefined).map((value) => value ?? 0);
    const signalOnDefined = ema(defined, signalPeriod);
    for (let i = 0; i < signalOnDefined.length; i += 1) {
      signalLine[firstDefined + i] = signalOnDefined[i] ?? null;
    }
  }

  const histogram: Array<number | null> = values.map((_, i) => {
    const m = macdLine[i];
    const s = signalLine[i];
    if (m === null || m === undefined || s === null || s === undefined) return null;
    return m - s;
  });

  return { macd: macdLine, signal: signalLine, histogram };
}

/** Rate of change over `period` bars, as a percentage. */
export function roc(values: Series, period: number): IndicatorSeries {
  assertPeriod(period);
  const out: Array<number | null> = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    const previous = values[i - period] ?? 0;
    if (previous === 0) continue;
    out[i] = (((values[i] ?? 0) - previous) / previous) * 100;
  }
  return out;
}

export interface StochasticResult {
  k: IndicatorSeries;
  d: IndicatorSeries;
}

/**
 * Stochastic oscillator: where the close sits within the recent range.
 *
 * Distinct from RSI in a way that matters for swing trading. RSI measures the
 * size of recent moves; this measures position within the range, so a stock
 * drifting sideways near its highs reads differently on the two.
 */
export function stochastic(
  highs: Series,
  lows: Series,
  closes: Series,
  period = 14,
  smoothD = 3,
): StochasticResult {
  assertPeriod(period);
  assertPeriod(smoothD, 'smoothD');
  if (highs.length !== lows.length || lows.length !== closes.length) {
    throw new IndicatorError('highs, lows and closes must be the same length');
  }

  const k: Array<number | null> = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i += 1) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      high = Math.max(high, highs[j] ?? -Infinity);
      low = Math.min(low, lows[j] ?? Infinity);
    }
    const range = high - low;
    // A flat range means no information rather than a division by zero; 50 is
    // the neutral reading.
    k[i] = range === 0 ? 50 : (((closes[i] ?? 0) - low) / range) * 100;
  }

  const firstDefined = k.findIndex((value) => value !== null);
  const d: Array<number | null> = new Array(closes.length).fill(null);
  if (firstDefined !== -1) {
    const defined = k.slice(firstDefined).map((value) => value ?? 0);
    let sum = 0;
    for (let i = 0; i < defined.length; i += 1) {
      sum += defined[i] ?? 0;
      if (i >= smoothD) sum -= defined[i - smoothD] ?? 0;
      if (i >= smoothD - 1) d[firstDefined + i] = sum / smoothD;
    }
  }

  return { k, d };
}

/**
 * Average Directional Index, a measure of trend strength regardless of
 * direction.
 *
 * Included because it is what separates "the moving averages are stacked
 * bullishly and price is actually trending" from "the moving averages are
 * stacked bullishly and price is going nowhere". A trend factor without it
 * scores a drifting stock the same as a trending one.
 */
export function adx(highs: Series, lows: Series, closes: Series, period = 14): IndicatorSeries {
  assertPeriod(period);
  if (highs.length !== lows.length || lows.length !== closes.length) {
    throw new IndicatorError('highs, lows and closes must be the same length');
  }

  const length = closes.length;
  const out: Array<number | null> = new Array(length).fill(null);
  if (length < period * 2) return out;

  const trueRanges: number[] = new Array(length).fill(0);
  const plusDm: number[] = new Array(length).fill(0);
  const minusDm: number[] = new Array(length).fill(0);

  for (let i = 1; i < length; i += 1) {
    const high = highs[i] ?? 0;
    const low = lows[i] ?? 0;
    const previousHigh = highs[i - 1] ?? 0;
    const previousLow = lows[i - 1] ?? 0;
    const previousClose = closes[i - 1] ?? 0;

    trueRanges[i] = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose),
    );

    const upMove = high - previousHigh;
    const downMove = previousLow - low;
    // Only the larger of the two counts, and only when positive: an inside bar
    // contributes no directional movement at all.
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const smoothedTr = wilderSmooth(trueRanges.slice(1), period);
  const smoothedPlus = wilderSmooth(plusDm.slice(1), period);
  const smoothedMinus = wilderSmooth(minusDm.slice(1), period);

  const dx: Array<number | null> = new Array(length).fill(null);
  for (let i = 0; i < smoothedTr.length; i += 1) {
    const tr = smoothedTr[i];
    const plus = smoothedPlus[i];
    const minus = smoothedMinus[i];
    if (
      tr === null ||
      tr === undefined ||
      tr === 0 ||
      plus === null ||
      plus === undefined ||
      minus === null ||
      minus === undefined
    ) {
      continue;
    }
    const plusDi = (plus / tr) * 100;
    const minusDi = (minus / tr) * 100;
    const sum = plusDi + minusDi;
    dx[i + 1] = sum === 0 ? 0 : (Math.abs(plusDi - minusDi) / sum) * 100;
  }

  const firstDx = dx.findIndex((value) => value !== null);
  if (firstDx === -1) return out;

  const definedDx = dx.slice(firstDx).map((value) => value ?? 0);
  const smoothedDx = wilderSmooth(definedDx, period);
  for (let i = 0; i < smoothedDx.length; i += 1) {
    out[firstDx + i] = smoothedDx[i] ?? null;
  }

  return out;
}
