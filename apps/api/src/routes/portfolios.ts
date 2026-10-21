import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound } from '../http/errors.js';
import { body, cuid, params, validate } from '../http/validate.js';
import { prisma } from '../db/prisma.js';
import { currentUser } from '../auth/middleware.js';
import { requireActiveUser } from '../auth/access.js';
import type { Tokens } from '../auth/tokens.js';
import { getPortfolioCycles, getPortfolioPositions } from '../services/positions.js';
import { loadOwnedPortfolio } from '../services/trades.js';

const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  costBasisMethod: z.enum(['FIFO', 'LIFO', 'AVERAGE']).default('FIFO'),
  isPaperTrading: z.boolean().default(false),
  accountId: cuid.optional(),
});

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    costBasisMethod: z.enum(['FIFO', 'LIFO', 'AVERAGE']).optional(),
    accountId: cuid.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

const IdParams = z.object({ id: cuid });

export function portfolioRoutes(tokens: Tokens): Router {
  const router = Router();
  router.use(...requireActiveUser(tokens));

  router.get('/', async (req, res) => {
    const { id: userId } = currentUser(req);
    const portfolios = await prisma.portfolio.findMany({
      where: { userId },
      include: {
        account: { select: { id: true, name: true, brokerName: true } },
        _count: { select: { trades: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      portfolios: portfolios.map((portfolio) => ({
        id: portfolio.id,
        name: portfolio.name,
        costBasisMethod: portfolio.costBasisMethod,
        isPaperTrading: portfolio.isPaperTrading,
        account: portfolio.account,
        tradeCount: portfolio._count.trades,
        createdAt: portfolio.createdAt.toISOString(),
      })),
    });
  });

  router.post('/', validate({ body: CreateBody }), async (req, res) => {
    const { id: userId } = currentUser(req);
    const input = body<z.infer<typeof CreateBody>>(req);

    if (input.accountId !== undefined) {
      const account = await prisma.brokerageAccount.findFirst({
        where: { id: input.accountId, userId },
        select: { id: true },
      });
      if (account === null) throw notFound('Brokerage account');
    }

    const existing = await prisma.portfolio.findFirst({
      where: { userId, name: input.name },
      select: { id: true },
    });
    if (existing !== null) throw conflict('A portfolio with that name already exists');

    const portfolio = await prisma.portfolio.create({
      data: {
        userId,
        name: input.name,
        costBasisMethod: input.costBasisMethod,
        isPaperTrading: input.isPaperTrading,
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      },
    });

    res.status(201).json({ portfolio: serialise(portfolio) });
  });

  router.get('/:id', validate({ params: IdParams }), async (req, res) => {
    const { id } = params<z.infer<typeof IdParams>>(req);
    const { id: userId } = currentUser(req);
    const portfolio = await loadOwnedPortfolio(prisma, id, userId);
    res.json({ portfolio: serialise(portfolio) });
  });

  router.patch('/:id', validate({ params: IdParams, body: UpdateBody }), async (req, res) => {
    const { id } = params<z.infer<typeof IdParams>>(req);
    const { id: userId } = currentUser(req);
    const input = body<z.infer<typeof UpdateBody>>(req);

    await loadOwnedPortfolio(prisma, id, userId);

    // Changing the cost-basis method changes which lots past sales consumed,
    // and therefore every realised figure. Allowed, but the client is told so
    // it can warn rather than silently restating history.
    const changesMethod = input.costBasisMethod !== undefined;

    const portfolio = await prisma.portfolio.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.costBasisMethod !== undefined
          ? { costBasisMethod: input.costBasisMethod }
          : {}),
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      },
    });

    res.json({
      portfolio: serialise(portfolio),
      ...(changesMethod
        ? {
            warning:
              'Changing the cost-basis method restates every realised gain in this ' +
              'portfolio, because sales now consume different lots.',
          }
        : {}),
    });
  });

  router.get('/:id/positions', validate({ params: IdParams }), async (req, res) => {
    const { id } = params<z.infer<typeof IdParams>>(req);
    const { id: userId } = currentUser(req);
    res.json(await getPortfolioPositions(id, userId));
  });

  router.get(
    '/:id/cycles',
    validate({ params: IdParams, query: z.object({ symbol: z.string().trim().toUpperCase().optional() }) }),
    async (req, res) => {
      const { id } = params<z.infer<typeof IdParams>>(req);
      const { id: userId } = currentUser(req);
      const symbol = (req.valid?.query as { symbol?: string } | undefined)?.symbol;
      res.json(await getPortfolioCycles(id, userId, symbol));
    },
  );

  return router;
}

function serialise(portfolio: {
  id: string;
  name: string;
  costBasisMethod: string;
  isPaperTrading: boolean;
  accountId: string | null;
  createdAt: Date;
}) {
  return {
    id: portfolio.id,
    name: portfolio.name,
    costBasisMethod: portfolio.costBasisMethod,
    isPaperTrading: portfolio.isPaperTrading,
    accountId: portfolio.accountId,
    createdAt: portfolio.createdAt.toISOString(),
  };
}
