import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { auth, mailer, signUpActive, type Session } from '../helpers/account.js';
import { loadEnv } from '../../src/env.js';
import { prisma } from '../../src/db/prisma.js';
import { getMarketStatus } from '../../src/services/market.js';

/**
 * The market index.
 *
 * The case that matters here is the one that produced the feature's first
 * wrong answer: a rights letter trading at a few paisa. One of them went from
 * 1 paisa to 76 in a day — a +7,500% move — and because rights letters were
 * stored as ordinary equities, eighteen of them dragged an equal-weighted
 * index to +105% when the median liquid share had fallen 42%. The fixtures
 * below reproduce that shape deliberately.
 */

function isTestDatabase(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  const name = url.split('/').pop()?.split('?')[0] ?? '';
  return /test/i.test(name);
}

async function reachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const hasDatabase = isTestDatabase() && (await reachable());
if (!hasDatabase) {
  console.warn('\n  Skipping market integration tests: no test database.\n');
}

const env = hasDatabase ? loadEnv() : null;
const app = hasDatabase && env !== null ? createApp({ env, mailer }) : null;

const p = (rupees: number): number => Math.round(rupees * 100);

async function seed(
  symbol: string,
  listing: 'EQUITY' | 'RIGHT' | 'PREFERENCE',
  bars: Array<{ date: string; ldcp: number; close: number; volume?: number }>,
): Promise<void> {
  const security = await prisma.security.upsert({
    where: { symbol },
    update: { listing },
    create: { symbol, name: `${symbol} Limited`, segment: 'EQUITY', listing },
    select: { id: true },
  });

  for (const bar of bars) {
    await prisma.dailyBar.upsert({
      where: {
        securityId_date: { securityId: security.id, date: new Date(`${bar.date}T00:00:00Z`) },
      },
      update: {
        ldcp: BigInt(bar.ldcp),
        close: BigInt(bar.close),
        volume: bar.volume ?? 100_000,
      },
      create: {
        securityId: security.id,
        date: new Date(`${bar.date}T00:00:00Z`),
        open: BigInt(bar.ldcp),
        high: BigInt(Math.max(bar.ldcp, bar.close)),
        low: BigInt(Math.min(bar.ldcp, bar.close)),
        close: BigInt(bar.close),
        ldcp: BigInt(bar.ldcp),
        volume: bar.volume ?? 100_000,
      },
    });
  }
}

async function wipe(): Promise<void> {
  await prisma.alertEvent.deleteMany();
  await prisma.alertRule.deleteMany();
  await prisma.signalFactor.deleteMany();
  await prisma.signal.deleteMany();
  await prisma.positionCycle.deleteMany();
  await prisma.taxLot.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.corporateActionApplication.deleteMany();
  await prisma.corporateAction.deleteMany();
  await prisma.fundamental.deleteMany();
  await prisma.dailyBar.deleteMany();
  await prisma.security.deleteMany();
  await prisma.ingestRun.deleteMany();
  await prisma.portfolio.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
}

describe.skipIf(!hasDatabase)('market status', () => {
  let session: Session;

  beforeAll(async () => {
    await wipe();
    session = await signUpActive(app!, 'market@example.com');

    // Two ordinary shares: one up 10% a day, one flat. The equal-weighted
    // index should therefore rise 5% a day.
    await seed('UPUP', 'EQUITY', [
      { date: '2026-10-01', ldcp: p(100), close: p(100) },
      { date: '2026-10-02', ldcp: p(100), close: p(110) },
      { date: '2026-10-05', ldcp: p(110), close: p(121) },
    ]);
    await seed('FLATCO', 'EQUITY', [
      { date: '2026-10-01', ldcp: p(50), close: p(50) },
      { date: '2026-10-02', ldcp: p(50), close: p(50) },
      { date: '2026-10-05', ldcp: p(50), close: p(50) },
    ]);
  });

  it('requires authentication', async () => {
    await request(app!).get('/api/market/status').expect(401);
  });

  it('bases the index at 1,000 on the first stored session', async () => {
    const status = await getMarketStatus();
    expect(status.base).toBe(1_000);
    expect(status.series[0]?.date).toBe('2026-10-01');
    expect(status.series[0]?.level).toBe(1_000);
    // The first day is the base, not a move: it has no prior session here.
    expect(status.series[0]?.change).toBe(0);
  });

  it('moves the level by the mean of the daily moves', async () => {
    const status = await getMarketStatus();
    // +10% and 0% average to +5%, so 1000 becomes 1050 and then 1102.5.
    expect(status.series[1]?.level).toBe(1_050);
    expect(status.series[1]?.changeBps).toBe(500);
    expect(status.series[2]?.level).toBe(1_102.5);
  });

  it('reports the median beside the mean', async () => {
    const status = await getMarketStatus();
    // Two shares at +10% and 0%: the mean is +5% and the median is the same,
    // being the midpoint of the two.
    expect(status.series[1]?.changeBps).toBe(500);
    expect(status.series[1]?.medianChangeBps).toBe(500);
  });

  it('counts advances, declines and unchanged from the exchange previous close', async () => {
    const status = await getMarketStatus();
    const day = status.series[1];
    expect(day?.advances).toBe(1);
    expect(day?.declines).toBe(0);
    expect(day?.unchanged).toBe(1);
    expect(day?.counted).toBe(2);
  });

  /*
   * The bug this feature found. WAVESAPPR really did close at 76 paisa against
   * a 1-paisa previous close on 31 Aug 2026, and with rights letters stored as
   * equities that single row would have moved the index by thousands of
   * percent. A rights letter is a different instrument — a few paisa, and it
   * expires — so one tick is a double-digit move and it has no business in an
   * index of shares.
   */
  it('excludes rights letters, whose one-paisa ticks are not market moves', async () => {
    await seed('WAVESAPPR', 'RIGHT', [
      { date: '2026-10-01', ldcp: 1, close: 1 },
      { date: '2026-10-02', ldcp: 1, close: 76 },
      { date: '2026-10-05', ldcp: 76, close: 76 },
    ]);

    const status = await getMarketStatus();
    // Unchanged from the two-share answer above: a +7,500% day did not happen
    // to the market.
    expect(status.series[1]?.level).toBe(1_050);
    expect(status.series[1]?.counted).toBe(2);
  });

  it('excludes preference shares too', async () => {
    await seed('AGLNCPS', 'PREFERENCE', [
      { date: '2026-10-01', ldcp: p(10), close: p(10) },
      { date: '2026-10-02', ldcp: p(10), close: p(20) },
    ]);

    const status = await getMarketStatus();
    expect(status.series[1]?.counted).toBe(2);
    expect(status.series[1]?.level).toBe(1_050);
  });

  it('ignores shares below the volume floor', async () => {
    await seed('THINCO', 'EQUITY', [
      { date: '2026-10-01', ldcp: p(100), close: p(100), volume: 10 },
      { date: '2026-10-02', ldcp: p(100), close: p(200), volume: 10 },
    ]);

    const status = await getMarketStatus();
    expect(status.series[1]?.counted).toBe(2);

    // Drop the floor and the same row counts, which proves the floor is what
    // excluded it rather than something else.
    const open = await getMarketStatus({ minVolume: 0 });
    expect(open.series[1]?.counted).toBe(3);
  });

  /*
   * Chaining happens over the whole stored history and the window is sliced
   * off the end afterwards. Compute the level within the window instead and
   * the base moves whenever the window does, so the same date reads
   * differently depending on how much history was asked for.
   */
  it('gives a date the same level whatever window is requested', async () => {
    const full = await getMarketStatus({ days: 2_000 });
    const narrow = await getMarketStatus({ days: 5 });

    const lastOfFull = full.series[full.series.length - 1];
    const lastOfNarrow = narrow.series[narrow.series.length - 1];
    expect(lastOfNarrow?.date).toBe(lastOfFull?.date);
    expect(lastOfNarrow?.level).toBe(lastOfFull?.level);
  });

  it('carries the basis sentence to the client, naming what it is not', async () => {
    const response = await request(app!)
      .get('/api/market/status?days=5')
      .set(auth(session))
      .expect(200);

    // The one thing a points figure on a Pakistani trading app must not do is
    // let itself be read as a KSE-100 quote.
    expect(response.body.basis).toContain('not the KSE-100');
    expect(response.body.basis).toContain('Rights letters are excluded');
    expect(response.body.latest.level).toBeGreaterThan(0);
  });

  it('refuses a window outside the supported range', async () => {
    await request(app!).get('/api/market/status?days=1').set(auth(session)).expect(400);
    await request(app!).get('/api/market/status?days=99999').set(auth(session)).expect(400);
  });

  it('returns an empty series rather than failing when nothing is stored', async () => {
    await wipe();
    const status = await getMarketStatus();
    expect(status.series).toEqual([]);
    expect(status.latest).toBeNull();
  });
});
