import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * The server-side API client.
 *
 * Every call to the Express API happens on the server, from a server component
 * or a server action. The browser never receives a token, which is the point:
 * an access token in `localStorage` is readable by any script that gets onto
 * the page, and a refresh token there is a permanent account compromise. Here
 * both live in httpOnly cookies that JavaScript cannot read, and the API's
 * origin is never exposed to the client either.
 *
 * The cost is that interactive data has to come through a server action or a
 * page navigation rather than a fetch from the browser. For a portfolio app
 * built on end-of-day prices, that is no cost at all.
 */

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

export const ACCESS_COOKIE = 'psx_access';
export const REFRESH_COOKIE = 'psx_refresh';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Seconds to cache. Zero means always fresh, which is the default. */
  revalidate?: number;
  /** Throw instead of redirecting when unauthenticated. For server actions. */
  noRedirect?: boolean;
}

/**
 * Calls the API with the signed-in user's access token.
 *
 * On a 401 it redirects to the login page rather than rendering a broken
 * dashboard. Token refresh happens in middleware, before the request reaches
 * a page, because a server component cannot set a cookie.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;

  if (token === undefined) {
    if (options.noRedirect === true) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
    }
    redirect('/login');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    // Portfolio figures must never be stale: a cached position after a trade
    // would show the user a number that is simply wrong.
    cache: options.revalidate === undefined ? 'no-store' : 'force-cache',
    ...(options.revalidate !== undefined ? { next: { revalidate: options.revalidate } } : {}),
  });

  if (response.status === 401) {
    if (options.noRedirect === true) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
    }
    redirect('/login?expired=1');
  }

  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // A non-JSON error body is itself the information; the status carries it.
    }
    throw new ApiError(
      response.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `Request failed with ${response.status}`,
      body.error?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Unauthenticated call, for login and registration. */
export async function apiPublic<T>(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; code: string; message: string }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (!response.ok) {
    let parsed: ApiErrorBody = {};
    try {
      parsed = (await response.json()) as ApiErrorBody;
    } catch {
      /* status is enough */
    }
    return {
      ok: false,
      status: response.status,
      code: parsed.error?.code ?? 'UNKNOWN',
      message: parsed.error?.message ?? 'Something went wrong',
    };
  }

  return { ok: true, data: (await response.json()) as T };
}

export { API_BASE };
