import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  WeakPasswordError,
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParams,
} from '../src/auth/password.js';
import { Tokens, hashRefreshToken, parseDuration } from '../src/auth/tokens.js';

/** Low cost, so the suite is not dominated by key derivation. */
const FAST: ScryptParams = { N: 1024, r: 8, p: 1, keyLength: 32 };

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse batteries', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a different hash each time, so equal passwords are not detectable', async () => {
    const a = await hashPassword('same password here', FAST);
    const b = await hashPassword('same password here', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password here', a)).toBe(true);
    expect(await verifyPassword('same password here', b)).toBe(true);
  });

  it('stores its cost parameters so they can be raised later', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(hash.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
  });

  it('flags a hash made with weaker parameters for upgrade', async () => {
    const weak = await hashPassword('correct horse battery', FAST);
    expect(needsRehash(weak, DEFAULT_PARAMS)).toBe(true);
    // And a hash at the current parameters is left alone.
    expect(needsRehash(weak, FAST)).toBe(false);
  });

  it('still verifies an old hash after the defaults are raised', async () => {
    const old = await hashPassword('correct horse battery', FAST);
    // Verification reads the parameters out of the hash rather than assuming
    // the current defaults, which is what makes an upgrade non-breaking.
    expect(await verifyPassword('correct horse battery', old)).toBe(true);
  });

  it('normalises unicode, so the same password typed differently still works', async () => {
    // U+00E9 versus e + U+0301: visually identical, different bytes.
    const composed = 'café password';
    const decomposed = 'café password';
    const hash = await hashPassword(composed, FAST);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('enforces a minimum length but no composition rules', async () => {
    await expect(hashPassword('short', FAST)).rejects.toThrow(WeakPasswordError);
    // Length is what costs an attacker; composition rules push people towards
    // "Password1!".
    await expect(hashPassword('aaaaaaaaaaaaaaaaaaaa', FAST)).resolves.toBeTypeOf('string');
  });

  it('refuses an unbounded password, which would be cheap server-side work', async () => {
    await expect(hashPassword('a'.repeat(2000), FAST)).rejects.toThrow(WeakPasswordError);
  });

  describe('malformed stored hashes', () => {
    it('returns false rather than throwing', async () => {
      for (const bad of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$1024$8$1$aa$bb']) {
        expect(await verifyPassword('anything at all', bad)).toBe(false);
      }
    });

    /**
     * A tampered row could otherwise ask for a derivation large enough to hang
     * the process, which turns a database write into a denial of service.
     */
    it('refuses absurd cost parameters from a tampered row', async () => {
      const absurd = 'scrypt$99999999$8$1$YWJjZA$YWJjZA';
      expect(await verifyPassword('anything at all', absurd)).toBe(false);
    });
  });
});

describe('tokens', () => {
  const tokens = new Tokens({
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    accessTtl: '15m',
    refreshTtl: '30d',
  });

  it('issues an access token that verifies back to the user', async () => {
    const token = await tokens.signAccessToken({ id: 'user-1', email: 'a@example.com' });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.email).toBe('a@example.com');
  });

  it('rejects a token signed with a different secret', async () => {
    const other = new Tokens({
      accessSecret: 'c'.repeat(48),
      refreshSecret: 'd'.repeat(48),
      accessTtl: '15m',
      refreshTtl: '30d',
    });
    const token = await other.signAccessToken({ id: 'user-1', email: 'a@example.com' });
    await expect(tokens.verifyAccessToken(token)).rejects.toThrow();
  });

  /**
   * The reason access and refresh use different secrets: otherwise a long-lived
   * refresh token would verify as an access token.
   */
  it('will not accept a token signed with the refresh secret', async () => {
    const swapped = new Tokens({
      accessSecret: 'b'.repeat(48),
      refreshSecret: 'a'.repeat(48),
      accessTtl: '15m',
      refreshTtl: '30d',
    });
    const refreshSigned = await swapped.signAccessToken({ id: 'u', email: 'a@example.com' });
    await expect(tokens.verifyAccessToken(refreshSigned)).rejects.toThrow();
  });

  it('rejects junk and an empty token', async () => {
    await expect(tokens.verifyAccessToken('not.a.jwt')).rejects.toThrow();
    await expect(tokens.verifyAccessToken('')).rejects.toThrow();
  });

  it('reports an expired token distinctly from an invalid one', async () => {
    const shortLived = new Tokens({
      accessSecret: 'a'.repeat(48),
      refreshSecret: 'b'.repeat(48),
      accessTtl: '0s',
      refreshTtl: '30d',
    });
    const token = await shortLived.signAccessToken({ id: 'u', email: 'a@example.com' });
    await expect(shortLived.verifyAccessToken(token)).rejects.toThrow(/expired/i);
  });

  it('issues an opaque refresh token with its hash and expiry', () => {
    const issued = tokens.issueRefreshToken();
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * Refresh tokens are stored hashed, so a leaked database yields nothing
   * replayable. SHA-256 is right here, where a slow password hash would not be:
   * the token is 32 random bytes, so there is nothing to brute-force.
   */
  it('hashes a refresh token deterministically and irreversibly', () => {
    const issued = tokens.issueRefreshToken();
    expect(hashRefreshToken(issued.token)).toBe(issued.tokenHash);
    expect(issued.tokenHash).not.toContain(issued.token);
  });

  it('never issues the same refresh token twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(tokens.issueRefreshToken().token);
    expect(seen.size).toBe(500);
  });
});

describe('parseDuration', () => {
  it('parses the units the config uses', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
    expect(parseDuration('2w')).toBe(1_209_600_000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration(' 15m ')).toBe(900_000);
  });

  it('refuses something it cannot parse, rather than defaulting silently', () => {
    for (const bad of ['', '15', 'm', '15 minutes', '-5m', '1.5h']) {
      expect(() => parseDuration(bad)).toThrow();
    }
  });
});
