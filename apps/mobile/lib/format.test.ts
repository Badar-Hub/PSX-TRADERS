import { describe, expect, it } from 'vitest';
import {
  countdown,
  money,
  percent,
  percentFromBps,
  rupees,
  rupeesCompact,
  shares,
  shortDate,
  signedRupees,
} from './format';

/**
 * The money formatters are hand-rolled rather than `Intl.NumberFormat`,
 * because Hermes ships without full ICU locale data on Android unless the
 * build opts in, and a missing locale degrades quietly to differently grouped
 * output instead of throwing. Hand-rolled means it needs tests: the first
 * version of `paisaToDecimal` printed "400.27.999999999996" when handed a
 * value that was not quite an integer, which is how it was found.
 */

describe('money', () => {
  it('divides paisa into rupees and paisa', () => {
    expect(money(123456)).toBe('1,234.56');
    expect(money(100)).toBe('1.00');
    expect(money(1)).toBe('0.01');
    expect(money(0)).toBe('0.00');
  });

  it('groups thousands', () => {
    expect(money(100000000)).toBe('1,000,000.00');
    expect(money(99999)).toBe('999.99');
  });

  it('shows a dash for a missing figure', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
  });

  it('marks a negative with a minus sign', () => {
    expect(money(-123456)).toBe('−1,234.56');
  });

  /*
   * Every amount in the ledger is an integer. A figure derived on the way out
   * of the API can still arrive as 40027.999999999996, and splitting that on
   * the hundreds produced two decimal points. Rounding first is the fix, and
   * this is the case that proves it.
   */
  it('rounds a value that is not quite a whole paisa', () => {
    expect(rupees(40027.999999999996)).toBe('Rs 400.28');
    expect(rupees(40028.000000000004)).toBe('Rs 400.28');
    expect(money(99.5)).toBe('1.00');
  });
});

describe('rupees', () => {
  it('prefixes the currency', () => {
    expect(rupees(209100 * 100)).toBe('Rs 209,100.00');
    expect(rupees(null)).toBe('—');
  });

  it('puts the sign before the currency, not inside the number', () => {
    expect(rupees(-5000)).toBe('−Rs 50.00');
  });
});

describe('signedRupees', () => {
  it('always shows the direction of a gain or a loss', () => {
    expect(signedRupees(12345)).toBe('+Rs 123.45');
    expect(signedRupees(-12345)).toBe('−Rs 123.45');
    expect(signedRupees(0)).toBe('Rs 0.00');
  });
});

describe('rupeesCompact', () => {
  it('abbreviates once the exact paisa is noise', () => {
    expect(rupeesCompact(50000)).toBe('Rs 500');
    expect(rupeesCompact(150000)).toBe('Rs 1.5K');
    expect(rupeesCompact(250000000)).toBe('Rs 2.5M');
    expect(rupeesCompact(300000000000)).toBe('Rs 3.0B');
  });

  it('keeps the sign', () => {
    expect(rupeesCompact(-250000000)).toBe('−Rs 2.5M');
  });
});

describe('percentFromBps', () => {
  it('reads basis points as a percentage', () => {
    expect(percentFromBps(1234)).toBe('+12.3%');
    expect(percentFromBps(-6170)).toBe('−61.7%');
    expect(percentFromBps(0)).toBe('0.0%');
    expect(percentFromBps(null)).toBe('—');
  });
});

describe('percent', () => {
  it('reads a fraction as a percentage', () => {
    expect(percent(0.51)).toBe('51%');
    expect(percent(0.5123, 1)).toBe('51.2%');
    expect(percent(null)).toBe('—');
  });
});

describe('shares', () => {
  it('groups share counts', () => {
    expect(shares(200)).toBe('200');
    expect(shares(12500)).toBe('12,500');
  });
});

describe('shortDate', () => {
  it('reads an ISO date without a timezone shift', () => {
    // Parsed by pattern rather than by `new Date`, so a date never slides to
    // the previous day for a reader east of UTC.
    expect(shortDate('2026-10-21')).toBe('21 Oct 2026');
    expect(shortDate('2026-01-01')).toBe('1 Jan 2026');
    expect(shortDate('2026-12-31T18:30:00.000Z')).toBe('31 Dec 2026');
  });

  it('returns anything unparseable unchanged', () => {
    expect(shortDate('not a date')).toBe('not a date');
    expect(shortDate(null)).toBe('—');
  });
});

describe('countdown', () => {
  it('counts a code down to its expiry', () => {
    expect(countdown(10 * 60 * 1000)).toBe('10:00');
    expect(countdown(59_400)).toBe('1:00');
    expect(countdown(5_000)).toBe('0:05');
    expect(countdown(0)).toBe('expired');
    expect(countdown(-1_000)).toBe('expired');
  });
});
