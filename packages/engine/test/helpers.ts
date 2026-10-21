import type { Bar } from '../src/patterns/candles.js';

/**
 * Synthetic series for testing.
 *
 * Deterministic throughout: a seeded generator rather than Math.random, so a
 * failure can be reproduced and a flaky test cannot creep in. Indicator
 * correctness is checked against hand-computed values and invariants here;
 * the real-data check lives in its own test against a saved PSX fixture.
 */

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeriesOptions {
  length: number;
  start?: number;
  /** Percentage drift per bar. */
  driftPct?: number;
  /** Percentage noise amplitude per bar. */
  noisePct?: number;
  volume?: number;
  seed?: number;
}

/** Builds bars with a given drift, each bar a plausible candle. */
export function makeBars(options: SeriesOptions): Bar[] {
  const {
    length,
    start = 100,
    driftPct = 0,
    noisePct = 0,
    volume = 100_000,
    seed = 42,
  } = options;

  const random = mulberry32(seed);
  const bars: Bar[] = [];
  let price = start;

  for (let i = 0; i < length; i += 1) {
    const open = price;
    const drift = price * (driftPct / 100);
    const noise = price * (noisePct / 100) * (random() * 2 - 1);
    const close = Math.max(0.01, open + drift + noise);
    const high = Math.max(open, close) * (1 + (noisePct / 100) * random() * 0.5);
    const low = Math.min(open, close) * (1 - (noisePct / 100) * random() * 0.5);

    bars.push({
      open,
      high,
      low,
      close,
      volume: Math.round(volume * (0.7 + random() * 0.6)),
    });
    price = close;
  }

  return bars;
}

/** A clean uptrend with enough history for every factor. */
export function uptrend(length = 260): Bar[] {
  return makeBars({ length, driftPct: 0.35, noisePct: 0.4, seed: 7 });
}

export function downtrend(length = 260): Bar[] {
  return makeBars({ length, start: 300, driftPct: -0.35, noisePct: 0.4, seed: 11 });
}

/** Sideways chop: the case a trend-following signal should not get excited by. */
export function choppy(length = 260): Bar[] {
  const random = mulberry32(3);
  const bars: Bar[] = [];
  const base = 100;
  for (let i = 0; i < length; i += 1) {
    const open = base + Math.sin(i / 3) * 2 + (random() - 0.5);
    const close = base + Math.sin((i + 1) / 3) * 2 + (random() - 0.5);
    bars.push({
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100_000,
    });
  }
  return bars;
}

/** ISO dates for a series, ending today-ish, weekends ignored. */
export function datesFor(bars: readonly Bar[], end = '2026-10-21'): string[] {
  const endTime = Date.parse(`${end}T00:00:00Z`);
  return bars.map((_, i) =>
    new Date(endTime - (bars.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** A single candle, for pattern tests. */
export function candle(open: number, high: number, low: number, close: number, volume = 100_000): Bar {
  return { open, high, low, close, volume };
}

/** A run of falling bars, to give a reversal pattern the context it needs. */
export function decliningRun(count: number, from = 120, step = 2): Bar[] {
  const bars: Bar[] = [];
  let price = from;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price - step;
    bars.push(candle(open, open + 0.3, close - 0.3, close));
    price = close;
  }
  return bars;
}

export function risingRun(count: number, from = 80, step = 2): Bar[] {
  const bars: Bar[] = [];
  let price = from;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price + step;
    bars.push(candle(open, close + 0.3, open - 0.3, close));
    price = close;
  }
  return bars;
}
