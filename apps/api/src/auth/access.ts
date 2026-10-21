import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, unauthorized } from '../http/errors.js';
import { prisma } from '../db/prisma.js';
import type { Tokens } from './tokens.js';
import { requireUser } from './middleware.js';

/**
 * The access gates.
 *
 * `requireUser` proves who someone is from their token alone, with no database
 * query. That is deliberately cheap and is why it was enough until now. These
 * two gates ask a further question — *may* this person use the app — and that
 * cannot come from the token, because a token issued before approval must stop
 * being enough the moment an admin rejects or suspends the account.
 *
 * So `requireActiveUser` reads the user's status on every request. One indexed
 * primary-key lookup per request is a real cost, and the alternative is worse:
 * putting the status in the token means a rejected user keeps full access until
 * it expires, and the whole point of an approval gate is that it can be shut.
 *
 * A blocked account gets a 403 with a specific code rather than a 401, so the
 * web and mobile clients can tell "sign in again" from "you are verified and
 * waiting" and show the right screen instead of bouncing to the login form.
 */

export type BlockedCode =
  | 'EMAIL_NOT_VERIFIED'
  | 'AWAITING_APPROVAL'
  | 'ACCOUNT_REJECTED'
  | 'ACCOUNT_SUSPENDED';

export interface AccountState {
  status: string;
  role: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
  approvedAt: Date | null;
  decisionNote: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    account?: AccountState;
  }
}

const BLOCKED: Record<string, { code: BlockedCode; message: string }> = {
  PENDING_VERIFICATION: {
    code: 'EMAIL_NOT_VERIFIED',
    message: 'Verify your email address before using the app.',
  },
  PENDING_APPROVAL: {
    code: 'AWAITING_APPROVAL',
    message:
      'Your email is verified and your account is waiting for an administrator to approve it. ' +
      'You will be emailed when that happens.',
  },
  REJECTED: {
    code: 'ACCOUNT_REJECTED',
    message: 'This account was not approved.',
  },
  SUSPENDED: {
    code: 'ACCOUNT_SUSPENDED',
    message: 'This account has been suspended.',
  },
};

/** Loads the account and attaches it, without judging the status. */
export function loadAccount(tokens: Tokens): RequestHandler[] {
  return [
    requireUser(tokens),
    async (req: Request, _res: Response, next: NextFunction) => {
      try {
        const id = req.user?.id;
        if (id === undefined) throw unauthorized();

        const account = await prisma.user.findUnique({
          where: { id },
          select: {
            status: true,
            role: true,
            email: true,
            name: true,
            emailVerifiedAt: true,
            approvedAt: true,
            decisionNote: true,
          },
        });

        // A token for an account that no longer exists. 401, because signing in
        // again is the only sensible next step.
        if (account === null) throw unauthorized('Account no longer exists');

        req.account = account;
        next();
      } catch (error) {
        next(error);
      }
    },
  ];
}

/** Requires a verified, approved, unsuspended account. */
export function requireActiveUser(tokens: Tokens): RequestHandler[] {
  return [
    ...loadAccount(tokens),
    (req: Request, _res: Response, next: NextFunction) => {
      const account = req.account;
      if (account === undefined) {
        next(unauthorized());
        return;
      }

      if (account.status === 'ACTIVE') {
        next();
        return;
      }

      const blocked = BLOCKED[account.status];
      next(
        new AppError(403, blocked?.code ?? 'ACCOUNT_BLOCKED', blocked?.message ?? 'No access.', {
          status: account.status,
          ...(account.decisionNote !== null ? { note: account.decisionNote } : {}),
        }),
      );
    },
  ];
}

/** Requires an active account that is also an admin. */
export function requireAdmin(tokens: Tokens): RequestHandler[] {
  return [
    ...requireActiveUser(tokens),
    (req: Request, _res: Response, next: NextFunction) => {
      if (req.account?.role !== 'ADMIN') {
        // 404 rather than 403: an endpoint a member may not use should not
        // confirm that it exists.
        next(new AppError(404, 'NOT_FOUND', 'Resource not found'));
        return;
      }
      next();
    },
  ];
}

export function currentAccount(req: Request): AccountState {
  if (req.account === undefined) {
    throw new Error('currentAccount() called on a route without loadAccount middleware');
  }
  return req.account;
}
