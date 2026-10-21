import { Router } from 'express';
import { z } from 'zod';
import {
  cuid,
  isoDate,
  nonNegativeRupeeString,
  params,
  positiveRupeeString,
  query,
  symbolString,
  validate,
  wholeShares,
  body,
} from '../http/validate.js';
import { currentUser } from '../auth/middleware.js';
import { requireActiveUser } from '../auth/access.js';
import type { Tokens } from '../auth/tokens.js';
import { createTrade, listTrades, reverseTrade } from '../services/trades.js';

/**
 * Trade endpoints.
 *
 * Prices and charges cross the wire as strings ("170.19"), never JSON numbers.
 * A JSON number is already a float by the time it is parsed, so 170.19 arrives
 * as 170.18999999999999 and any rounding back is a guess. The string parses
 * into integer paisa exactly.
 */

const ChargesBody = z
  .object({
    brokerage: nonNegativeRupeeString.optional(),
    salesTax: nonNegativeRupeeString.optional(),
    cdc: nonNegativeRupeeString.optional(),
    secp: nonNegativeRupeeString.optional(),
    otherFees: nonNegativeRupeeString.optional(),
  })
  .optional();

const CreateTradeBody = z.object({
  symbol: symbolString,
  side: z.enum(['BUY', 'SELL']),
  tradedOn: isoDate,
  quantity: wholeShares,
  unitPrice: positiveRupeeString,
  /** Orders trades within a day, when the contract notes make it known. */
  sequence: z.number().int().min(0).max(10_000).optional(),
  /**
   * Omit to have charges computed from the portfolio's brokerage account.
   * Supply them to use the figures from a contract note verbatim, which is
   * what makes the portfolio reconcile against the broker.
   */
  charges: ChargesBody,
  note: z.string().trim().max(2000).optional(),
  externalRef: z.string().trim().max(120).optional(),
});

const ListQuery = z.object({
  symbol: symbolString.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  includeReversed: z
    .union([z.literal('true'), z.literal('false')])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: cuid.optional(),
});

const PortfolioParams = z.object({ portfolioId: cuid });
const TradeParams = z.object({ tradeId: cuid });

const ReverseBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .optional()
  .default({});

export function tradeRoutes(tokens: Tokens): Router {
  const router = Router();
  // Applied per route rather than with router.use(). This router is mounted at
  // the bare /api prefix, so a blanket guard would challenge every unknown
  // /api/... path and answer 401 where the honest response is 404.
  const guard = requireActiveUser(tokens);

  router.post(
    '/portfolios/:portfolioId/trades',
    ...guard,
    validate({ params: PortfolioParams, body: CreateTradeBody }),
    async (req, res) => {
      const { portfolioId } = params<z.infer<typeof PortfolioParams>>(req);
      const { id: userId } = currentUser(req);
      const input = body<z.infer<typeof CreateTradeBody>>(req);

      const trade = await createTrade({
        portfolioId,
        userId,
        symbol: input.symbol,
        side: input.side,
        tradedOn: input.tradedOn,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
        ...(input.charges !== undefined ? { charges: input.charges } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
      });

      res.status(201).json({ trade });
    },
  );

  router.get(
    '/portfolios/:portfolioId/trades',
    ...guard,
    validate({ params: PortfolioParams, query: ListQuery }),
    async (req, res) => {
      const { portfolioId } = params<z.infer<typeof PortfolioParams>>(req);
      const { id: userId } = currentUser(req);
      const filters = query<z.infer<typeof ListQuery>>(req);

      res.json(
        await listTrades({
          portfolioId,
          userId,
          ...(filters.symbol !== undefined ? { symbol: filters.symbol } : {}),
          ...(filters.from !== undefined ? { from: filters.from } : {}),
          ...(filters.to !== undefined ? { to: filters.to } : {}),
          ...(filters.includeReversed !== undefined
            ? { includeReversed: filters.includeReversed }
            : {}),
          ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
          ...(filters.cursor !== undefined ? { cursor: filters.cursor } : {}),
        }),
      );
    },
  );

  /**
   * Reverses a trade. There is deliberately no DELETE: the ledger is
   * append-only, so a mistake is cancelled by an entry rather than erased.
   */
  router.post(
    '/trades/:tradeId/reverse',
    ...guard,
    validate({ params: TradeParams, body: ReverseBody }),
    async (req, res) => {
      const { tradeId } = params<z.infer<typeof TradeParams>>(req);
      const { id: userId } = currentUser(req);
      const input = body<{ reason?: string }>(req);

      const result = await reverseTrade(tradeId, userId, input?.reason);
      res.json(result);
    },
  );

  return router;
}
