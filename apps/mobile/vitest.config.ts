import { defineConfig } from 'vitest/config';

/**
 * Tests for the parts of the app that are plain TypeScript.
 *
 * Deliberately not a React Native test setup: rendering native components in
 * Node needs a preset and a mock for every native module, which is a lot of
 * machinery to assert that a view has a style. The formatters are where the
 * logic worth testing lives, and they import nothing from React Native.
 */
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
