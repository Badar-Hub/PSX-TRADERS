/**
 * All money in this system is an integer count of paisa (1 PKR = 100 paisa).
 *
 * Floating point is never used for money. `0.1 + 0.2 !== 0.3` is a curiosity in
 * most software and a corrupted cost basis here: a portfolio re-derives realised
 * P&L from thousands of stored amounts, so a half-paisa drift per row compounds
 * into a number the user cannot reconcile against their broker statement.
 *
 * Range: Number.MAX_SAFE_INTEGER is ~9.0e15 paisa, i.e. ~90 trillion PKR, which
 * is several thousand times the entire market capitalisation of the PSX. A plain
 * `number` is therefore safe, and avoids BigInt's JSON-serialisation friction.
 *
 * Indicators and factor scores deliberately do NOT use this type: they are
 * statistical, consume floats, and a 1e-12 error in an RSI value is meaningless.
 * The boundary is "anything the user could add up" versus "anything we infer".
 */

declare const PaisaBrand: unique symbol;

/** An integer number of paisa. Construct via the helpers in this module. */
export type Paisa = number & { readonly [PaisaBrand]: true };

export const ZERO = 0 as Paisa;

export class MoneyError extends Error {}

/** Wraps an already-integral paisa value, e.g. one straight out of the database. */
export function paisa(value: number): Paisa {
  if (!Number.isFinite(value)) throw new MoneyError(`Not a finite paisa value: ${value}`);
  if (!Number.isInteger(value)) throw new MoneyError(`Paisa must be an integer, got ${value}`);
  if (!Number.isSafeInteger(value)) throw new MoneyError(`Paisa value out of safe range: ${value}`);
  return value as Paisa;
}

/**
 * Parses a rupee amount into paisa. Accepts a string (preferred, since then no
 * float ever exists) or a number, and rejects more than 2 decimal places rather
 * than silently rounding away part of what the user typed.
 */
export function rupeesToPaisa(rupees: string | number): Paisa {
  const text = typeof rupees === 'number' ? formatPlain(rupees) : rupees.trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new MoneyError(`Invalid rupee amount: "${rupees}" (max 2 decimal places)`);
  const sign = match[1];
  const whole = match[2] ?? '0';
  const frac = match[3] ?? '';
  const paisaPart = (frac + '00').slice(0, 2);
  const magnitude = Number(whole) * 100 + Number(paisaPart);
  return paisa(sign === '-' ? -magnitude : magnitude);
}

/** Exact decimal string, e.g. 123456 becomes "1234.56". Safe to display and to re-parse. */
export function paisaToRupeeString(value: Paisa): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Lossy. For charts and indicator input only, never for storage or arithmetic. */
export function paisaToRupeeFloat(value: Paisa): number {
  return value / 100;
}

export function addPaisa(...values: Paisa[]): Paisa {
  return paisa(values.reduce<number>((sum, v) => sum + v, 0));
}

export function subPaisa(a: Paisa, b: Paisa): Paisa {
  return paisa(a - b);
}

export function negatePaisa(value: Paisa): Paisa {
  return paisa(-value);
}

export type Rounding = 'half-up' | 'half-even' | 'floor' | 'ceil';

/**
 * Rounds a non-integral intermediate result to whole paisa. 'half-up' is the
 * default because it matches how PSX brokers round contract-note charges, which
 * is what the user will be reconciling against.
 */
export function roundToPaisa(value: number, mode: Rounding = 'half-up'): Paisa {
  if (!Number.isFinite(value)) throw new MoneyError(`Cannot round ${value}`);
  switch (mode) {
    case 'floor':
      return paisa(Math.floor(value));
    case 'ceil':
      return paisa(Math.ceil(value));
    case 'half-even': {
      const floor = Math.floor(value);
      const diff = value - floor;
      if (diff > 0.5) return paisa(floor + 1);
      if (diff < 0.5) return paisa(floor);
      return paisa(floor % 2 === 0 ? floor : floor + 1);
    }
    case 'half-up':
    default:
      // Math.round(-0.5) is 0, not -1. Mirroring the magnitude keeps charges on
      // a sell rounded the same way as charges on a buy.
      return paisa(value < 0 ? -Math.round(-value) : Math.round(value));
  }
}

/** Price-per-share times whole shares. Exact, because both operands are integers. */
export function multiplyByQuantity(unitPrice: Paisa, quantity: number): Paisa {
  if (!Number.isInteger(quantity)) {
    throw new MoneyError(`Share quantity must be a whole number, got ${quantity}`);
  }
  return paisa(unitPrice * quantity);
}

/** Scales by an arbitrary ratio: split factors, percentage charges, FX. */
export function scalePaisa(value: Paisa, factor: number, mode: Rounding = 'half-up'): Paisa {
  if (!Number.isFinite(factor)) throw new MoneyError(`Cannot scale by ${factor}`);
  return roundToPaisa(value * factor, mode);
}

/**
 * Applies a rate expressed in basis points (1 bp = 0.01%). Brokerage, CDC and
 * SECP charges are all quoted in bps or percent, so holding the rates as
 * integers keeps a float out of a figure the user reconciles.
 */
export function applyBasisPoints(value: Paisa, bps: number, mode: Rounding = 'half-up'): Paisa {
  return roundToPaisa((value * bps) / 10_000, mode);
}

/**
 * Splits an amount across buckets so the parts sum back to exactly the whole.
 *
 * Needed whenever a charge levied on a whole order has to be attributed across
 * the individual tax lots that order consumed. Rounding each lot's share
 * independently leaves stray paisa, and then a position's cost basis no longer
 * reconciles against the sum of its lots.
 */
export function allocatePaisa(total: Paisa, weights: number[]): Paisa[] {
  return allocateInteger(total, weights).map((part) => paisa(part));
}

/**
 * Splits a whole number across buckets so the parts sum to exactly the total.
 *
 * Used for money via `allocatePaisa`, and for share counts when a corporate
 * action has to be spread over tax lots. Entitlements are computed by the
 * registrar on the entire holding, so flooring a ratio lot by lot loses shares:
 * a 10% bonus on two lots of 75 gives 7 each, where the holding of 150 is
 * entitled to 15. Allocating the total fixes that.
 */
export function allocateInteger(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total)) throw new MoneyError(`Allocation total must be an integer, got ${total}`);
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) throw new MoneyError('Allocation weights must be non-negative');
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  if (weightTotal <= 0) throw new MoneyError('Allocation weights must sum to a positive value');

  const parts = weights.map((w) => Math.floor((total * w) / weightTotal));
  let remainder = total - parts.reduce((sum, p) => sum + p, 0);

  // Hand the leftover units to the largest weights first, so the distribution is
  // deterministic rather than dependent on iteration order.
  const order = weights
    .map((w, index) => ({ w, index }))
    .sort((a, b) => b.w - a.w || a.index - b.index);

  for (let i = 0; remainder > 0 && i < order.length; i += 1, remainder -= 1) {
    const slot = order[i];
    if (slot === undefined) break;
    parts[slot.index] = (parts[slot.index] ?? 0) + 1;
  }
  return parts;
}

const pkrFormat = new Intl.NumberFormat('en-PK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Display only, e.g. "Rs 1,234.56". */
export function formatPKR(value: Paisa, options: { withSymbol?: boolean } = {}): string {
  const { withSymbol = true } = options;
  const body = pkrFormat.format(paisaToRupeeFloat(value));
  return withSymbol ? `Rs ${body}` : body;
}

function formatPlain(value: number): string {
  // Keeps exponent notation such as "1e-7" away from the regex above.
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}
