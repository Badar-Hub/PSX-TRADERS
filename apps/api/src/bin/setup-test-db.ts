/**
 * Creates the test database and brings its schema up to date.
 *
 *   pnpm --filter @psx/api db:test:setup
 *
 * Separate from the development database because the integration suite
 * truncates every table, including the shared market-data ones. Running it
 * against development would destroy backfilled price history.
 *
 * Safe to re-run: the database is only created if missing, and the migration
 * step is `migrate deploy`, which applies what is outstanding and nothing else.
 */

import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';
import { Client } from 'pg';

config({ path: '.env' });
config({ path: '.env.test', override: true });

function parseUrl(url: string): { adminUrl: string; database: string } {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');
  if (database === '') throw new Error(`DATABASE_URL has no database name: ${url}`);

  // Connect to the maintenance database to issue CREATE DATABASE, since a
  // database cannot be created from inside itself.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return { adminUrl: admin.toString(), database };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is not set; is .env.test present?');

  const { adminUrl, database } = parseUrl(url);

  if (!/test/i.test(database)) {
    throw new Error(
      `Refusing to set up "${database}": the test database name must contain "test", ` +
        `so this script can never be pointed at development data by accident.`,
    );
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (existing.rowCount === 0) {
    // The name is validated above and comes from local configuration, but it is
    // still interpolated into DDL, so it is quoted as an identifier.
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    console.log(`created database ${database}`);
  } else {
    console.log(`database ${database} already exists`);
  }

  await client.end();

  console.log('applying migrations...');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
    shell: true,
  });

  console.log(`\ntest database ready: ${database}`);
}

main().catch((error: unknown) => {
  console.error('failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
