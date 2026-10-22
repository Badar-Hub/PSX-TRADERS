import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Where the API lives.
 *
 * On a simulator `localhost` happens to work. On a real phone it does not —
 * `localhost` is the phone's own loopback, so the request never leaves the
 * device and fails with a connection error that looks like the server being
 * down. This is the single most common "it works on my machine" problem in
 * React Native development, so it is resolved rather than configured.
 *
 * Expo's dev server tells the app which address it was reached on, in
 * `hostUri` (for example `192.168.1.5:8081`). Taking that host and swapping the
 * port gives the API's address on the same network, whichever Wi-Fi the laptop
 * happens to be on today.
 *
 * `extra.apiBaseUrl` in app.json overrides it, which is what a real build uses
 * to point at a deployed API instead of someone's laptop.
 */

const API_PORT = 4000;

function fromDevServer(): string | null {
  // hostUri is only present while running against a dev server.
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Older/alternate shapes, kept because this is the one value worth being
    // defensive about: without it the app cannot reach anything.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost ??
    null;

  if (hostUri === null) return null;

  const host = hostUri.split(':')[0];
  if (host === undefined || host === '') return null;

  return `http://${host}:${API_PORT}`;
}

/**
 * The browser build has no `hostUri`: that value comes from the native dev
 * client's manifest, and a page loaded over HTTP never sees one. The page's own
 * host is the equivalent fact, and it is already right — the browser reached
 * the dev server somehow, and the API is beside it.
 */
function fromLocation(): string | null {
  if (Platform.OS !== 'web') return null;
  const host = globalThis.location?.hostname;
  if (host === undefined || host === '') return null;
  return `http://${host}:${API_PORT}`;
}

function resolveBaseUrl(): string {
  const configured = (Constants.expoConfig?.extra as { apiBaseUrl?: string | null } | undefined)
    ?.apiBaseUrl;
  if (typeof configured === 'string' && configured !== '') return configured;

  const derived = fromDevServer() ?? fromLocation();
  if (derived !== null) return derived;

  // A production build with nothing configured. Failing loudly here beats
  // every screen showing an unexplained network error.
  throw new Error(
    'No API address. Set expo.extra.apiBaseUrl in app.json for a standalone build.',
  );
}

export const API_BASE_URL = resolveBaseUrl();

/** Shown on the sign-in screen, so a connection problem is diagnosable. */
export const API_HOST_LABEL = API_BASE_URL.replace(/^https?:\/\//, '');
