import { paisa, type Paisa } from '@psx/shared';

/**
 * The single boundary between the database's `bigint` and the engine's `Paisa`.
 *
 * Money is BIGINT in Postgres, which Prisma hands back as a JavaScript
 * `bigint`. The ledger and the rest of the engine work in `Paisa`, a branded
 * `number`, because arithmetic on `bigint` cannot be mixed with the plain
 * numbers that share counts and ratios use, and because `JSON.stringify`
 * throws on a `bigint` rather than serialising it.
 *
 * Keeping the conversion in one place means there is one thing to audit. Doing
 * it ad hoc at each call site is how a `Number(...)` ends up missing somewhere
 * and a bigint reaches a JSON response, where it fails at runtime rather than
 * at compile time.
 *
 * The range is safe: Number.MAX_SAFE_INTEGER is about 9.0e15 paisa, i.e. some
 * 90 trillion rupees, several thousand times the entire market capitalisation
 * of the PSX. `toPaisa` still checks, because a silent precision loss in a cost
 * basis is worse than a loud failure.
 */

export class PaisaConversionError extends Error {}

/** Database bigint to engine Paisa. */
export function toPaisa(value: bigint): Paisa {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new PaisaConversionError(
      `Monetary value ${value} is outside the safe integer range; it cannot be converted ` +
        `without losing precision. This should be impossible for a real portfolio and ` +
        `probably means a corrupt row.`,
    );
  }
  return paisa(Number(value));
}

/** Engine Paisa to database bigint. */
export function fromPaisa(value: Paisa): bigint {
  return BigInt(value);
}

/** Nullable column variant, for optional amounts such as a trailing stop. */
export function toPaisaOrNull(value: bigint | null): Paisa | null {
  return value === null ? null : toPaisa(value);
}

export function fromPaisaOrNull(value: Paisa | null | undefined): bigint | null {
  return value === null || value === undefined ? null : fromPaisa(value);
}

/**
 * Prisma returns a `Date` for a `@db.Date` column, at UTC midnight. Trading
 * dates are calendar facts, so they travel through the system as ISO strings
 * and only become `Date` at the database boundary.
 */
export function toIsoDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function fromIsoDateColumn(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new PaisaConversionError(`Expected an ISO calendar date, got "${value}"`);
  return new Date(`${value}T00:00:00.000Z`);
}
