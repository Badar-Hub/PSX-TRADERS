import { NextResponse, type NextRequest } from 'next/server';

/**
 * Keeps the session alive.
 *
 * A server component can read cookies but cannot set them, so it has nowhere to
 * put a freshly refreshed token. Middleware can, and it runs before the page
 * does, so this is where the 15-minute access token is exchanged for a new one
 * using the long-lived refresh token.
 *
 * The API rotates refresh tokens, so the new one it returns must be stored:
 * presenting the old one again would be treated as a replay and would drop
 * every session for the user. That is the behaviour working as intended, and
 * the reason this writes both cookies rather than only the access one.
 */

const ACCESS_COOKIE = 'psx_access';
const REFRESH_COOKIE = 'psx_refresh';
const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

const PUBLIC_PATHS = ['/login', '/register'];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  if (access !== undefined) return NextResponse.next();

  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (refresh === undefined) {
    const login = new URL('/login', request.url);
    return NextResponse.redirect(login);
  }

  try {
    const response = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
      cache: 'no-store',
    });

    if (!response.ok) {
      // The refresh token is spent, expired or revoked. Clearing both cookies
      // keeps the user from looping through a refresh that cannot succeed.
      const login = new URL('/login?expired=1', request.url);
      const redirect = NextResponse.redirect(login);
      redirect.cookies.delete(ACCESS_COOKIE);
      redirect.cookies.delete(REFRESH_COOKIE);
      return redirect;
    }

    const pair = (await response.json()) as { accessToken: string; refreshToken: string };
    const next = NextResponse.next();
    const secure = process.env.NODE_ENV === 'production';

    next.cookies.set(ACCESS_COOKIE, pair.accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 15 * 60,
    });
    next.cookies.set(REFRESH_COOKIE, pair.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });

    return next;
  } catch {
    // The API being unreachable is not a reason to destroy the session: the
    // user is sent to the login page, but the refresh cookie is left alone so
    // they are signed back in once the API returns.
    return NextResponse.redirect(new URL('/login?unreachable=1', request.url));
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
