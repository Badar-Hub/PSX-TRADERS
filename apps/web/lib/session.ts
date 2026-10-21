import { cookies } from 'next/headers';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './api';

/**
 * Cookie handling for the session.
 *
 * Both tokens are httpOnly, so no script on the page can read them. `sameSite:
 * lax` is enough here because every state change goes through a POST from the
 * app's own origin; `strict` would log the user out whenever they followed a
 * link in from elsewhere.
 *
 * The access cookie expires with the token it carries. When it goes and the
 * refresh cookie remains, middleware exchanges one for the other, which is why
 * the two have different lifetimes rather than sharing one.
 */

const ACCESS_MAX_AGE = 15 * 60;
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function setSessionCookies(pair: TokenPair): Promise<void> {
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';

  store.set(ACCESS_COOKIE, pair.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: ACCESS_MAX_AGE,
  });

  store.set(REFRESH_COOKIE, pair.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: REFRESH_MAX_AGE,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}

export async function currentRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(REFRESH_COOKIE)?.value;
}

export async function isSignedIn(): Promise<boolean> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE) !== undefined || store.get(REFRESH_COOKIE) !== undefined;
}
