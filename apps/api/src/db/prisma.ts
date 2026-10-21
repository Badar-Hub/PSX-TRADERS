import { PrismaClient } from '@prisma/client';

/**
 * One Prisma client for the process.
 *
 * Each client holds its own connection pool, so constructing them per request
 * exhausts Postgres' connection limit under load. The global cache also keeps
 * `tsx watch` from leaking a pool on every reload during development.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type Db = PrismaClient;

/**
 * A transaction client. Services take this so they can be composed inside one
 * transaction: rebuilding a portfolio's projection after a trade must either
 * complete or leave nothing behind.
 */
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
