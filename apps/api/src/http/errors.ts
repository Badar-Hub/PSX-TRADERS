import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { InsufficientSharesError, LedgerError } from '@psx/ledger';
import { MoneyError } from '@psx/shared';
import { PaisaConversionError } from '../db/paisa.js';

/**
 * One place that decides what the client sees when something goes wrong.
 *
 * The principle: a client error says exactly what was wrong so it can be fixed,
 * while a server error says nothing beyond a request id. Leaking a stack trace
 * or a database message to a browser hands an attacker a map of the system, and
 * in this app it could also leak another user's data through an error string.
 */

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

/**
 * Deliberately indistinguishable from "not found" at the route level: telling a
 * caller that a portfolio exists but is not theirs confirms the existence of
 * another user's data.
 */
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'RATE_LIMITED', message);

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Maps a thrown value to a status, code and client-safe message. */
export function describeError(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  internal: boolean;
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      internal: false,
    };
  }

  // express.json() rejects a malformed or oversized body by throwing an
  // http-errors instance before any route runs. Left unhandled these became
  // 500s, which is both wrong for the client and noise in the error log, since
  // a truncated request body is the caller's problem, not a server fault.
  const bodyParser = describeBodyParserError(error);
  if (bodyParser !== null) return bodyParser;

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'The request body or query is not valid',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      internal: false,
    };
  }

  // Selling more than is held is the user's mistake, not a crash, and the
  // ledger's message already names the symbol and the shortfall.
  if (error instanceof InsufficientSharesError) {
    return {
      status: 409,
      code: 'INSUFFICIENT_SHARES',
      message: error.message,
      details: { requested: error.requested, available: error.available },
      internal: false,
    };
  }

  if (error instanceof LedgerError || error instanceof MoneyError) {
    return { status: 400, code: 'LEDGER_REJECTED', message: error.message, internal: false };
  }

  if (error instanceof PaisaConversionError) {
    return {
      status: 500,
      code: 'DATA_INTEGRITY',
      message: 'A stored amount could not be read',
      internal: true,
    };
  }

  return {
    status: 500,
    code: 'INTERNAL',
    message: 'Something went wrong',
    internal: true,
  };
}

/**
 * Recognises the errors `express.json()` throws.
 *
 * They are http-errors instances carrying a status and a `type` such as
 * `entity.parse.failed` or `entity.too.large`. The status they already set is
 * trusted, but the message is replaced: body-parser's text can quote part of
 * the offending payload back to the caller.
 */
function describeBodyParserError(error: unknown): ReturnType<typeof describeError> | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof candidate.type !== 'string' || !candidate.type.startsWith('entity.')) return null;

  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : 400;

  if (candidate.type === 'entity.too.large') {
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large',
      internal: false,
    };
  }

  return {
    status: status >= 400 && status < 500 ? status : 400,
    code: 'MALFORMED_BODY',
    message: 'Request body could not be parsed as JSON',
    internal: false,
  };
}

export interface ErrorHandlerOptions {
  /** Logs the full error server-side. Separate so tests can stay quiet. */
  log?: (error: unknown, context: { requestId?: string; method: string; path: string }) => void;
}

export function errorHandler(options: ErrorHandlerOptions = {}) {
  const log =
    options.log ??
    ((error, context) => {
      console.error(`[${context.requestId ?? '-'}] ${context.method} ${context.path}`, error);
    });

  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const described = describeError(error);
    const requestId = res.getHeader('x-request-id');
    const id = typeof requestId === 'string' ? requestId : undefined;

    // Only unexpected failures are logged in full; a 400 is routine traffic.
    if (described.internal) {
      log(error, { requestId: id, method: req.method, path: req.path });
    }

    const body: ErrorBody = {
      error: {
        code: described.code,
        message: described.message,
        ...(described.details !== undefined ? { details: described.details } : {}),
        ...(id !== undefined ? { requestId: id } : {}),
      },
    };

    res.status(described.status).json(body);
  };
}

export function notFoundHandler(_req: Request, res: Response): void {
  const body: ErrorBody = {
    error: { code: 'NOT_FOUND', message: 'No such endpoint' },
  };
  res.status(404).json(body);
}
