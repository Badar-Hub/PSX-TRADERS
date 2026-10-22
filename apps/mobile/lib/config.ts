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
 * `extra.apiBaseUrl` in app.json is the fallback for a standalone build, which
 * has no dev server to ask and so has no way to work it out.
 *
 * The order matters and used to be the other way round. With the configured
 * value winning, setting it for an installable APK also pinned Expo Go to that
 * one address — so the dev build stopped following whichever network the laptop
 * was on, which is the entire point of deriving it. Derivation first means both
 * work: dev follows the dev server, a standalone build falls back to the
 * configured address.
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
  // Derivation first, so a dev build follows whatever network it is on.
  const derived = fromDevServer() ?? fromLocation();
  if (derived !== null) return derived;

  // No dev server and not a browser: a standalone build, which can only use
  // what it was told at build time.
  const configured = (Constants.expoConfig?.extra as { apiBaseUrl?: string | null } | undefined)
    ?.apiBaseUrl;
  if (typeof configured === 'string' && configured !== '') return configured;

  // Failing loudly beats every screen showing an unexplained network error.
  throw new Error(
    'No API address. Set expo.extra.apiBaseUrl in app.json for a standalone build.',
  );
}

export const API_BASE_URL = resolveBaseUrl();

/** Shown on the sign-in screen, so a connection problem is diagnosable. */
export const API_HOST_LABEL = API_BASE_URL.replace(/^https?:\/\//, '');
