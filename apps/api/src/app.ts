import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { Tokens } from './auth/tokens.js';
import { createMailer, type Mailer } from './email/mailer.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { portfolioRoutes } from './routes/portfolios.js';
import { reportRoutes } from './routes/reports.js';
import { signalRoutes } from './routes/signals.js';
import { stopRoutes } from './routes/stops.js';
import { tradeRoutes } from './routes/trades.js';
import type { Env } from './env.js';
import { prisma } from './db/prisma.js';

/**
 * Builds the Express app.
 *
 * Separate from the server so tests can mount it without binding a port, and
 * so configuration arrives as an argument rather than being read from
 * process.env deep inside a route.
 *
 * Express 5 is used for one specific reason: it forwards a rejected promise
 * from a handler to the error middleware. Under Express 4 an unawaited
 * rejection in an async route hangs the request until it times out, and every
 * handler needs a wrapper to avoid it.
 */

export interface AppOptions {
  env: Env;
  /** Overridden in tests to keep expected errors out of the output. */
  logError?: (error: unknown, context: { requestId?: string; method: string; path: string }) => void;
  /** Overridden in tests with a recording mailer, so nothing is sent. */
  mailer?: Mailer;
}

export function createApp(options: AppOptions): Express {
  const { env } = options;
  const app = express();

  // Behind a reverse proxy in production, so the rate limiter and logs see the
  // real client address rather than the proxy's.
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(helmet());

  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      maxAge: 86_400,
    }),
  );

  // A modest body limit: every endpoint here takes a small JSON object, and a
  // large default is free denial-of-service surface.
  app.use(express.json({ limit: '256kb' }));

  // A request id on every response, so a 500 the user reports can be found in
  // the logs without guessing.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming !== undefined && incoming.length <= 200 ? incoming : randomUUID();
    res.setHeader('x-request-id', id);
    next();
  });

  const tokens = new Tokens({
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.ACCESS_TOKEN_TTL,
    refreshTtl: env.REFRESH_TOKEN_TTL,
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  /** Readiness, as distinct from liveness: it checks the database answers. */
  app.get('/health/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ready', database: 'up' });
    } catch {
      res.status(503).json({ status: 'not-ready', database: 'down' });
    }
  });

  const mailer = options.mailer ?? createMailer(env);

  app.use('/api/auth', authRoutes(tokens, env, mailer));
  app.use('/api', adminRoutes(tokens, env, mailer));
  app.use('/api/portfolios', portfolioRoutes(tokens));
  app.use('/api', tradeRoutes(tokens));
  app.use('/api', reportRoutes(tokens));
  app.use('/api', signalRoutes(tokens));
  app.use('/api', stopRoutes(tokens));

  app.use(notFoundHandler);
  app.use(errorHandler(options.logError !== undefined ? { log: options.logError } : {}));

  return app;
}
