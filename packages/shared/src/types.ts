import type { Paisa } from './money.js';

export type TradeSide = 'BUY' | 'SELL';

/**
 * How a sale is matched against the lots it consumes.
 *
 * FIFO is the default and the only method that matches how CGT is assessed in
 * Pakistan, so AVERAGE exists for reporting comparisons rather than for tax.
 */
export type CostBasisMethod = 'FIFO' | 'LIFO' | 'AVERAGE';

/**
 * Corporate actions, which on the PSX are frequent enough that ignoring them
 * silently corrupts every cost basis in the portfolio. A bonus issue raises the
 * share count without any cash changing hands; left unhandled, the position
 * looks like it lost value per share for no reason.
 */
export type CorporateActionType =
  | 'BONUS'
  | 'RIGHT'
  | 'SPLIT'
  | 'REVERSE_SPLIT'
  | 'CASH_DIVIDEND'
  | 'MERGER'
  | 'DELISTING';

/**
 * Rule types the alert engine evaluates. Note these are alerts, not orders:
 * PSX brokers do not generally expose an order API to retail, so the engine
 * tells the user to act rather than acting for them.
 */
export type RuleType =
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT'
  | 'PRICE_ALERT'
  | 'INDICATOR_ALERT';

export type RuleStatus = 'ARMED' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED';

/** Which price a rule watches. Close-only is the honest default on EOD data. */
export type RuleTrigger = 'CLOSE' | 'INTRADAY_LOW' | 'INTRADAY_HIGH';

export type SignalHorizon = 'SWING' | 'LONG_TERM';

export type SignalAction = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';

/**
 * Factor groupings. Every prediction is a weighted sum over these, and the
 * weights differ by horizon: swing leans on the technical groups, long term on
 * the fundamental ones.
 */
export type FactorCategory =
  | 'TREND'
  | 'MOMENTUM'
  | 'VOLATILITY'
  | 'VOLUME'
  | 'PATTERN'
  | 'VALUATION'
  | 'GROWTH'
  | 'QUALITY'
  | 'LEVERAGE'
  | 'MARKET';

/** How a prediction turned out, once enough time has passed to judge it. */
export type SignalOutcome = 'PENDING' | 'HIT' | 'MISS' | 'NEUTRAL' | 'VOIDED';

/**
 * One trading day for one symbol. Prices are paisa so that the stored series is
 * byte-identical to what PSX published; indicator code converts to float at the
 * point of use.
 *
 * `ldcp` (last day close price) is carried through from the PSX file because it
 * is how gaps are detected: a close outside the prior day's range is a gap, and
 * several candlestick patterns are defined in terms of one.
 */
export interface Candle {
  /** Trading date as an ISO calendar date, e.g. "2026-10-20". */
  date: string;
  open: Paisa;
  high: Paisa;
  low: Paisa;
  close: Paisa;
  /** Shares traded. Not money, so a plain number. */
  volume: number;
  ldcp: Paisa | null;
}

export interface SymbolRef {
  /** PSX ticker, e.g. "HBL". */
  symbol: string;
  name: string;
  sectorCode: string | null;
}

/**
 * A single scored piece of evidence behind a prediction.
 *
 * This is the unit the UI renders when the user taps a prediction to ask why.
 * It deliberately stores the raw observation alongside the score, so the
 * explanation can never drift from the number that produced the call, and an
 * old prediction can still be audited after the weights have been retuned.
 */
export interface FactorScore {
  /** Stable identifier, e.g. "ema_alignment" or "rsi_14". */
  key: string;
  label: string;
  category: FactorCategory;
  /** Normalised to -100 (maximally bearish) through +100 (maximally bullish). */
  score: number;
  /** Weight applied for this horizon, 0..1. */
  weight: number;
  /** score * weight, i.e. this factor's contribution to the total. */
  contribution: number;
  /** The observed value, e.g. 58.3 for RSI. Null when the factor is qualitative. */
  value: number | null;
  /** Human-readable rendering of `value`, e.g. "20 > 50 > 200" or "1.8x average". */
  display: string;
  /** One sentence the user reads. Generated from the numbers, not by an LLM. */
  reason: string;
  /**
   * Bars this factor matched on, as indices into the candle series it was given.
   * Lets the chart highlight exactly the candles a pattern fired on.
   */
  barIndices?: number[];
}

/** A complete prediction, carrying its own evidence. */
export interface Signal {
  symbol: string;
  horizon: SignalHorizon;
  /** The date of the last candle the signal was computed from. */
  asOf: string;
  action: SignalAction;
  /** Weighted total, -100..+100. */
  score: number;
  /**
   * 0..1. Reflects how much the factors agree and how many had data, not how
   * likely the prediction is to be right. Historical hit rate is tracked
   * separately, because confidence and accuracy are not the same claim.
   */
  confidence: number;
  factors: FactorScore[];
  /** Count of factors that had to be skipped for want of data. */
  missingFactors: number;
  /** LLM prose written over the factor table. Null until generated. */
  narrative: string | null;
}

export const SIGNAL_THRESHOLDS: ReadonlyArray<{ min: number; action: SignalAction }> = [
  { min: 50, action: 'STRONG_BUY' },
  { min: 15, action: 'BUY' },
  { min: -15, action: 'HOLD' },
  { min: -50, action: 'SELL' },
  { min: -Infinity, action: 'STRONG_SELL' },
];

export function actionForScore(score: number): SignalAction {
  for (const band of SIGNAL_THRESHOLDS) {
    if (score >= band.min) return band.action;
  }
  return 'HOLD';
}
