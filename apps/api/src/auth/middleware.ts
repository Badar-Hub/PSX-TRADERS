import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { unauthorized } from '../http/errors.js';
import type { Tokens } from './tokens.js';

/**
 * Attaches the authenticated user to the request, or rejects.
 *
 * Only the access token is consulted, so this costs no database query. The
 * trade-off is that a user disabled mid-session keeps access until their token
 * expires, which is what the short access TTL bounds.
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export function requireUser(tokens: Tokens): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(req);
      if (token === null) throw unauthorized('Authorization header with a bearer token is required');
      const claims = await tokens.verifyAccessToken(token);
      req.user = { id: claims.sub, email: claims.email };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** Reads the authenticated user, throwing if the route forgot `requireUser`. */
export function currentUser(req: Request): AuthenticatedUser {
  if (req.user === undefined) {
    // A programming error, not a client one: the route is misconfigured.
    throw new Error('currentUser() called on a route without requireUser middleware');
  }
  return req.user;
}
