import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { paisa } from '@psx/shared';
import type { DailyBarsResult, MarketDataProvider, PsxSymbolRecord } from '@psx/data';
import { createApp } from '../../src/app.js';
import { auth as authFor, mailer, signUpActive } from '../helpers/account.js';
import { loadEnv } from '../../src/env.js';
import { prisma } from '../../src/db/prisma.js';
import { backfill, coverage, ingestTradingDay } from '../../src/services/ingest.js';
import {
  accuracyReport,
  computeSignalForSymbol,
  getLatestSignal,
  liquidSymbols,
  settleDueSignals,
} from '../../src/services/signals.js';

/**
 * Ingest and prediction, end to end against a real database.
 *
 * The market data comes from a stub provider rather than the live exchange, so
 * the test is deterministic and needs no network. What is exercised for real is
 * everything downstream: the idempotent day replacement, corporate-action
 * detection against the previous stored day, signal persistence with its factor
 * table, settling, and the endpoints.
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
  console.warn('\n  Skipping signal integration tests: no test database.\n');
}

/**
 * A price series with a clean uptrend, long enough for the 200-day factors.
 *
 * Generated rather than taken from the exchange so the expected direction is
 * known: a test asserting "this should read bullish" needs data that is
 * unambiguously bullish.
 */
function syntheticDays(symbols: string[], count: number): Map<string, DailyBarsResult> {
  const days = new Map<string, DailyBarsResult>();
  const prices = new Map(symbols.map((symbol, i) => [symbol, 100 + i * 50]));

  // Weekdays only, working forwards from a known Monday.
  const dates: string[] = [];
  let cursor = Date.parse('2025-09-01T00:00:00Z');
  while (dates.length < count) {
    const date = new Date(cursor);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(date.toISOString().slice(0, 10));
    cursor += 86_400_000;
  }

  for (const date of dates) {
    const bars = symbols.map((symbol, index) => {
      const previous = prices.get(symbol) ?? 100;
      // A steady climb with a little shape, so indicators have something to say.
      const next = previous * 1.004 + Math.sin(dates.indexOf(date) / 5) * 0.2;
      prices.set(symbol, next);
      const toP = (value: number) => paisa(Math.round(value * 100));
      return {
        date,
        symbol,
        sectorCode: '0807',
        companyName: `${symbol} Limited`,
        segment: 'EQUITY' as const,
        open: toP(previous),
        high: toP(Math.max(previous, next) * 1.004),
        low: toP(Math.min(previous, next) * 0.996),
        close: toP(next),
        volume: 400_000 + index * 10_000,
        ldcp: toP(previous),
      };
    });

    days.set(date, {
      date,
      bars,
      summary: {
        date,
        bars,
        skipped: [],
        warnings: [],
        segmentCounts: { EQUITY: bars.length, FUTURE: 0, INDEX_FUTURE: 0, DEBT: 0, UNKNOWN: 0 },
      },
      raw: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    });
  }

  return days;
}

/** The next weekday strictly after `iso`. */
function nextWeekday(iso: string): string {
  let cursor = Date.parse(`${iso}T00:00:00Z`) + 86_400_000;
  for (;;) {
    const date = new Date(cursor);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) return date.toISOString().slice(0, 10);
    cursor += 86_400_000;
  }
}

function stubProvider(days: Map<string, DailyBarsResult>): MarketDataProvider {
  return {
    name: 'stub',
    fetchDailyBars: async (date: string) => days.get(date) ?? null,
    fetchSymbolMaster: async (): Promise<PsxSymbolRecord[] | null> => null,
  };
}

const SYMBOLS = ['AAAA', 'BBBB'];
const days = syntheticDays(SYMBOLS, 230);
const dayList = [...days.keys()];
const provider = stubProvider(days);

const app = hasDatabase ? createApp({ env: loadEnv(), logError: () => {}, mailer }) : null;

async function wipe(): Promise<void> {
  await prisma.signalFactor.deleteMany();
  await prisma.signal.deleteMany();
  await prisma.lotConsumption.deleteMany();
  await prisma.taxLot.deleteMany();
  await prisma.positionCycle.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.corporateActionApplication.deleteMany();
  await prisma.corporateAction.deleteMany();
  await prisma.dailyBar.deleteMany();
  await prisma.fundamental.deleteMany();
  await prisma.security.deleteMany();
  await prisma.ingestRun.deleteMany();
  await prisma.portfolio.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
}

describe.skipIf(!hasDatabase)('ingest against a database', () => {
  beforeAll(async () => {
    await wipe();
  });

  // No $disconnect: the client is a process-wide singleton shared with the
  // other integration file. See the note in api.test.ts.

  it('writes a day of bars and creates the securities they refer to', async () => {
    const first = dayList[0]!;
    const result = await ingestTradingDay(first, { provider });

    expect(result.status).toBe('SUCCESS');
    expect(result.barsWritten).toBe(SYMBOLS.length);
    expect(result.securitiesCreated).toBe(SYMBOLS.length);

    const stored = await prisma.dailyBar.count();
    expect(stored).toBe(SYMBOLS.length);

    const security = await prisma.security.findUnique({ where: { symbol: 'AAAA' } });
    expect(security?.name).toBe('AAAA Limited');
    expect(security?.sectorCode).toBe('0807');
    expect(security?.segment).toBe('EQUITY');
  });

  /**
   * Re-running a date replaces that day rather than duplicating or merging it,
   * so a run that failed halfway can simply be run again.
   */
  it('is idempotent: re-ingesting a day replaces it', async () => {
    const first = dayList[0]!;
    const before = await prisma.dailyBar.count();

    const again = await ingestTradingDay(first, { provider });
    expect(again.status).toBe('SUCCESS');
    expect(again.securitiesCreated).toBe(0);
    expect(await prisma.dailyBar.count()).toBe(before);
  });

  it('records a non-trading day as NO_FILE and calls the run a success', async () => {
    const result = await ingestTradingDay('2024-01-01', { provider });
    expect(result.status).toBe('NO_FILE');
    expect(result.barsWritten).toBe(0);

    const run = await prisma.ingestRun.findFirst({
      where: { tradingDay: new Date('2024-01-01T00:00:00.000Z') },
    });
    expect(run?.status).toBe('NO_FILE');
  });

  /**
   * A regression test for a bug that only an end-to-end run revealed.
   *
   * Recording a trade in a symbol the ingest has not seen creates a stub with
   * segment UNKNOWN. Signal generation filters on EQUITY, so before the fix
   * such a symbol stayed UNKNOWN forever and silently never got a prediction:
   * buy a stock before its first ingest and it was locked out permanently.
   */
  it('corrects a trade stub left as UNKNOWN once the exchange reports the symbol', async () => {
    await prisma.security.create({
      data: { symbol: 'AAAA', name: 'AAAA', segment: 'UNKNOWN' },
    }).catch(async () => {
      // Already created by the ingest above; force it back to the stub state.
      await prisma.security.update({
        where: { symbol: 'AAAA' },
        data: { segment: 'UNKNOWN', name: 'AAAA' },
      });
    });

    const before = await prisma.security.findUniqueOrThrow({ where: { symbol: 'AAAA' } });
    expect(before.segment).toBe('UNKNOWN');

    await ingestTradingDay(dayList[0]!, { provider });

    const after = await prisma.security.findUniqueOrThrow({ where: { symbol: 'AAAA' } });
    expect(after.segment).toBe('EQUITY');
    expect(after.name).toBe('AAAA Limited');
    // That it is consequently eligible for scoring is asserted by "finds the
    // liquid symbols worth scoring" below, once enough days have been ingested
    // for the 20-session liquidity window to mean anything.
  });

  it('keeps an audit trail of every run', async () => {
    const runs = await prisma.ingestRun.findMany();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.finishedAt).not.toBeNull();
      expect(['SUCCESS', 'NO_FILE', 'FAILED']).toContain(run.status);
    }
  });

  it('backfills a range oldest first and skips what it already has', async () => {
    const results = await backfill(dayList[0]!, dayList[dayList.length - 1]!, {
      provider,
      delayMs: 0,
    });

    // The first day was already ingested above, so it is skipped.
    expect(results.length).toBeLessThan(dayList.length);
    const bars = await prisma.dailyBar.count();
    expect(bars).toBe(dayList.length * SYMBOLS.length);
  });

  it('reports coverage with no unexplained gaps', async () => {
    const report = await coverage();
    expect(report.firstDay).toBe(dayList[0]);
    expect(report.lastDay).toBe(dayList[dayList.length - 1]);
    expect(report.tradingDaysStored).toBe(dayList.length);
    expect(report.securities).toBe(SYMBOLS.length);
    // 2024-01-01 was recorded as NO_FILE above, so it is explained rather than
    // counted as a gap. That distinction is the point of the report.
    expect(report.missingDays).toEqual([]);
  });
});

describe.skipIf(!hasDatabase)('corporate action detection on ingest', () => {
  it('records a detected dividend without applying it', async () => {
    // A day whose LDCP is marked down against the previous stored close. Placed
    // after the end of the series rather than inside it, so ingesting it does
    // not replace a mid-series day and shorten the other symbol's history.
    const previous = dayList[dayList.length - 1]!;
    const exDate = nextWeekday(previous);

    const previousClose = await prisma.dailyBar.findFirstOrThrow({
      where: { date: new Date(`${previous}T00:00:00.000Z`), security: { symbol: 'AAAA' } },
      select: { close: true },
    });

    const markedDown = paisa(Number(previousClose.close) - 250);
    const bars = [
      {
        date: exDate,
        symbol: 'AAAA',
        sectorCode: '0807',
        companyName: 'AAAA Limited',
        segment: 'EQUITY' as const,
        open: markedDown,
        high: paisa(markedDown + 100),
        low: paisa(markedDown - 100),
        close: markedDown,
        volume: 500_000,
        ldcp: markedDown,
      },
    ];

    const result = await ingestTradingDay(exDate, {
      provider: {
        name: 'stub-exdate',
        fetchDailyBars: async (date: string) =>
          date === exDate
            ? {
                date,
                bars,
                summary: {
                  date,
                  bars,
                  skipped: [],
                  warnings: [],
                  segmentCounts: {
                    EQUITY: 1,
                    FUTURE: 0,
                    INDEX_FUTURE: 0,
                    DEBT: 0,
                    UNKNOWN: 0,
                  },
                },
                raw: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
              }
            : null,
        fetchSymbolMaster: async () => null,
      },
    });

    expect(result.actionsDetected).toBe(1);
    expect(result.actionDescriptions[0]).toContain('ex-dividend');

    const action = await prisma.corporateAction.findFirst({
      where: { security: { symbol: 'AAAA' } },
    });
    // Detected, never applied: the exchange's announcements remain
    // authoritative and a mis-applied action corrupts a cost basis silently.
    expect(action?.status).toBe('DETECTED');
    expect(action?.amountPerShare).toBe(250n);
    expect(action?.detectionNote).toContain('ex-dividend');
    expect(await prisma.corporateActionApplication.count()).toBe(0);
  });
});

describe.skipIf(!hasDatabase)('signals from stored prices', () => {
  it('finds the liquid symbols worth scoring', async () => {
    const symbols = await liquidSymbols(100_000);
    expect(symbols).toContain('AAAA');
    expect(symbols).toContain('BBBB');
  });

  it('computes and persists a signal with its whole factor table', async () => {
    const result = await computeSignalForSymbol('AAAA', 'SWING');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.computed.signalId).not.toBeNull();
    expect(result.computed.signal.factors.length).toBeGreaterThan(5);
    expect(result.computed.narrative).toContain('AAAA');

    const stored = await prisma.signal.findUniqueOrThrow({
      where: { id: result.computed.signalId! },
      include: { factors: true },
    });

    expect(stored.factors.length).toBe(result.computed.signal.factors.length);
    expect(stored.outcome).toBe('PENDING');
    expect(stored.priceAtSignal).not.toBeNull();
    expect(stored.narrative).not.toBeNull();

    /*
     * The served price is integer paisa, like every other amount in the API.
     *
     * This was divided by 100 on the way out, which handed clients a float in
     * rupees; the client that renders it divided again and showed a
     * four-hundred-rupee share as Rs 4.00. Nothing caught it, because "is it
     * null" is all the assertion above asked for.
     */
    const served = await getLatestSignal('AAAA', 'SWING');
    expect(served?.priceAtSignal).toBe(Number(stored.priceAtSignal));
    expect(Number.isInteger(served?.priceAtSignal)).toBe(true);
    for (const factor of stored.factors) {
      expect(factor.reason.length).toBeGreaterThan(20);
      expect(factor.display.length).toBeGreaterThan(0);
    }
  });

  it('reads a steady climb as bullish', async () => {
    const result = await computeSignalForSymbol('AAAA', 'SWING');
    if (!result.ok) return;
    expect(result.computed.signal.score).toBeGreaterThan(0);
    expect(['BUY', 'STRONG_BUY']).toContain(result.computed.signal.action);
  });

  /**
   * A recomputation replaces the factor rows wholesale. A run that dropped a
   * factor would otherwise leave a stale row, and the stored table would no
   * longer add up to the score beside it.
   */
  it('replaces the factor rows on recomputation rather than accumulating them', async () => {
    const first = await computeSignalForSymbol('AAAA', 'SWING');
    if (!first.ok) return;
    const countAfterFirst = await prisma.signalFactor.count({
      where: { signalId: first.computed.signalId! },
    });

    const second = await computeSignalForSymbol('AAAA', 'SWING');
    if (!second.ok) return;
    expect(second.computed.signalId).toBe(first.computed.signalId);

    const countAfterSecond = await prisma.signalFactor.count({
      where: { signalId: first.computed.signalId! },
    });
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('refuses a symbol with too little history, and persists nothing', async () => {
    await prisma.security.create({ data: { symbol: 'THIN', name: 'Thin Co' } });
    const result = await computeSignalForSymbol('THIN', 'SWING');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('INSUFFICIENT_HISTORY');
    expect(await prisma.signal.count({ where: { security: { symbol: 'THIN' } } })).toBe(0);
  });

  it('settles nothing until a horizon has elapsed', async () => {
    const summary = await settleDueSignals();
    // The signals were computed as of the last stored bar, so no later prices
    // exist to judge them against.
    expect(summary.settled).toBe(0);
  });

  it('reports no accuracy until predictions have been settled', async () => {
    const reports = await accuracyReport();
    expect(reports.every((report) => report.settled === 0)).toBe(true);
  });
});

describe.skipIf(!hasDatabase)('signal endpoints', () => {
  let token: string;

  beforeAll(async () => {
    // Registering is no longer enough to use the app: the account has to verify
    // its email and be approved. signUpActive walks both gates.
    const session = await signUpActive(app!, 'signals@example.com');
    token = session.accessToken;
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('requires authentication', async () => {
    await request(app!).get('/api/securities/AAAA/signal').expect(401);
    await request(app!).get('/api/market/coverage').expect(401);
    await request(app!).get('/api/signals/stats/accuracy').expect(401);
  });

  it('serves a signal with its factor breakdown and group totals', async () => {
    const res = await request(app!)
      .get('/api/securities/AAAA/signal?horizon=SWING')
      .set(auth())
      .expect(200);

    expect(res.body.signal).not.toBeNull();
    expect(res.body.signal.symbol).toBe('AAAA');
    expect(res.body.signal.factors.length).toBeGreaterThan(5);
    expect(res.body.signal.byCategory.length).toBeGreaterThan(2);
    expect(res.body.signal.narrative).toContain('AAAA');

    // The group totals must still reconcile to the score after a round trip
    // through the database's integer encoding.
    const summed = res.body.signal.byCategory.reduce(
      (total: number, group: { contribution: number }) => total + group.contribution,
      0,
    );
    expect(summed).toBeCloseTo(res.body.signal.score, 1);
  });

  it('gives every factor a reason the client can show', async () => {
    const res = await request(app!).get('/api/securities/AAAA/signal').set(auth()).expect(200);
    for (const factor of res.body.signal.factors) {
      expect(typeof factor.reason).toBe('string');
      expect(factor.reason.length).toBeGreaterThan(20);
      expect(factor.key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('orders factors by what decided the call', async () => {
    const res = await request(app!).get('/api/securities/AAAA/signal').set(auth()).expect(200);
    const magnitudes = res.body.signal.factors.map((factor: { contribution: number }) =>
      Math.abs(factor.contribution),
    );
    expect(magnitudes).toEqual([...magnitudes].sort((a: number, b: number) => b - a));
  });

  it('recomputes on demand', async () => {
    const res = await request(app!)
      .post('/api/securities/AAAA/signal/refresh?horizon=LONG_TERM')
      .set(auth())
      .expect(200);
    expect(res.body.signal.horizon).toBe('LONG_TERM');
  });

  /**
   * A refusal is a legitimate answer to the question asked, not a failure, so
   * it comes back as 200 with a reason for the client to display.
   */
  it('returns a refusal as a reason rather than an error', async () => {
    const res = await request(app!).get('/api/securities/THIN/signal').set(auth()).expect(200);
    expect(res.body.signal).toBeNull();
    expect(res.body.refusal.code).toBe('INSUFFICIENT_HISTORY');
    // THIN has no bars at all, so the reason is the no-history one rather than
    // the too-few-sessions one. Both say what is missing.
    expect(res.body.refusal.reason).toMatch(/history/i);
  });

  it('404s an unknown symbol', async () => {
    await request(app!).get('/api/securities/NOSUCH/signal').set(auth()).expect(404);
  });

  it('serves the coverage report', async () => {
    const res = await request(app!).get('/api/market/coverage').set(auth()).expect(200);
    // The series, plus the ex-date day added by the corporate-action test.
    expect(res.body.coverage.tradingDaysStored).toBe(dayList.length + 1);
    expect(res.body.coverage.missingDays).toEqual([]);
  });

  it('serves the accuracy report with an explanatory note', async () => {
    const res = await request(app!).get('/api/signals/stats/accuracy').set(auth()).expect(200);
    expect(Array.isArray(res.body.accuracy)).toBe(true);
    expect(res.body.note).toContain('settled');
  });

  it('serves signals for a portfolio holding', async () => {
    const portfolios = await request(app!).get('/api/portfolios').set(auth()).expect(200);
    const portfolioId = portfolios.body.portfolios[0].id;

    await request(app!)
      .post(`/api/portfolios/${portfolioId}/trades`)
      .set(auth())
      .send({
        symbol: 'AAAA',
        side: 'BUY',
        tradedOn: '2026-06-01',
        quantity: 100,
        unitPrice: '150.00',
      })
      .expect(201);

    const res = await request(app!)
      .get(`/api/portfolios/${portfolioId}/signals?horizon=SWING`)
      .set(auth())
      .expect(200);

    expect(res.body.signals).toHaveLength(1);
    expect(res.body.signals[0].symbol).toBe('AAAA');
    expect(res.body.signals[0].signal).not.toBeNull();
  });

  it('hides another user portfolio signals', async () => {
    const other = await signUpActive(app!, 'other-signals@example.com');

    const portfolios = await request(app!).get('/api/portfolios').set(auth()).expect(200);
    const portfolioId = portfolios.body.portfolios[0].id;

    await request(app!)
      .get(`/api/portfolios/${portfolioId}/signals`)
      .set(authFor(other))
      .expect(404);
  });
});
