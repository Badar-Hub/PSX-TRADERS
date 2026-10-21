import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { InsufficientSharesError, LedgerError } from '@psx/ledger';
import { MoneyError } from '@psx/shared';
import { AppError, badRequest, conflict, describeError, notFound } from '../src/http/errors.js';
import { PaisaConversionError } from '../src/db/paisa.js';
import {
  isoDate,
  nonNegativeRupeeString,
  positiveRupeeString,
  rupeeString,
  symbolString,
  wholeShares,
} from '../src/http/validate.js';
import { loadEnv } from '../src/env.js';
import { currentTaxYear } from '../src/routes/reports.js';

describe('error mapping', () => {
  it('passes an AppError through with its status and code', () => {
    const described = describeError(badRequest('Price must be positive'));
    expect(described).toMatchObject({ status: 400, code: 'BAD_REQUEST', internal: false });
  });

  it('turns a validation failure into a 400 listing each bad field', () => {
    const error = new ZodError([
      { code: 'custom', path: ['unitPrice'], message: 'Expected a rupee amount' },
    ]);
    const described = describeError(error);
    expect(described.status).toBe(400);
    expect(described.code).toBe('VALIDATION_FAILED');
    expect(described.details).toEqual([{ path: 'unitPrice', message: 'Expected a rupee amount' }]);
  });

  /**
   * Overselling is the user's mistake, not a crash, and the ledger's message
   * already names the symbol and the shortfall.
   */
  it('reports insufficient shares as a 409 with the numbers', () => {
    const described = describeError(new InsufficientSharesError(80, 50, 'ABL'));
    expect(described.status).toBe(409);
    expect(described.code).toBe('INSUFFICIENT_SHARES');
    expect(described.message).toContain('ABL');
    expect(described.details).toEqual({ requested: 80, available: 50 });
    expect(described.internal).toBe(false);
  });

  it('reports other ledger and money rejections as 400', () => {
    expect(describeError(new LedgerError('bad lot')).status).toBe(400);
    expect(describeError(new MoneyError('bad amount')).status).toBe(400);
  });

  /**
   * The rule that matters most here: an unexpected failure must not leak its
   * message to the client, because in this app an error string could carry
   * another user's data or the shape of the database.
   */
  it('hides the detail of an unexpected error', () => {
    const described = describeError(new Error('connect ECONNREFUSED 10.0.0.5:5432 as user psx'));
    expect(described.status).toBe(500);
    expect(described.code).toBe('INTERNAL');
    expect(described.message).toBe('Something went wrong');
    expect(described.message).not.toContain('10.0.0.5');
    expect(described.internal).toBe(true);
  });

  it('hides a data-integrity failure too, while marking it for the log', () => {
    const described = describeError(new PaisaConversionError('value 99999999999999999999 too big'));
    expect(described.status).toBe(500);
    expect(described.message).not.toContain('99999999999999999999');
    expect(described.internal).toBe(true);
  });

  it('handles a thrown non-error', () => {
    expect(describeError('oops').status).toBe(500);
    expect(describeError(null).status).toBe(500);
  });

  /**
   * Telling a caller that a portfolio exists but is not theirs confirms the
   * existence of another user's data, so ownership failures are 404.
   */
  it('uses not-found for an unowned resource', () => {
    const described = describeError(notFound('Portfolio'));
    expect(described.status).toBe(404);
    expect(described.message).toBe('Portfolio not found');
  });

  it('keeps conflict details for the client', () => {
    const described = describeError(conflict('Already reversed', { tradeId: 't1' }));
    expect(described.status).toBe(409);
    expect(described.details).toEqual({ tradeId: 't1' });
  });

  it('respects a custom status on AppError', () => {
    expect(describeError(new AppError(418, 'TEAPOT', 'no coffee')).status).toBe(418);
  });
});

describe('request validation', () => {
  describe('rupee amounts arrive as strings', () => {
    it('accepts a well-formed amount', () => {
      for (const value of ['0', '170.19', '1.5', '28655.00', '-50.25']) {
        expect(rupeeString.parse(value)).toBe(value);
      }
    });

    /**
     * Strings, not JSON numbers: 170.19 as a JSON number is already
     * 170.18999999999999 by the time it is parsed, and rounding it back is
     * guesswork. The string converts to integer paisa exactly.
     */
    it('refuses sub-paisa precision instead of rounding it away', () => {
      expect(() => rupeeString.parse('10.001')).toThrow();
    });

    it('refuses anything that is not a decimal amount', () => {
      for (const value of ['', 'abc', '1e5', '1,234.56', ' ', '.5', '5.']) {
        expect(() => rupeeString.parse(value)).toThrow();
      }
    });

    it('enforces positivity where a price is required', () => {
      expect(positiveRupeeString.parse('0.01')).toBe('0.01');
      expect(() => positiveRupeeString.parse('0')).toThrow();
      expect(() => positiveRupeeString.parse('-1.00')).toThrow();
    });

    it('allows zero but not negative where a charge is required', () => {
      expect(nonNegativeRupeeString.parse('0')).toBe('0');
      expect(() => nonNegativeRupeeString.parse('-0.01')).toThrow();
    });
  });

  describe('symbols', () => {
    it('uppercases and accepts PSX tickers', () => {
      expect(symbolString.parse('hbl')).toBe('HBL');
      expect(symbolString.parse(' ogdc ')).toBe('OGDC');
      expect(symbolString.parse('786')).toBe('786');
      expect(symbolString.parse('AGP-CDEC')).toBe('AGP-CDEC');
    });

    it('refuses junk that could reach a query', () => {
      for (const value of ['', 'A'.repeat(21), "HBL'; DROP TABLE", 'HBL HBL']) {
        expect(() => symbolString.parse(value)).toThrow();
      }
    });
  });

  describe('share quantities', () => {
    it('requires whole positive shares, since the PSX has no fractions', () => {
      expect(wholeShares.parse(100)).toBe(100);
      expect(() => wholeShares.parse(1.5)).toThrow();
      expect(() => wholeShares.parse(0)).toThrow();
      expect(() => wholeShares.parse(-10)).toThrow();
    });
  });

  describe('dates', () => {
    it('accepts a calendar date', () => {
      expect(isoDate.parse('2026-10-20')).toBe('2026-10-20');
    });

    it('refuses a timestamp or a non-date', () => {
      for (const value of ['2026-10-20T10:00:00Z', '20-10-2026', '2026-13-45', 'today']) {
        expect(() => isoDate.parse(value)).toThrow();
      }
    });
  });
});

describe('environment validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://psx:psx@localhost:5433/psx_trader',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
  };

  it('loads a valid configuration and applies defaults', () => {
    const env = loadEnv(base as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.ACCESS_TOKEN_TTL).toBe('15m');
    expect(env.corsOrigins).toEqual(['http://localhost:3000']);
  });

  it('splits the CORS origin list', () => {
    const env = loadEnv({
      ...base,
      CORS_ORIGINS: 'http://localhost:3000, https://app.example.com ',
    } as NodeJS.ProcessEnv);
    expect(env.corsOrigins).toEqual(['http://localhost:3000', 'https://app.example.com']);
  });

  it('fails at startup when a secret is missing, not on the first login', () => {
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL } as NodeJS.ProcessEnv)).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('refuses a short secret', () => {
    expect(() =>
      loadEnv({ ...base, JWT_ACCESS_SECRET: 'tooshort' } as NodeJS.ProcessEnv),
    ).toThrow(/at least 32/);
  });

  /** A deployment running on "change-me" signs tokens anyone can forge. */
  it('refuses the placeholder secrets from .env.example', () => {
    expect(() =>
      loadEnv({
        ...base,
        JWT_ACCESS_SECRET: 'change-me-access',
      } as NodeJS.ProcessEnv),
    ).toThrow(/placeholder/);
  });

  /**
   * The length rule alone would accept this, which is why the placeholder scan
   * matches a substring rather than comparing for equality.
   */
  it('refuses a long secret that is still obviously a placeholder', () => {
    expect(() =>
      loadEnv({
        ...base,
        JWT_REFRESH_SECRET: 'change-me-change-me-change-me-change-me-change-me',
      } as NodeJS.ProcessEnv),
    ).toThrow(/placeholder/);
  });

  it('refuses identical access and refresh secrets', () => {
    expect(() =>
      loadEnv({
        ...base,
        JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET,
      } as NodeJS.ProcessEnv),
    ).toThrow(/must differ/);
  });

  it('refuses a malformed database url', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'not-a-url' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('currentTaxYear', () => {
  /** Pakistan's tax year runs 1 July to 30 June. */
  it('starts the year on 1 July', () => {
    expect(currentTaxYear(new Date('2026-07-01T00:00:00Z'))).toEqual({
      from: '2026-07-01',
      to: '2027-06-30',
    });
  });

  it('puts a date before July in the year that began the previous July', () => {
    expect(currentTaxYear(new Date('2026-06-30T00:00:00Z'))).toEqual({
      from: '2025-07-01',
      to: '2026-06-30',
    });
  });

  it('handles today', () => {
    expect(currentTaxYear(new Date('2026-10-21T00:00:00Z'))).toEqual({
      from: '2026-07-01',
      to: '2027-06-30',
    });
  });
});
