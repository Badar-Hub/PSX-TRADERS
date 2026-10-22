import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from './config';

/**
 * The API client.
 *
 * Tokens live in `expo-secure-store`, which is the iOS Keychain and the Android
 * Keystore — not `AsyncStorage`, which is an unencrypted file any process with
 * filesystem access on a rooted or jailbroken device can read.
 *
 * The Next.js app keeps its tokens in httpOnly cookies so no script can reach
 * them. A native app has no such option: there is no browser to hold a cookie
 * and the app itself must present the token. Hardware-backed storage is the
 * equivalent guarantee on this platform, and the reason the two clients differ
 * here is the platform, not a change of mind.
 */

const ACCESS_KEY = 'psx_access';
const REFRESH_KEY = 'psx_refresh';

/*
 * Storage, per platform.
 *
 * expo-secure-store has no browser implementation — a browser has no Keychain
 * to put anything in — and throws rather than degrading, so the web build needs
 * its own path. `localStorage` is reachable by any script on the origin, which
 * is weaker than what the native builds get; the Next.js dashboard is the real
 * answer in a browser, and `expo start --web` exists here to run the screens
 * during development rather than to be shipped as a web app.
 */
const store = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        /* a browser with storage blocked simply has no session between loads */
      }
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* nothing to remove */
      }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

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

/** Thrown when the API cannot be reached at all, as opposed to refusing. */
export class NetworkError extends Error {}

export async function readTokens(): Promise<{ access: string | null; refresh: string | null }> {
  const [access, refresh] = await Promise.all([
    store.get(ACCESS_KEY),
    store.get(REFRESH_KEY),
  ]);
  return { access, refresh };
}

export async function storeTokens(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([
    store.set(ACCESS_KEY, accessToken),
    store.set(REFRESH_KEY, refreshToken),
  ]);
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    store.remove(ACCESS_KEY),
    store.remove(REFRESH_KEY),
  ]);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the token and the refresh dance. For register, login and verify. */
  anonymous?: boolean;
}

async function raw(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    // fetch rejects only on a transport failure, which on a phone usually means
    // no network or the wrong API address rather than anything the server did.
    throw new NetworkError(
      `Could not reach the API at ${API_BASE_URL}. Check that it is running and that ` +
        `the phone is on the same network.`,
    );
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

async function toError(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    /* a non-JSON error body carries nothing beyond the status */
  }
  return new ApiError(
    response.status,
    body.error?.code ?? 'UNKNOWN',
    body.error?.message ?? `Request failed with ${response.status}`,
    body.error?.details,
  );
}

/**
 * Calls the API, refreshing the access token once on a 401.
 *
 * The refresh is attempted exactly once per request. Looping would turn an
 * expired-session case into a storm of refresh calls, and the API revokes every
 * session when a spent refresh token is replayed — so a retry loop would log
 * the user out of all their devices.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (options.anonymous === true) {
    const response = await raw(path, options, null);
    if (!response.ok) throw await toError(response);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  const { access, refresh } = await readTokens();
  let response = await raw(path, options, access);

  if (response.status === 401 && refresh !== null) {
    const refreshed = await refreshSession(refresh);
    if (refreshed === null) {
      await clearTokens();
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired. Sign in again.');
    }
    response = await raw(path, options, refreshed);
  }

  if (!response.ok) throw await toError(response);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** Exchanges a refresh token for a new pair. Returns the new access token. */
export async function refreshSession(refreshToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return null;

    const pair = (await response.json()) as { accessToken: string; refreshToken: string };
    // The API rotates refresh tokens, so the new one must be stored. Keeping
    // the old one would get every session revoked on the next refresh, which
    // the API treats as a replay.
    await storeTokens(pair.accessToken, pair.refreshToken);
    return pair.accessToken;
  } catch {
    return null;
  }
}
