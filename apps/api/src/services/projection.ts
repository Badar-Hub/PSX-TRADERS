import { addPaisa, multiplyByQuantity, type CostBasisMethod, type Paisa } from '@psx/shared';
import { replayTrades, type TradeRecord } from '@psx/ledger';
import type { Trade } from '@prisma/client';
import { conflict } from '../http/errors.js';
import { fromIsoDateColumn, fromPaisa, toIsoDateColumn, toPaisa } from '../db/paisa.js';
import type { Tx } from '../db/prisma.js';

/**
 * Rebuilds the derived tables for one portfolio and one security.
 *
 * The trade ledger is the source of truth, so lots, consumptions and cycles are
 * deleted and recomputed from a full replay rather than patched incrementally.
 * Patching is how a derived total drifts away from the history behind it: an
 * incremental update has to be right for every ordering of every edit, while a
 * rebuild only has to be right once.
 *
 * It is cheap at the scale this app operates on. A few hundred trades in a
 * symbol replay in well under a millisecond, and the rebuild runs inside the
 * same transaction as the trade that triggered it, so a reader never sees a
 * half-rebuilt portfolio.
 */

export interface RebuildResult {
  quantity: number;
  costBasis: Paisa;
  realisedPnl: Paisa;
  lotCount: number;
  cycleCount: number;
  buyBackCount: number;
}

export function toTradeRecord(trade: Trade): TradeRecord {
  return {
    id: trade.id,
    side: trade.side,
    tradedOn: toIsoDateColumn(trade.tradedOn),
    quantity: trade.quantity,
    unitPrice: toPaisa(trade.unitPrice),
    charges: toPaisa(trade.charges),
    sequence: trade.sequence,
  };
}

export async function rebuildProjection(
  tx: Tx,
  portfolioId: string,
  securityId: string,
  method: CostBasisMethod,
  symbol: string,
): Promise<RebuildResult> {
  // A confirmed corporate action changes the share count without a trade. The
  // replay below only knows about trades, so proceeding would produce a lot set
  // that disagrees with the registrar. Rather than emit a number that is
  // quietly wrong, this refuses and says what is in the way. Applying actions
  // during replay is the next piece of work, and this guard is what it removes.
  const unappliedActions = await tx.corporateAction.count({
    where: {
      securityId,
      status: 'CONFIRMED',
      applications: { none: { portfolioId } },
    },
  });
  if (unappliedActions > 0) {
    throw conflict(
      `${symbol} has ${unappliedActions} confirmed corporate action(s) that have not been ` +
        `applied to this portfolio. Applying them is required before positions can be ` +
        `recomputed, because a bonus or split changes the share count without a trade.`,
      { symbol, unappliedActions },
    );
  }

  const trades = await tx.trade.findMany({
    where: { portfolioId, securityId, status: 'ACTIVE' },
    orderBy: [{ tradedOn: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
  });

  const replay = replayTrades(trades.map(toTradeRecord), { method, symbol });

  // Order matters: consumptions reference lots, so they go first.
  await tx.lotConsumption.deleteMany({ where: { portfolioId, taxLot: { securityId } } });
  await tx.taxLot.deleteMany({ where: { portfolioId, securityId } });
  await tx.positionCycle.deleteMany({ where: { portfolioId, securityId } });

  // Every BUY opened a lot. The replay returns only those still open, so the
  // originals are reconstructed from the trades and the remainders looked up:
  // a fully consumed lot is still a row, because its consumptions point at it.
  const openById = new Map(replay.openLots.map((lot) => [lot.id, lot]));

  const lotRows = trades
    .filter((trade) => trade.side === 'BUY')
    .map((trade) => {
      const lotId = `lot-${trade.id}`;
      const open = openById.get(lotId);
      const originalCostBasis = addPaisa(
        multiplyByQuantity(toPaisa(trade.unitPrice), trade.quantity),
        toPaisa(trade.charges),
      );
      return {
        id: lotId,
        portfolioId,
        securityId,
        openTradeId: trade.id,
        source: 'PURCHASE' as const,
        openedOn: trade.tradedOn,
        originalQuantity: trade.quantity,
        remainingQuantity: open?.quantity ?? 0,
        originalCostBasis: fromPaisa(originalCostBasis),
        remainingCostBasis: fromPaisa(open?.costBasis ?? (0 as Paisa)),
        closedAt: open === undefined ? new Date() : null,
      };
    });

  if (lotRows.length > 0) await tx.taxLot.createMany({ data: lotRows });

  const consumptionRows = replay.realisations.flatMap((realisation) =>
    realisation.allocations.map((allocation) => ({
      portfolioId,
      taxLotId: allocation.lotId,
      sellTradeId: realisation.tradeId,
      quantity: allocation.quantitySold,
      costBasis: fromPaisa(allocation.costBasis),
      proceeds: fromPaisa(allocation.proceeds),
      realisedPnl: fromPaisa(allocation.realisedPnl),
      holdingDays: allocation.holdingDays,
      soldOn: fromIsoDateColumn(realisation.soldOn),
    })),
  );

  if (consumptionRows.length > 0) await tx.lotConsumption.createMany({ data: consumptionRows });

  // A cycle is a buy-back when a repurchase opened it, so the two are matched
  // up by the trade that did it.
  const buyBackByTrade = new Map(replay.buyBacks.map((back) => [back.buyTradeId, back]));

  const cycleRows = replay.cycles.map((cycle) => {
    const openingTradeId = cycle.tradeIds[0];
    const back = openingTradeId === undefined ? undefined : buyBackByTrade.get(openingTradeId);
    return {
      portfolioId,
      securityId,
      cycleIndex: cycle.index,
      openedOn: fromIsoDateColumn(cycle.openedOn),
      closedOn: cycle.closedOn === null ? null : fromIsoDateColumn(cycle.closedOn),
      sharesBought: cycle.sharesBought,
      sharesSold: cycle.sharesSold,
      totalInvested: fromPaisa(cycle.totalInvested),
      totalProceeds: fromPaisa(cycle.totalProceeds),
      realisedPnl: fromPaisa(cycle.realisedPnl),
      entryAveragePrice: fromPaisa(cycle.entryAveragePrice),
      exitAveragePrice:
        cycle.exitAveragePrice === null ? null : fromPaisa(cycle.exitAveragePrice),
      holdingDays: cycle.holdingDays,
      isBuyBack: back !== undefined,
      previousExitPrice: back === undefined ? null : fromPaisa(back.previousExitPrice),
      daysOutOfPosition: back?.daysOut ?? null,
      buyBackAdvantage: back === undefined ? null : fromPaisa(back.advantage),
    };
  });

  if (cycleRows.length > 0) await tx.positionCycle.createMany({ data: cycleRows });

  return {
    quantity: replay.quantity,
    costBasis: replay.costBasis,
    realisedPnl: replay.totalRealisedPnl,
    lotCount: lotRows.length,
    cycleCount: cycleRows.length,
    buyBackCount: replay.buyBacks.length,
  };
}

/** Rebuilds every security a portfolio has traded. Used after a bulk import. */
export async function rebuildPortfolio(
  tx: Tx,
  portfolioId: string,
  method: CostBasisMethod,
): Promise<RebuildResult[]> {
  const traded = await tx.trade.findMany({
    where: { portfolioId, status: 'ACTIVE' },
    distinct: ['securityId'],
    select: { securityId: true, security: { select: { symbol: true } } },
  });

  const results: RebuildResult[] = [];
  for (const row of traded) {
    results.push(
      await rebuildProjection(tx, portfolioId, row.securityId, method, row.security.symbol),
    );
  }
  return results;
}
