/**
 * Re-derives every security's listing kind from its stored name.
 *
 *   pnpm --filter @psx/api reclassify
 *
 * The nightly ingest classifies each security it sees, so a change to the
 * classifier fixes the symbols that traded that day and leaves everything else
 * on the old answer. After the rights-letter fix that was 2 of 18 corrected and
 * 16 left wrong, which is worse than either state: the universe disagreed with
 * itself depending on when a stock last traded.
 *
 * So this exists, and it will be needed again the next time the classifier
 * learns something. It reads nothing from the exchange — the names are already
 * stored — and it only writes rows whose answer actually changed.
 *
 * `--dry-run` prints what would change without writing.
 */

import { classifyListing } from '@psx/data';
import { prisma } from '../db/prisma.js';
import { loadEnv } from '../env.js';

async function main(): Promise<void> {
  loadEnv();
  const dryRun = process.argv.includes('--dry-run');

  const securities = await prisma.security.findMany({
    select: { id: true, symbol: true, name: true, listing: true, baseSymbol: true },
    orderBy: { symbol: 'asc' },
  });

  const changes: Array<{
    symbol: string;
    name: string;
    from: string;
    to: string;
    baseSymbol: string | null;
  }> = [];

  for (const security of securities) {
    // The same inputs the ingest uses, so this and the nightly run can never
    // reach different conclusions about the same row.
    const listing = classifyListing({
      symbol: security.symbol,
      shortName: security.name,
      fullName: security.name,
    });
    const baseSymbol = listing.base === security.symbol ? null : listing.base;

    if (security.listing === listing.kind && security.baseSymbol === baseSymbol) continue;

    changes.push({
      symbol: security.symbol,
      name: security.name,
      from: security.listing,
      to: listing.kind,
      baseSymbol,
    });

    if (!dryRun) {
      await prisma.security.update({
        where: { id: security.id },
        data: { listing: listing.kind, baseSymbol },
      });
    }
  }

  console.log(`${securities.length} securities examined, ${changes.length} reclassified`);
  for (const change of changes) {
    console.log(
      `  ${change.symbol.padEnd(12)} ${change.from} -> ${change.to}` +
        `${change.baseSymbol === null ? '' : ` (of ${change.baseSymbol})`}  ${change.name}`,
    );
  }
  if (dryRun && changes.length > 0) console.log('\nDry run: nothing was written.');

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error('[reclassify] failed:', error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
