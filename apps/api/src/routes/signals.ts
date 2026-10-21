import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../http/errors.js';
import { cuid, params, query, symbolString, validate } from '../http/validate.js';
import { requireActiveUser } from '../auth/access.js';
import type { Tokens } from '../auth/tokens.js';
import {
  accuracyReport,
  computeSignalForSymbol,
  getLatestSignal,
  getSignalById,
} from '../services/signals.js';
import { coverage } from '../services/ingest.js';
import { prisma } from '../db/prisma.js';

/**
 * Prediction endpoints.
 *
 * A signal is always returned with its full factor table, not just a score.
 * That is the whole point of the engine, and making the breakdown a separate
 * request would let a client show a verdict without the reasoning behind it.
 *
 * Refusals come back as 200 with `signal: null` and a reason rather than as an
 * error. "This stock trades too thinly to say anything about" is a legitimate
 * answer to the question asked, and a client should display it rather than
 * treat it as a failure.
 */

const HorizonQuery = z.object({
  horizon: z.enum(['SWING', 'LONG_TERM']).default('SWING'),
});

const SymbolParams = z.object({ symbol: symbolString });
const IdParams = z.object({ id: cuid });

export function signalRoutes(tokens: Tokens): Router {
  const router = Router();
  const guard = requireActiveUser(tokens);

  /** The stored prediction, or a computed one if none has been stored yet. */
  router.get(
    '/securities/:symbol/signal',
    ...guard,
    validate({ params: SymbolParams, query: HorizonQuery }),
    async (req, res) => {
      const { symbol } = params<z.infer<typeof SymbolParams>>(req);
      const { horizon } = query<z.infer<typeof HorizonQuery>>(req);

      const stored = await getLatestSignal(symbol, horizon);
      if (stored !== null) {
        res.json({ signal: stored, source: 'stored' });
        return;
      }

      const result = await computeSignalForSymbol(symbol, horizon);
      if (!result.ok) {
        res.json({
          signal: null,
          source: 'computed',
          refusal: { code: result.refusal.code, reason: result.refusal.reason },
        });
        return;
      }

      const fresh = await getLatestSignal(symbol, horizon);
      res.json({ signal: fresh, source: 'computed' });
    },
  );

  /** Forces a recomputation from the latest stored prices. */
  router.post(
    '/securities/:symbol/signal/refresh',
    ...guard,
    validate({ params: SymbolParams, query: HorizonQuery }),
    async (req, res) => {
      const { symbol } = params<z.infer<typeof SymbolParams>>(req);
      const { horizon } = query<z.infer<typeof HorizonQuery>>(req);

      const result = await computeSignalForSymbol(symbol, horizon, { force: true });
      if (!result.ok) {
        res.json({
          signal: null,
          refusal: { code: result.refusal.code, reason: result.refusal.reason },
        });
        return;
      }

      res.json({ signal: await getLatestSignal(symbol, horizon) });
    },
  );

  router.get('/signals/:id', ...guard, validate({ params: IdParams }), async (req, res) => {
    const { id } = params<z.infer<typeof IdParams>>(req);
    res.json({ signal: await getSignalById(id) });
  });

  /**
   * The engine's own track record.
   *
   * Exposed as a first-class endpoint rather than buried, because a prediction
   * engine that cannot show its hit rate is asking to be trusted on faith.
   */
  router.get('/signals/stats/accuracy', ...guard, async (_req, res) => {
    const reports = await accuracyReport();
    res.json({
      accuracy: reports,
      note:
        reports.length === 0 || reports.every((report) => report.settled === 0)
          ? 'No predictions have been settled yet. Accuracy becomes meaningful once a ' +
            'horizon has elapsed for a few hundred signals.'
          : 'Neutral outcomes are excluded from the hit rate: the call was directional ' +
            'and the market did nothing, which is neither right nor wrong.',
    });
  });

  /** Signals for every holding in a portfolio, for the dashboard. */
  router.get(
    '/portfolios/:id/signals',
    ...guard,
    validate({ params: z.object({ id: cuid }), query: HorizonQuery }),
    async (req, res) => {
      const { id } = params<{ id: string }>(req);
      const { horizon } = query<z.infer<typeof HorizonQuery>>(req);
      const user = req.user;
      if (user === undefined) throw notFound('Portfolio');

      const portfolio = await prisma.portfolio.findFirst({
        where: { id, userId: user.id },
        select: { id: true },
      });
      if (portfolio === null) throw notFound('Portfolio');

      const held = await prisma.trade.findMany({
        where: { portfolioId: id, status: 'ACTIVE' },
        distinct: ['securityId'],
        select: { security: { select: { symbol: true } } },
      });

      const signals = await Promise.all(
        held.map(async (row) => ({
          symbol: row.security.symbol,
          signal: await getLatestSignal(row.security.symbol, horizon),
        })),
      );

      res.json({ horizon, signals });
    },
  );

  /**
   * Price history for a chart.
   *
   * Returned unadjusted, exactly as the exchange published it, matching what is
   * stored. Prices are paisa integers like everything else on the wire, so the
   * client divides once at the point of display and never does arithmetic on a
   * figure it might then disagree with.
   */
  router.get(
    '/securities/:symbol/bars',
    ...guard,
    validate({
      params: SymbolParams,
      query: z.object({ limit: z.coerce.number().int().min(10).max(1000).default(180) }),
    }),
    async (req, res) => {
      const { symbol } = params<z.infer<typeof SymbolParams>>(req);
      const { limit } = query<{ limit: number }>(req);

      const security = await prisma.security.findUnique({
        where: { symbol },
        select: { id: true, symbol: true, name: true },
      });
      if (security === null) throw notFound('Security');

      const rows = await prisma.dailyBar.findMany({
        where: { securityId: security.id },
        orderBy: { date: 'desc' },
        take: limit,
        select: {
          date: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
          closeOutsideRange: true,
        },
      });

      res.json({
        symbol: security.symbol,
        name: security.name,
        // Newest first from the query so the limit takes the most recent
        // window; reversed here because a chart reads oldest to newest.
        bars: rows.reverse().map((row) => ({
          date: row.date.toISOString().slice(0, 10),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: row.volume,
          closeOutsideRange: row.closeOutsideRange,
        })),
      });
    },
  );

  /**
   * What price history is present.
   *
   * Worth exposing: a prediction built on a series with a three-week hole in it
   * is wrong in a way nothing else would reveal.
   */
  router.get('/market/coverage', ...guard, async (_req, res) => {
    res.json({ coverage: await coverage() });
  });

  return router;
}
