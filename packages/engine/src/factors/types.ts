import type { FactorCategory, SignalHorizon } from '@psx/shared';
import type { Bar } from '../patterns/candles.js';

/**
 * The factor contract.
 *
 * Every prediction this system makes is a weighted sum of factors, and each
 * factor is responsible for explaining itself. That is the whole design: the
 * score and its explanation are produced by the same code from the same
 * numbers, so they cannot drift apart. A narrative written separately from the
 * scoring would eventually describe a different conclusion than the one shown.
 *
 * A factor returns `null` when it has no data. It does not return zero.
 * Scoring zero would mean "neutral evidence", which is a claim; null means "no
 * evidence", which is the truth when a stock has no published earnings. The
 * aggregator then renormalises over the factors that did report, so a missing
 * fundamental does not silently drag a technical signal towards neutral.
 */

export interface Fundamentals {
  /** Earnings per share, in rupees. */
  eps?: number;
  epsGrowthPct?: number;
  revenueGrowthPct?: number;
  roePct?: number;
  debtToEquity?: number;
  bookValuePerShare?: number;
  /** Annual dividend per share, in rupees. */
  dividendPerShare?: number;
  /** Sector average P/E, for a relative valuation rather than an absolute one. */
  sectorPe?: number;
}

export interface EngineContext {
  symbol: string;
  /** Oldest first. Prices as floats in rupees; paisa is converted at the edge. */
  bars: readonly Bar[];
  /** ISO dates aligned to `bars`, so a factor can name the day it fired. */
  dates: readonly string[];
  horizon: SignalHorizon;
  fundamentals?: Fundamentals | undefined;
  /** Index series, for relative strength. KSE-100 in practice. */
  marketBars?: readonly Bar[] | undefined;
}

export interface FactorEvaluation {
  /** -100 maximally bearish through +100 maximally bullish. */
  score: number;
  /** The observed number, e.g. 58.3 for RSI. Null when qualitative. */
  value: number | null;
  /** How the value reads, e.g. "20 > 50 > 200" or "1.8x average". */
  display: string;
  /** One sentence for the user, generated from the numbers. */
  reason: string;
  /** Bars this factor matched on, for highlighting on the chart. */
  barIndices?: number[];
}

export interface Factor {
  key: string;
  label: string;
  category: FactorCategory;
  /** Bars required before this factor can report anything. */
  minBars: number;
  evaluate: (context: EngineContext) => FactorEvaluation | null;
}

/** Clamps a score into the range every factor is required to return. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

/**
 * Maps a value onto -100..+100 by where it sits between two bounds.
 *
 * `bearishAt` and `bullishAt` are the values that should score -100 and +100.
 * Passing them the other way round inverts the scale, which is how an
 * "oversold is bullish" factor is expressed without a special case.
 */
export function scaleBetween(value: number, bearishAt: number, bullishAt: number): number {
  if (bearishAt === bullishAt) return 0;
  const ratio = (value - bearishAt) / (bullishAt - bearishAt);
  return clampScore(ratio * 200 - 100);
}

export const closes = (bars: readonly Bar[]): number[] => bars.map((bar) => bar.close);
export const highs = (bars: readonly Bar[]): number[] => bars.map((bar) => bar.high);
export const lows = (bars: readonly Bar[]): number[] => bars.map((bar) => bar.low);
export const volumes = (bars: readonly Bar[]): number[] => bars.map((bar) => bar.volume);

export const fmt = (value: number, digits = 2): string => value.toFixed(digits);
export const pct = (value: number, digits = 1): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;

export type { Bar, FactorCategory, SignalHorizon };
