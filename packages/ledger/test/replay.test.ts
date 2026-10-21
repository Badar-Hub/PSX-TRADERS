import { describe, expect, it } from 'vitest';
import { rupeesToPaisa } from '@psx/shared';
import { LedgerError } from '../src/lots.js';
import {
  buildPosition,
  replayTrades,
  sortTradesForReplay,
  type TradeRecord,
} from '../src/replay.js';

const rs = (value: string) => rupeesToPaisa(value);

function buy(id: string, tradedOn: string, quantity: number, price: string, charges = '0'): TradeRecord {
  return { id, side: 'BUY', tradedOn, quantity, unitPrice: rs(price), charges: rs(charges) };
}

function sell(id: string, tradedOn: string, quantity: number, price: string, charges = '0'): TradeRecord {
  return { id, side: 'SELL', tradedOn, quantity, unitPrice: rs(price), charges: rs(charges) };
}

describe('sortTradesForReplay', () => {
  it('puts buys before sells on the same date', () => {
    const sorted = sortTradesForReplay([
      sell('s', '2026-03-01', 10, '100'),
      buy('b', '2026-03-01', 10, '90'),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['b', 's']);
  });

  it('respects an explicit sequence over the buy-first default', () => {
    const sorted = sortTradesForReplay([
      { ...sell('s', '2026-03-01', 10, '100'), sequence: 1 },
      { ...buy('b', '2026-03-01', 10, '90'), sequence: 2 },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['s', 'b']);
  });

  it('orders by date first', () => {
    const sorted = sortTradesForReplay([
      buy('late', '2026-06-01', 1, '10'),
      buy('early', '2026-01-01', 1, '10'),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['early', 'late']);
  });
});

describe('replayTrades', () => {
  it('opens a lot per purchase and reports the holding', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00', '15.00'),
      buy('t2', '2026-02-05', 50, '120.00', '9.00'),
    ]);

    expect(result.quantity).toBe(150);
    expect(result.costBasis).toBe(rs('16024.00'));
    expect(result.openLots).toHaveLength(2);
    expect(result.totalCharges).toBe(rs('24.00'));
    expect(result.realisations).toEqual([]);
  });

  it('realises a gain on a sale, FIFO', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      buy('t2', '2026-02-05', 100, '150.00'),
      sell('t3', '2026-06-05', 100, '180.00'),
    ]);

    expect(result.realisations).toHaveLength(1);
    expect(result.realisations[0]?.realisedPnl).toBe(rs('8000.00'));
    expect(result.totalRealisedPnl).toBe(rs('8000.00'));
    expect(result.quantity).toBe(100);
    // The 150.00 lot is what is left.
    expect(result.costBasis).toBe(rs('15000.00'));
  });

  it('refuses a sale with no position, naming the likely cause', () => {
    expect(() => replayTrades([sell('t1', '2026-01-05', 10, '100.00')], { symbol: 'ABL' })).toThrow(
      LedgerError,
    );
    try {
      replayTrades([sell('t1', '2026-01-05', 10, '100.00')], { symbol: 'ABL' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('bonus issue has not been applied');
    }
  });

  it('refuses a fractional quantity', () => {
    expect(() => replayTrades([{ ...buy('t1', '2026-01-05', 1, '10'), quantity: 1.5 }])).toThrow(
      LedgerError,
    );
  });
});

describe('position cycles', () => {
  it('closes a cycle when the position returns to flat', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 100, '130.00'),
    ]);

    expect(result.cycles).toHaveLength(1);
    const cycle = result.cycles[0];
    expect(cycle?.isOpen).toBe(false);
    expect(cycle?.openedOn).toBe('2026-01-05');
    expect(cycle?.closedOn).toBe('2026-03-05');
    expect(cycle?.holdingDays).toBe(59);
    expect(cycle?.realisedPnl).toBe(rs('3000.00'));
    expect(cycle?.entryAveragePrice).toBe(rs('100.00'));
    expect(cycle?.exitAveragePrice).toBe(rs('130.00'));
  });

  it('separates two round trips in the same stock', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 100, '130.00'),
      buy('t3', '2026-05-05', 100, '110.00'),
      sell('t4', '2026-08-05', 100, '95.00'),
    ]);

    expect(result.cycles).toHaveLength(2);
    expect(result.cycles[0]?.realisedPnl).toBe(rs('3000.00'));
    expect(result.cycles[1]?.realisedPnl).toBe(rs('-1500.00'));
    // The point of cycles: a good March trade and a bad August one stay apart,
    // where a single total would report a bland +1,500.
    expect(result.totalRealisedPnl).toBe(rs('1500.00'));
  });

  it('leaves the current cycle open and reports it', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 40, '130.00'),
    ]);

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]?.isOpen).toBe(true);
    expect(result.cycles[0]?.closedOn).toBeNull();
    expect(result.cycles[0]?.sharesBought).toBe(100);
    expect(result.cycles[0]?.sharesSold).toBe(40);
  });

  it('weights the entry average by size, not by trade count', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 10, '100.00'),
      buy('t2', '2026-01-06', 90, '200.00'),
      sell('t3', '2026-03-05', 100, '250.00'),
    ]);
    // Naive mean of prices would be 150.00; weighted is 190.00.
    expect(result.cycles[0]?.entryAveragePrice).toBe(rs('190.00'));
  });
});

/**
 * Buy-back tracking: recording a repurchase of something sold, and whether
 * stepping out actually paid.
 */
describe('buy-backs', () => {
  it('records a repurchase after a full exit and credits the saving', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 100, '130.00'),
      buy('t3', '2026-04-05', 100, '110.00'),
    ]);

    expect(result.buyBacks).toHaveLength(1);
    const back = result.buyBacks[0];
    expect(back?.fullyExited).toBe(true);
    expect(back?.previousExitPrice).toBe(rs('130.00'));
    expect(back?.buyPrice).toBe(rs('110.00'));
    expect(back?.daysOut).toBe(31);
    // Sold at 130, back in at 110: 20.00 a share better on 100 shares.
    expect(back?.advantage).toBe(rs('2000.00'));
    // -1538 bps is about -15.4%.
    expect(back?.priceChangeBps).toBe(-1538);
  });

  it('reports a negative advantage when the repurchase was dearer', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 100, '130.00'),
      buy('t3', '2026-04-05', 100, '150.00'),
    ]);

    const back = result.buyBacks[0];
    // Stepping out cost 20.00 a share.
    expect(back?.advantage).toBe(rs('-2000.00'));
    expect(back?.priceChangeBps).toBe(1538);
  });

  it('tracks adding back after only trimming a position', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 40, '130.00'),
      buy('t3', '2026-04-05', 40, '120.00'),
    ]);

    expect(result.buyBacks).toHaveLength(1);
    expect(result.buyBacks[0]?.fullyExited).toBe(false);
    expect(result.buyBacks[0]?.previousExitQuantity).toBe(40);
    expect(result.buyBacks[0]?.advantage).toBe(rs('400.00'));
  });

  it('bounds the advantage by the shares actually sold', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 10, '130.00'),
      // Buying 100 after selling only 10 is mostly a new position, so only the
      // 10 repurchased shares count as bought back.
      buy('t3', '2026-04-05', 100, '110.00'),
    ]);
    expect(result.buyBacks[0]?.advantage).toBe(rs('200.00'));
  });

  it('averages a run of sales before the repurchase', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 50, '120.00'),
      sell('t3', '2026-03-06', 50, '140.00'),
      buy('t4', '2026-04-05', 100, '110.00'),
    ]);
    expect(result.buyBacks[0]?.previousExitPrice).toBe(rs('130.00'));
    expect(result.buyBacks[0]?.previousExitQuantity).toBe(100);
  });

  it('does not call an initial purchase a buy-back', () => {
    const result = replayTrades([buy('t1', '2026-01-05', 100, '100.00')]);
    expect(result.buyBacks).toEqual([]);
  });

  it('does not call adding to a position a buy-back', () => {
    const result = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      buy('t2', '2026-02-05', 100, '110.00'),
    ]);
    expect(result.buyBacks).toEqual([]);
  });
});

describe('buildPosition', () => {
  it('values an open holding against a market price', () => {
    const replay = replayTrades([buy('t1', '2026-01-05', 100, '100.00', '15.00')]);
    const position = buildPosition('ABL', replay.openLots, rs('120.00'));

    expect(position.quantity).toBe(100);
    expect(position.costBasis).toBe(rs('10015.00'));
    expect(position.averageCost).toBe(rs('100.15'));
    expect(position.marketValue).toBe(rs('12000.00'));
    expect(position.unrealisedPnl).toBe(rs('1985.00'));
    expect(position.unrealisedPnlBps).toBe(1982);
  });

  it('leaves the valuation unreported when no price is known', () => {
    const replay = replayTrades([buy('t1', '2026-01-05', 100, '100.00')]);
    const position = buildPosition('ABL', replay.openLots, null);
    expect(position.marketValue).toBeNull();
    expect(position.unrealisedPnl).toBeNull();
    expect(position.unrealisedPnlBps).toBeNull();
  });

  it('handles a closed position', () => {
    const replay = replayTrades([
      buy('t1', '2026-01-05', 100, '100.00'),
      sell('t2', '2026-03-05', 100, '130.00'),
    ]);
    const position = buildPosition('ABL', replay.openLots, rs('140.00'));
    expect(position.quantity).toBe(0);
    expect(position.averageCost).toBeNull();
    expect(position.unrealisedPnl).toBe(0);
  });
});
