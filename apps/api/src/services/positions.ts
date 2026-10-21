import { ZERO, addPaisa, type Paisa } from '@psx/shared';
import { buildPosition, replayTrades, type BuyBack, type PositionCycle } from '@psx/ledger';
import { prisma } from '../db/prisma.js';
import { toIsoDateColumn, toPaisa } from '../db/paisa.js';
import { loadOwnedPortfolio } from './trades.js';
import { toTradeRecord } from './projection.js';

/**
 * The read side: positions, cycles and buy-backs.
 *
 * Positions are recomputed from the ledger rather than read from the projection
 * tables. The projection exists so the alert engine can scan open lots cheaply,
 * but a figure shown to the user is derived from the trades on the spot, so the
 * two can never silently disagree about what is held.
 */

export interface PositionView {
  symbol: string;
  name: string;
  quantity: number;
  costBasis: Paisa;
  averageCost: Paisa | null;
  marketPrice: Paisa | null;
  priceAsOf: string | null;
  marketValue: Paisa | null;
  unrealisedPnl: Paisa | null;
  unrealisedPnlBps: number | null;
  realisedPnl: Paisa;
  /** Share of the portfolio's market value, in basis points. */
  weightBps: number | null;
  lots: Array<{
    id: string;
    openedOn: string;
    quantity: number;
    costBasis: Paisa;
    source: string;
  }>;
}

export interface PortfolioSummary {
  portfolioId: string;
  name: string;
  costBasisMethod: string;
  isPaperTrading: boolean;
  /** Cost of open positions only. */
  investedCost: Paisa;
  marketValue: Paisa | null;
  unrealisedPnl: Paisa | null;
  realisedPnl: Paisa;
  /** True when at least one holding has no price, so totals are incomplete. */
  hasMissingPrices: boolean;
  positionCount: number;
  positions: PositionView[];
}

/** Latest close per security, which is what an EOD feed can offer. */
async function latestPrices(
  securityIds: string[],
): Promise<Map<string, { price: Paisa; date: string }>> {
  if (securityIds.length === 0) return new Map();

  // One query per security would be N round trips; a window function would be
  // better still, but this stays inside Prisma's typed API and the result set
  // is one row per security.
  const rows = await prisma.$queryRaw<Array<{ securityId: string; close: bigint; date: Date }>>`
    SELECT DISTINCT ON ("securityId") "securityId", "close", "date"
    FROM "daily_bars"
    WHERE "securityId" = ANY(${securityIds}::text[])
    ORDER BY "securityId", "date" DESC
  `;

  return new Map(
    rows.map((row) => [row.securityId, { price: toPaisa(row.close), date: toIsoDateColumn(row.date) }]),
  );
}

export async function getPortfolioPositions(
  portfolioId: string,
  userId: string,
): Promise<PortfolioSummary> {
  const portfolio = await loadOwnedPortfolio(prisma, portfolioId, userId);

  const trades = await prisma.trade.findMany({
    where: { portfolioId, status: 'ACTIVE' },
    include: { security: { select: { id: true, symbol: true, name: true } } },
    orderBy: [{ tradedOn: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
  });

  const bySecurity = new Map<string, typeof trades>();
  for (const trade of trades) {
    const existing = bySecurity.get(trade.securityId);
    if (existing === undefined) bySecurity.set(trade.securityId, [trade]);
    else existing.push(trade);
  }

  const prices = await latestPrices([...bySecurity.keys()]);

  const positions: PositionView[] = [];
  let investedCost: Paisa = ZERO;
  let realisedTotal: Paisa = ZERO;
  let marketValueTotal = 0;
  let hasMissingPrices = false;
  let anyPrice = false;

  for (const [securityId, securityTrades] of bySecurity) {
    const first = securityTrades[0];
    if (first === undefined) continue;
    const { symbol, name } = first.security;

    const replay = replayTrades(
      securityTrades.map(toTradeRecord),
      { method: portfolio.costBasisMethod, symbol },
    );

    realisedTotal = addPaisa(realisedTotal, replay.totalRealisedPnl);

    // A closed position has no holding to show, but its realised result still
    // belongs in the totals above.
    if (replay.quantity === 0) continue;

    const quote = prices.get(securityId);
    const position = buildPosition(symbol, replay.openLots, quote?.price ?? null);

    if (quote === undefined) hasMissingPrices = true;
    else {
      anyPrice = true;
      marketValueTotal += position.marketValue ?? 0;
    }

    investedCost = addPaisa(investedCost, position.costBasis);

    positions.push({
      symbol,
      name,
      quantity: position.quantity,
      costBasis: position.costBasis,
      averageCost: position.averageCost,
      marketPrice: position.marketPrice,
      priceAsOf: quote?.date ?? null,
      marketValue: position.marketValue,
      unrealisedPnl: position.unrealisedPnl,
      unrealisedPnlBps: position.unrealisedPnlBps,
      realisedPnl: replay.totalRealisedPnl,
      weightBps: null,
      lots: position.lots.map((lot) => ({
        id: lot.id,
        openedOn: lot.openedOn,
        quantity: lot.quantity,
        costBasis: lot.costBasis,
        source: lot.source,
      })),
    });
  }

  const marketValue = anyPrice ? (marketValueTotal as Paisa) : null;

  // Weights are only meaningful against a total, so they stay null until one
  // exists rather than being computed against a partial figure.
  if (marketValue !== null && marketValue > 0) {
    for (const position of positions) {
      if (position.marketValue !== null) {
        position.weightBps = Math.round((position.marketValue / marketValue) * 10_000);
      }
    }
  }

  positions.sort((a, b) => (b.marketValue ?? b.costBasis) - (a.marketValue ?? a.costBasis));

  return {
    portfolioId,
    name: portfolio.name,
    costBasisMethod: portfolio.costBasisMethod,
    isPaperTrading: portfolio.isPaperTrading,
    investedCost,
    marketValue,
    unrealisedPnl: marketValue === null ? null : ((marketValue - investedCost) as Paisa),
    realisedPnl: realisedTotal,
    hasMissingPrices,
    positionCount: positions.length,
    positions,
  };
}

export interface CycleView extends PositionCycle {
  symbol: string;
}

/** Round trips across the portfolio, most recently opened first. */
export async function getPortfolioCycles(
  portfolioId: string,
  userId: string,
  symbolFilter?: string,
): Promise<{ cycles: CycleView[]; buyBacks: Array<BuyBack & { symbol: string }> }> {
  const portfolio = await loadOwnedPortfolio(prisma, portfolioId, userId);

  const trades = await prisma.trade.findMany({
    where: {
      portfolioId,
      status: 'ACTIVE',
      ...(symbolFilter !== undefined ? { security: { symbol: symbolFilter } } : {}),
    },
    include: { security: { select: { id: true, symbol: true } } },
    orderBy: [{ tradedOn: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
  });

  const bySecurity = new Map<string, typeof trades>();
  for (const trade of trades) {
    const existing = bySecurity.get(trade.securityId);
    if (existing === undefined) bySecurity.set(trade.securityId, [trade]);
    else existing.push(trade);
  }

  const cycles: CycleView[] = [];
  const buyBacks: Array<BuyBack & { symbol: string }> = [];

  for (const securityTrades of bySecurity.values()) {
    const symbol = securityTrades[0]?.security.symbol;
    if (symbol === undefined) continue;

    const replay = replayTrades(securityTrades.map(toTradeRecord), {
      method: portfolio.costBasisMethod,
      symbol,
    });

    for (const cycle of replay.cycles) cycles.push({ ...cycle, symbol });
    for (const back of replay.buyBacks) buyBacks.push({ ...back, symbol });
  }

  cycles.sort((a, b) => (a.openedOn < b.openedOn ? 1 : a.openedOn > b.openedOn ? -1 : 0));
  buyBacks.sort((a, b) => (a.boughtOn < b.boughtOn ? 1 : a.boughtOn > b.boughtOn ? -1 : 0));

  return { cycles, buyBacks };
}
