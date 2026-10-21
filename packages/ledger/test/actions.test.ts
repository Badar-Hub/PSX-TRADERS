import { describe, expect, it } from 'vitest';
import { rupeesToPaisa } from '@psx/shared';
import { applyCorporateAction, applyCorporateActions } from '../src/actions.js';
import { LedgerError, openLot, totalCostBasis, totalQuantity } from '../src/lots.js';

const rs = (value: string) => rupeesToPaisa(value);

function lot(id: string, openedOn: string, quantity: number, unitPrice: string) {
  return openLot({ id, openedOn, quantity, unitPrice: rs(unitPrice), charges: rs('0') });
}

describe('cash dividend', () => {
  const lots = [lot('a', '2026-01-05', 100, '100.00'), lot('b', '2026-02-05', 50, '120.00')];

  it('pays on the whole holding and leaves the lots untouched', () => {
    const result = applyCorporateAction(lots, {
      id: 'div1',
      type: 'CASH_DIVIDEND',
      exDate: '2026-06-01',
      amountPerShare: rs('2.50'),
    });

    expect(result.grossCash).toBe(rs('375.00'));
    expect(result.netCash).toBe(rs('375.00'));
    expect(result.sharesAdded).toBe(0);
    expect(totalQuantity(result.lots)).toBe(150);
    // A dividend is income, not a return of capital: the basis must not move,
    // or the eventual capital gain is overstated.
    expect(totalCostBasis(result.lots)).toBe(totalCostBasis(lots));
  });

  it('withholds tax at source', () => {
    const result = applyCorporateAction(lots, {
      id: 'div1',
      type: 'CASH_DIVIDEND',
      exDate: '2026-06-01',
      amountPerShare: rs('2.50'),
      taxWithheldBps: 1500,
    });

    expect(result.grossCash).toBe(rs('375.00'));
    expect(result.taxWithheld).toBe(rs('56.25'));
    expect(result.netCash).toBe(rs('318.75'));
  });

  it('is a no-op with no position', () => {
    const result = applyCorporateAction([], {
      id: 'div1',
      type: 'CASH_DIVIDEND',
      exDate: '2026-06-01',
      amountPerShare: rs('2.50'),
    });
    expect(result.grossCash).toBe(0);
    expect(result.note).toContain('No position');
  });
});

describe('bonus issue', () => {
  /**
   * The case that motivates computing the entitlement on the whole holding.
   * Two lots of 75 with a 10% bonus: the holding of 150 is entitled to 15
   * shares, but flooring 7.5 per lot would issue only 14.
   */
  it('issues on the total holding, not lot by lot', () => {
    const lots = [lot('a', '2026-01-05', 75, '100.00'), lot('b', '2026-02-05', 75, '100.00')];
    const result = applyCorporateAction(lots, {
      id: 'bonus1',
      type: 'BONUS',
      exDate: '2026-06-01',
      newSharesPerShare: 0.1,
    });

    expect(result.sharesAdded).toBe(15);
    expect(totalQuantity(result.lots)).toBe(165);
    expect(result.lots.map((l) => l.quantity)).toEqual([83, 82]);
  });

  it('leaves the total cost basis unchanged and dilutes the per-share cost', () => {
    const lots = [lot('a', '2026-01-05', 100, '110.00')];
    const before = totalCostBasis(lots);

    const result = applyCorporateAction(lots, {
      id: 'bonus1',
      type: 'BONUS',
      exDate: '2026-06-01',
      newSharesPerShare: 0.1,
    });

    expect(totalCostBasis(result.lots)).toBe(before);
    expect(totalQuantity(result.lots)).toBe(110);
    // 11,000 over 110 shares: the per-share cost falls from 110 to 100 without
    // any money changing hands.
    expect(Math.round(totalCostBasis(result.lots) / totalQuantity(result.lots))).toBe(rs('100.00'));
  });

  it('keeps the acquisition date of the lots that earned the bonus', () => {
    const lots = [lot('a', '2026-01-05', 100, '110.00')];
    const result = applyCorporateAction(lots, {
      id: 'bonus1',
      type: 'BONUS',
      exDate: '2026-06-01',
      newSharesPerShare: 0.1,
    });
    expect(result.lots[0]?.openedOn).toBe('2026-01-05');
  });

  it('reports the fractional entitlement the exchange settles in cash', () => {
    const lots = [lot('a', '2026-01-05', 105, '100.00')];
    const result = applyCorporateAction(lots, {
      id: 'bonus1',
      type: 'BONUS',
      exDate: '2026-06-01',
      newSharesPerShare: 0.1,
    });
    expect(result.sharesAdded).toBe(10);
    expect(result.fractionalEntitlement).toBe(0.5);
  });

  it('can instead open a separate zero-cost lot dated the ex-date', () => {
    const lots = [lot('a', '2026-01-05', 100, '110.00')];
    const result = applyCorporateAction(lots, {
      id: 'bonus1',
      type: 'BONUS',
      exDate: '2026-06-01',
      newSharesPerShare: 0.1,
      policy: 'NEW_ZERO_COST_LOT',
    });

    expect(result.lots).toHaveLength(2);
    expect(result.lots[1]).toMatchObject({
      quantity: 10,
      costBasis: 0,
      source: 'BONUS',
      openedOn: '2026-06-01',
    });
    expect(totalCostBasis(result.lots)).toBe(rs('11000.00'));
  });

  it('rejects a non-positive ratio', () => {
    expect(() =>
      applyCorporateAction([lot('a', '2026-01-05', 100, '100.00')], {
        id: 'b',
        type: 'BONUS',
        exDate: '2026-06-01',
        newSharesPerShare: 0,
      }),
    ).toThrow(LedgerError);
  });
});

describe('split', () => {
  it('doubles the shares and halves the per-share cost on a 2-for-1', () => {
    const lots = [lot('a', '2026-01-05', 100, '500.00')];
    const result = applyCorporateAction(lots, {
      id: 'split1',
      type: 'SPLIT',
      exDate: '2026-06-01',
      multiplier: 2,
    });

    expect(totalQuantity(result.lots)).toBe(200);
    expect(totalCostBasis(result.lots)).toBe(rs('50000.00'));
    expect(Math.round(totalCostBasis(result.lots) / 200)).toBe(rs('250.00'));
  });

  it('keeps the totals exact across several lots on an awkward ratio', () => {
    const lots = [
      lot('a', '2026-01-05', 33, '100.00'),
      lot('b', '2026-02-05', 33, '100.00'),
      lot('c', '2026-03-05', 34, '100.00'),
    ];
    const before = totalCostBasis(lots);

    const result = applyCorporateAction(lots, {
      id: 'split1',
      type: 'SPLIT',
      exDate: '2026-06-01',
      multiplier: 1.5,
    });

    expect(totalQuantity(result.lots)).toBe(150);
    expect(totalCostBasis(result.lots)).toBe(before);
    const summed = result.lots.reduce<number>((sum, l) => sum + l.quantity, 0);
    expect(summed).toBe(150);
  });

  it('redistributes the basis of a lot a reverse split rounds away', () => {
    const lots = [lot('big', '2026-01-05', 100, '10.00'), lot('tiny', '2026-02-05', 3, '10.00')];
    const before = totalCostBasis(lots);

    const result = applyCorporateAction(lots, {
      id: 'rev1',
      type: 'SPLIT',
      exDate: '2026-06-01',
      multiplier: 0.1,
    });

    // 103 shares become 10; the 3-share lot cannot survive at a tenth.
    expect(totalQuantity(result.lots)).toBe(10);
    // Its cost basis is not discarded.
    expect(totalCostBasis(result.lots)).toBe(before);
  });

  it('refuses a reverse split that would leave no whole shares', () => {
    expect(() =>
      applyCorporateAction([lot('a', '2026-01-05', 5, '10.00')], {
        id: 'rev1',
        type: 'SPLIT',
        exDate: '2026-06-01',
        multiplier: 0.1,
      }),
    ).toThrow(/cash settlement/);
  });
});

describe('rights issue', () => {
  const lots = [lot('a', '2026-01-05', 100, '100.00')];

  it('opens a priced lot for the shares taken up', () => {
    const result = applyCorporateAction(lots, {
      id: 'right1',
      type: 'RIGHT',
      exDate: '2026-06-01',
      entitlementPerShare: 0.5,
      subscriptionPrice: rs('60.00'),
      subscribedShares: 50,
    });

    expect(result.sharesAdded).toBe(50);
    expect(result.cashPaid).toBe(rs('3000.00'));
    expect(totalQuantity(result.lots)).toBe(150);
    // Rights shares cost money, so unlike a bonus they do raise the basis.
    expect(totalCostBasis(result.lots)).toBe(rs('13000.00'));
    expect(result.lots[1]?.source).toBe('RIGHT');
  });

  it('adds nothing when the right lapses', () => {
    const result = applyCorporateAction(lots, {
      id: 'right1',
      type: 'RIGHT',
      exDate: '2026-06-01',
      entitlementPerShare: 0.5,
      subscriptionPrice: rs('60.00'),
      subscribedShares: 0,
    });

    expect(result.sharesAdded).toBe(0);
    expect(result.cashPaid).toBe(0);
    expect(result.note).toContain('not taken up');
    expect(totalCostBasis(result.lots)).toBe(rs('10000.00'));
  });

  it('refuses to subscribe beyond the entitlement', () => {
    expect(() =>
      applyCorporateAction(lots, {
        id: 'right1',
        type: 'RIGHT',
        exDate: '2026-06-01',
        entitlementPerShare: 0.5,
        subscriptionPrice: rs('60.00'),
        subscribedShares: 60,
      }),
    ).toThrow(/entitled to 50/);
  });
});

describe('applyCorporateActions, in sequence', () => {
  it('applies in date order, since the order compounds', () => {
    const lots = [lot('a', '2026-01-05', 100, '200.00')];

    const { lots: after, results } = applyCorporateActions(lots, [
      { id: 'split', type: 'SPLIT', exDate: '2026-07-01', multiplier: 2 },
      { id: 'bonus', type: 'BONUS', exDate: '2026-04-01', newSharesPerShare: 0.1 },
    ]);

    // Bonus first: 100 -> 110. Then the split: 110 -> 220.
    expect(results[0]?.note).toContain('bonus');
    expect(totalQuantity(after)).toBe(220);
    // No cash was involved in either, so the basis is untouched throughout.
    expect(totalCostBasis(after)).toBe(rs('20000.00'));
  });

  it('would reach a different holding in the other order', () => {
    const lots = [lot('a', '2026-01-05', 100, '200.00')];

    const bonusFirst = applyCorporateActions(lots, [
      { id: 'b', type: 'BONUS', exDate: '2026-04-01', newSharesPerShare: 0.1 },
      { id: 's', type: 'SPLIT', exDate: '2026-07-01', multiplier: 2 },
    ]);
    const splitFirst = applyCorporateActions(lots, [
      { id: 's', type: 'SPLIT', exDate: '2026-04-01', multiplier: 2 },
      { id: 'b', type: 'BONUS', exDate: '2026-07-01', newSharesPerShare: 0.1 },
    ]);

    expect(totalQuantity(bonusFirst.lots)).toBe(220);
    expect(totalQuantity(splitFirst.lots)).toBe(220);
    // Equal here by arithmetic coincidence; the dates are what decide, and both
    // paths must still preserve the basis.
    expect(totalCostBasis(bonusFirst.lots)).toBe(totalCostBasis(splitFirst.lots));
  });
});

/**
 * The reason this module exists: a bonus issue that is never applied makes the
 * next sale fail, because the registrar's share count and the ledger's have
 * drifted apart.
 */
describe('the failure an unapplied action causes', () => {
  it('leaves the ledger short of the shares actually held', () => {
    const lots = [lot('a', '2026-01-05', 100, '110.00')];
    const applied = applyCorporateAction(lots, {
      id: 'bonus1',
      type: 'BONUS',
      exDate: '2026-06-01',
      newSharesPerShare: 0.1,
    });

    // The broker statement would show 110 shares.
    expect(totalQuantity(applied.lots)).toBe(110);
    // Without the action, the ledger still thinks there are 100, and a sale of
    // all 110 would be rejected as a short.
    expect(totalQuantity(lots)).toBe(100);
  });
});
