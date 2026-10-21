import type { SignalHorizon } from '@psx/shared';

/**
 * Factor weights per horizon.
 *
 * This table is the difference between the two predictions. A swing call over
 * days to weeks is decided by price behaviour: trend, momentum, participation
 * and the patterns at the current edge. A long-term call over months to years
 * is decided by the business: what it earns, what it costs, how it is financed.
 * Running the same weights for both would produce one number wearing two
 * labels, which is the most common way a two-horizon product is fake.
 *
 * The weights deliberately do not sum to 1. They are renormalised over whichever
 * factors actually reported, so a stock with no published fundamentals produces
 * a signal weighted purely across the technical factors rather than one dragged
 * towards neutral by seven silent zeros. The cost of that choice is that such a
 * signal is thinner than it looks, which is why coverage is folded into the
 * confidence figure and the count of missing factors is reported alongside.
 *
 * These are starting values based on what each factor measures, not fitted to
 * historical returns. Fitting them is what the prediction-outcome tracking is
 * for: once a few hundred signals have been settled, the hit rate per factor
 * is evidence and these numbers can be revised against it. Until then they are
 * a considered prior and should be described as one.
 */
export type FactorWeights = Readonly<Record<string, number>>;

const SWING: FactorWeights = {
  // Trend: direction and whether there is one at all.
  ema_alignment: 0.12,
  price_vs_ema200: 0.05,
  adx_strength: 0.1,

  // Momentum: the largest block, since this is what moves over weeks.
  rsi_14: 0.1,
  macd: 0.12,
  roc_20: 0.08,

  // Volatility: position in range, plus a drag for a wild tape.
  bollinger_position: 0.07,
  atr_percent: 0.04,

  // Volume: whether anyone was behind the move.
  volume_ratio: 0.09,
  obv_trend: 0.07,

  // The patterns at the current edge.
  candlestick: 0.1,

  relative_strength: 0.06,

  // Fundamentals still matter a little: a cheap, growing company is a better
  // swing long than an expensive shrinking one with the same chart.
  pe_vs_sector: 0.03,
  eps_growth: 0.03,
  debt_to_equity: 0.02,
};

const LONG_TERM: FactorWeights = {
  // Technicals are kept, at lower weight, mostly to avoid buying into a
  // collapsing chart on the strength of last year's accounts.
  ema_alignment: 0.08,
  price_vs_ema200: 0.06,
  adx_strength: 0.03,
  rsi_14: 0.03,
  macd: 0.03,
  roc_20: 0.02,
  bollinger_position: 0.01,
  atr_percent: 0.02,
  volume_ratio: 0.02,
  obv_trend: 0.04,
  candlestick: 0.01,
  relative_strength: 0.05,

  // The business.
  pe_vs_sector: 0.15,
  price_to_book: 0.07,
  dividend_yield: 0.07,
  eps_growth: 0.15,
  revenue_growth: 0.08,
  roe: 0.1,
  debt_to_equity: 0.08,
};

export const HORIZON_WEIGHTS: Readonly<Record<SignalHorizon, FactorWeights>> = {
  SWING,
  LONG_TERM,
};

export function weightFor(horizon: SignalHorizon, factorKey: string): number {
  return HORIZON_WEIGHTS[horizon][factorKey] ?? 0;
}

/**
 * Version stamp for the scoring model.
 *
 * Stored on every signal so a prediction made under one set of weights can
 * still be audited after they change. Without it, retuning the weights would
 * quietly invalidate the historical hit rate the retuning was based on.
 */
export const ENGINE_VERSION = '0.1.0';
