import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { unauthorized } from '../http/errors.js';

/**
 * Access and refresh tokens.
 *
 * Access tokens are short-lived JWTs, verified on every request without a
 * database round trip. Refresh tokens are long-lived, so they are stored
 * server-side and can be revoked; a stateless long-lived token cannot be taken
 * away once issued.
 *
 * Refresh tokens are stored as a SHA-256 of the token, not the token itself. A
 * leaked database then yields nothing replayable, which is the same reason
 * passwords are not stored in the clear. SHA-256 is right here where a
 * password hash would not be: the token is 32 random bytes, so there is nothing
 * to brute-force and no need for a slow hash.
 *
 * Access and refresh tokens are signed with different secrets, so a refresh
 * token can never be presented as an access token.
 */

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  email: string;
}

export interface TokenConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtl: string;
  refreshTtl: string;
  issuer?: string;
  audience?: string;
}

const DEFAULT_ISSUER = 'psx-trader';
const DEFAULT_AUDIENCE = 'psx-trader-app';

export class Tokens {
  private readonly accessKey: Uint8Array;
  private readonly refreshKey: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(private readonly config: TokenConfig) {
    this.accessKey = new TextEncoder().encode(config.accessSecret);
    this.refreshKey = new TextEncoder().encode(config.refreshSecret);
    this.issuer = config.issuer ?? DEFAULT_ISSUER;
    this.audience = config.audience ?? DEFAULT_AUDIENCE;
  }

  async signAccessToken(user: { id: string; email: string }): Promise<string> {
    return new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(this.config.accessTtl)
      .sign(this.accessKey);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.accessKey, {
        issuer: this.issuer,
        audience: this.audience,
        // Pinned: without it, a token could claim "alg":"none" and verify.
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw unauthorized('Token is missing required claims');
      }
      return payload as AccessTokenClaims;
    } catch (error) {
      if (error instanceof Error && error.name === 'JWTExpired') {
        throw unauthorized('Access token has expired');
      }
      throw unauthorized('Access token is not valid');
    }
  }

  /**
   * A refresh token is opaque random bytes rather than a JWT: it is only ever
   * looked up server-side, so there is no claim worth carrying in it, and
   * nothing to parse means nothing to confuse.
   */
  issueRefreshToken(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + parseDuration(this.config.refreshTtl)),
    };
  }

  get refreshTtlMs(): number {
    return parseDuration(this.config.refreshTtl);
  }
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Parses "15m", "30d", "12h", "45s" into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Cannot parse a duration from "${value}"; expected something like "15m"`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const multiplier = multipliers[unit ?? ''];
  if (multiplier === undefined) throw new Error(`Unknown duration unit "${unit}"`);
  return amount * multiplier;
}
