import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { auth, firstPortfolioId, mailer, signUpActive, type Session } from '../helpers/account.js';
import { loadEnv } from '../../src/env.js';
import { prisma } from '../../src/db/prisma.js';
import { evaluateArmedRules } from '../../src/services/stops.js';

/**
 * Stop rules end to end against a real database.
 *
 * The evaluator itself is unit-tested in `@psx/engine` without any I/O; what
 * is exercised here is everything the database adds — arming from the stored
 * price, replaying only the bars a rule has not seen, writing the event and
 * disarming the rule in one transaction, and the catch-up behaviour that makes
 * the nightly job safe to miss a day.
 *
 * Prices are written directly rather than ingested. The ingest has its own
 * suite; here a precisely shaped series is the point, because the interesting
 * cases are a gap through a stop and a bar that both lifts a trail and breaches
 * it.
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
  console.warn('\n  Skipping stop integration tests: no test database.\n');
}

const env = hasDatabase ? loadEnv() : null;
const app = hasDatabase && env !== null ? createApp({ env, mailer }) : null;

/** A security with a price series, written straight in. */
async function seedSeries(
  symbol: string,
  bars: Array<{ date: string; high: number; low: number; close: number }>,
): Promise<string> {
  const security = await prisma.security.upsert({
    where: { symbol },
    update: {},
    create: { symbol, name: `${symbol} Limited`, segment: 'EQUITY' },
    select: { id: true },
  });

  for (const bar of bars) {
    await prisma.dailyBar.upsert({
      where: { securityId_date: { securityId: security.id, date: new Date(`${bar.date}T00:00:00Z`) } },
      update: {
        high: BigInt(bar.high),
        low: BigInt(bar.low),
        close: BigInt(bar.close),
        open: BigInt(bar.close),
      },
      create: {
        securityId: security.id,
        date: new Date(`${bar.date}T00:00:00Z`),
        open: BigInt(bar.close),
        high: BigInt(bar.high),
        low: BigInt(bar.low),
        close: BigInt(bar.close),
        volume: 100_000,
      },
    });
  }

  return security.id;
}

/** Rupees as paisa, so the fixtures read in the units a person thinks in. */
const p = (rupees: number): number => Math.round(rupees * 100);

/**
 * Clears the database between suites.
 *
 * Every table that references a security has to go before the securities do,
 * and three of those relations are `onDelete: Restrict` rather than Cascade —
 * deliberately, because a security silently taking tax lots with it would
 * destroy cost bases. So the order here is not cosmetic: miss one and the
 * delete fails on a foreign key, which is how this was found. It only showed
 * up when the suite ran after one that records trades, because tax lots are
 * the table a stop test never creates itself.
 */
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

describe.skipIf(!hasDatabase)('stop rules', () => {
  let session: Session;
  let portfolioId: string;

  beforeAll(async () => {
    await wipe();
    session = await signUpActive(app!, 'stops@example.com');
    portfolioId = await firstPortfolioId(app!, session);

    // One flat series to arm against, and one that rises then falls.
    await seedSeries('FLAT', [
      { date: '2026-10-01', high: p(101), low: p(99), close: p(100) },
    ]);
    await seedSeries('RUNUP', [
      { date: '2026-10-01', high: p(101), low: p(99), close: p(100) },
    ]);
  });

  const url = () => `/api/portfolios/${portfolioId}/stops`;

  it('requires authentication', async () => {
    await request(app!).get(url()).expect(401);
    await request(app!).post(url()).send({ symbol: 'FLAT', type: 'STOP_LOSS' }).expect(401);
  });

  it('arms a stop-loss below the current price', async () => {
    const response = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'STOP_LOSS', thresholdPrice: '95.00', quantity: 100 })
      .expect(201);

    const rule = response.body.rule;
    expect(rule.status).toBe('ARMED');
    expect(rule.thresholdPrice).toBe(p(95));
    expect(rule.marketPrice).toBe(p(100));
    // 100.00 is 5.26% above a 95.00 stop, and the UI shows that as headroom.
    expect(rule.headroomBps).toBe(526);
    // 100 shares at the stop is what the rule is protecting.
    expect(rule.valueAtStop).toBe(p(9_500));
  });

  /*
   * Headroom is "how far until it fires", not "how far above the level", so a
   * stop and a target are signed the same way. Otherwise every consumer has to
   * re-derive which direction means danger, and the first one to forget shows
   * a target in red for being below its level — which is the normal state of
   * every target ever set.
   */
  it('reports headroom as distance-until-firing for a target too', async () => {
    const response = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'TAKE_PROFIT', thresholdPrice: '110.00' })
      .expect(201);

    // Market 100.00, target 110.00: 9.09% of the target still to rise, and
    // positive, exactly as a stop 9% below the market would be.
    expect(response.body.rule.headroomBps).toBe(909);
  });

  /*
   * The transposed-number case. A stop-loss set above the market fires on the
   * very next bar, which is nearly always a typo rather than an intention, and
   * an alert system that cries wolf on day one gets ignored.
   */
  it('refuses a stop-loss at or above the last close', async () => {
    const response = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'STOP_LOSS', thresholdPrice: '105.00' })
      .expect(409);

    expect(response.body.error.message).toContain('would fire immediately');
  });

  it('refuses a take-profit at or below the last close', async () => {
    await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'TAKE_PROFIT', thresholdPrice: '95.00' })
      .expect(409);
  });

  it('arms a trailing stop from the stored close, not from a level typed in', async () => {
    const response = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'RUNUP', type: 'TRAILING_STOP', trailBps: 1_000 })
      .expect(201);

    const rule = response.body.rule;
    expect(rule.highWaterMark).toBe(p(100));
    expect(rule.effectiveStop).toBe(p(90));
    expect(rule.thresholdPrice).toBeNull();
  });

  it('refuses a trailing stop given both a fixed and a proportional trail', async () => {
    await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'RUNUP', type: 'TRAILING_STOP', trailBps: 1_000, trailAmount: '5.00' })
      .expect(400);
  });

  it('refuses a trail outside the band where a stop means anything', async () => {
    // 0.5% sits inside the daily noise of most mid caps.
    await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'RUNUP', type: 'TRAILING_STOP', trailBps: 50 })
      .expect(400);
    // 80% is not protecting anything.
    await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'RUNUP', type: 'TRAILING_STOP', trailBps: 8_000 })
      .expect(400);
  });

  /*
   * The types in the enum without an evaluator must be refused at the door.
   * Accepting one would create a rule that sits in the list looking armed and
   * never fires, which is worse than not offering it.
   */
  it('refuses a rule type the engine cannot evaluate', async () => {
    await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'PRICE_ALERT', thresholdPrice: '95.00' })
      .expect(400);
  });

  it('refuses a trailing stop on a symbol with no stored price', async () => {
    const response = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'NOPRICE', type: 'TRAILING_STOP', trailBps: 1_000 })
      .expect(400);

    expect(response.body.error.message).toContain('nothing to trail from');
  });

  it('hides another user\'s rules behind a 404', async () => {
    const other = await signUpActive(app!, 'other-stops@example.com');
    const mine = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'STOP_LOSS', thresholdPrice: '80.00' })
      .expect(201);

    // Not a 403: saying "forbidden" would confirm the rule exists.
    await request(app!).get(`/api/stops/${mine.body.rule.id}`).set(auth(other)).expect(404);
    await request(app!)
      .post(`/api/stops/${mine.body.rule.id}/cancel`)
      .set(auth(other))
      .expect(404);
    await request(app!).get(url()).set(auth(other)).expect(404);
  });

  it('lists rules with their counts by status', async () => {
    const response = await request(app!).get(url()).set(auth(session)).expect(200);
    expect(response.body.rules.length).toBeGreaterThan(0);
    expect(response.body.counts.ARMED).toBeGreaterThan(0);
  });

  it('cancels rather than deletes, so the history survives', async () => {
    const created = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'STOP_LOSS', thresholdPrice: '70.00' })
      .expect(201);

    const cancelled = await request(app!)
      .post(`/api/stops/${created.body.rule.id}/cancel`)
      .set(auth(session))
      .expect(200);
    expect(cancelled.body.rule.status).toBe('CANCELLED');

    // Still readable afterwards.
    const read = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);
    expect(read.body.rule.status).toBe('CANCELLED');

    // And cannot be cancelled twice.
    await request(app!)
      .post(`/api/stops/${created.body.rule.id}/cancel`)
      .set(auth(session))
      .expect(409);
  });

  it('refuses to adjust a rule that is no longer armed', async () => {
    const created = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'FLAT', type: 'STOP_LOSS', thresholdPrice: '60.00' })
      .expect(201);
    await request(app!)
      .post(`/api/stops/${created.body.rule.id}/cancel`)
      .set(auth(session))
      .expect(200);

    await request(app!)
      .patch(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .send({ thresholdPrice: '55.00' })
      .expect(409);
  });

  it('recomputes a widened trail from the mark the rule has already reached', async () => {
    const created = await request(app!)
      .post(url())
      .set(auth(session))
      .send({ symbol: 'RUNUP', type: 'TRAILING_STOP', trailBps: 1_000 })
      .expect(201);

    // Pretend the stock has run to 200.00 and the mark followed it.
    await prisma.alertRule.update({
      where: { id: created.body.rule.id },
      data: { highWaterMark: BigInt(p(200)), effectiveStop: BigInt(p(180)) },
    });

    const widened = await request(app!)
      .patch(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .send({ trailBps: 2_000 })
      .expect(200);

    // 20% below the 200.00 mark, not 20% below the price it was armed at: a
    // trail loosened after a run must not give back the protection that run
    // earned.
    expect(widened.body.rule.effectiveStop).toBe(p(160));
    expect(widened.body.rule.highWaterMark).toBe(p(200));
  });
});

describe.skipIf(!hasDatabase)('evaluation', () => {
  let session: Session;
  let portfolioId: string;

  beforeAll(async () => {
    await wipe();
    session = await signUpActive(app!, 'evaluate@example.com');
    portfolioId = await firstPortfolioId(app!, session);
  });

  it('triggers a stop-loss on a later bar and disarms the rule', async () => {
    await seedSeries('FALLS', [{ date: '2026-10-01', high: p(101), low: p(99), close: p(100) }]);

    const created = await request(app!)
      .post(`/api/portfolios/${portfolioId}/stops`)
      .set(auth(session))
      .send({ symbol: 'FALLS', type: 'STOP_LOSS', thresholdPrice: '95.00' })
      .expect(201);

    // Nothing to evaluate yet: the rule was armed at the latest stored bar.
    const quiet = await evaluateArmedRules({ portfolioId });
    expect(quiet.triggered).toBe(0);

    await seedSeries('FALLS', [{ date: '2026-10-02', high: p(97), low: p(90), close: p(92) }]);

    const summary = await evaluateArmedRules({ portfolioId });
    expect(summary.triggered).toBe(1);

    const rule = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);

    expect(rule.body.rule.status).toBe('TRIGGERED');
    expect(rule.body.rule.events).toHaveLength(1);
    const event = rule.body.rule.events[0];
    expect(event.triggeredOn).toBe('2026-10-02');
    expect(event.triggerPrice).toBe(p(92));
    expect(event.stopAtTrigger).toBe(p(95));
    expect(event.message).toContain('92.00');
  });

  it('is idempotent: a second run on the same bars reports nothing', async () => {
    const again = await evaluateArmedRules({ portfolioId });
    expect(again.triggered).toBe(0);
  });

  /*
   * The catch-up case, and the reason evaluation replays rather than looking at
   * the latest bar. If the job does not run for three days, a stop breached on
   * the first of them must still be reported — and reported at that day's
   * price, not at today's.
   */
  it('catches up over days the job did not run, reporting the day it broke', async () => {
    await seedSeries('GAPDAYS', [{ date: '2026-10-01', high: p(101), low: p(99), close: p(100) }]);

    const created = await request(app!)
      .post(`/api/portfolios/${portfolioId}/stops`)
      .set(auth(session))
      .send({ symbol: 'GAPDAYS', type: 'STOP_LOSS', thresholdPrice: '95.00' })
      .expect(201);

    // Three days arrive at once: broke on the 2nd, then recovered.
    await seedSeries('GAPDAYS', [
      { date: '2026-10-02', high: p(96), low: p(90), close: p(91) },
      { date: '2026-10-05', high: p(99), low: p(94), close: p(98) },
      { date: '2026-10-06', high: p(106), low: p(99), close: p(105) },
    ]);

    const summary = await evaluateArmedRules({ portfolioId });
    expect(summary.triggered).toBe(1);

    const rule = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);

    const event = rule.body.rule.events[0];
    // The 2nd, not the 6th — and at 91.00, not the 105.00 it recovered to.
    expect(event.triggeredOn).toBe('2026-10-02');
    expect(event.triggerPrice).toBe(p(91));
  });

  it('trails a stop up through a rise and fires on the fall back', async () => {
    await seedSeries('CLIMB', [{ date: '2026-10-01', high: p(101), low: p(99), close: p(100) }]);

    const created = await request(app!)
      .post(`/api/portfolios/${portfolioId}/stops`)
      .set(auth(session))
      .send({ symbol: 'CLIMB', type: 'TRAILING_STOP', trailBps: 1_000 })
      .expect(201);
    expect(created.body.rule.effectiveStop).toBe(p(90));

    await seedSeries('CLIMB', [
      { date: '2026-10-02', high: p(126), low: p(119), close: p(125) },
      { date: '2026-10-05', high: p(152), low: p(144), close: p(150) },
    ]);

    const rising = await evaluateArmedRules({ portfolioId });
    expect(rising.moved).toBe(1);
    expect(rising.triggered).toBe(0);

    const trailed = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);
    // Followed the closes to 150.00, so the stop is 10% below that.
    expect(trailed.body.rule.highWaterMark).toBe(p(150));
    expect(trailed.body.rule.effectiveStop).toBe(p(135));

    await seedSeries('CLIMB', [
      { date: '2026-10-06', high: p(140), low: p(128), close: p(130) },
    ]);

    const fell = await evaluateArmedRules({ portfolioId });
    expect(fell.triggered).toBe(1);

    const fired = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);

    const event = fired.body.rule.events[0];
    expect(event.stopAtTrigger).toBe(p(135));
    expect(event.highWaterMark).toBe(p(150));
    // The explanation names the high it trailed from, which is the whole point
    // of a trailing stop over a fixed one.
    expect(event.message).toContain('150.00');
  });

  /*
   * A stop is most useful and most easily misrepresented on a gap. If the whole
   * day traded below the level, the level was never on offer — saying so is the
   * difference between an alert and an implied fill at a price that did not
   * exist.
   */
  it('says when the price gapped through the level rather than implying a fill there', async () => {
    await seedSeries('GAPPER', [{ date: '2026-10-01', high: p(101), low: p(99), close: p(100) }]);

    const created = await request(app!)
      .post(`/api/portfolios/${portfolioId}/stops`)
      .set(auth(session))
      .send({ symbol: 'GAPPER', type: 'STOP_LOSS', thresholdPrice: '95.00' })
      .expect(201);

    // Opens and stays well below the stop: an overnight gap.
    await seedSeries('GAPPER', [
      { date: '2026-10-02', high: p(88), low: p(84), close: p(85) },
    ]);

    await evaluateArmedRules({ portfolioId });

    const rule = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);

    expect(rule.body.rule.events[0].message).toContain('gapped through');
  });

  it('expires a rule on the day it expired, not on the day the job runs', async () => {
    await seedSeries('EXPIRY', [{ date: '2026-10-01', high: p(101), low: p(99), close: p(100) }]);

    const created = await request(app!)
      .post(`/api/portfolios/${portfolioId}/stops`)
      .set(auth(session))
      .send({
        symbol: 'EXPIRY',
        type: 'STOP_LOSS',
        thresholdPrice: '95.00',
        expiresOn: '2026-10-03',
      })
      .expect(201);

    await seedSeries('EXPIRY', [
      { date: '2026-10-05', high: p(96), low: p(90), close: p(91) },
    ]);

    const summary = await evaluateArmedRules({ portfolioId });
    expect(summary.expired).toBeGreaterThan(0);

    const rule = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);
    // Expired, and no event: a rule past its date does not fire.
    expect(rule.body.rule.status).toBe('EXPIRED');
    expect(rule.body.rule.events).toHaveLength(0);
  });

  it('acknowledges a firing so the UI can stop drawing attention to it', async () => {
    await seedSeries('ACKME', [{ date: '2026-10-01', high: p(101), low: p(99), close: p(100) }]);
    const created = await request(app!)
      .post(`/api/portfolios/${portfolioId}/stops`)
      .set(auth(session))
      .send({ symbol: 'ACKME', type: 'STOP_LOSS', thresholdPrice: '95.00' })
      .expect(201);
    await seedSeries('ACKME', [{ date: '2026-10-02', high: p(96), low: p(90), close: p(92) }]);
    await evaluateArmedRules({ portfolioId });

    const withEvent = await request(app!)
      .get(`/api/stops/${created.body.rule.id}`)
      .set(auth(session))
      .expect(200);
    const eventId = withEvent.body.rule.events[0].id;

    const acknowledged = await request(app!)
      .post(`/api/stop-events/${eventId}/acknowledge`)
      .set(auth(session))
      .expect(200);
    expect(acknowledged.body.event.acknowledgedAt).not.toBeNull();

    const other = await signUpActive(app!, 'ack-other@example.com');
    await request(app!)
      .post(`/api/stop-events/${eventId}/acknowledge`)
      .set(auth(other))
      .expect(404);
  });

  it('exposes the evaluation endpoint so a new rule can be checked at once', async () => {
    const response = await request(app!)
      .post(`/api/portfolios/${portfolioId}/stops/evaluate`)
      .set(auth(session))
      .expect(200);

    expect(response.body.summary).toHaveProperty('rulesChecked');
  });
});

describe.skipIf(!hasDatabase)('suggestions and backtests', () => {
  let session: Session;

  beforeAll(async () => {
    await wipe();
    session = await signUpActive(app!, 'suggest@example.com');

    /*
     * Sixty days that rise and then fall away, so a trail has something to
     * follow up and then something to fire on. The daily range is a steady 4%
     * of the price, which gives the ATR a value a test can reason about.
     */
    const bars: Array<{ date: string; high: number; low: number; close: number }> = [];
    let cursor = Date.parse('2026-07-01T00:00:00Z');
    for (let i = 0; i < 60; i += 1) {
      const date = new Date(cursor);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
        cursor += 86_400_000;
        i -= 1;
        continue;
      }
      // Up for forty sessions, then down for twenty.
      const close = i < 40 ? 100 + i * 2 : 180 - (i - 40) * 5;
      bars.push({
        date: date.toISOString().slice(0, 10),
        high: p(close * 1.02),
        low: p(close * 0.98),
        close: p(close),
      });
      cursor += 86_400_000;
    }
    await seedSeries('TREND', bars);
    // A series that only ever rises, for the case where no trail is hit.
    const rising: Array<{ date: string; high: number; low: number; close: number }> = [];
    let risingCursor = Date.parse('2026-07-01T00:00:00Z');
    for (let i = 0; i < 40; i += 1) {
      const date = new Date(risingCursor);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
        risingCursor += 86_400_000;
        i -= 1;
        continue;
      }
      const close = 100 + i * 2;
      rising.push({
        date: date.toISOString().slice(0, 10),
        high: p(close * 1.02),
        low: p(close * 0.98),
        close: p(close),
      });
      risingCursor += 86_400_000;
    }
    await seedSeries('RISEONLY', rising);
    await seedSeries('SHORTHIST', [
      { date: '2026-10-01', high: p(101), low: p(99), close: p(100) },
    ]);
  });

  it('suggests a trail scaled to the symbol own range, with its reasoning', async () => {
    const response = await request(app!)
      .get('/api/securities/TREND/stop-suggestion')
      .set(auth(session))
      .expect(200);

    const suggestion = response.body.suggestion;
    expect(suggestion.atr).toBeGreaterThan(0);
    expect(suggestion.trailBps).toBeGreaterThanOrEqual(100);
    expect(suggestion.trailBps).toBeLessThanOrEqual(5_000);
    expect(suggestion.suggestedStop).toBeLessThan(suggestion.marketPrice);
    // The reasoning names the measurement, so the number is a suggestion rather
    // than an oracle.
    expect(suggestion.reason).toContain('average day');
    expect(suggestion.reason).toContain('14 sessions');
  });

  it('declines to suggest from too little history instead of guessing', async () => {
    const response = await request(app!)
      .get('/api/securities/SHORTHIST/stop-suggestion')
      .set(auth(session))
      .expect(200);

    expect(response.body.suggestion.trailBps).toBeNull();
    expect(response.body.suggestion.reason).toContain('too few');
  });

  it('replays a trail over stored history and says what it would have done', async () => {
    const response = await request(app!)
      .get('/api/securities/TREND/stop-backtest?trailBps=1000')
      .set(auth(session))
      .expect(200);

    const backtest = response.body.backtest;
    expect(backtest.barsConsidered).toBeGreaterThan(30);
    // The series peaks at 180.00 and then falls 5.00 a day, so a 10% trail is
    // taken out on the way down.
    expect(backtest.triggeredOn).not.toBeNull();
    expect(backtest.highWaterMark).toBe(p(180));
    expect(backtest.verdict).toContain('took you out');
    // It fell much further than the trail, so the trail beat holding on.
    expect(backtest.versusHoldingBps).toBeGreaterThan(0);
    expect(backtest.verdict).toContain('protected you');
  });

  it('reports a trail that was never hit rather than inventing an exit', async () => {
    // RISEONLY never falls, so no trail can be hit. Asserting this against the
    // TREND series would be wrong: it drops 53% off its high, which takes out
    // even a 50% trail.
    const response = await request(app!)
      .get('/api/securities/RISEONLY/stop-backtest?trailBps=1000')
      .set(auth(session))
      .expect(200);

    expect(response.body.backtest.triggeredOn).toBeNull();
    expect(response.body.backtest.verdict).toContain('never hit');
  });

  it('refuses a backtest given a trail two ways or no way', async () => {
    await request(app!)
      .get('/api/securities/TREND/stop-backtest?trailBps=1000&trailAmount=5.00')
      .set(auth(session))
      .expect(400);
    await request(app!)
      .get('/api/securities/TREND/stop-backtest')
      .set(auth(session))
      .expect(400);
  });

  it('404s for a symbol it has never heard of', async () => {
    await request(app!)
      .get('/api/securities/NOSUCH/stop-suggestion')
      .set(auth(session))
      .expect(404);
  });
});
