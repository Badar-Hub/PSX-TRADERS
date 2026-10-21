import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads .env, then .env.test over the top, so the integration suite points
    // at its own database instead of the development one.
    setupFiles: ['./test/setup.ts'],
    // The integration tests share one database and reset it, so they must not
    // run alongside each other.
    fileParallelism: false,
    // The default 5s is for unit tests. Ingesting a year of synthetic trading
    // days into Postgres legitimately takes longer than that, and a timeout
    // there surfaces as a confusing cascade of unrelated failures downstream.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
