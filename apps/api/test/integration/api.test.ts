import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { rupeesToPaisa } from '@psx/shared';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { prisma } from '../../src/db/prisma.js';

/**
 * End-to-end tests over real HTTP against a real database.
 *
 * These skip when no database is reachable, rather than failing. The unit
 * suites cover the logic that does not need one; this covers the things only an
 * integration test can: that the routes are wired up, that the projection
 * rebuild runs inside the trade's transaction, that ownership checks hold, and
 * that a figure survives the round trip through Postgres and back.
 *
 * Run them with:
 *   pnpm infra:up && pnpm --filter @psx/api db:deploy && pnpm --filter @psx/api test
 */

const rs = (value: string) => rupeesToPaisa(value);

async function databaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * These tests truncate every table, including `securities` and `daily_bars`,
 * which hold shared market data rather than per-user rows. Pointed at the
 * development database, a run would silently destroy backfilled price history,
 * and the only symptom would be predictions refusing for want of data.
 *
 * So the suite refuses to run unless the database is named like a test
 * database. Failing to run is recoverable; deleting a year of prices is not.
 */
function isTestDatabase(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  const name = url.split('/').pop()?.split('?')[0] ?? '';
  return /test/i.test(name);
}

const onTestDatabase = isTestDatabase();
const hasDatabase = onTestDatabase && (await databaseReachable());

if (!onTestDatabase) {
  console.warn(
    `\n  Skipping API integration tests: DATABASE_URL does not name a test database.` +
      `\n  These tests truncate every table, so they refuse to touch anything else.` +
      `\n  Set it up with \`pnpm --filter @psx/api db:test:setup\`.\n`,
  );
} else if (!hasDatabase) {
  console.warn(
    '\n  Skipping API integration tests: the test database is not reachable.' +
      '\n  Start one with `pnpm infra:up && pnpm --filter @psx/api db:test:setup`.\n',
  );
}

/** Deletes in foreign-key-safe order so each run starts clean. */
async function resetDatabase(): Promise<void> {
  await prisma.lotConsumption.deleteMany();
  await prisma.taxLot.deleteMany();
  await prisma.positionCycle.deleteMany();
  await prisma.cashTransaction.deleteMany();
  await prisma.corporateActionApplication.deleteMany();
  await prisma.corporateAction.deleteMany();
  await prisma.alertEvent.deleteMany();
  await prisma.alertRule.deleteMany();
  await prisma.signalFactor.deleteMany();
  await prisma.signal.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.fundamental.deleteMany();
  await prisma.dailyBar.deleteMany();
  await prisma.security.deleteMany();
  await prisma.portfolio.deleteMany();
  await prisma.brokerageAccount.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.ingestRun.deleteMany();
}

const app = hasDatabase
  ? createApp({
      env: loadEnv(),
      // Expected 500s would otherwise clutter the output; there should be none.
      logError: () => {},
    })
  : null;

interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  portfolioId: string;
}

async function signUp(email: string): Promise<Session> {
  const response = await request(app!)
    .post('/api/auth/register')
    .send({ email, password: 'a-long-enough-password', name: 'Test User' })
    .expect(201);

  const portfolios = await request(app!)
    .get('/api/portfolios')
    .set('authorization', `Bearer ${response.body.accessToken}`)
    .expect(200);

  return {
    accessToken: response.body.accessToken,
    refreshToken: response.body.refreshToken,
    userId: response.body.user.id,
    portfolioId: portfolios.body.portfolios[0].id,
  };
}

function auth(session: Session) {
  return { authorization: `Bearer ${session.accessToken}` };
}

describe.skipIf(!hasDatabase)('API end to end', () => {
  let session: Session;

  beforeAll(async () => {
    await resetDatabase();
    session = await signUp('trader@example.com');
  });

  // Deliberately no $disconnect here. The Prisma client is a process-wide
  // singleton shared with the other integration file, so disconnecting at the
  // end of this one leaves the next with a closed engine. The pool closes when
  // the process exits.

  describe('health', () => {
    it('reports liveness without touching the database', async () => {
      const res = await request(app!).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('reports readiness by actually querying', async () => {
      const res = await request(app!).get('/health/ready').expect(200);
      expect(res.body).toMatchObject({ status: 'ready', database: 'up' });
    });
  });

  describe('authentication', () => {
    it('creates a first portfolio on registration', async () => {
      const res = await request(app!).get('/api/portfolios').set(auth(session)).expect(200);
      expect(res.body.portfolios).toHaveLength(1);
      expect(res.body.portfolios[0].name).toBe('Main');
      expect(res.body.portfolios[0].costBasisMethod).toBe('FIFO');
    });

    it('returns the current user', async () => {
      const res = await request(app!).get('/api/auth/me').set(auth(session)).expect(200);
      expect(res.body.user.email).toBe('trader@example.com');
      expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    it('refuses a request with no token', async () => {
      const res = await request(app!).get('/api/portfolios').expect(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('refuses a forged token', async () => {
      await request(app!)
        .get('/api/portfolios')
        .set('authorization', 'Bearer not.a.real.token')
        .expect(401);
    });

    it('refuses a duplicate registration', async () => {
      const res = await request(app!)
        .post('/api/auth/register')
        .send({ email: 'trader@example.com', password: 'another-long-password' })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('gives the same message for a wrong password and an unknown email', async () => {
      const wrongPassword = await request(app!)
        .post('/api/auth/login')
        .send({ email: 'trader@example.com', password: 'wrong-password-here' })
        .expect(401);
      const unknownEmail = await request(app!)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrong-password-here' })
        .expect(401);

      // Identical, so a response cannot be used to enumerate accounts.
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });

    it('logs in with the right password', async () => {
      const res = await request(app!)
        .post('/api/auth/login')
        .send({ email: 'trader@example.com', password: 'a-long-enough-password' })
        .expect(200);
      expect(res.body.accessToken).toBeTypeOf('string');
      expect(res.body.refreshToken).toBeTypeOf('string');
    });

    it('rejects a password below the minimum length', async () => {
      const res = await request(app!)
        .post('/api/auth/register')
        .send({ email: 'short@example.com', password: 'short' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    /**
     * Rotation: a refresh token is single use. If one is stolen, the next
     * legitimate refresh fails and the theft surfaces, instead of both parties
     * holding a working session.
     */
    it('rotates the refresh token and invalidates the old one', async () => {
      const temp = await signUp('rotate@example.com');

      const first = await request(app!)
        .post('/api/auth/refresh')
        .send({ refreshToken: temp.refreshToken })
        .expect(200);
      expect(first.body.refreshToken).not.toBe(temp.refreshToken);

      const replay = await request(app!)
        .post('/api/auth/refresh')
        .send({ refreshToken: temp.refreshToken })
        .expect(401);
      expect(replay.body.error.message).toMatch(/revoked/i);

      // Reuse of a revoked token drops every session for that user, so the
      // token just issued stops working too.
      await request(app!)
        .post('/api/auth/refresh')
        .send({ refreshToken: first.body.refreshToken })
        .expect(401);
    });

    it('logs out idempotently', async () => {
      const temp = await signUp('logout@example.com');
      await request(app!)
        .post('/api/auth/logout')
        .send({ refreshToken: temp.refreshToken })
        .expect(204);
      // Again, with a token that is already revoked.
      await request(app!)
        .post('/api/auth/logout')
        .send({ refreshToken: temp.refreshToken })
        .expect(204);
    });
  });

  describe('trades and positions', () => {
    let portfolioId: string;

    beforeAll(async () => {
      const created = await request(app!)
        .post('/api/portfolios')
        .set(auth(session))
        .send({ name: 'Trading', costBasisMethod: 'FIFO' })
        .expect(201);
      portfolioId = created.body.portfolio.id;
    });

    it('records a purchase', async () => {
      const res = await request(app!)
        .post(`/api/portfolios/${portfolioId}/trades`)
        .set(auth(session))
        .send({
          symbol: 'ABL',
          side: 'BUY',
          tradedOn: '2026-01-10',
          quantity: 100,
          unitPrice: '150.00',
          charges: { brokerage: '22.50' },
        })
        .expect(201);

      expect(res.body.trade).toMatchObject({
        symbol: 'ABL',
        side: 'BUY',
        quantity: 100,
        unitPrice: rs('150.00'),
        grossValue: rs('15000.00'),
      });
      expect(res.body.trade.charges.total).toBe(rs('22.50'));
      // A buy costs the value plus the charges.
      expect(res.body.trade.netCashFlow).toBe(rs('15022.50'));
    });

    it('shows the holding with charges folded into the cost basis', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/positions`)
        .set(auth(session))
        .expect(200);

      expect(res.body.positions).toHaveLength(1);
      expect(res.body.positions[0]).toMatchObject({
        symbol: 'ABL',
        quantity: 100,
        costBasis: rs('15022.50'),
        averageCost: rs('150.23'),
      });
      // No price has been ingested, so the valuation is withheld rather than
      // guessed at.
      expect(res.body.positions[0].marketPrice).toBeNull();
      expect(res.body.hasMissingPrices).toBe(true);
      expect(res.body.marketValue).toBeNull();
    });

    it('values the holding once a price exists', async () => {
      const security = await prisma.security.findUniqueOrThrow({ where: { symbol: 'ABL' } });
      await prisma.dailyBar.create({
        data: {
          securityId: security.id,
          date: new Date('2026-10-20T00:00:00.000Z'),
          open: 17_015n,
          high: 17_075n,
          low: 17_015n,
          close: 17_019n,
          volume: 3085,
          ldcp: 17_049n,
        },
      });

      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/positions`)
        .set(auth(session))
        .expect(200);

      const position = res.body.positions[0];
      expect(position.marketPrice).toBe(rs('170.19'));
      expect(position.priceAsOf).toBe('2026-10-20');
      expect(position.marketValue).toBe(rs('17019.00'));
      expect(position.unrealisedPnl).toBe(rs('1996.50'));
      expect(res.body.hasMissingPrices).toBe(false);
      expect(position.weightBps).toBe(10_000);
    });

    it('realises a gain on a partial sale, FIFO', async () => {
      await request(app!)
        .post(`/api/portfolios/${portfolioId}/trades`)
        .set(auth(session))
        .send({
          symbol: 'ABL',
          side: 'SELL',
          tradedOn: '2026-04-10',
          quantity: 40,
          unitPrice: '180.00',
          charges: { brokerage: '10.80' },
        })
        .expect(201);

      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/positions`)
        .set(auth(session))
        .expect(200);

      expect(res.body.positions[0].quantity).toBe(60);
      // 40 of 100 shares: 40% of the 15,022.50 basis is 6,009.00. Proceeds of
      // 7,200.00 less 10.80 of charges leaves a gain of 1,180.20.
      expect(res.body.realisedPnl).toBe(rs('1180.20'));
      expect(res.body.positions[0].costBasis).toBe(rs('9013.50'));
    });

    /**
     * The ledger refuses a short, and the rebuild runs inside the trade's
     * transaction, so the rejected trade must leave no row behind.
     */
    it('refuses to sell more than is held, and records nothing', async () => {
      const before = await prisma.trade.count({ where: { portfolioId } });

      const res = await request(app!)
        .post(`/api/portfolios/${portfolioId}/trades`)
        .set(auth(session))
        .send({
          symbol: 'ABL',
          side: 'SELL',
          tradedOn: '2026-05-10',
          quantity: 500,
          unitPrice: '180.00',
        })
        .expect(409);

      expect(res.body.error.code).toBe('INSUFFICIENT_SHARES');
      expect(res.body.error.details).toMatchObject({ requested: 500, available: 60 });
      expect(await prisma.trade.count({ where: { portfolioId } })).toBe(before);
    });

    it('lists trades newest first', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/trades`)
        .set(auth(session))
        .expect(200);
      expect(res.body.trades).toHaveLength(2);
      expect(res.body.trades[0].tradedOn).toBe('2026-04-10');
    });

    it('rejects a price with sub-paisa precision', async () => {
      const res = await request(app!)
        .post(`/api/portfolios/${portfolioId}/trades`)
        .set(auth(session))
        .send({
          symbol: 'ABL',
          side: 'BUY',
          tradedOn: '2026-05-10',
          quantity: 10,
          unitPrice: '150.001',
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a fractional share count', async () => {
      await request(app!)
        .post(`/api/portfolios/${portfolioId}/trades`)
        .set(auth(session))
        .send({
          symbol: 'ABL',
          side: 'BUY',
          tradedOn: '2026-05-10',
          quantity: 10.5,
          unitPrice: '150.00',
        })
        .expect(400);
    });
  });

  describe('cycles and buy-backs', () => {
    let portfolioId: string;

    beforeAll(async () => {
      const created = await request(app!)
        .post('/api/portfolios')
        .set(auth(session))
        .send({ name: 'Buybacks' })
        .expect(201);
      portfolioId = created.body.portfolio.id;

      const trades = [
        { side: 'BUY', tradedOn: '2026-01-05', quantity: 100, unitPrice: '100.00' },
        { side: 'SELL', tradedOn: '2026-03-05', quantity: 100, unitPrice: '130.00' },
        { side: 'BUY', tradedOn: '2026-04-05', quantity: 100, unitPrice: '110.00' },
      ];
      for (const trade of trades) {
        await request(app!)
          .post(`/api/portfolios/${portfolioId}/trades`)
          .set(auth(session))
          .send({ symbol: 'HBL', ...trade })
          .expect(201);
      }
    });

    it('reports a closed round trip and the open one that followed', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/cycles`)
        .set(auth(session))
        .expect(200);

      expect(res.body.cycles).toHaveLength(2);
      const closed = res.body.cycles.find((cycle: { isOpen: boolean }) => !cycle.isOpen);
      expect(closed).toMatchObject({
        symbol: 'HBL',
        openedOn: '2026-01-05',
        closedOn: '2026-03-05',
        realisedPnl: rs('3000.00'),
        holdingDays: 59,
      });
    });

    /** The figure that says whether stepping out actually paid. */
    it('credits the saving on the repurchase', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/cycles`)
        .set(auth(session))
        .expect(200);

      expect(res.body.buyBacks).toHaveLength(1);
      expect(res.body.buyBacks[0]).toMatchObject({
        symbol: 'HBL',
        previousExitPrice: rs('130.00'),
        buyPrice: rs('110.00'),
        advantage: rs('2000.00'),
        daysOut: 31,
        fullyExited: true,
      });
    });

    it('persists the buy-back onto the stored cycle', async () => {
      const cycles = await prisma.positionCycle.findMany({
        where: { portfolioId },
        orderBy: { cycleIndex: 'asc' },
      });
      expect(cycles).toHaveLength(2);
      expect(cycles[0]?.isBuyBack).toBe(false);
      expect(cycles[1]?.isBuyBack).toBe(true);
      expect(cycles[1]?.buyBackAdvantage).toBe(200_000n);
    });
  });

  describe('reversing a trade', () => {
    let portfolioId: string;
    let tradeId: string;

    beforeAll(async () => {
      const created = await request(app!)
        .post('/api/portfolios')
        .set(auth(session))
        .send({ name: 'Corrections' })
        .expect(201);
      portfolioId = created.body.portfolio.id;

      const trade = await request(app!)
        .post(`/api/portfolios/${portfolioId}/trades`)
        .set(auth(session))
        .send({
          symbol: 'OGDC',
          side: 'BUY',
          tradedOn: '2026-02-01',
          quantity: 200,
          unitPrice: '290.00',
        })
        .expect(201);
      tradeId = trade.body.trade.id;
    });

    it('cancels with an entry rather than deleting', async () => {
      const res = await request(app!)
        .post(`/api/trades/${tradeId}/reverse`)
        .set(auth(session))
        .send({ reason: 'Entered against the wrong portfolio' })
        .expect(200);

      expect(res.body.reversed.status).toBe('REVERSED');
      expect(res.body.reversal.side).toBe('SELL');
      expect(res.body.reversal.reversesTradeId).toBe(tradeId);

      // Both rows survive: the audit trail is the point.
      const rows = await prisma.trade.findMany({ where: { portfolioId } });
      expect(rows).toHaveLength(2);
    });

    it('removes the position the reversed trade had created', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/positions`)
        .set(auth(session))
        .expect(200);
      expect(res.body.positions).toHaveLength(0);
      expect(await prisma.taxLot.count({ where: { portfolioId } })).toBe(0);
    });

    it('refuses to reverse the same trade twice', async () => {
      const res = await request(app!)
        .post(`/api/trades/${tradeId}/reverse`)
        .set(auth(session))
        .send({})
        .expect(409);
      expect(res.body.error.message).toMatch(/already been reversed/i);
    });
  });

  describe('P&L report', () => {
    let portfolioId: string;

    beforeAll(async () => {
      const created = await request(app!)
        .post('/api/portfolios')
        .set(auth(session))
        .send({ name: 'Reporting' })
        .expect(201);
      portfolioId = created.body.portfolio.id;

      // A winner and a loser, both inside the 2026-27 tax year.
      const trades = [
        { symbol: 'PRL', side: 'BUY', tradedOn: '2026-07-10', quantity: 100, unitPrice: '150.00' },
        { symbol: 'PRL', side: 'SELL', tradedOn: '2026-08-10', quantity: 100, unitPrice: '180.00' },
        { symbol: 'TPL', side: 'BUY', tradedOn: '2026-07-15', quantity: 50, unitPrice: '280.00' },
        { symbol: 'TPL', side: 'SELL', tradedOn: '2026-09-15', quantity: 50, unitPrice: '260.00' },
      ];
      for (const trade of trades) {
        await request(app!)
          .post(`/api/portfolios/${portfolioId}/trades`)
          .set(auth(session))
          .send(trade)
          .expect(201);
      }
    });

    it('separates gains, losses and the net', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/reports/pnl?from=2026-07-01&to=2027-06-30`)
        .set(auth(session))
        .expect(200);

      const report = res.body.report;
      expect(report.realisedGains).toBe(rs('3000.00'));
      expect(report.realisedLosses).toBe(rs('-1000.00'));
      expect(report.realisedNet).toBe(rs('2000.00'));
      expect(report.tradeCount).toBe(2);
      expect(report.winningTrades).toBe(1);
      expect(report.losingTrades).toBe(1);
      expect(report.winRate).toBe(0.5);
    });

    it('names the best and worst trade', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/reports/pnl?from=2026-07-01&to=2027-06-30`)
        .set(auth(session))
        .expect(200);
      expect(res.body.report.bestTrade.symbol).toBe('PRL');
      expect(res.body.report.worstTrade.symbol).toBe('TPL');
    });

    it('labels the CGT figure as an estimate with the rate it used', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/reports/pnl?from=2026-07-01&to=2027-06-30`)
        .set(auth(session))
        .expect(200);

      // 12.5% of the 2,000.00 net, losses offset against gains.
      expect(res.body.report.estimatedCgt).toBe(rs('250.00'));
      expect(res.body.report.cgtBasis).toMatchObject({
        rateBps: 1250,
        filerStatus: 'FILER',
        isEstimate: true,
      });
    });

    it('defaults to the current Pakistani tax year', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/reports/pnl`)
        .set(auth(session))
        .expect(200);
      expect(res.body.report.from).toBe('2026-07-01');
      expect(res.body.report.to).toBe('2027-06-30');
    });

    it('excludes activity outside the requested period', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${portfolioId}/reports/pnl?from=2026-09-01&to=2026-09-30`)
        .set(auth(session))
        .expect(200);
      expect(res.body.report.tradeCount).toBe(1);
      expect(res.body.report.realisedNet).toBe(rs('-1000.00'));
    });

    it('refuses a backwards period', async () => {
      await request(app!)
        .get(`/api/portfolios/${portfolioId}/reports/pnl?from=2027-01-01&to=2026-01-01`)
        .set(auth(session))
        .expect(400);
    });
  });

  /**
   * Ownership. Every one of these must be a 404 rather than a 403: saying
   * "forbidden" would confirm that another user's portfolio exists.
   */
  describe('tenant isolation', () => {
    let other: Session;
    let victimPortfolioId: string;

    beforeAll(async () => {
      other = await signUp('intruder@example.com');
      const created = await request(app!)
        .post('/api/portfolios')
        .set(auth(session))
        .send({ name: 'Private' })
        .expect(201);
      victimPortfolioId = created.body.portfolio.id;
    });

    it('hides another user portfolio', async () => {
      const res = await request(app!)
        .get(`/api/portfolios/${victimPortfolioId}`)
        .set(auth(other))
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('refuses to read its positions', async () => {
      await request(app!)
        .get(`/api/portfolios/${victimPortfolioId}/positions`)
        .set(auth(other))
        .expect(404);
    });

    it('refuses to write a trade into it', async () => {
      await request(app!)
        .post(`/api/portfolios/${victimPortfolioId}/trades`)
        .set(auth(other))
        .send({ symbol: 'ABL', side: 'BUY', tradedOn: '2026-01-01', quantity: 1, unitPrice: '1.00' })
        .expect(404);
    });

    it('refuses to read its P&L', async () => {
      await request(app!)
        .get(`/api/portfolios/${victimPortfolioId}/reports/pnl`)
        .set(auth(other))
        .expect(404);
    });

    it('only lists its own portfolios', async () => {
      const res = await request(app!).get('/api/portfolios').set(auth(other)).expect(200);
      expect(res.body.portfolios).toHaveLength(1);
      expect(res.body.portfolios[0].name).toBe('Main');
    });
  });

  describe('unknown routes', () => {
    it('returns a structured 404', async () => {
      const res = await request(app!).get('/api/nope').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
