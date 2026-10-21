import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` resolves to scrypt's 3-argument overload, which drops the options
 * object that carries N, r, p and maxmem. The signature is restated so the
 * cost parameters are actually passed.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from node:crypto.
 *
 * scrypt rather than bcrypt or argon2 because it is in the standard library:
 * no native module to compile, which matters on Windows and in slim containers,
 * and one less dependency in the part of the system where a supply-chain
 * problem would be worst. scrypt is memory-hard and a sanctioned password
 * hashing function; the parameters below follow current guidance.
 *
 * The cost parameters are stored in the hash string, so they can be raised
 * later and old hashes still verify. `needsRehash` reports when a stored hash
 * was made with weaker parameters, so a password can be upgraded on next login.
 */

export interface ScryptParams {
  /** CPU/memory cost. Memory used is roughly 128 * N * r bytes. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelisation. */
  p: number;
  keyLength: number;
}

/**
 * N = 2^16 with r = 8 costs about 64 MB and ~100 ms per hash.
 *
 * Deliberately one step below the 2^17 often quoted: that doubles to 128 MB per
 * hash, and since the memory is held for the duration of the derivation, a
 * handful of simultaneous logins would be enough to exhaust a small VM. The
 * cost here still makes offline cracking expensive, and the rate limiter on the
 * credential endpoints bounds how often it can be demanded. The parameters are
 * stored in each hash, so this can be raised later and existing hashes keep
 * verifying, with `needsRehash` upgrading them on next login.
 */
export const DEFAULT_PARAMS: ScryptParams = { N: 65_536, r: 8, p: 1, keyLength: 64 };

const PREFIX = 'scrypt';
const SALT_BYTES = 16;

/** scrypt needs maxmem raised above Node's default for these parameters. */
function maxmem(params: ScryptParams): number {
  return 256 * params.N * params.r;
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  assertPasswordUsable(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password.normalize('NFKC'), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmem(params),
  })) as Buffer;

  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null) return false;

  let derived: Buffer;
  try {
    derived = (await scrypt(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmem({ ...parsed, keyLength: parsed.hash.length }),
    })) as Buffer;
  } catch {
    return false;
  }

  // Constant time: a length check first, because timingSafeEqual throws on a
  // mismatch, and then a comparison that does not leak how much matched.
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

export function needsRehash(stored: string, params: ScryptParams = DEFAULT_PARAMS): boolean {
  const parsed = parseHash(stored);
  if (parsed === null) return true;
  return parsed.N < params.N || parsed.r < params.r || parsed.p < params.p;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // Refuse absurd parameters from a tampered row rather than attempting a
  // derivation that would hang the process.
  if (N < 1024 || N > 1_048_576 || r < 1 || r > 64 || p < 1 || p > 16) return null;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(parts[4] ?? '', 'base64url'),
      hash: Buffer.from(parts[5] ?? '', 'base64url'),
    };
  } catch {
    return null;
  }
}

export class WeakPasswordError extends Error {}

/**
 * Length is the only rule enforced.
 *
 * Composition rules (an uppercase, a digit, a symbol) push people towards
 * "Password1!" and are no longer recommended; length is what actually costs an
 * attacker. The upper bound exists because scrypt hashes the whole input and an
 * unbounded password is a cheap way to make the server do expensive work.
 */
export function assertPasswordUsable(password: string): void {
  if (password.length < 10) {
    throw new WeakPasswordError('Password must be at least 10 characters');
  }
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw new WeakPasswordError('Password must be at most 1024 bytes');
  }
}
