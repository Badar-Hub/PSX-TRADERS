import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifySegment,
  parseClosingSummary,
  parsePsxDate,
  type PsxDailyBar,
} from '../src/parse/closingSummary.js';
import { describeAdjustment, detectAdjustments } from '../src/corporateActions.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');

const day20 = read('closing11-2026-10-20.lis');
const day21 = read('closing11-2026-10-21.lis');

describe('parsePsxDate', () => {
  it('converts the exchange format to ISO', () => {
    expect(parsePsxDate('20OCT2026')).toBe('2026-10-20');
    expect(parsePsxDate('1JAN2018')).toBe('2018-01-01');
    expect(parsePsxDate('31DEC2025')).toBe('2025-12-31');
  });

  it('rejects anything it does not recognise', () => {
    expect(() => parsePsxDate('2026-10-20')).toThrow();
    expect(() => parsePsxDate('20XXX2026')).toThrow();
  });
});

describe('classifySegment', () => {
  it('uses the sector code as the primary signal', () => {
    expect(classifySegment('0807', 'ABL')).toBe('EQUITY');
    expect(classifySegment('40', 'AGP-CDEC')).toBe('FUTURE');
    expect(classifySegment('41', 'BKTI-DEC')).toBe('INDEX_FUTURE');
    expect(classifySegment('36', 'P01GIS131126')).toBe('DEBT');
  });

  it('falls back to the symbol shape when the code is unfamiliar', () => {
    expect(classifySegment('99', 'AGP-CDEC')).toBe('FUTURE');
    expect(classifySegment('99', 'AGHA-OCT')).toBe('FUTURE');
    expect(classifySegment('99', 'ZAL-COCT')).toBe('FUTURE');
    expect(classifySegment('99', 'AGP-OCTB')).toBe('FUTURE');
    expect(classifySegment('99', 'P01GHS020927')).toBe('DEBT');
    expect(classifySegment('99', 'WHATEVER')).toBe('UNKNOWN');
  });
});

/**
 * The test that pins down the field order, and the reason the fixtures are two
 * consecutive trading days rather than one.
 *
 * Fields 7 and 9 are both closing prices, for this day and the day before. A
 * single file cannot distinguish them, so reading them the wrong way round
 * would shift the whole series by a day with no test failing. Chaining the days
 * settles it: the previous close published on the 21st must equal the close
 * published on the 20th.
 */
describe('field order, proven across two trading days', () => {
  const a = parseClosingSummary(day20, { segments: ['EQUITY'] });
  const b = parseClosingSummary(day21, { segments: ['EQUITY'] });

  it('reads the two fixtures as consecutive trading days', () => {
    expect(a.date).toBe('2026-10-20');
    expect(b.date).toBe('2026-10-21');
  });

  it("matches each day's close to the next day's published previous close", () => {
    const closeOn20 = new Map(a.bars.map((bar) => [bar.symbol, bar.close]));
    let compared = 0;
    let matched = 0;

    for (const bar of b.bars) {
      const previous = closeOn20.get(bar.symbol);
      if (previous === undefined || bar.ldcp === null) continue;
      compared += 1;
      if (bar.ldcp === previous) matched += 1;
    }

    expect(compared).toBeGreaterThan(400);
    // The remainder are ex-dates, and the test below accounts for every one of
    // them. Were the close and LDCP fields swapped, this would collapse.
    expect(matched / compared).toBeGreaterThan(0.95);
  });

  /**
   * Every symbol that breaks the chain must be explained by a corporate action.
   * This is the assertion that makes the chain proof airtight: a leftover
   * "UNEXPLAINED" row would mean something about the format is still not
   * understood, which is exactly when a price series should not be trusted.
   */
  it('explains every break in the chain as a corporate action', () => {
    const adjustments = detectAdjustments(a.bars, b.bars);
    expect(adjustments.length).toBeGreaterThan(0);

    const unexplained = adjustments.filter((adj) => adj.likely === 'UNEXPLAINED');
    expect(unexplained).toEqual([]);

    // All of them on this pair of days are cash dividends, declared in whole
    // multiples of 25 paisa and always marking the price down.
    for (const adj of adjustments) {
      expect(adj.likely).toBe('CASH_DIVIDEND');
      expect(adj.delta).toBeGreaterThan(0);
      expect(adj.delta % 25).toBe(0);
      expect(adj.dividendPerShare).toBe(adj.delta);
    }
  });

  it('describes a detected dividend in words the user can confirm', () => {
    const adjustments = detectAdjustments(a.bars, b.bars);
    const zal = adjustments.find((adj) => adj.symbol === 'ZAL');
    expect(zal?.dividendPerShare).toBe(100);
    expect(describeAdjustment(zal!)).toContain('ex-dividend');
    expect(describeAdjustment(zal!)).toContain('Rs 1.00');
  });
});

describe('detectAdjustments, synthetic cases', () => {
  const bar = (over: Partial<PsxDailyBar> = {}) => makeBar(over);

  it('ignores ordinary trading, where LDCP matches the prior close', () => {
    const yesterday = [bar({ date: '2026-10-20', close: 10_000 })];
    const today = [bar({ date: '2026-10-21', ldcp: 10_000 })];
    expect(detectAdjustments(yesterday, today)).toEqual([]);
  });

  it('ignores a one-paisa rounding difference', () => {
    const yesterday = [bar({ date: '2026-10-20', close: 10_000 })];
    const today = [bar({ date: '2026-10-21', ldcp: 9_999 })];
    expect(detectAdjustments(yesterday, today)).toEqual([]);
  });

  it('reads a clean markdown as a cash dividend', () => {
    const yesterday = [bar({ date: '2026-10-20', close: 10_000 })];
    const today = [bar({ date: '2026-10-21', ldcp: 9_750 })];
    const [adj] = detectAdjustments(yesterday, today);
    expect(adj?.likely).toBe('CASH_DIVIDEND');
    expect(adj?.dividendPerShare).toBe(250);
  });

  it('reads a halving as a split rather than a very large dividend', () => {
    const yesterday = [bar({ date: '2026-10-20', close: 10_000 })];
    const today = [bar({ date: '2026-10-21', ldcp: 5_000 })];
    const [adj] = detectAdjustments(yesterday, today);
    // 5000 paisa is also a multiple of 25, so the dividend rule would otherwise
    // claim this and report a Rs 50 dividend on a Rs 100 share.
    expect(adj?.likely).toBe('SPLIT_OR_BONUS');
    expect(adj?.shareRatio).toBe(2);
    expect(adj?.dividendPerShare).toBeNull();
  });

  it('marks a 10% markdown as ambiguous between a dividend and a bonus', () => {
    const yesterday = [bar({ date: '2026-10-20', close: 11_000 })];
    const today = [bar({ date: '2026-10-21', ldcp: 10_000 })];
    const [adj] = detectAdjustments(yesterday, today);
    expect(adj?.likely).toBe('CASH_DIVIDEND');
    expect(adj?.ambiguous).toBe(true);
    expect(adj?.shareRatio).toBe(1.1);
    expect(describeAdjustment(adj!)).toContain('Which was it?');
  });

  it('flags a gap it cannot account for', () => {
    const yesterday = [bar({ date: '2026-10-20', close: 10_000 })];
    const today = [bar({ date: '2026-10-21', ldcp: 9_737 })];
    const [adj] = detectAdjustments(yesterday, today);
    expect(adj?.likely).toBe('UNEXPLAINED');
    expect(describeAdjustment(adj!)).toContain('announcements');
  });

  it('skips symbols absent from either day', () => {
    const yesterday = [bar({ symbol: 'AAA', date: '2026-10-20', close: 10_000 })];
    const today = [bar({ symbol: 'BBB', date: '2026-10-21', ldcp: 5_000 })];
    expect(detectAdjustments(yesterday, today)).toEqual([]);
  });
});

function makeBar(over: Partial<PsxDailyBar> = {}): PsxDailyBar {
  return {
    date: '2026-10-21',
    symbol: 'TEST',
    sectorCode: '0801',
    companyName: 'Test Co',
    segment: 'EQUITY',
    open: 10_000 as PsxDailyBar['open'],
    high: 10_000 as PsxDailyBar['high'],
    low: 10_000 as PsxDailyBar['low'],
    close: 10_000 as PsxDailyBar['close'],
    volume: 1000,
    ldcp: 10_000 as PsxDailyBar['ldcp'],
    ...over,
  };
}

describe('parseClosingSummary, against a real PSX file', () => {
  const all = parseClosingSummary(day20);
  const equities = parseClosingSummary(day20, { segments: ['EQUITY'] });

  it('separates the boards the file mixes together', () => {
    expect(all.segmentCounts).toEqual({
      EQUITY: 497,
      FUTURE: 507,
      INDEX_FUTURE: 9,
      DEBT: 20,
      UNKNOWN: 0,
    });
  });

  it('yields only equities when asked for them', () => {
    expect(equities.bars.length).toBe(496);
    for (const bar of equities.bars) {
      expect(bar.segment).toBe('EQUITY');
      // No futures contract should survive the filter.
      expect(bar.symbol).not.toMatch(/-(C?)(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)B?$/);
    }
  });

  it('drops the untraded rows that carry a reference price but no candle', () => {
    const reasons = all.skipped.map((s) => s.reason);
    expect(reasons.every((r) => r === 'no_trade_prices')).toBe(true);
    expect(all.skipped.length).toBe(414);
  });

  it('agrees on the date across every row', () => {
    for (const bar of equities.bars) expect(bar.date).toBe('2026-10-20');
  });

  it('reads a known row exactly', () => {
    // 20OCT2026|ABL|0807|Allied Bank Ltd|170.15|170.75|170.15|170.19|3085|170.49
    const abl = equities.bars.find((bar) => bar.symbol === 'ABL');
    expect(abl).toMatchObject({
      symbol: 'ABL',
      sectorCode: '0807',
      segment: 'EQUITY',
      open: 17_015,
      high: 17_075,
      low: 17_015,
      close: 17_019,
      volume: 3085,
      ldcp: 17_049,
    });
  });

  /**
   * The exchange's computed closing price can sit outside the day's traded
   * range in near-untraded stocks. This asserts the anomaly stays confined to
   * that explanation: if it ever shows up on a liquid stock, the parser is
   * reading the wrong field and the test should fail.
   */
  it('confines out-of-range closes to negligible volume', () => {
    const outliers = equities.warnings.filter((w) => w.kind === 'close_outside_range');
    expect(outliers.length).toBeGreaterThan(0);
    expect(outliers.length).toBeLessThan(20);

    const bySymbol = new Map(equities.bars.map((bar) => [bar.symbol, bar]));
    for (const warning of outliers) {
      const bar = bySymbol.get(warning.symbol);
      expect(bar).toBeDefined();
      expect(bar?.volume).toBeLessThan(1000);
    }
  });

  it('keeps the close inside the range for every meaningfully traded stock', () => {
    const liquid = equities.bars.filter((bar) => bar.volume >= 1000);
    expect(liquid.length).toBeGreaterThan(300);
    for (const bar of liquid) {
      expect(bar.close).toBeLessThanOrEqual(bar.high);
      expect(bar.close).toBeGreaterThanOrEqual(bar.low);
      expect(bar.open).toBeLessThanOrEqual(bar.high);
      expect(bar.open).toBeGreaterThanOrEqual(bar.low);
    }
  });

  it('returns prices as whole paisa', () => {
    for (const bar of equities.bars) {
      for (const price of [bar.open, bar.high, bar.low, bar.close]) {
        expect(Number.isInteger(price)).toBe(true);
      }
      expect(Number.isInteger(bar.volume)).toBe(true);
    }
  });

  it('does not report the same symbol twice', () => {
    const duplicates = equities.warnings.filter((w) => w.kind === 'duplicate_symbol');
    expect(duplicates).toEqual([]);
  });
});

describe('parseClosingSummary, malformed input', () => {
  it('skips short lines rather than throwing', () => {
    const result = parseClosingSummary('20OCT2026|ABL|0807|Allied Bank\nnot a row at all');
    expect(result.bars).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['too_few_fields', 'too_few_fields']);
  });

  it('flags an incoherent candle but keeps the row', () => {
    const line = '20OCT2026|XYZ|0801|Bad Candle|10|12|11.5|13|500|11|||';
    const result = parseClosingSummary(line);
    expect(result.bars).toHaveLength(1);
    expect(result.warnings.map((w) => w.kind)).toContain('close_outside_range');
  });

  it('handles bare CR line endings, as the price-band export uses', () => {
    const content =
      '20OCT2026|ABL|0807|Allied Bank Ltd|170.15|170.75|170.15|170.19|3085|170.49|||\r' +
      '20OCT2026|HBL|0807|Habib Bank Ltd|180|182|179|181|9000|180.5|||\r';
    expect(parseClosingSummary(content).bars).toHaveLength(2);
  });

  it('strips BOM and zero-width marks the exchange writes between fields', () => {
    const line =
      '﻿20OCT2026|﻿ABL|0807|Allied Bank Ltd|170.15|170.75|170.15|170.19|3085|170.49';
    expect(parseClosingSummary(line).bars[0]?.symbol).toBe('ABL');
  });

  it('reports an empty file without inventing a date', () => {
    const result = parseClosingSummary('');
    expect(result.date).toBeNull();
    expect(result.bars).toEqual([]);
  });
});
