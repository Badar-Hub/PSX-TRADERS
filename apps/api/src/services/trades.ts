import {
  multiplyByQuantity,
  netCashFlow,
  rupeesToPaisa,
  type Paisa,
  type TradeSide,
} from '@psx/shared';
import type { BrokerageAccount, Portfolio, Trade } from '@prisma/client';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { fromIsoDateColumn, fromPaisa, toIsoDateColumn, toPaisa } from '../db/paisa.js';
import { prisma, type Tx } from '../db/prisma.js';
import { resolveCharges, type ChargeOverrides } from './charges.js';
import { rebuildProjection } from './projection.js';

/**
 * Recording and correcting trades.
 *
 * The ledger is append-only. A trade is never edited or deleted: a mistake is
 * cancelled by a reversing entry that points at it, and both rows stay. That
 * costs a little clarity in the raw table and buys an audit trail, which is the
 * thing you want six months later when a number looks wrong and the question is
 * what was believed at the time.
 */

export interface CreateTradeInput {
  portfolioId: string;
  userId: string;
  symbol: string;
  side: TradeSide;
  tradedOn: string;
  quantity: number;
  /** Rupees as a string, so no float exists on the wire. */
  unitPrice: string;
  sequence?: number;
  charges?: {
    brokerage?: string;
    salesTax?: string;
    cdc?: string;
    secp?: string;
    otherFees?: string;
  };
  note?: string;
  externalRef?: string;
}

export interface TradeView {
  id: string;
  symbol: string;
  securityName: string;
  side: TradeSide;
  tradedOn: string;
  sequence: number;
  quantity: number;
  unitPrice: Paisa;
  grossValue: Paisa;
  charges: {
    brokerage: Paisa;
    salesTax: Paisa;
    cdc: Paisa;
    secp: Paisa;
    otherFees: Paisa;
    total: Paisa;
  };
  netCashFlow: Paisa;
  status: 'ACTIVE' | 'REVERSED';
  reversesTradeId: string | null;
  note: string | null;
  externalRef: string | null;
  createdAt: string;
}

export type OwnedPortfolio = Portfolio & { account: BrokerageAccount | null };

/** Loads a portfolio, refusing one that belongs to someone else. */
export async function loadOwnedPortfolio(
  tx: Tx | typeof prisma,
  portfolioId: string,
  userId: string,
): Promise<OwnedPortfolio> {
  const portfolio = await tx.portfolio.findFirst({
    where: { id: portfolioId, userId },
    include: { account: true },
  });
  // Not found rather than forbidden: distinguishing them would confirm that
  // another user's portfolio exists.
  if (portfolio === null) throw notFound('Portfolio');
  return portfolio;
}

/** Finds a security by ticker, creating a placeholder if the ingest has not seen it. */
export async function resolveSecurity(
  tx: Tx,
  symbol: string,
): Promise<{ id: string; symbol: string; name: string }> {
  const existing = await tx.security.findUnique({
    where: { symbol },
    select: { id: true, symbol: true, name: true },
  });
  if (existing !== null) return existing;

  // A user may enter a trade before the nightly ingest has run, or in a symbol
  // the equity filter excludes. Creating a stub keeps the trade recordable; the
  // ingest fills in the name and sector when it next sees the symbol.
  return tx.security.create({
    data: { symbol, name: symbol, segment: 'UNKNOWN' },
    select: { id: true, symbol: true, name: true },
  });
}

export async function createTrade(input: CreateTradeInput): Promise<TradeView> {
  const quantity = input.quantity;
  const unitPrice = rupeesToPaisa(input.unitPrice);

  if (unitPrice <= 0) throw badRequest('Trade price must be greater than zero');

  return prisma.$transaction(async (tx) => {
    const portfolio = await loadOwnedPortfolio(tx, input.portfolioId, input.userId);
    const security = await resolveSecurity(tx, input.symbol);

    const overrides: ChargeOverrides | undefined =
      input.charges === undefined
        ? undefined
        : {
            ...(input.charges.brokerage !== undefined
              ? { brokerage: rupeesToPaisa(input.charges.brokerage) }
              : {}),
            ...(input.charges.salesTax !== undefined
              ? { salesTax: rupeesToPaisa(input.charges.salesTax) }
              : {}),
            ...(input.charges.cdc !== undefined ? { cdc: rupeesToPaisa(input.charges.cdc) } : {}),
            ...(input.charges.secp !== undefined
              ? { secp: rupeesToPaisa(input.charges.secp) }
              : {}),
            ...(input.charges.otherFees !== undefined
              ? { otherFees: rupeesToPaisa(input.charges.otherFees) }
              : {}),
          };

    const charges = resolveCharges(unitPrice, quantity, portfolio.account, overrides);
    const cashFlow = netCashFlow(input.side, unitPrice, quantity, charges);

    const trade = await tx.trade.create({
      data: {
        portfolioId: portfolio.id,
        securityId: security.id,
        side: input.side,
        tradedOn: fromIsoDateColumn(input.tradedOn),
        sequence: input.sequence ?? 0,
        quantity,
        unitPrice: fromPaisa(unitPrice),
        brokerage: fromPaisa(charges.brokerage),
        salesTax: fromPaisa(charges.salesTax),
        cdc: fromPaisa(charges.cdc),
        secp: fromPaisa(charges.secp),
        otherFees: fromPaisa(charges.fixed),
        charges: fromPaisa(charges.total),
        netCashFlow: fromPaisa(cashFlow),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
      },
      include: { security: { select: { symbol: true, name: true } } },
    });

    // The rebuild validates the whole history, so an oversold position is
    // rejected here and the transaction rolls the trade back. Validating
    // beforehand would leave a race between the check and the insert.
    await rebuildProjection(
      tx,
      portfolio.id,
      security.id,
      portfolio.costBasisMethod,
      security.symbol,
    );

    return toTradeView(trade);
  });
}

/**
 * Cancels a trade with a reversing entry.
 *
 * The original row stays ACTIVE=false and the reversal records what happened,
 * so the history shows both that the trade was believed and that it was undone.
 */
export async function reverseTrade(
  tradeId: string,
  userId: string,
  reason?: string,
): Promise<{ reversed: TradeView; reversal: TradeView }> {
  return prisma.$transaction(async (tx) => {
    const original = await tx.trade.findFirst({
      where: { id: tradeId, portfolio: { userId } },
      include: { security: { select: { symbol: true, name: true } }, portfolio: true },
    });
    if (original === null) throw notFound('Trade');
    if (original.status === 'REVERSED') throw conflict('That trade has already been reversed');

    const existingReversal = await tx.trade.findUnique({
      where: { reversesTradeId: tradeId },
      select: { id: true },
    });
    if (existingReversal !== null) throw conflict('That trade has already been reversed');

    const reversal = await tx.trade.create({
      data: {
        portfolioId: original.portfolioId,
        securityId: original.securityId,
        // The opposite side, so the two net to nothing in any cash total.
        side: original.side === 'BUY' ? 'SELL' : 'BUY',
        tradedOn: original.tradedOn,
        sequence: original.sequence,
        quantity: original.quantity,
        unitPrice: original.unitPrice,
        brokerage: -original.brokerage,
        salesTax: -original.salesTax,
        cdc: -original.cdc,
        secp: -original.secp,
        otherFees: -original.otherFees,
        charges: -original.charges,
        netCashFlow: -original.netCashFlow,
        // REVERSED so the replay ignores it: a reversal is bookkeeping, not a
        // trade that ever happened in the market.
        status: 'REVERSED',
        reversesTradeId: original.id,
        note: reason ?? `Reversal of ${original.id}`,
      },
      include: { security: { select: { symbol: true, name: true } } },
    });

    const updated = await tx.trade.update({
      where: { id: original.id },
      data: { status: 'REVERSED' },
      include: { security: { select: { symbol: true, name: true } } },
    });

    await rebuildProjection(
      tx,
      original.portfolioId,
      original.securityId,
      original.portfolio.costBasisMethod,
      original.security.symbol,
    );

    return { reversed: toTradeView(updated), reversal: toTradeView(reversal) };
  });
}

export interface ListTradesOptions {
  portfolioId: string;
  userId: string;
  symbol?: string;
  from?: string;
  to?: string;
  includeReversed?: boolean;
  limit?: number;
  cursor?: string;
}

export async function listTrades(options: ListTradesOptions): Promise<{
  trades: TradeView[];
  nextCursor: string | null;
}> {
  await loadOwnedPortfolio(prisma, options.portfolioId, options.userId);

  const limit = Math.min(options.limit ?? 100, 500);

  const trades = await prisma.trade.findMany({
    where: {
      portfolioId: options.portfolioId,
      ...(options.includeReversed === true ? {} : { status: 'ACTIVE' }),
      ...(options.symbol !== undefined ? { security: { symbol: options.symbol } } : {}),
      ...(options.from !== undefined || options.to !== undefined
        ? {
            tradedOn: {
              ...(options.from !== undefined ? { gte: fromIsoDateColumn(options.from) } : {}),
              ...(options.to !== undefined ? { lte: fromIsoDateColumn(options.to) } : {}),
            },
          }
        : {}),
    },
    include: { security: { select: { symbol: true, name: true } } },
    orderBy: [{ tradedOn: 'desc' }, { sequence: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor !== undefined ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const page = trades.slice(0, limit);
  return {
    trades: page.map(toTradeView),
    nextCursor: trades.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

type TradeWithSecurity = Trade & { security: { symbol: string; name: string } };

export function toTradeView(trade: TradeWithSecurity): TradeView {
  const unitPrice = toPaisa(trade.unitPrice);
  const brokerage = toPaisa(trade.brokerage);
  const salesTax = toPaisa(trade.salesTax);
  const cdc = toPaisa(trade.cdc);
  const secp = toPaisa(trade.secp);
  const otherFees = toPaisa(trade.otherFees);

  return {
    id: trade.id,
    symbol: trade.security.symbol,
    securityName: trade.security.name,
    side: trade.side,
    tradedOn: toIsoDateColumn(trade.tradedOn),
    sequence: trade.sequence,
    quantity: trade.quantity,
    unitPrice,
    grossValue: multiplyByQuantity(unitPrice, trade.quantity),
    charges: {
      brokerage,
      salesTax,
      cdc,
      secp,
      otherFees,
      total: toPaisa(trade.charges),
    },
    netCashFlow: toPaisa(trade.netCashFlow),
    status: trade.status,
    reversesTradeId: trade.reversesTradeId,
    note: trade.note,
    externalRef: trade.externalRef,
    createdAt: trade.createdAt.toISOString(),
  };
}
