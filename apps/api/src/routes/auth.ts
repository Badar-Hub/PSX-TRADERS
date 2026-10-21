import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { badRequest, conflict, unauthorized } from '../http/errors.js';
import { body, validate } from '../http/validate.js';
import { prisma } from '../db/prisma.js';
import { hashPassword, needsRehash, verifyPassword, WeakPasswordError } from '../auth/password.js';
import { hashRefreshToken, type Tokens } from '../auth/tokens.js';
import { currentUser, requireUser } from '../auth/middleware.js';

/**
 * Authentication.
 *
 * Refresh tokens rotate: presenting one invalidates it and issues a new pair.
 * If a stolen token is used, the legitimate user's next refresh fails and the
 * theft surfaces, instead of both parties holding a valid session indefinitely.
 */

const RegisterBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(1024),
  name: z.string().trim().min(1).max(120).optional(),
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
});

const RefreshBody = z.object({
  refreshToken: z.string().min(1).max(512),
});

/**
 * Rate limit on the credential endpoints specifically.
 *
 * Login is where an attacker can make unlimited cheap guesses, and scrypt makes
 * each attempt expensive for the server too, so this protects availability as
 * well as accounts.
 */
export function authRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts; try again later' } },
  });
}

export function authRoutes(tokens: Tokens): Router {
  const router = Router();
  const limiter = authRateLimiter();

  router.post('/register', limiter, validate({ body: RegisterBody }), async (req, res) => {
    const input = body<z.infer<typeof RegisterBody>>(req);

    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing !== null) throw conflict('An account with that email already exists');

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(input.password);
    } catch (error) {
      if (error instanceof WeakPasswordError) throw badRequest(error.message);
      throw error;
    }

    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        ...(input.name !== undefined ? { name: input.name } : {}),
      },
      select: { id: true, email: true, name: true },
    });

    // A first portfolio, so the app is usable immediately rather than opening
    // on an empty state that asks for setup before anything can be recorded.
    await prisma.portfolio.create({
      data: { userId: user.id, name: 'Main' },
    });

    const pair = await issueTokenPair(tokens, user, req.header('user-agent'));
    res.status(201).json({ user, ...pair });
  });

  router.post('/login', limiter, validate({ body: LoginBody }), async (req, res) => {
    const input = body<z.infer<typeof LoginBody>>(req);

    const user = await prisma.user.findUnique({ where: { email: input.email } });

    // The same message and a real hash comparison either way, so a response
    // does not reveal whether an email is registered, by content or by timing.
    const storedHash =
      user?.passwordHash ??
      'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(input.password, storedHash);

    if (user === null || !ok) throw unauthorized('Email or password is incorrect');

    // Transparently upgrade a hash made with weaker parameters.
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(input.password);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
    }

    const pair = await issueTokenPair(
      tokens,
      { id: user.id, email: user.email },
      req.header('user-agent'),
    );
    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      ...pair,
    });
  });

  router.post('/refresh', validate({ body: RefreshBody }), async (req, res) => {
    const { refreshToken } = body<z.infer<typeof RefreshBody>>(req);
    const tokenHash = hashRefreshToken(refreshToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    if (stored === null) throw unauthorized('Refresh token is not valid');
    if (stored.revokedAt !== null) {
      // A revoked token being presented again means it was captured, or the
      // client is replaying. Either way every session for the user is dropped.
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw unauthorized('Refresh token has been revoked; sign in again');
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw unauthorized('Refresh token has expired; sign in again');
    }

    // Rotation: the presented token dies as the new one is issued.
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const pair = await issueTokenPair(tokens, stored.user, req.header('user-agent'));
    res.json({ user: stored.user, ...pair });
  });

  router.post('/logout', validate({ body: RefreshBody }), async (req, res) => {
    const { refreshToken } = body<z.infer<typeof RefreshBody>>(req);
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Always 204: whether that token existed is not the caller's business, and
    // logging out should never fail.
    res.status(204).end();
  });

  router.get('/me', requireUser(tokens), async (req, res) => {
    const { id } = currentUser(req);
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, isTaxFiler: true, timezone: true, createdAt: true },
    });
    if (user === null) throw unauthorized('Account no longer exists');
    res.json({ user });
  });

  return router;
}

async function issueTokenPair(
  tokens: Tokens,
  user: { id: string; email: string },
  userAgent: string | undefined,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = await tokens.signAccessToken(user);
  const refresh = tokens.issueRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
      ...(userAgent !== undefined ? { userAgent: userAgent.slice(0, 255) } : {}),
    },
  });

  return {
    accessToken,
    refreshToken: refresh.token,
    expiresIn: Math.floor(tokens.refreshTtlMs / 1000),
  };
}
