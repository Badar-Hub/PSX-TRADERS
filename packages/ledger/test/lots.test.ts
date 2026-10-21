import { describe, expect, it } from 'vitest';
import { paisa, rupeesToPaisa, type Paisa } from '@psx/shared';
import {
  InsufficientSharesError,
  LedgerError,
  averageCostPerShare,
  matchSale,
  openLot,
  totalCostBasis,
  totalQuantity,
  type OpenLot,
} from '../src/lots.js';

const rs = (value: string) => rupeesToPaisa(value);

function lot(id: string, openedOn: string, quantity: number, unitPrice: string, charges = '0') {
  return openLot({ id, openedOn, quantity, unitPrice: rs(unitPrice), charges: rs(charges) });
}

describe('openLot', () => {
  it('folds buy-side charges into the cost basis', () => {
    // 100 shares at 170.00 = 17,000.00, plus 51.00 of charges.
    const result = lot('a', '2026-01-05', 100, '170.00', '51.00');
    expect(result.costBasis).toBe(rs('17051.00'));
    expect(result.quantity).toBe(100);
    expect(result.source).toBe('PURCHASE');
  });

  it('refuses a fractional or empty lot', () => {
    expect(() => lot('a', '2026-01-05', 0, '10')).toThrow(LedgerError);
    expect(() => lot('a', '2026-01-05', 1.5, '10')).toThrow();
  });
});

describe('averageCostPerShare', () => {
  it('derives the per-share cost from the lot totals', () => {
    const lots = [lot('a', '2026-01-05', 100, '100.00'), lot('b', '2026-02-05', 100, '120.00')];
    expect(averageCostPerShare(lots)).toBe(rs('110.00'));
  });

  it('is null with no shares', () => {
    expect(averageCostPerShare([])).toBeNull();
  });
});

describe('matchSale, FIFO', () => {
  const lots = [
    lot('old', '2026-01-05', 100, '100.00'),
    lot('mid', '2026-03-05', 100, '150.00'),
    lot('new', '2026-06-05', 100, '200.00'),
  ];

  it('consumes the oldest lot first', () => {
    const result = matchSale(lots, {
      soldOn: '2026-07-01',
      quantity: 100,
      unitPrice: rs('180.00'),
      charges: rs('0'),
    });

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.lotId).toBe('old');
    expect(result.allocations[0]?.costBasis).toBe(rs('10000.00'));
    expect(result.allocations[0]?.proceeds).toBe(rs('18000.00'));
    expect(result.realisedPnl).toBe(rs('8000.00'));
    expect(totalQuantity(result.remainingLots)).toBe(200);
  });

  it('spans several lots when one is not enough', () => {
    const result = matchSale(lots, {
      soldOn: '2026-07-01',
      quantity: 250,
      unitPrice: rs('180.00'),
      charges: rs('0'),
    });

    expect(result.allocations.map((a) => a.lotId)).toEqual(['old', 'mid', 'new']);
    expect(result.allocations.map((a) => a.quantitySold)).toEqual([100, 100, 50]);
    // 100@100 + 100@150 + 50@200 = 10,000 + 15,000 + 10,000 = 35,000
    expect(result.totalCostBasis).toBe(rs('35000.00'));
    expect(result.grossProceeds).toBe(rs('45000.00'));
    expect(result.realisedPnl).toBe(rs('10000.00'));
  });

  it('leaves a partially consumed lot with the right share of its basis', () => {
    const result = matchSale(lots, {
      soldOn: '2026-07-01',
      quantity: 150,
      unitPrice: rs('180.00'),
      charges: rs('0'),
    });

    const remaining = result.remainingLots;
    expect(remaining.map((l) => l.id)).toEqual(['mid', 'new']);
    // 50 of the 100-share 150.00 lot was sold, so half its basis is left.
    expect(remaining[0]?.quantity).toBe(50);
    expect(remaining[0]?.costBasis).toBe(rs('7500.00'));
  });

  it('records the holding period of each lot it consumes', () => {
    const result = matchSale(lots, {
      soldOn: '2026-07-01',
      quantity: 150,
      unitPrice: rs('180.00'),
      charges: rs('0'),
    });
    expect(result.allocations[0]?.holdingDays).toBe(177);
    expect(result.allocations[1]?.holdingDays).toBe(118);
  });

  it('breaks same-day ties on id so a replay is reproducible', () => {
    const sameDay = [
      lot('b', '2026-01-05', 10, '100.00'),
      lot('a', '2026-01-05', 10, '200.00'),
    ];
    const result = matchSale(sameDay, {
      soldOn: '2026-02-01',
      quantity: 10,
      unitPrice: rs('150.00'),
      charges: rs('0'),
    });
    expect(result.allocations[0]?.lotId).toBe('a');
  });

  it('does not mutate the lots it was given', () => {
    const original = [lot('x', '2026-01-05', 100, '100.00')];
    const snapshot = JSON.stringify(original);
    matchSale(original, {
      soldOn: '2026-07-01',
      quantity: 40,
      unitPrice: rs('120.00'),
      charges: rs('0'),
    });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('matchSale, LIFO', () => {
  it('consumes the newest lot first', () => {
    const lots = [lot('old', '2026-01-05', 100, '100.00'), lot('new', '2026-06-05', 100, '200.00')];
    const result = matchSale(
      lots,
      { soldOn: '2026-07-01', quantity: 100, unitPrice: rs('180.00'), charges: rs('0') },
      'LIFO',
    );
    expect(result.allocations[0]?.lotId).toBe('new');
    // Sold at 180 what cost 200, so LIFO books a loss where FIFO booked a gain.
    expect(result.realisedPnl).toBe(rs('-2000.00'));
  });
});

describe('matchSale, AVERAGE', () => {
  const lots = [lot('a', '2026-01-05', 100, '100.00'), lot('b', '2026-06-05', 100, '200.00')];

  it('charges the sale at the pooled rate, not the oldest lot', () => {
    const result = matchSale(
      lots,
      { soldOn: '2026-07-01', quantity: 100, unitPrice: rs('180.00'), charges: rs('0') },
      'AVERAGE',
    );
    // Pool is 30,000 over 200 shares, so 100 shares cost 15,000.
    expect(result.totalCostBasis).toBe(rs('15000.00'));
    expect(result.realisedPnl).toBe(rs('3000.00'));
  });

  it('re-bases the surviving shares to the pool average', () => {
    const result = matchSale(
      lots,
      { soldOn: '2026-07-01', quantity: 100, unitPrice: rs('180.00'), charges: rs('0') },
      'AVERAGE',
    );
    expect(totalCostBasis(result.remainingLots)).toBe(rs('15000.00'));
    expect(averageCostPerShare(result.remainingLots)).toBe(rs('150.00'));
  });
});

describe('matchSale, charges', () => {
  it('takes sale charges off the proceeds and so off the gain', () => {
    const lots = [lot('a', '2026-01-05', 100, '100.00')];
    const result = matchSale(lots, {
      soldOn: '2026-07-01',
      quantity: 100,
      unitPrice: rs('120.00'),
      charges: rs('36.50'),
    });

    expect(result.grossProceeds).toBe(rs('12000.00'));
    expect(result.netProceeds).toBe(rs('11963.50'));
    // Gross gain of 2,000 less 36.50 of charges.
    expect(result.realisedPnl).toBe(rs('1963.50'));
  });

  it('splits charges across lots so the allocations sum to the net exactly', () => {
    const lots = [
      lot('a', '2026-01-05', 33, '100.00'),
      lot('b', '2026-02-05', 33, '100.00'),
      lot('c', '2026-03-05', 34, '100.00'),
    ];
    const result = matchSale(lots, {
      soldOn: '2026-07-01',
      quantity: 100,
      unitPrice: rs('120.00'),
      charges: rs('100.01'),
    });

    const summed = result.allocations.reduce<number>((sum, a) => sum + a.proceeds, 0);
    expect(summed).toBe(result.netProceeds);
  });
});

describe('matchSale, refusals', () => {
  it('refuses to sell more than is held', () => {
    const lots = [lot('a', '2026-01-05', 50, '100.00')];
    expect(() =>
      matchSale(
        lots,
        { soldOn: '2026-07-01', quantity: 51, unitPrice: rs('120.00'), charges: rs('0') },
        'FIFO',
        'ABL',
      ),
    ).toThrow(InsufficientSharesError);
  });

  it('explains what is missing rather than failing opaquely', () => {
    const lots = [lot('a', '2026-01-05', 50, '100.00')];
    try {
      matchSale(
        lots,
        { soldOn: '2026-07-01', quantity: 80, unitPrice: rs('120.00'), charges: rs('0') },
        'FIFO',
        'ABL',
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientSharesError);
      expect((error as Error).message).toContain('ABL');
      expect((error as Error).message).toContain('only 50 held');
    }
  });

  it('refuses a zero or fractional sale', () => {
    const lots = [lot('a', '2026-01-05', 50, '100.00')];
    const sale = { soldOn: '2026-07-01', unitPrice: rs('120.00'), charges: rs('0') };
    expect(() => matchSale(lots, { ...sale, quantity: 0 })).toThrow(LedgerError);
    expect(() => matchSale(lots, { ...sale, quantity: 2.5 })).toThrow(LedgerError);
  });

  it('allows selling the entire holding to zero', () => {
    const lots = [lot('a', '2026-01-05', 50, '100.00')];
    const result = matchSale(lots, {
      soldOn: '2026-07-01',
      quantity: 50,
      unitPrice: rs('120.00'),
      charges: rs('0'),
    });
    expect(result.remainingLots).toEqual([]);
    expect(totalQuantity(result.remainingLots)).toBe(0);
  });
});

/**
 * The invariant the whole module exists to protect, checked over randomised
 * histories rather than hand-picked cases.
 *
 * For every lot: basis consumed by sales plus basis still open must equal the
 * basis it opened with, exactly. Awkward prices and share counts are chosen
 * deliberately, because that is where proportional splits stop dividing evenly
 * and a naive implementation starts losing paisa.
 */
describe('cost basis conservation', () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const method of ['FIFO', 'LIFO', 'AVERAGE'] as const) {
    it(`holds across 300 randomised ${method} histories`, () => {
      const random = mulberry32(method === 'FIFO' ? 1 : method === 'LIFO' ? 2 : 3);

      for (let scenario = 0; scenario < 300; scenario += 1) {
        const lotCount = 1 + Math.floor(random() * 5);
        let lots: OpenLot[] = [];
        for (let i = 0; i < lotCount; i += 1) {
          // Prime-ish share counts and odd paisa prices: the hostile case.
          const quantity = 1 + Math.floor(random() * 97);
          const price = paisa(1 + Math.floor(random() * 99_999)) as Paisa;
          const charges = paisa(Math.floor(random() * 997)) as Paisa;
          lots.push(
            openLot({
              id: `lot-${scenario}-${i}`,
              openedOn: `2026-0${1 + (i % 9)}-15`,
              quantity,
              unitPrice: price,
              charges,
            }),
          );
        }

        const openingBasis = totalCostBasis(lots);
        const openingQuantity = totalQuantity(lots);
        let consumedBasis = 0;
        let consumedQuantity = 0;

        // Sell down in random slices until flat.
        let guard = 0;
        while (totalQuantity(lots) > 0 && guard < 20) {
          guard += 1;
          const held = totalQuantity(lots);
          const quantity = 1 + Math.floor(random() * held);
          const result = matchSale(
            lots,
            {
              soldOn: '2026-11-01',
              quantity,
              unitPrice: paisa(1 + Math.floor(random() * 99_999)) as Paisa,
              charges: paisa(Math.floor(random() * 5_000)) as Paisa,
            },
            method,
          );

          // Proceeds must account for every paisa the sale netted.
          const allocatedProceeds = result.allocations.reduce<number>((s, a) => s + a.proceeds, 0);
          expect(allocatedProceeds).toBe(result.netProceeds);

          // Realised P&L must equal proceeds less the basis consumed.
          const allocatedPnl = result.allocations.reduce<number>((s, a) => s + a.realisedPnl, 0);
          expect(allocatedPnl).toBe(result.realisedPnl);

          consumedBasis += result.totalCostBasis;
          consumedQuantity += quantity;
          lots = result.remainingLots;
        }

        expect(consumedQuantity).toBe(openingQuantity);
        // Not "close to": exactly.
        expect(consumedBasis + totalCostBasis(lots)).toBe(openingBasis);
        expect(totalCostBasis(lots)).toBe(0);
      }
    });
  }
});
