import { createApp } from './app.js';
import { createNarrativeWriter } from './services/narrative.js';
import { loadEnv } from './env.js';
import { prisma } from './db/prisma.js';

/**
 * Process entry point.
 *
 * Config is validated before anything binds a port, so a misconfigured
 * deployment fails at startup with a readable message rather than serving
 * traffic that errors on the first login.
 */

async function main(): Promise<void> {
  const env = loadEnv();

  // Built here rather than inside createApp so the startup line can say which
  // model is writing the prediction explanations, or that none is. Whether an
  // explanation came from a language model is not something to leave implicit.
  const narrativeWriter = createNarrativeWriter(env);
  const app = createApp({ env, narrativeWriter });

  const server = app.listen(env.PORT, () => {
    console.log(`psx-trader api listening on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
    console.log(`narratives: ${narrativeWriter.describe()}`);
  });

  // Finish in-flight requests and release the connection pool before exiting,
  // so a deploy does not drop a transaction halfway through a trade.
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    // A request that will not finish must not hold the deploy open forever.
    setTimeout(() => {
      console.error('Shutdown timed out; exiting');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
