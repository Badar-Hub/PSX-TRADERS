import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../http/errors.js';
import { cuid, isoDate, params, query, validate } from '../http/validate.js';
import { currentUser } from '../auth/middleware.js';
import { requireActiveUser } from '../auth/access.js';
import type { Tokens } from '../auth/tokens.js';
import { getPnlReport } from '../services/reports.js';

const PortfolioParams = z.object({ portfolioId: cuid });

const boolFlag = z
  .union([z.literal('true'), z.literal('false')])
  .transform((value) => value === 'true');

const PnlQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Defaults on, since a report without it understates how the year is going. */
  includeUnrealised: boolFlag.optional(),
  includeCgtEstimate: boolFlag.optional(),
});

/** Pakistan's tax year runs 1 July to 30 June. */
export function currentTaxYear(today = new Date()): { from: string; to: string } {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const startYear = month >= 6 ? year : year - 1;
  return { from: `${startYear}-07-01`, to: `${startYear + 1}-06-30` };
}

export function reportRoutes(tokens: Tokens): Router {
  const router = Router();
  // Per route, not router.use(): mounted at the bare /api prefix, a blanket
  // guard would answer 401 for every unknown /api/... path.
  const guard = requireActiveUser(tokens);

  /**
   * The profit and loss statement.
   *
   * Defaults to the current Pakistani tax year, since that is the period the
   * figure is usually wanted for.
   */
  router.get(
    '/portfolios/:portfolioId/reports/pnl',
    ...guard,
    validate({ params: PortfolioParams, query: PnlQuery }),
    async (req, res) => {
      const { portfolioId } = params<z.infer<typeof PortfolioParams>>(req);
      const { id: userId } = currentUser(req);
      const filters = query<z.infer<typeof PnlQuery>>(req);

      const defaults = currentTaxYear();
      const from = filters.from ?? defaults.from;
      const to = filters.to ?? defaults.to;

      if (from > to) throw badRequest('The "from" date must not be after the "to" date');

      const report = await getPnlReport({
        portfolioId,
        userId,
        from,
        to,
        includeUnrealised: filters.includeUnrealised ?? true,
        includeCgtEstimate: filters.includeCgtEstimate ?? true,
      });

      res.json({ report });
    },
  );

  return router;
}
