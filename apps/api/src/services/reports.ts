import {
  PLACEHOLDER_CGT_FILER,
  PLACEHOLDER_CGT_NON_FILER,
  type CgtSchedule,
} from '@psx/shared';
import {
  buildPosition,
  buildStatement,
  replayTrades,
  type ProfitAndLossStatement,
  type SecurityRealisations,
} from '@psx/ledger';
import { prisma } from '../db/prisma.js';
import { toPaisa } from '../db/paisa.js';
import { loadOwnedPortfolio } from './trades.js';
import { toTradeRecord } from './projection.js';

/**
 * The profit and loss report.
 *
 * Built by replaying the ledger, so the statement is reproducible from the
 * trades and can be regenerated for any period without a stored snapshot going
 * stale. The CGT line is an estimate and labelled as one all the way to the
 * client: the rate comes from configuration, because it depends on filer status
 * and changes with each finance act.
 */

export interface PnlReportOptions {
  portfolioId: string;
  userId: string;
  from: string;
  to: string;
  /** Include the unrealised line by valuing open positions. */
  includeUnrealised?: boolean;
  includeCgtEstimate?: boolean;
}

export interface PnlReport extends ProfitAndLossStatement {
  portfolioId: string;
  portfolioName: string;
  isPaperTrading: boolean;
  /** Set when the CGT line is present, so the client can label the rate used. */
  cgtBasis: { rateBps: number; filerStatus: 'FILER' | 'NON_FILER'; isEstimate: true } | null;
  /** Securities whose unrealised value could not be computed for want of a price. */
  pricesMissingFor: string[];
}

export async function getPnlReport(options: PnlReportOptions): Promise<PnlReport> {
  const portfolio = await loadOwnedPortfolio(prisma, options.portfolioId, options.userId);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: options.userId },
    select: { isTaxFiler: true },
  });

  const trades = await prisma.trade.findMany({
    where: { portfolioId: options.portfolioId, status: 'ACTIVE' },
    include: { security: { select: { id: true, symbol: true } } },
    orderBy: [{ tradedOn: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
  });

  const bySecurity = new Map<string, typeof trades>();
  for (const trade of trades) {
    const existing = bySecurity.get(trade.securityId);
    if (existing === undefined) bySecurity.set(trade.securityId, [trade]);
    else existing.push(trade);
  }

  const realisations: SecurityRealisations[] = [];
  const positions = [];
  const pricesMissingFor: string[] = [];

  const securityIds = [...bySecurity.keys()];
  const prices =
    options.includeUnrealised === true && securityIds.length > 0
      ? await latestCloses(securityIds)
      : new Map<string, bigint>();

  for (const [securityId, securityTrades] of bySecurity) {
    const symbol = securityTrades[0]?.security.symbol;
    if (symbol === undefined) continue;

    const replay = replayTrades(securityTrades.map(toTradeRecord), {
      method: portfolio.costBasisMethod,
      symbol,
    });

    realisations.push({ symbol, realisations: replay.realisations });

    if (options.includeUnrealised === true && replay.quantity > 0) {
      const close = prices.get(securityId);
      if (close === undefined) pricesMissingFor.push(symbol);
      positions.push(buildPosition(symbol, replay.openLots, close === undefined ? null : toPaisa(close)));
    }
  }

  // Buy-side charges inside the period are not visible from realisations, which
  // only carry the sell side, so they are summed from the ledger directly.
  const purchaseCharges = await prisma.trade.aggregate({
    where: {
      portfolioId: options.portfolioId,
      status: 'ACTIVE',
      side: 'BUY',
      tradedOn: { gte: new Date(`${options.from}T00:00:00.000Z`), lte: new Date(`${options.to}T00:00:00.000Z`) },
    },
    _sum: { charges: true },
  });

  const cgt: CgtSchedule | undefined =
    options.includeCgtEstimate === true
      ? user.isTaxFiler
        ? PLACEHOLDER_CGT_FILER
        : PLACEHOLDER_CGT_NON_FILER
      : undefined;

  const statement = buildStatement({
    from: options.from,
    to: options.to,
    realisations,
    positions,
    purchaseCharges: toPaisa(purchaseCharges._sum.charges ?? 0n),
    ...(cgt !== undefined ? { cgt } : {}),
  });

  return {
    ...statement,
    portfolioId: options.portfolioId,
    portfolioName: portfolio.name,
    isPaperTrading: portfolio.isPaperTrading,
    cgtBasis:
      cgt === undefined
        ? null
        : {
            rateBps: cgt.rateBps,
            filerStatus: user.isTaxFiler ? 'FILER' : 'NON_FILER',
            isEstimate: true,
          },
    pricesMissingFor,
  };
}

async function latestCloses(securityIds: string[]): Promise<Map<string, bigint>> {
  const rows = await prisma.$queryRaw<Array<{ securityId: string; close: bigint }>>`
    SELECT DISTINCT ON ("securityId") "securityId", "close"
    FROM "daily_bars"
    WHERE "securityId" = ANY(${securityIds}::text[])
    ORDER BY "securityId", "date" DESC
  `;
  return new Map(rows.map((row) => [row.securityId, row.close]));
}
