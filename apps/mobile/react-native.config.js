const path = require('node:path');

/**
 * Makes Expo's own autolinking config load under pnpm.
 *
 * `expo/react-native.config.js` begins with
 * `require('expo-modules-autolinking/exports')`. expo declares that dependency
 * and pnpm links it as a sibling in the virtual store, so the require is fine
 * — until the Android build loads that config file through its *symlinked*
 * path, `apps/mobile/node_modules/expo/react-native.config.js`. Node resolves
 * modules by walking up from the file's literal directory, and from the
 * symlink there is no sibling to find, so the require throws.
 *
 * expo-modules-autolinking catches every error from loading a config and
 * returns null, then falls back to guessing the package's Java class from its
 * AndroidManifest. For expo that guess is `expo.core.ExpoModulesPackage` — a
 * package name Expo abandoned years ago — and the release build fails
 * compiling the generated PackageList with "cannot find symbol". The silent
 * catch is what makes this expensive to diagnose: nothing reports that a
 * config failed to load.
 *
 * `require.resolve` returns the real path inside pnpm's store rather than the
 * symlink, so requiring the config from there resolves the sibling and runs
 * Expo's real logic. The result is handed back as a `dependencies` override,
 * which autolinking spreads over the library's own config
 * (reactNativeConfig.js: `...projectConfig?.dependencies?.[name]`).
 *
 * Deliberately not done by copying the class name into this file: that would
 * freeze a constant belonging to Expo, and it would go stale at the next SDK
 * upgrade as a native crash rather than an error. Nor by depending on
 * expo-modules-autolinking directly, which works but makes expo-doctor fail
 * the project for installing it directly.
 */

const expoPackageRoot = path.dirname(require.resolve('expo/package.json'));
const expoConfig = require(path.join(expoPackageRoot, 'react-native.config.js'));

module.exports = {
  dependencies: {
    expo: expoConfig.dependency,
  },
};
