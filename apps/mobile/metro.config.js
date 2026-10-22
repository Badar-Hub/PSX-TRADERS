const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro in a pnpm workspace.
 *
 * Metro resolves modules by walking up from the file that imported them, which
 * works in a flat `node_modules` and does not work here: pnpm installs each
 * package as a symlink into a content-addressed store, so `react-native`'s own
 * dependencies live nowhere near `apps/mobile`. Two settings fix it —
 * `watchFolders` so the repository root is watched, and `nodeModulesPaths` so
 * the root's `node_modules` is searched as well as this app's.
 *
 * `disableHierarchicalLookup` stays off deliberately. Turning it on is the
 * usual advice for monorepos, but with pnpm it breaks the transitive
 * dependencies that are only reachable by walking up from a symlinked package.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
