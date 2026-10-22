import { Router } from 'express';
import { z } from 'zod';
import {
  body,
  cuid,
  isoDate,
  params,
  positiveRupeeString,
  query,
  symbolString,
  validate,
  wholeShares,
} from '../http/validate.js';
import { currentUser } from '../auth/middleware.js';
import { requireActiveUser } from '../auth/access.js';
import type { Tokens } from '../auth/tokens.js';
import {
  acknowledgeEvent,
  backtestTrail,
  cancelStopRule,
  createStopRule,
  evaluateArmedRules,
  getStopRule,
  listStopRules,
  suggestStop,
  updateStopRule,
} from '../services/stops.js';
import { notFound } from '../http/errors.js';

/**
 * Stop-loss, trailing stop and take-profit endpoints.
 *
 * `/evaluate` is here as well as in the nightly job so a user who has just
 * armed a rule can see it checked against the stored history rather than
 * waiting until tomorrow to find out whether it was already breached. It is
 * idempotent, so pressing it twice is harmless.
 */

const PortfolioParams = z.object({ portfolioId: cuid });
const RuleParams = z.object({ ruleId: cuid });
const EventParams = z.object({ eventId: cuid });
const SymbolParams = z.object({ symbol: symbolString });

/** Only the three types the engine actually evaluates. */
const RuleTypeEnum = z.enum(['STOP_LOSS', 'TRAILING_STOP', 'TAKE_PROFIT']);
const TriggerEnum = z.enum(['CLOSE', 'INTRADAY_LOW', 'INTRADAY_HIGH']);

/**
 * A trail between 1% and 50%.
 *
 * Below one percent a stop sits inside the day-to-day noise of most PSX mid
 * caps and will be hit by nothing in particular; above fifty it is not
 * protecting anything. Both ends are mistakes worth refusing rather than
 * accepting and then explaining.
 */
const trailBps = z.coerce.number().int().min(100).max(5_000);

const CreateBody = z
  .object({
    symbol: symbolString,
    type: RuleTypeEnum,
    triggerOn: TriggerEnum.optional(),
    thresholdPrice: positiveRupeeString.optional(),
    trailAmount: positiveRupeeString.optional(),
    trailBps: trailBps.optional(),
    quantity: wholeShares.optional(),
    note: z.string().trim().max(500).optional(),
    expiresOn: isoDate.optional(),
  })
  // Checked here as well as in the service: the shape is a property of the
  // request, and a 400 that names the field is more use than a 409 later.
  .refine(
    (input) =>
      input.type !== 'TRAILING_STOP' ||
      (input.trailAmount === undefined) !== (input.trailBps === undefined),
    { message: 'A trailing stop needs exactly one of trailAmount or trailBps' },
  )
  .refine((input) => input.type === 'TRAILING_STOP' || input.thresholdPrice !== undefined, {
    message: 'A stop-loss or take-profit needs thresholdPrice',
  });

const UpdateBody = z
  .object({
    thresholdPrice: positiveRupeeString.optional(),
    trailAmount: positiveRupeeString.optional(),
    trailBps: trailBps.optional(),
    quantity: wholeShares.optional(),
    note: z.string().trim().max(500).nullable().optional(),
    triggerOn: TriggerEnum.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: 'Nothing to change' });

const ListQuery = z.object({
  status: z.enum(['ARMED', 'TRIGGERED', 'CANCELLED', 'EXPIRED']).optional(),
});

const SuggestQuery = z.object({
  /** ATR multiples. Two to three is the usual range. */
  multiple: z.coerce.number().min(0.5).max(10).optional(),
});

const BacktestQuery = z
  .object({
    trailBps: trailBps.optional(),
    trailAmount: positiveRupeeString.optional(),
    bars: z.coerce.number().int().min(30).max(1_000).optional(),
    triggerOn: TriggerEnum.optional(),
  })
  .refine((input) => (input.trailBps === undefined) !== (input.trailAmount === undefined), {
    message: 'Give exactly one of trailBps or trailAmount',
  });

export function stopRoutes(tokens: Tokens): Router {
  const router = Router();
  // Per route rather than router.use(): this router is mounted at the bare
  // /api prefix, so a blanket guard would answer 401 for unknown paths.
  const guard = requireActiveUser(tokens);

  router.get(
    '/portfolios/:portfolioId/stops',
    ...guard,
    validate({ params: PortfolioParams, query: ListQuery }),
    async (req, res) => {
      const { portfolioId } = params<z.infer<typeof PortfolioParams>>(req);
      const { id: userId } = currentUser(req);
      const filters = query<z.infer<typeof ListQuery>>(req);

      res.json(
        await listStopRules(
          portfolioId,
          userId,
          filters.status !== undefined ? { status: filters.status } : {},
        ),
      );
    },
  );

  router.post(
    '/portfolios/:portfolioId/stops',
    ...guard,
    validate({ params: PortfolioParams, body: CreateBody }),
    async (req, res) => {
      const { portfolioId } = params<z.infer<typeof PortfolioParams>>(req);
      const { id: userId } = currentUser(req);
      const input = body<z.infer<typeof CreateBody>>(req);

      const rule = await createStopRule({
        portfolioId,
        userId,
        symbol: input.symbol,
        type: input.type,
        ...(input.triggerOn !== undefined ? { triggerOn: input.triggerOn } : {}),
        ...(input.thresholdPrice !== undefined ? { thresholdPrice: input.thresholdPrice } : {}),
        ...(input.trailAmount !== undefined ? { trailAmount: input.trailAmount } : {}),
        ...(input.trailBps !== undefined ? { trailBps: input.trailBps } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.expiresOn !== undefined ? { expiresOn: input.expiresOn } : {}),
      });

      res.status(201).json({ rule });
    },
  );

  router.get('/stops/:ruleId', ...guard, validate({ params: RuleParams }), async (req, res) => {
    const { ruleId } = params<z.infer<typeof RuleParams>>(req);
    const { id: userId } = currentUser(req);

    const rule = await getStopRule(ruleId, userId);
    if (rule === null) throw notFound('Rule');
    res.json({ rule });
  });

  router.patch(
    '/stops/:ruleId',
    ...guard,
    validate({ params: RuleParams, body: UpdateBody }),
    async (req, res) => {
      const { ruleId } = params<z.infer<typeof RuleParams>>(req);
      const { id: userId } = currentUser(req);
      const input = body<z.infer<typeof UpdateBody>>(req);

      res.json({ rule: await updateStopRule(ruleId, { userId, ...input }) });
    },
  );

  /**
   * Cancels a rule. There is no DELETE: a rule is disarmed rather than erased,
   * so "what was I protecting in March" still has an answer.
   */
  router.post(
    '/stops/:ruleId/cancel',
    ...guard,
    validate({ params: RuleParams }),
    async (req, res) => {
      const { ruleId } = params<z.infer<typeof RuleParams>>(req);
      const { id: userId } = currentUser(req);
      res.json({ rule: await cancelStopRule(ruleId, userId) });
    },
  );

  router.post(
    '/stop-events/:eventId/acknowledge',
    ...guard,
    validate({ params: EventParams }),
    async (req, res) => {
      const { eventId } = params<z.infer<typeof EventParams>>(req);
      const { id: userId } = currentUser(req);
      res.json({ event: await acknowledgeEvent(eventId, userId) });
    },
  );

  router.post(
    '/portfolios/:portfolioId/stops/evaluate',
    ...guard,
    validate({ params: PortfolioParams }),
    async (req, res) => {
      const { portfolioId } = params<z.infer<typeof PortfolioParams>>(req);
      const { id: userId } = currentUser(req);

      // Ownership is checked by listing first; evaluateArmedRules takes a
      // portfolio id and would otherwise evaluate a portfolio that is not the
      // caller's.
      await listStopRules(portfolioId, userId);
      res.json({ summary: await evaluateArmedRules({ portfolioId }) });
    },
  );

  /** A trail scaled to the symbol's own range, rather than a round number. */
  router.get(
    '/securities/:symbol/stop-suggestion',
    ...guard,
    validate({ params: SymbolParams, query: SuggestQuery }),
    async (req, res) => {
      const { symbol } = params<z.infer<typeof SymbolParams>>(req);
      const { multiple } = query<z.infer<typeof SuggestQuery>>(req);
      res.json({
        suggestion: await suggestStop(symbol, multiple !== undefined ? { multiple } : {}),
      });
    },
  );

  /** Replays a proposed trail over stored history, with the same evaluator. */
  router.get(
    '/securities/:symbol/stop-backtest',
    ...guard,
    validate({ params: SymbolParams, query: BacktestQuery }),
    async (req, res) => {
      const { symbol } = params<z.infer<typeof SymbolParams>>(req);
      const input = query<z.infer<typeof BacktestQuery>>(req);

      res.json({
        backtest: await backtestTrail(
          symbol,
          {
            ...(input.trailBps !== undefined ? { trailBps: input.trailBps } : {}),
            ...(input.trailAmount !== undefined ? { trailAmount: input.trailAmount } : {}),
          },
          {
            ...(input.bars !== undefined ? { bars: input.bars } : {}),
            ...(input.triggerOn !== undefined ? { triggerOn: input.triggerOn } : {}),
          },
        ),
      });
    },
  );

  return router;
}
