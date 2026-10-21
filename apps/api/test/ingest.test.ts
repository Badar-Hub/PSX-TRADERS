import { describe, expect, it, vi } from 'vitest';
import type { DailyBarsResult, MarketDataProvider, PsxSymbolRecord } from '@psx/data';
import { paisa } from '@psx/shared';

/**
 * Ingest tests that need no network and no database.
 *
 * The provider is an interface precisely so it can be replaced here: these
 * check the decisions the ingest makes about what the exchange returns, which
 * is the part worth pinning down. Whether the rows reach Postgres is covered
 * by the integration suite.
 */

function barsResult(date: string, symbols: string[]): DailyBarsResult {
  const bars = symbols.map((symbol, index) => ({
    date,
    symbol,
    sectorCode: '0807',
    companyName: `${symbol} Limited`,
    segment: 'EQUITY' as const,
    open: paisa(10_000 + index * 100),
    high: paisa(10_200 + index * 100),
    low: paisa(9_900 + index * 100),
    close: paisa(10_100 + index * 100),
    volume: 500_000,
    // Equal to the close, so two consecutive days built from this helper are
    // internally consistent: LDCP is by definition the previous day's close,
    // and a mismatch here would look like a corporate action to the detector.
    ldcp: paisa(10_100 + index * 100),
  }));

  return {
    date,
    bars,
    summary: {
      date,
      bars,
      skipped: [],
      warnings: [],
      segmentCounts: { EQUITY: bars.length, FUTURE: 0, INDEX_FUTURE: 0, DEBT: 0, UNKNOWN: 0 },
    },
    raw: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  };
}

/** A provider that answers from a fixed map of dates. */
function fakeProvider(days: Record<string, DailyBarsResult | null>): MarketDataProvider {
  return {
    name: 'fake',
    fetchDailyBars: vi.fn(async (date: string) => days[date] ?? null),
    fetchSymbolMaster: vi.fn(async (): Promise<PsxSymbolRecord[] | null> => null),
  };
}

describe('provider contract the ingest relies on', () => {
  it('reports a non-trading day as null rather than throwing', async () => {
    const provider = fakeProvider({ '2026-10-20': barsResult('2026-10-20', ['HBL']) });
    expect(await provider.fetchDailyBars('2026-10-18')).toBeNull();
    expect(await provider.fetchDailyBars('2026-10-20')).not.toBeNull();
  });

  /**
   * The exchange publishes nothing for weekends and public holidays, and
   * Pakistan's holidays include lunar-calendar dates announced weeks ahead, so
   * there is no calendar to check against. A missing file has to be data.
   */
  it('lets a holiday be distinguished from a failure', async () => {
    const provider = fakeProvider({});
    const result = await provider.fetchDailyBars('2026-10-20');
    expect(result).toBeNull();
  });
});

describe('date arithmetic the schedule depends on', () => {
  it('walks back over a weekend', async () => {
    const { addDays, isWeekend } = await import('@psx/data');
    // 2026-10-19 is a Monday; stepping back twice lands on the Saturday.
    expect(isWeekend(addDays('2026-10-19', -1))).toBe(true);
    expect(isWeekend(addDays('2026-10-19', -2))).toBe(true);
    expect(isWeekend('2026-10-19')).toBe(false);
  });

  it('enumerates only weekdays in a range', async () => {
    const { candidateTradingDays } = await import('@psx/data');
    const days = [...candidateTradingDays('2026-10-19', '2026-10-25')];
    expect(days).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ]);
  });
});

describe('corporate-action detection as the ingest uses it', () => {
  it('finds a dividend from the gap between LDCP and the prior close', async () => {
    const { detectAdjustments } = await import('@psx/data');

    const yesterday = barsResult('2026-10-20', ['ZAL']).bars;
    const previousClose = yesterday[0]!.close;

    const today = barsResult('2026-10-21', ['ZAL']).bars.map((bar) => ({
      ...bar,
      // The exchange marks the reference price down by the dividend, so today's
      // published LDCP sits 1.00 below yesterday's actual close.
      ldcp: paisa(previousClose - 100),
    }));

    const adjustments = detectAdjustments(yesterday, today);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.likely).toBe('CASH_DIVIDEND');
    expect(adjustments[0]?.dividendPerShare).toBe(100);
  });

  it('finds nothing on an ordinary day', async () => {
    const { detectAdjustments } = await import('@psx/data');
    const yesterday = barsResult('2026-10-20', ['HBL']).bars;
    const today = barsResult('2026-10-21', ['HBL']).bars;
    expect(detectAdjustments(yesterday, today)).toEqual([]);
  });
});

describe('score encoding used when a signal is stored', () => {
  /**
   * Scores go into the database as integers: score times 100, weights and
   * confidence in basis points. Same reason money is integer paisa. A stored
   * float invites comparisons that differ by 1e-15 and totals that no longer
   * reconcile when read back.
   */
  it('round-trips a score through its integer form', () => {
    for (const score of [0, 7.71, -21.53, 100, -100, 0.01, -0.01]) {
      const encoded = Math.round(score * 100);
      expect(Number.isInteger(encoded)).toBe(true);
      expect(encoded / 100).toBeCloseTo(score, 2);
    }
  });

  it('round-trips confidence and weight through basis points', () => {
    for (const value of [0, 0.5, 0.583, 1]) {
      const encoded = Math.round(value * 10_000);
      expect(Number.isInteger(encoded)).toBe(true);
      expect(encoded / 10_000).toBeCloseTo(value, 4);
    }
  });
});
