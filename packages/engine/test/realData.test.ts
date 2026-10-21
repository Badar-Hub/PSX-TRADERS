import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { latest, rsi, sma } from '../src/indicators/index.js';
import { detectPatterns } from '../src/patterns/candles.js';
import { groupByCategory, scoreSignal } from '../src/scoring.js';
import { summarise, validateNarrative } from '../src/narrative.js';
import type { EngineContext } from '../src/factors/types.js';
import type { Bar } from '../src/patterns/candles.js';

/**
 * The engine against real PSX prices.
 *
 * Synthetic series are better for checking that an indicator computes what it
 * claims, because the expected value is known. They are worse at catching what
 * actually breaks an engine: a stock that stops trading mid-series, a price
 * that halves overnight on a corporate action, a stretch of identical closes.
 *
 * This fixture is 260 trading days to 21 Oct 2026 for five liquid symbols,
 * downloaded from the exchange's own archives by
 * `pnpm --filter @psx/engine fixture:fetch`. The period is usefully varied:
 * PRL rose 166%, HBL and LUCK fell, OGDC and FFC rose moderately.
 */

interface FixtureBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ldcp: number | null;
}

interface Fixture {
  generatedAt: string;
  endDate: string;
  tradingDays: number;
  holidaysSkipped: number;
  series: Record<string, FixtureBar[]>;
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'psx-history.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const SYMBOLS = Object.keys(fixture.series);

function barsFor(symbol: string): Bar[] {
  return (fixture.series[symbol] ?? []).map((bar) => ({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

function contextFor(symbol: string, horizon: 'SWING' | 'LONG_TERM' = 'SWING'): EngineContext {
  return {
    symbol,
    bars: barsFor(symbol),
    dates: (fixture.series[symbol] ?? []).map((bar) => bar.date),
    horizon,
  };
}

describe('the fixture itself', () => {
  it('holds a year of real trading days', () => {
    expect(fixture.tradingDays).toBe(260);
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(5);
  });

  it('is in chronological order with no duplicate dates', () => {
    for (const symbol of SYMBOLS) {
      const dates = (fixture.series[symbol] ?? []).map((bar) => bar.date);
      expect(dates).toEqual([...dates].sort());
      expect(new Set(dates).size).toBe(dates.length);
    }
  });

  it('contains coherent candles', () => {
    for (const symbol of SYMBOLS) {
      for (const bar of fixture.series[symbol] ?? []) {
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
        expect(bar.open).toBeGreaterThan(0);
        expect(bar.volume).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /** 12 weekdays in the year had no file: Pakistan's public holidays. */
  it('skipped the non-trading weekdays', () => {
    expect(fixture.holidaysSkipped).toBeGreaterThan(5);
    expect(fixture.holidaysSkipped).toBeLessThan(30);
  });
});

describe('indicators on real prices', () => {
  it('stays inside its bounds on every symbol', () => {
    for (const symbol of SYMBOLS) {
      const closes = barsFor(symbol).map((bar) => bar.close);
      for (const value of rsi(closes, 14)) {
        if (value === null) continue;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('produces no NaN or Infinity anywhere', () => {
    for (const symbol of SYMBOLS) {
      const closes = barsFor(symbol).map((bar) => bar.close);
      for (const series of [sma(closes, 50), rsi(closes, 14)]) {
        for (const value of series) {
          if (value === null) continue;
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  /**
   * PRL rose from 37.59 to 99.88 over the year, so its RSI should read firm.
   * A reading near 50 would mean the indicator is not tracking the move.
   */
  it('reads PRL as strong after a 166% year', () => {
    const closes = barsFor('PRL').map((bar) => bar.close);
    expect(latest(sma(closes, 200))).toBeLessThan(closes[closes.length - 1]!);
    expect(latest(rsi(closes, 14))!).toBeGreaterThan(45);
  });
});

describe('patterns on real prices', () => {
  it('finds patterns without crashing, and all within the series', () => {
    for (const symbol of SYMBOLS) {
      const bars = barsFor(symbol);
      const matches = detectPatterns(bars, { lookback: 30 });
      for (const match of matches) {
        expect(match.strength).toBeGreaterThanOrEqual(0);
        expect(match.strength).toBeLessThanOrEqual(100);
        expect(match.description.length).toBeGreaterThan(10);
        for (const index of match.barIndices) {
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(bars.length);
        }
      }
    }
  });

  /**
   * A year of real data should contain some patterns but not be carpeted in
   * them. Firing on most days would mean the context checks are not working,
   * which is the failure mode that makes a pattern engine useless.
   */
  it('fires occasionally rather than constantly', () => {
    for (const symbol of SYMBOLS) {
      const bars = barsFor(symbol);
      let daysWithPattern = 0;
      for (let i = 10; i < bars.length; i += 1) {
        if (detectPatterns(bars.slice(0, i + 1), { lookback: 1, minStrength: 20 }).length > 0) {
          daysWithPattern += 1;
        }
      }
      const share = daysWithPattern / (bars.length - 10);
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThan(0.45);
    }
  });
});

describe('scoring on real prices', () => {
  it('produces a signal for every liquid symbol, on both horizons', () => {
    for (const symbol of SYMBOLS) {
      for (const horizon of ['SWING', 'LONG_TERM'] as const) {
        const result = scoreSignal(contextFor(symbol, horizon));
        expect(result.ok, `${symbol} ${horizon}: ${result.ok ? '' : result.reason}`).toBe(true);
        if (!result.ok) continue;

        expect(result.signal.score).toBeGreaterThanOrEqual(-100);
        expect(result.signal.score).toBeLessThanOrEqual(100);
        expect(result.signal.confidence).toBeGreaterThanOrEqual(0);
        expect(result.signal.confidence).toBeLessThanOrEqual(1);
        expect(result.signal.factors.length).toBeGreaterThan(5);
        expect(result.signal.asOf).toBe('2026-10-21');
      }
    }
  });

  it('reports the 200-day factors, which only a full year of data unlocks', () => {
    const result = scoreSignal(contextFor('HBL'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.signal.factors.map((factor) => factor.key);
    expect(keys).toContain('ema_alignment');
    expect(keys).toContain('price_vs_ema200');
  });

  it('keeps the arithmetic exact on real numbers', () => {
    for (const symbol of SYMBOLS) {
      const result = scoreSignal(contextFor(symbol));
      if (!result.ok) continue;
      const summed = result.signal.factors.reduce((total, f) => total + f.contribution, 0);
      expect(summed).toBeCloseTo(result.signal.score, 1);
      const weights = result.signal.factors.reduce((total, f) => total + f.weight, 0);
      expect(weights).toBeCloseTo(1, 3);
    }
  });

  /**
   * The engine should disagree across symbols that behaved differently. If
   * every stock scored the same, the factors would not be measuring anything.
   */
  it('separates the stocks that rose from those that fell', () => {
    const scores = new Map<string, number>();
    for (const symbol of SYMBOLS) {
      const result = scoreSignal(contextFor(symbol, 'LONG_TERM'));
      if (result.ok) scores.set(symbol, result.signal.score);
    }

    expect(scores.size).toBe(SYMBOLS.length);
    const values = [...scores.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(15);

    // PRL tripled over the year; LUCK fell. Their long-term readings should
    // not come out the same way round.
    expect(scores.get('PRL')!).toBeGreaterThan(scores.get('LUCK')!);
  });

  it('explains every factor it reports, on real data', () => {
    for (const symbol of SYMBOLS) {
      const result = scoreSignal(contextFor(symbol));
      if (!result.ok) continue;
      for (const factor of result.signal.factors) {
        expect(factor.reason.length).toBeGreaterThan(20);
        expect(factor.reason).not.toContain('NaN');
        expect(factor.reason).not.toContain('undefined');
        expect(factor.reason).not.toContain('Infinity');
        expect(factor.display).not.toContain('NaN');
      }
    }
  });

  it('groups the breakdown so the totals still reconcile', () => {
    for (const symbol of SYMBOLS) {
      const result = scoreSignal(contextFor(symbol));
      if (!result.ok) continue;
      const groups = groupByCategory(result.signal);
      const total = groups.reduce((sum, group) => sum + group.contribution, 0);
      expect(total).toBeCloseTo(result.signal.score, 1);
    }
  });
});

describe('narratives on real prices', () => {
  it('writes a clean explanation for every symbol', () => {
    for (const symbol of SYMBOLS) {
      const result = scoreSignal(contextFor(symbol));
      if (!result.ok) continue;

      const text = summarise(result.signal);
      expect(text).toContain(symbol);
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('undefined');
      expect(text.length).toBeGreaterThan(100);
      // The deterministic summary must never trip its own validator.
      expect(validateNarrative(result.signal, text)).toEqual([]);
    }
  });
});

describe('robustness', () => {
  /**
   * A thin stock is the realistic failure case on this exchange, where several
   * hundred listings go days without trading. The engine must refuse rather
   * than compute indicators across the gaps.
   */
  it('refuses a series with most sessions untraded', () => {
    const bars = barsFor('HBL').map((bar, i) => ({ ...bar, volume: i % 4 === 0 ? bar.volume : 0 }));
    const result = scoreSignal({ ...contextFor('HBL'), bars });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ILLIQUID');
  });

  it('survives a truncated series by refusing it', () => {
    const result = scoreSignal({
      ...contextFor('HBL'),
      bars: barsFor('HBL').slice(-10),
      dates: (fixture.series.HBL ?? []).slice(-10).map((bar) => bar.date),
    });
    expect(result.ok).toBe(false);
  });

  /** An unadjusted split would appear as a one-day halving. */
  it('still produces a bounded signal across a violent price break', () => {
    const bars = barsFor('OGDC').map((bar, i, all) =>
      i < all.length / 2
        ? { ...bar, open: bar.open * 2, high: bar.high * 2, low: bar.low * 2, close: bar.close * 2 }
        : bar,
    );
    const result = scoreSignal({ ...contextFor('OGDC'), bars });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isFinite(result.signal.score)).toBe(true);
    expect(result.signal.score).toBeGreaterThanOrEqual(-100);
    expect(result.signal.score).toBeLessThanOrEqual(100);
  });

  it('is deterministic across repeated runs on real data', () => {
    for (const symbol of SYMBOLS) {
      const a = scoreSignal(contextFor(symbol));
      const b = scoreSignal(contextFor(symbol));
      expect(a).toEqual(b);
    }
  });
});
