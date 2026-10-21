import {
  ZERO,
  addPaisa,
  daysBetween,
  multiplyByQuantity,
  paisa,
  subPaisa,
  type CostBasisMethod,
  type IsoDate,
  type Paisa,
  type TradeSide,
} from '@psx/shared';
import {
  LedgerError,
  matchSale,
  openLot,
  totalCostBasis,
  totalQuantity,
  type LotAllocation,
  type OpenLot,
} from './lots.js';

/**
 * Replays a trade history into the state derived from it.
 *
 * The trade ledger is the only thing this system stores as fact. Open lots,
 * realised gains, positions and cycles are all derived by replaying that ledger
 * from the beginning, which is what makes a correction safe: fix the trade and
 * everything downstream follows, with no stored total left disagreeing with the
 * history behind it.
 *
 * That choice costs a replay per query and buys the ability to answer "why is
 * this number what it is" for any figure in the app, which for an accounting
 * system is the more valuable half of the trade.
 */

export interface TradeRecord {
  id: string;
  side: TradeSide;
  tradedOn: IsoDate;
  quantity: number;
  unitPrice: Paisa;
  /** Total charges on this order. Added to a buy's cost, taken off a sale. */
  charges: Paisa;
  /**
   * Orders the trade within its date. Without it, two trades on one day have no
   * defined order, and a sale replayed before its purchase fails.
   */
  sequence?: number;
}

/** What one sale realised, and against which lots. */
export interface Realisation {
  tradeId: string;
  soldOn: IsoDate;
  quantity: number;
  unitPrice: Paisa;
  grossProceeds: Paisa;
  netProceeds: Paisa;
  costBasis: Paisa;
  realisedPnl: Paisa;
  charges: Paisa;
  allocations: LotAllocation[];
}

/**
 * One round trip: from opening a position to going flat again.
 *
 * Cycles are what make "how did I do on this stock" answerable. A single
 * realised-gain total mixes together a good trade in March and a bad one in
 * September; cycles keep them apart.
 */
export interface PositionCycle {
  index: number;
  openedOn: IsoDate;
  closedOn: IsoDate | null;
  isOpen: boolean;
  sharesBought: number;
  sharesSold: number;
  /** Total paid for shares bought in this cycle, charges included. */
  totalInvested: Paisa;
  /** Total received from shares sold in this cycle, charges deducted. */
  totalProceeds: Paisa;
  realisedPnl: Paisa;
  entryAveragePrice: Paisa;
  exitAveragePrice: Paisa | null;
  holdingDays: number | null;
  tradeIds: string[];
}

/**
 * A repurchase of something previously sold.
 *
 * Recorded because selling and buying back is a decision with an outcome that
 * no other figure in a portfolio captures. The realised gain shows what the
 * exit made; it says nothing about whether getting out and back in beat simply
 * holding. `advantage` answers that, in rupees.
 *
 * Detected against the most recent run of sales rather than only full exits, so
 * trimming a position and adding back to it is reported too.
 */
export interface BuyBack {
  buyTradeId: string;
  boughtOn: IsoDate;
  quantity: number;
  buyPrice: Paisa;
  /** Weighted average price of the sales immediately preceding this buy. */
  previousExitPrice: Paisa;
  previousExitOn: IsoDate;
  /** Shares sold in that run, which bounds how much was really bought back. */
  previousExitQuantity: number;
  daysOut: number;
  /** Negative means bought back cheaper than sold. */
  priceChangeBps: number;
  /**
   * Rupee benefit of having been out, over the shares actually bought back:
   * positive when the repurchase was cheaper than the exit.
   */
  advantage: Paisa;
  /** Whether the position had gone fully flat before this buy. */
  fullyExited: boolean;
}

export interface ReplayResult {
  openLots: OpenLot[];
  quantity: number;
  costBasis: Paisa;
  realisations: Realisation[];
  cycles: PositionCycle[];
  buyBacks: BuyBack[];
  totalRealisedPnl: Paisa;
  /** Charges across every trade, buy and sell. The cost of doing business. */
  totalCharges: Paisa;
}

/**
 * Sorts trades into replay order.
 *
 * Same-date ties put buys first. A sale cannot be replayed before the purchase
 * it closes, and on the PSX settlement means a same-day sale of shares bought
 * that morning is the ordinary case rather than a short. Explicit `sequence`
 * overrides this when the real order is known from the contract notes.
 */
export function sortTradesForReplay(trades: readonly TradeRecord[]): TradeRecord[] {
  return [...trades].sort((a, b) => {
    if (a.tradedOn !== b.tradedOn) return a.tradedOn < b.tradedOn ? -1 : 1;
    const aSeq = a.sequence;
    const bSeq = b.sequence;
    if (aSeq !== undefined && bSeq !== undefined && aSeq !== bSeq) return aSeq - bSeq;
    if (a.side !== b.side) return a.side === 'BUY' ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

interface SellRun {
  quantity: number;
  /** Gross value sold, for a quantity-weighted average exit price. */
  grossValue: number;
  lastSoldOn: IsoDate;
  wentFlat: boolean;
}

/**
 * Replays one security's trades in one portfolio.
 *
 * Scoped to a single security deliberately: lots, cycles and buy-backs are all
 * per-symbol concepts, and a function that took a mixed history would have to
 * group internally and could silently match a sale against the wrong stock.
 */
export function replayTrades(
  trades: readonly TradeRecord[],
  options: { method?: CostBasisMethod; symbol?: string; lotIdPrefix?: string } = {},
): ReplayResult {
  const method = options.method ?? 'FIFO';
  const prefix = options.lotIdPrefix ?? 'lot';
  const ordered = sortTradesForReplay(trades);

  let lots: OpenLot[] = [];
  const realisations: Realisation[] = [];
  const cycles: PositionCycle[] = [];
  const buyBacks: BuyBack[] = [];

  let position = 0;
  let totalCharges: Paisa = ZERO;
  let current: PositionCycle | null = null;
  let sellRun: SellRun | null = null;

  for (const trade of ordered) {
    if (!Number.isInteger(trade.quantity) || trade.quantity <= 0) {
      throw new LedgerError(
        `Trade ${trade.id} has a non-positive or fractional quantity (${trade.quantity})`,
      );
    }
    totalCharges = addPaisa(totalCharges, trade.charges);

    if (trade.side === 'BUY') {
      if (current === null) {
        current = {
          index: cycles.length,
          openedOn: trade.tradedOn,
          closedOn: null,
          isOpen: true,
          sharesBought: 0,
          sharesSold: 0,
          totalInvested: ZERO,
          totalProceeds: ZERO,
          realisedPnl: ZERO,
          entryAveragePrice: ZERO,
          exitAveragePrice: null,
          holdingDays: null,
          tradeIds: [],
        };
      }

      // A buy straight after a run of sales is a repurchase, whether the
      // position had gone flat or was only trimmed.
      if (sellRun !== null) {
        const exitPrice = paisa(Math.round(sellRun.grossValue / sellRun.quantity));
        const boughtBack = Math.min(trade.quantity, sellRun.quantity);
        const perShare = subPaisa(exitPrice, trade.unitPrice);
        buyBacks.push({
          buyTradeId: trade.id,
          boughtOn: trade.tradedOn,
          quantity: trade.quantity,
          buyPrice: trade.unitPrice,
          previousExitPrice: exitPrice,
          previousExitOn: sellRun.lastSoldOn,
          previousExitQuantity: sellRun.quantity,
          daysOut: daysBetween(sellRun.lastSoldOn, trade.tradedOn),
          priceChangeBps:
            exitPrice === 0 ? 0 : Math.round(((trade.unitPrice - exitPrice) / exitPrice) * 10_000),
          advantage: multiplyByQuantity(perShare, boughtBack),
          fullyExited: sellRun.wentFlat,
        });
        sellRun = null;
      }

      const lot = openLot({
        id: `${prefix}-${trade.id}`,
        openedOn: trade.tradedOn,
        quantity: trade.quantity,
        unitPrice: trade.unitPrice,
        charges: trade.charges,
        source: 'PURCHASE',
        openTradeId: trade.id,
      });
      lots = [...lots, lot];
      position += trade.quantity;

      current.sharesBought += trade.quantity;
      current.totalInvested = addPaisa(current.totalInvested, lot.costBasis);
      current.tradeIds.push(trade.id);
      continue;
    }

    // SELL
    if (current === null) {
      throw new LedgerError(
        `Trade ${trade.id} sells ${trade.quantity} share(s)${options.symbol ? ` of ${options.symbol}` : ''} with no open position. ` +
          `A purchase is missing, or a bonus issue has not been applied.`,
      );
    }

    const result = matchSale(
      lots,
      {
        soldOn: trade.tradedOn,
        quantity: trade.quantity,
        unitPrice: trade.unitPrice,
        charges: trade.charges,
      },
      method,
      options.symbol,
    );

    lots = result.remainingLots;
    position -= trade.quantity;

    realisations.push({
      tradeId: trade.id,
      soldOn: trade.tradedOn,
      quantity: trade.quantity,
      unitPrice: trade.unitPrice,
      grossProceeds: result.grossProceeds,
      netProceeds: result.netProceeds,
      costBasis: result.totalCostBasis,
      realisedPnl: result.realisedPnl,
      charges: trade.charges,
      allocations: result.allocations,
    });

    current.sharesSold += trade.quantity;
    current.totalProceeds = addPaisa(current.totalProceeds, result.netProceeds);
    current.realisedPnl = addPaisa(current.realisedPnl, result.realisedPnl);
    current.tradeIds.push(trade.id);

    const gross = trade.unitPrice * trade.quantity;
    sellRun =
      sellRun === null
        ? {
            quantity: trade.quantity,
            grossValue: gross,
            lastSoldOn: trade.tradedOn,
            wentFlat: position === 0,
          }
        : {
            quantity: sellRun.quantity + trade.quantity,
            grossValue: sellRun.grossValue + gross,
            lastSoldOn: trade.tradedOn,
            wentFlat: sellRun.wentFlat || position === 0,
          };

    if (position === 0) {
      current.closedOn = trade.tradedOn;
      current.isOpen = false;
      current.holdingDays = daysBetween(current.openedOn, trade.tradedOn);
      cycles.push(finaliseCycle(current, ordered));
      current = null;
    }
  }

  if (current !== null) cycles.push(finaliseCycle(current, ordered));

  return {
    openLots: lots,
    quantity: totalQuantity(lots),
    costBasis: totalCostBasis(lots),
    realisations,
    cycles,
    buyBacks,
    totalRealisedPnl: addPaisa(...realisations.map((r) => r.realisedPnl)),
    totalCharges,
  };
}

/** Fills in the weighted average entry and exit prices for a finished cycle. */
function finaliseCycle(cycle: PositionCycle, trades: readonly TradeRecord[]): PositionCycle {
  const inCycle = trades.filter((trade) => cycle.tradeIds.includes(trade.id));

  const buys = inCycle.filter((trade) => trade.side === 'BUY');
  const sells = inCycle.filter((trade) => trade.side === 'SELL');

  const weightedAverage = (subset: TradeRecord[]): Paisa | null => {
    const shares = subset.reduce((sum, trade) => sum + trade.quantity, 0);
    if (shares === 0) return null;
    const value = subset.reduce((sum, trade) => sum + trade.unitPrice * trade.quantity, 0);
    return paisa(Math.round(value / shares));
  };

  return {
    ...cycle,
    entryAveragePrice: weightedAverage(buys) ?? ZERO,
    exitAveragePrice: weightedAverage(sells),
  };
}

/** A holding as it stands now, valued against a market price when one is known. */
export interface Position {
  symbol: string;
  quantity: number;
  costBasis: Paisa;
  averageCost: Paisa | null;
  marketPrice: Paisa | null;
  marketValue: Paisa | null;
  unrealisedPnl: Paisa | null;
  unrealisedPnlBps: number | null;
  lots: OpenLot[];
}

export function buildPosition(
  symbol: string,
  lots: readonly OpenLot[],
  marketPrice: Paisa | null,
): Position {
  const quantity = totalQuantity(lots);
  const costBasis = totalCostBasis(lots);
  const averageCost = quantity === 0 ? null : paisa(Math.round(costBasis / quantity));

  // Market value excludes the charges a sale would incur: it is what the
  // holding is worth, not what closing it would net. The sale's charges are
  // recorded when the sale actually happens.
  const marketValue = marketPrice === null ? null : multiplyByQuantity(marketPrice, quantity);
  const unrealisedPnl = marketValue === null ? null : subPaisa(marketValue, costBasis);

  return {
    symbol,
    quantity,
    costBasis,
    averageCost,
    marketPrice,
    marketValue,
    unrealisedPnl,
    unrealisedPnlBps:
      unrealisedPnl === null || costBasis === 0
        ? null
        : Math.round((unrealisedPnl / costBasis) * 10_000),
    lots: [...lots],
  };
}
