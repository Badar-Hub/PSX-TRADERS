import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_CGT_FILER, rupeesToPaisa } from '@psx/shared';
import { applyCorporateAction } from '../src/actions.js';
import { openLot } from '../src/lots.js';
import { buildPosition, replayTrades, type TradeRecord } from '../src/replay.js';
import { buildStatement } from '../src/statement.js';

const rs = (value: string) => rupeesToPaisa(value);

function buy(id: string, tradedOn: string, quantity: number, price: string, charges = '0'): TradeRecord {
  return { id, side: 'BUY', tradedOn, quantity, unitPrice: rs(price), charges: rs(charges) };
}
function sell(id: string, tradedOn: string, quantity: number, price: string, charges = '0'): TradeRecord {
  return { id, side: 'SELL', tradedOn, quantity, unitPrice: rs(price), charges: rs(charges) };
}

/** A winner in ABL, a loser in HBL, and an open position in OGDC. */
function scenario() {
  const abl = replayTrades([
    buy('abl-1', '2026-01-10', 100, '150.00', '22.50'),
    sell('abl-2', '2026-04-10', 100, '180.00', '27.00'),
  ]);
  const hbl = replayTrades([
    buy('hbl-1', '2026-02-10', 50, '280.00', '21.00'),
    sell('hbl-2', '2026-05-10', 50, '260.00', '19.50'),
  ]);
  const ogdc = replayTrades([buy('ogdc-1', '2026-03-10', 200, '290.00', '87.00')]);

  return { abl, hbl, ogdc };
}

describe('buildStatement', () => {
  const { abl, hbl, ogdc } = scenario();

  const input = {
    from: '2026-01-01',
    to: '2026-12-31',
    realisations: [
      { symbol: 'ABL', realisations: abl.realisations },
      { symbol: 'HBL', realisations: hbl.realisations },
    ],
    positions: [buildPosition('OGDC', ogdc.openLots, rs('300.00'))],
    purchaseCharges: rs('130.50'),
  };

  it('separates realised gains from realised losses', () => {
    const statement = buildStatement(input);
    // ABL: 18,000 - 27 proceeds against 15,022.50 basis = +2,950.50
    expect(statement.realisedGains).toBe(rs('2950.50'));
    // HBL: 13,000 - 19.50 against 14,021 = -1,040.50
    expect(statement.realisedLosses).toBe(rs('-1040.50'));
    expect(statement.realisedNet).toBe(rs('1910.00'));
  });

  it('reports unrealised separately, never folded into the realised figure', () => {
    const statement = buildStatement(input);
    // OGDC: 200 at 300 = 60,000 against a basis of 58,087
    expect(statement.unrealisedPnl).toBe(rs('1913.00'));
    expect(statement.bankedNet).toBe(rs('1910.00'));
    expect(statement.totalReturn).toBe(rs('3823.00'));
  });

  it('leaves unrealised unreported when no positions were supplied', () => {
    const statement = buildStatement({ ...input, positions: [] });
    expect(statement.unrealisedPnl).toBeNull();
    expect(statement.totalReturn).toBeNull();
  });

  it('totals the charges paid on both sides', () => {
    const statement = buildStatement(input);
    // 27.00 + 19.50 of sell charges, plus 130.50 of buy charges.
    expect(statement.chargesPaid).toBe(rs('177.00'));
  });

  it('counts wins and losses and the payoff ratio', () => {
    const statement = buildStatement(input);
    expect(statement.tradeCount).toBe(2);
    expect(statement.winningTrades).toBe(1);
    expect(statement.losingTrades).toBe(1);
    expect(statement.winRate).toBe(0.5);
    // 2,950.50 of average win against 1,040.50 of average loss.
    expect(statement.payoffRatio).toBe(2.84);
  });

  it('names the best and worst trade', () => {
    const statement = buildStatement(input);
    expect(statement.bestTrade?.symbol).toBe('ABL');
    expect(statement.worstTrade?.symbol).toBe('HBL');
  });

  it('breaks the result down by security, best first', () => {
    const statement = buildStatement(input);
    // ABL's realised 2,950.50 beats OGDC's unrealised 1,913.00; HBL is negative.
    expect(statement.bySecurity.map((line) => line.symbol)).toEqual(['ABL', 'OGDC', 'HBL']);
    const ablLine = statement.bySecurity.find((line) => line.symbol === 'ABL');
    expect(ablLine?.sharesSold).toBe(100);
    expect(ablLine?.realisedPnl).toBe(rs('2950.50'));
  });

  it('estimates CGT on the net realised result, offsetting the loss', () => {
    const statement = buildStatement({ ...input, cgt: PLACEHOLDER_CGT_FILER });
    // 12.5% of the 1,910.00 net, because losses offset gains in the same year.
    expect(statement.estimatedCgt).toBe(rs('238.75'));
  });

  it('reports no CGT when no schedule is configured', () => {
    expect(buildStatement(input).estimatedCgt).toBeNull();
  });
});

describe('statement periods', () => {
  const { abl, hbl } = scenario();
  const realisations = [
    { symbol: 'ABL', realisations: abl.realisations },
    { symbol: 'HBL', realisations: hbl.realisations },
  ];

  it('includes only sales settled inside the period', () => {
    // April only: the ABL winner, not the May loser.
    const statement = buildStatement({ from: '2026-04-01', to: '2026-04-30', realisations });
    expect(statement.tradeCount).toBe(1);
    expect(statement.realisedNet).toBe(rs('2950.50'));
    expect(statement.bySecurity.map((l) => l.symbol)).toEqual(['ABL']);
  });

  it('is empty for a period with no activity', () => {
    const statement = buildStatement({ from: '2026-07-01', to: '2026-07-31', realisations });
    expect(statement.tradeCount).toBe(0);
    expect(statement.realisedNet).toBe(0);
    expect(statement.winRate).toBeNull();
    expect(statement.bySecurity).toEqual([]);
  });

  it('refuses a period that runs backwards', () => {
    expect(() => buildStatement({ from: '2026-12-31', to: '2026-01-01', realisations })).toThrow();
  });
});

describe('dividend income in the statement', () => {
  it('reports dividends as income, apart from capital gains', () => {
    const lots = [
      openLot({
        id: 'a',
        openedOn: '2026-01-05',
        quantity: 1000,
        unitPrice: rs('100.00'),
        charges: rs('0'),
      }),
    ];
    const dividend = applyCorporateAction(lots, {
      id: 'div1',
      type: 'CASH_DIVIDEND',
      exDate: '2026-06-01',
      amountPerShare: rs('3.00'),
      taxWithheldBps: 1500,
    });

    const statement = buildStatement({
      from: '2026-01-01',
      to: '2026-12-31',
      realisations: [],
      dividends: [{ symbol: 'ENGRO', paidOn: '2026-06-01', result: dividend }],
      positions: [buildPosition('ENGRO', lots, rs('105.00'))],
    });

    expect(statement.dividendGross).toBe(rs('3000.00'));
    expect(statement.dividendTaxWithheld).toBe(rs('450.00'));
    expect(statement.dividendNet).toBe(rs('2550.00'));
    // No sales, so nothing realised: the dividend is the only banked return.
    expect(statement.realisedNet).toBe(0);
    expect(statement.bankedNet).toBe(rs('2550.00'));
    expect(statement.bySecurity[0]?.dividendIncome).toBe(rs('2550.00'));
  });

  it('excludes a dividend paid outside the period', () => {
    const lots = [
      openLot({
        id: 'a',
        openedOn: '2026-01-05',
        quantity: 100,
        unitPrice: rs('100.00'),
        charges: rs('0'),
      }),
    ];
    const dividend = applyCorporateAction(lots, {
      id: 'div1',
      type: 'CASH_DIVIDEND',
      exDate: '2025-06-01',
      amountPerShare: rs('3.00'),
    });

    const statement = buildStatement({
      from: '2026-01-01',
      to: '2026-12-31',
      realisations: [],
      dividends: [{ symbol: 'ENGRO', paidOn: '2025-06-01', result: dividend }],
    });

    expect(statement.dividendNet).toBe(0);
  });
});
