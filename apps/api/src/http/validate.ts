import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';

/**
 * Request validation at the edge.
 *
 * Every handler downstream can then treat its input as already correct, which
 * is what keeps a parsing concern from spreading through the service layer.
 * Validated values replace the raw ones on the request, so a coerced number
 * stays a number rather than the string Express handed over.
 */

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

declare module 'express-serve-static-core' {
  interface Request {
    valid?: {
      body?: unknown;
      query?: unknown;
      params?: unknown;
    };
  }
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const valid: { body?: unknown; query?: unknown; params?: unknown } = {};
      if (schemas.body) valid.body = schemas.body.parse(req.body);
      if (schemas.query) valid.query = schemas.query.parse(req.query);
      if (schemas.params) valid.params = schemas.params.parse(req.params);
      req.valid = valid;
      next();
    } catch (error) {
      // ZodError is translated by the error handler into a 400 listing each
      // failing field, so it is passed through untouched.
      next(error);
    }
  };
}

/** Typed accessors, so a handler does not repeat the cast. */
export function body<T>(req: Request): T {
  return req.valid?.body as T;
}
export function query<T>(req: Request): T {
  return req.valid?.query as T;
}
export function params<T>(req: Request): T {
  return req.valid?.params as T;
}

/**
 * A rupee amount as the client sends it: a string.
 *
 * Strings, not numbers, so no float ever exists on the wire. `"170.19"` parses
 * exactly; a JSON number 170.19 is already an approximation by the time it
 * reaches the server, and rounding it back is guesswork.
 */
export const rupeeString = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Expected a rupee amount such as "170.19", at most 2 decimals');

/** A positive rupee amount: a price or a charge. */
export const positiveRupeeString = rupeeString.refine(
  (value) => Number(value) > 0,
  'Must be greater than zero',
);

export const nonNegativeRupeeString = rupeeString.refine(
  (value) => Number(value) >= 0,
  'Must not be negative',
);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a real calendar date');

/** PSX tickers are short and alphanumeric, with a dash for derived listings. */
export const symbolString = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,20}$/, 'Expected a PSX ticker such as "HBL"');

export const wholeShares = z
  .number()
  .int('Share quantities must be whole numbers; the PSX has no fractional shares')
  .positive();

export const cuid = z.string().min(1).max(64);
