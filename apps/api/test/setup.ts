import { config } from 'dotenv';

/**
 * Test environment setup, run before any test module is imported.
 *
 * The important part is the override: `.env.test` points DATABASE_URL at a
 * separate database. The integration suite truncates every table, including
 * `securities` and `daily_bars`, which are shared market data rather than
 * per-user rows. Pointed at the development database, a test run would silently
 * destroy a year of backfilled price history, and the only symptom would be
 * predictions quietly refusing for want of data.
 *
 * `api.test.ts` additionally refuses to run against a database whose name does
 * not look like a test database, so forgetting this file fails loudly rather
 * than deleting anything.
 */

config({ path: '.env' });
config({ path: '.env.test', override: true });
