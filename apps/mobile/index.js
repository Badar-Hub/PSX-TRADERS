/**
 * The app's entry point.
 *
 * `expo-router/entry` is the real entry and this file does nothing but import
 * it, so pointing `main` straight at the package would seem simpler. It is not,
 * under pnpm. The release build resolves the entry to an absolute path inside
 * pnpm's content-addressed store (`node_modules/.pnpm/expo-router@4.0.22_<hash>/
 * …/entry.js`), makes it relative for Metro, and then resolves it again from a
 * different directory — so the `../..` hops no longer land anywhere and the
 * bundle step fails with "Unable to resolve module". Expo Go and the web build
 * never hit it because they resolve the entry through Metro's own resolver.
 *
 * A real file inside this app has none of that indirection: the path is local
 * either way it is computed, and `expo-router/entry` below is left to Metro,
 * which already handles the workspace correctly (see metro.config.js).
 */

import 'expo-router/entry';
