import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  allocatePaisa,
  applyBasisPoints,
  multiplyByQuantity,
  paisa,
  paisaToRupeeString,
  roundToPaisa,
  rupeesToPaisa,
} from './money.js';

describe('rupeesToPaisa', () => {
  it('parses whole and fractional rupees', () => {
    expect(rupeesToPaisa('100')).toBe(10_000);
    expect(rupeesToPaisa('170.19')).toBe(17_019);
    expect(rupeesToPaisa('0.05')).toBe(5);
    expect(rupeesToPaisa('1,234.56')).toBe(123_456);
    expect(rupeesToPaisa('-50.25')).toBe(-5025);
  });

  it('treats a single decimal place as tens of paisa', () => {
    expect(rupeesToPaisa('20.5')).toBe(2050);
  });

  it('rejects sub-paisa precision instead of silently rounding it away', () => {
    expect(() => rupeesToPaisa('10.001')).toThrow(MoneyError);
  });

  it('rejects junk', () => {
    expect(() => rupeesToPaisa('abc')).toThrow(MoneyError);
    expect(() => rupeesToPaisa('')).toThrow(MoneyError);
  });

  it('round-trips through the string form', () => {
    for (const value of ['0.00', '1.05', '947.72', '165930.98']) {
      expect(paisaToRupeeString(rupeesToPaisa(value))).toBe(value);
    }
  });
});

describe('float avoidance', () => {
  it('keeps the classic 0.1 + 0.2 case exact', () => {
    const sum = rupeesToPaisa('0.10') + rupeesToPaisa('0.20');
    expect(sum).toBe(30);
    expect(paisaToRupeeString(paisa(sum))).toBe('0.30');
  });

  it('is exact over a long run of odd amounts where floats would drift', () => {
    let total = 0;
    for (let i = 0; i < 10_000; i += 1) total += rupeesToPaisa('0.07');
    expect(total).toBe(70_000);

    let naive = 0;
    for (let i = 0; i < 10_000; i += 1) naive += 0.07;
    expect(naive).not.toBe(700);
  });
});

describe('roundToPaisa', () => {
  it('rounds half away from zero symmetrically', () => {
    expect(roundToPaisa(10.5)).toBe(11);
    expect(roundToPaisa(-10.5)).toBe(-11);
    expect(roundToPaisa(10.4)).toBe(10);
    expect(roundToPaisa(-10.4)).toBe(-10);
  });

  it('supports banker rounding when asked', () => {
    expect(roundToPaisa(2.5, 'half-even')).toBe(2);
    expect(roundToPaisa(3.5, 'half-even')).toBe(4);
  });
});

describe('multiplyByQuantity', () => {
  it('multiplies price by whole shares exactly', () => {
    expect(multiplyByQuantity(rupeesToPaisa('170.19'), 3085)).toBe(52_503_615);
  });

  it('refuses fractional share counts, which the PSX does not have', () => {
    expect(() => multiplyByQuantity(rupeesToPaisa('10'), 1.5)).toThrow(MoneyError);
  });
});

describe('applyBasisPoints', () => {
  it('applies a 15 bp commission', () => {
    expect(applyBasisPoints(rupeesToPaisa('100000'), 15)).toBe(15_000);
  });

  it('rounds rather than truncating a part-paisa charge', () => {
    expect(applyBasisPoints(paisa(1), 15_000)).toBe(2);
  });
});

describe('allocatePaisa', () => {
  it('distributes without losing or inventing a paisa', () => {
    const parts = allocatePaisa(paisa(100), [1, 1, 1]);
    expect(parts.reduce<number>((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it('weights the split by lot size', () => {
    const parts = allocatePaisa(paisa(1000), [700, 300]);
    expect(parts).toEqual([700, 300]);
  });

  it('always sums back to the total across many awkward splits', () => {
    for (let total = 1; total <= 200; total += 7) {
      for (const weights of [[1, 2], [5, 5, 5], [1, 1, 1, 1, 1, 1, 7]]) {
        const parts = allocatePaisa(paisa(total), weights);
        expect(parts.reduce<number>((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('is deterministic about who receives the leftover', () => {
    expect(allocatePaisa(paisa(10), [3, 3, 4])).toEqual(allocatePaisa(paisa(10), [3, 3, 4]));
  });

  it('rejects weights that cannot define a split', () => {
    expect(() => allocatePaisa(paisa(10), [0, 0])).toThrow(MoneyError);
    expect(() => allocatePaisa(paisa(10), [-1, 2])).toThrow(MoneyError);
  });
});
