import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  categoryLabel,
  money,
  percent,
  percentFromBps,
  rupees,
  rupeesCompact,
  shares,
  shortDate,
  signedRupees,
  toneFor,
} from './format';

/**
 * The formatting layer is the only place in the web app that divides paisa, so
 * it is the only place a money bug can originate. Everything else passes the
 * integer through from the API untouched.
 */

describe('money', () => {
  it('renders paisa as rupees with two decimals', () => {
    expect(money(5_845_400)).toBe('58,454.00');
    expect(money(29_222)).toBe('292.22');
    expect(money(1)).toBe('0.01');
    expect(money(0)).toBe('0.00');
  });

  it('shows an em dash for an absent amount rather than zero', () => {
    // A missing market price and a price of zero are different facts, and
    // showing "0.00" for the first would be a lie.
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money(0)).toBe('0.00');
  });

  it('prefixes with the currency where it matters', () => {
    expect(rupees(6_114_580)).toBe('Rs 61,145.80');
    expect(rupees(null)).toBe('—');
  });

  it('compacts a large figure', () => {
    expect(rupeesCompact(10_909_900_000)).toMatch(/^Rs \d/);
  });
});

describe('signedRupees', () => {
  it('marks a gain and a loss explicitly', () => {
    expect(signedRupees(280_620)).toBe('+Rs 2,806.20');
    // A true minus sign, not a hyphen: it reads correctly at small sizes and
    // aligns with the digits in a tabular column.
    expect(signedRupees(-280_620)).toBe('−Rs 2,806.20');
  });

  it('leaves zero unsigned', () => {
    expect(signedRupees(0)).toBe('Rs 0.00');
  });
});

describe('percentFromBps', () => {
  it('converts basis points to a signed percentage', () => {
    expect(percentFromBps(1982)).toBe('+19.8%');
    expect(percentFromBps(-2148)).toBe('−21.5%');
    expect(percentFromBps(0)).toBe('0.0%');
  });

  it('handles an absent value', () => {
    expect(percentFromBps(null)).toBe('—');
  });
});

describe('percent', () => {
  it('renders a fraction', () => {
    expect(percent(0.54)).toBe('54%');
    expect(percent(0.536, 1)).toBe('53.6%');
    expect(percent(null)).toBe('—');
  });
});

describe('toneFor', () => {
  /**
   * Zero is neutral, not green. Colouring a flat position as a gain would
   * misreport it, and it is the common case for a holding bought today.
   */
  it('is neutral for zero and for an absent value', () => {
    expect(toneFor(0)).toContain('slate');
    expect(toneFor(null)).toContain('slate');
    expect(toneFor(undefined)).toContain('slate');
  });

  it('is green above zero and red below', () => {
    expect(toneFor(1)).toContain('emerald');
    expect(toneFor(-1)).toContain('rose');
  });
});

describe('shortDate', () => {
  it('renders an ISO date readably', () => {
    expect(shortDate('2026-10-21')).toBe('21 Oct 2026');
    expect(shortDate('2026-01-01')).toBe('1 Jan 2026');
  });

  /**
   * Parsed as UTC. Treating a trading date as a local timestamp shifts it by a
   * day for anyone west of Greenwich, which would misdate every trade.
   */
  it('does not shift the date by a timezone', () => {
    expect(shortDate('2026-01-01')).toContain('2026');
    expect(shortDate('2026-01-01')).toContain('1 Jan');
  });

  it('passes through something it cannot parse', () => {
    expect(shortDate('not-a-date')).toBe('not-a-date');
    expect(shortDate(null)).toBe('—');
  });
});

describe('labels', () => {
  it('renders an action readably', () => {
    expect(actionLabel('STRONG_BUY')).toBe('Strong Buy');
    expect(actionLabel('HOLD')).toBe('Hold');
  });

  it('renders a factor category readably', () => {
    expect(categoryLabel('PATTERN')).toBe('Candlestick patterns');
    expect(categoryLabel('TREND')).toBe('Trend');
    // An unknown category passes through rather than rendering as blank.
    expect(categoryLabel('NEW_THING')).toBe('NEW_THING');
  });
});

describe('shares', () => {
  it('groups thousands', () => {
    expect(shares(1000)).toBe('1,000');
    expect(shares(200)).toBe('200');
  });
});
