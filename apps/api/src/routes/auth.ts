import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { badRequest, conflict, unauthorized } from '../http/errors.js';
import { body, validate } from '../http/validate.js';
import { prisma } from '../db/prisma.js';
import {
  assertPasswordUsable,
  hashPassword,
  needsRehash,
  verifyPassword,
  WeakPasswordError,
} from '../auth/password.js';
import { hashRefreshToken, type Tokens } from '../auth/tokens.js';
import { loadAccount, currentAccount, nextStep } from '../auth/access.js';
import { currentUser } from '../auth/middleware.js';
import {
  configFromEnv,
  issueVerificationCode,
  verifyCode,
  CODE_LENGTH,
} from '../auth/verification.js';
import type { Env } from '../env.js';
import { EmailError, type Mailer } from '../email/mailer.js';

/**
 * Registration, verification and sign-in.
 *
 * Onboarding has two gates and they are independent: the user proves the email
 * is theirs, then an administrator decides whether to let them in. Tokens are
 * issued at registration even though the account cannot do anything yet, which
 * is the one decision here worth explaining.
 *
 * The alternative — no tokens until approved — means the sign-up screen has
 * nothing to poll and the app has to ask for the password again at every step.
 * Issuing tokens and blocking the routes instead lets the client call
 * `/auth/me`, read the status, and render "enter your code" or "waiting for
 * approval" with a specific reason. The token by itself grants nothing: every
 * other route sits behind `requireActiveUser`, which re-reads the status from
 * the database on each request, so a rejection takes effect immediately rather
 * than when the token expires.
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

const RefreshBody = z.object({ refreshToken: z.string().min(1).max(512) });

const ChangePasswordBody = z.object({
  // No minimum on the current one: it is checked against the stored hash, and
  // a length rule here would only reject the attempt a step earlier with a
  // less useful message.
  currentPassword: z.string().min(1).max(1024),
  // Matches RegisterBody, so a password accepted at sign-up is accepted here.
  newPassword: z.string().min(10).max(1024),
});

const VerifyBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z
    .string()
    .trim()
    // Spaces and dashes stripped: people paste "123 456" out of the email.
    .transform((value) => value.replace(/[\s-]/g, ''))
    .refine((value) => new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value), {
      message: `Enter the ${CODE_LENGTH}-digit code from your email`,
    }),
});

const ResendBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export function authRateLimiter(limit = 20) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts; try again later' } },
  });
}

/**
 * A tighter limit on the code endpoints.
 *
 * Six digits is a million possibilities and each code allows five guesses, so
 * the per-code budget is the main defence. This bounds the other axis: an
 * attacker registering many accounts, or hammering one address, to buy more
 * five-guess budgets.
 */
function codeRateLimiter(limit = 10) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many code attempts; try again later' },
    },
  });
}

export function authRoutes(tokens: Tokens, env: Env, mailer: Mailer): Router {
  const router = Router();
  const limiter = authRateLimiter(env.AUTH_RATE_LIMIT);
  const codeLimiter = codeRateLimiter(env.CODE_RATE_LIMIT);
  const config = configFromEnv(env);

  router.post('/register', limiter, validate({ body: RegisterBody }), async (req, res) => {
    const input = body<z.infer<typeof RegisterBody>>(req);

    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, status: true, email: true, name: true },
    });

    if (existing !== null) {
      // An account stuck at PENDING_VERIFICATION is almost always the same
      // person trying again because the first email never arrived. Re-issuing
      // the code is far more useful than an error, and reveals nothing a
      // registration form does not already reveal.
      if (existing.status === 'PENDING_VERIFICATION') {
        const { expiresAt } = await issueVerificationCode(existing, config, mailer);
        res.status(202).json({
          status: 'PENDING_VERIFICATION',
          message: 'That email is already registered but not verified. A new code has been sent.',
          codeExpiresAt: expiresAt.toISOString(),
          codeLength: CODE_LENGTH,
        });
        return;
      }
      // Falls through to the conflict below for any other status.
      throw conflict('An account with that email already exists');
    }

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
      select: { id: true, email: true, name: true, status: true, role: true },
    });

    // The first portfolio is created now rather than on approval, so an
    // approved account opens on a usable app instead of a setup step.
    await prisma.portfolio.create({ data: { userId: user.id, name: 'Main' } });

    const pair = await issueTokenPair(tokens, user, req.header('user-agent'));

    /*
     * The account exists from here on, whatever happens to the email.
     *
     * A mail server being briefly unreachable should not throw away a
     * perfectly good registration, and it must not surface as "something went
     * wrong" either — the caller would have no idea an account had been
     * created, or that pressing resend is the way out. So the failure is
     * reported specifically, with the tokens still issued so the client can
     * land on the verify screen and use its resend button.
     */
    try {
      const { expiresAt } = await issueVerificationCode(user, config, mailer);
      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          status: user.status,
          role: user.role,
        },
        ...pair,
        codeExpiresAt: expiresAt.toISOString(),
        codeLength: CODE_LENGTH,
        next: 'VERIFY_EMAIL',
      });
    } catch (error) {
      if (!(error instanceof EmailError)) throw error;
      console.error('[auth] account created but the code could not be sent:', error.message);
      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          status: user.status,
          role: user.role,
        },
        ...pair,
        codeLength: CODE_LENGTH,
        next: 'VERIFY_EMAIL',
        warning: {
          code: 'EMAIL_SEND_FAILED',
          message:
            'Your account was created, but the verification email could not be sent just now. ' +
            'Use "resend code" in a moment.',
        },
      });
    }
  });

  router.post('/verify-email', codeLimiter, validate({ body: VerifyBody }), async (req, res) => {
    const input = body<z.infer<typeof VerifyBody>>(req);
    const outcome = await verifyCode(input.email, input.code, config, mailer, env.APP_URL);

    if (!outcome.ok) {
      const messages: Record<typeof outcome.reason, string> = {
        NO_CODE: 'That code is not valid. Request a new one.',
        EXPIRED: `That code has expired. Codes last ${config.ttlMinutes} minutes — request a new one.`,
        SUPERSEDED:
          'That code was replaced when a new one was sent. Use the code from the most ' +
          'recent email.',
        WRONG_CODE:
          outcome.attemptsLeft > 0
            ? `That code is not correct. ${outcome.attemptsLeft} attempt${outcome.attemptsLeft === 1 ? '' : 's'} left.`
            : 'That code is not correct, and no attempts are left. Request a new one.',
        TOO_MANY_ATTEMPTS: 'Too many incorrect attempts. Request a new code.',
      };

      res.status(400).json({
        error: {
          code: outcome.reason,
          message: messages[outcome.reason],
          details: { attemptsLeft: outcome.attemptsLeft },
        },
      });
      return;
    }

    res.json({
      status: outcome.user.status,
      next: 'AWAITING_APPROVAL',
      message:
        'Your email is verified. An administrator now has to approve your account; ' +
        'you will be emailed when that happens.',
    });
  });

  router.post('/resend-code', codeLimiter, validate({ body: ResendBody }), async (req, res) => {
    const input = body<z.infer<typeof ResendBody>>(req);

    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, status: true },
    });

    // Always the same answer, whether or not that address has a pending
    // account. Otherwise this endpoint tells anyone who asks which addresses
    // are registered.
    const generic = {
      message: 'If that address has an account awaiting verification, a new code has been sent.',
      codeLength: CODE_LENGTH,
    };

    if (user === null || user.status !== 'PENDING_VERIFICATION') {
      res.status(202).json(generic);
      return;
    }

    const { expiresAt } = await issueVerificationCode(user, config, mailer);
    res.status(202).json({ ...generic, codeExpiresAt: expiresAt.toISOString() });
  });

  router.post('/login', limiter, validate({ body: LoginBody }), async (req, res) => {
    const input = body<z.infer<typeof LoginBody>>(req);
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    const storedHash =
      user?.passwordHash ??
      'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(input.password, storedHash);

    if (user === null || !ok) throw unauthorized('Email or password is incorrect');

    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(input.password);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
    }

    const pair = await issueTokenPair(
      tokens,
      { id: user.id, email: user.email },
      req.header('user-agent'),
    );

    // Signing in succeeds for an unapproved account, and the response says so.
    // Refusing the password would leave the client unable to tell a wrong
    // password from a pending account, and the user re-typing a password that
    // was never the problem.
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        role: user.role,
      },
      ...pair,
      next: nextStep(user),
    });
  });

  router.post('/refresh', validate({ body: RefreshBody }), async (req, res) => {
    const { refreshToken } = body<z.infer<typeof RefreshBody>>(req);
    const tokenHash = hashRefreshToken(refreshToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: { select: { id: true, email: true, name: true, status: true, role: true } },
      },
    });

    if (stored === null) throw unauthorized('Refresh token is not valid');
    if (stored.revokedAt !== null) {
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw unauthorized('Refresh token has been revoked; sign in again');
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw unauthorized('Refresh token has expired; sign in again');
    }

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
    res.status(204).end();
  });

  /**
   * Readable by any signed-in account, whatever its status.
   *
   * This is the endpoint the sign-up screens poll, so it must work precisely
   * when the rest of the API is closed to the caller.
   */
  router.get('/me', ...loadAccount(tokens), async (req, res) => {
    const { id } = currentUser(req);
    const account = currentAccount(req);

    res.json({
      user: {
        id,
        email: account.email,
        name: account.name,
        status: account.status,
        role: account.role,
        emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null,
        approvedAt: account.approvedAt?.toISOString() ?? null,
        decisionNote: account.decisionNote,
      },
      next: nextStep(account),
    });
  });

  /**
   * Change the password of the signed-in account.
   *
   * Deliberately behind `loadAccount` rather than `requireActiveUser`: an
   * account flagged for a password reset is refused by the latter, so routing
   * this through it would leave the only way out of the flag locked behind the
   * flag. The current password is still required, which is what keeps a stolen
   * access token from being enough to take the account over.
   */
  router.post(
    '/change-password',
    limiter,
    ...loadAccount(tokens),
    validate({ body: ChangePasswordBody }),
    async (req, res) => {
      const input = body<z.infer<typeof ChangePasswordBody>>(req);
      const { id } = currentUser(req);

      const user = await prisma.user.findUnique({ where: { id } });
      if (user === null) throw unauthorized('Account no longer exists');

      const ok = await verifyPassword(input.currentPassword, user.passwordHash);
      if (!ok) throw unauthorized('Current password is incorrect');

      if (input.currentPassword === input.newPassword) {
        throw badRequest('The new password must differ from the current one');
      }

      try {
        assertPasswordUsable(input.newPassword);
      } catch (error) {
        if (error instanceof WeakPasswordError) throw badRequest(error.message);
        throw error;
      }

      const passwordHash = await hashPassword(input.newPassword);

      await prisma.$transaction([
        prisma.user.update({
          where: { id },
          data: { passwordHash, mustResetPassword: false },
        }),
        // Every other session dies with the old password. If the temporary one
        // leaked — and a password that travelled through a message should be
        // assumed to have — this is what closes the door on whoever has it.
        prisma.refreshToken.deleteMany({ where: { userId: id, revokedAt: null } }),
      ]);

      const pair = await issueTokenPair(
        tokens,
        { id: user.id, email: user.email },
        req.header('user-agent'),
      );

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          status: user.status,
          role: user.role,
        },
        ...pair,
        next: nextStep({ status: user.status, mustResetPassword: false }),
      });
    },
  );

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
