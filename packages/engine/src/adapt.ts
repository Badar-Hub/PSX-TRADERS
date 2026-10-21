import { paisaToRupeeFloat, type Candle, type SignalHorizon } from '@psx/shared';
import type { Bar } from './patterns/candles.js';
import type { EngineContext, Fundamentals } from './factors/types.js';

/**
 * The boundary between stored prices and the engine.
 *
 * The ledger keeps money as integer paisa because a cost basis must be exact.
 * The engine works in floats because an RSI is a statistic, and an error of
 * 1e-12 in it is meaningless. Converting here, once, keeps that distinction
 * clear: nothing downstream of this file does accounting, and nothing upstream
 * of it does statistics.
 */

export function barFromCandle(candle: Candle): Bar {
  return {
    open: paisaToRupeeFloat(candle.open),
    high: paisaToRupeeFloat(candle.high),
    low: paisaToRupeeFloat(candle.low),
    close: paisaToRupeeFloat(candle.close),
    volume: candle.volume,
  };
}

export interface BuildContextInput {
  symbol: string;
  /** Oldest first. The engine assumes chronological order throughout. */
  candles: readonly Candle[];
  horizon: SignalHorizon;
  fundamentals?: Fundamentals;
  /** Index candles for relative strength, typically KSE-100. */
  marketCandles?: readonly Candle[];
}

export function buildContext(input: BuildContextInput): EngineContext {
  // Sorted defensively. A series out of order would not throw; it would quietly
  // produce indicator values computed over shuffled days, which is far worse
  // than an error.
  const ordered = [...input.candles].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    symbol: input.symbol,
    bars: ordered.map(barFromCandle),
    dates: ordered.map((candle) => candle.date),
    horizon: input.horizon,
    fundamentals: input.fundamentals,
    marketBars:
      input.marketCandles === undefined
        ? undefined
        : [...input.marketCandles]
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
            .map(barFromCandle),
  };
}
