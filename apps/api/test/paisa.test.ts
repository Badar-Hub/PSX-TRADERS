import { describe, expect, it } from 'vitest';
import { rupeesToPaisa } from '@psx/shared';
import {
  PaisaConversionError,
  fromIsoDateColumn,
  fromPaisa,
  fromPaisaOrNull,
  toIsoDateColumn,
  toPaisa,
  toPaisaOrNull,
} from '../src/db/paisa.js';

describe('paisa column conversion', () => {
  it('round-trips an amount through the database representation', () => {
    const amount = rupeesToPaisa('28655.00');
    expect(toPaisa(fromPaisa(amount))).toBe(amount);
  });

  it('round-trips a negative amount, as a realised loss would be', () => {
    const loss = rupeesToPaisa('-1040.50');
    expect(toPaisa(fromPaisa(loss))).toBe(loss);
  });

  it('handles zero', () => {
    expect(toPaisa(0n)).toBe(0);
    expect(fromPaisa(rupeesToPaisa('0'))).toBe(0n);
  });

  it('handles a portfolio far larger than anyone will have', () => {
    // 10 billion rupees.
    const big = 1_000_000_000_000n;
    expect(toPaisa(big)).toBe(1_000_000_000_000);
  });

  /**
   * Fails loudly rather than silently losing precision. A rounded cost basis is
   * far worse than an error, because nothing downstream would reveal it.
   */
  it('refuses a value that cannot convert without precision loss', () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => toPaisa(tooBig)).toThrow(PaisaConversionError);
    expect(() => toPaisa(-tooBig)).toThrow(PaisaConversionError);
  });

  it('accepts exactly the safe boundary', () => {
    expect(() => toPaisa(BigInt(Number.MAX_SAFE_INTEGER))).not.toThrow();
  });

  it('passes nulls through for optional columns', () => {
    expect(toPaisaOrNull(null)).toBeNull();
    expect(fromPaisaOrNull(null)).toBeNull();
    expect(fromPaisaOrNull(undefined)).toBeNull();
    expect(toPaisaOrNull(5000n)).toBe(5000);
  });

  it('keeps a converted amount JSON-serialisable, which a bigint is not', () => {
    const amount = toPaisa(12_345n);
    expect(() => JSON.stringify({ amount })).not.toThrow();
    expect(() => JSON.stringify({ amount: 12_345n })).toThrow(TypeError);
  });
});

describe('trading date conversion', () => {
  it('round-trips a calendar date', () => {
    expect(toIsoDateColumn(fromIsoDateColumn('2026-10-20'))).toBe('2026-10-20');
  });

  /**
   * A trading date is a calendar fact. Going through UTC midnight keeps it from
   * shifting by a day depending on the machine's timezone, which would move a
   * sale across a capital-gains holding-period boundary.
   */
  it('anchors to UTC midnight so the date cannot drift', () => {
    const date = fromIsoDateColumn('2026-01-01');
    expect(date.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(date.getUTCDate()).toBe(1);
    expect(date.getUTCHours()).toBe(0);
  });

  it('rejects anything that is not a calendar date', () => {
    expect(() => fromIsoDateColumn('20-10-2026')).toThrow(PaisaConversionError);
    expect(() => fromIsoDateColumn('2026-10-20T10:00:00Z')).toThrow(PaisaConversionError);
  });
});
