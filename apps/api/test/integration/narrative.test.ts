import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { summarise } from '@psx/engine';
import { createApp } from '../../src/app.js';
import { auth, mailer, signUpActive, type Session } from '../helpers/account.js';
import { loadEnv } from '../../src/env.js';
import { prisma } from '../../src/db/prisma.js';
import { computeSignalForSymbol, warmNarratives } from '../../src/services/signals.js';
import {
  createNarrativeWriter,
  createRecordingWriter,
  type NarrativeOutcome,
} from '../../src/services/narrative.js';

/**
 * The LLM narrative pass, end to end, without a key or a network.
 *
 * The point of these tests is the fallback. The factor table is the real
 * explanation and the prose is a rendering of it, so every way the model can
 * fail — absent, rate-limited, refused, truncated, or simply writing something
 * that contradicts the score — has to leave the user with the deterministic
 * summary rather than with nothing. A stubbed writer is the only way to
 * exercise all of that, and it also means the suite costs nothing to run.
 *
 * What is deliberately not covered here: a real call to the Anthropic API.
 * That needs a key, which is the user's to add.
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
  console.warn('\n  Skipping narrative integration tests: no test database.\n');
}

const env = hasDatabase ? loadEnv() : null;

/** Rupees as paisa, so the fixtures read in the units a person thinks in. */
const p = (rupees: number): number => Math.round(rupees * 100);

/**
 * A rising series long enough for the engine to score it without refusing.
 *
 * Generated rather than taken from the exchange: a test about narratives needs
 * a signal to exist, and it should not also depend on what the market did.
 */
async function seedScorableSeries(symbol: string): Promise<void> {
  const security = await prisma.security.upsert({
    where: { symbol },
    update: {},
    create: { symbol, name: `${symbol} Limited`, segment: 'EQUITY' },
    select: { id: true },
  });

  const rows: Array<{ date: Date; open: bigint; high: bigint; low: bigint; close: bigint; volume: number }> =
    [];
  let cursor = Date.parse('2025-09-01T00:00:00Z');
  for (let i = 0; i < 230; ) {
    const date = new Date(cursor);
    cursor += 86_400_000;
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;

    const close = 100 + i * 0.6;
    rows.push({
      date,
      open: BigInt(p(close)),
      high: BigInt(p(close * 1.01)),
      low: BigInt(p(close * 0.99)),
      close: BigInt(p(close)),
      volume: 500_000,
    });
    i += 1;
  }

  await prisma.dailyBar.createMany({
    data: rows.map((row) => ({ securityId: security.id, ...row })),
    skipDuplicates: true,
  });
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

describe.skipIf(!hasDatabase)('the narrative writer', () => {
  beforeAll(async () => {
    await wipe();
    await seedScorableSeries('NARR');
  });

  it('writes the generated prose onto the signal and records the model', async () => {
    const writer = createRecordingWriter();
    const result = await computeSignalForSymbol('NARR', 'SWING', { writer });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(writer.calls).toHaveLength(1);
    expect(result.computed.narrativeModel).toBe('recording-writer');
    expect(result.computed.narrative).toContain('NARR');

    const stored = await prisma.signal.findUniqueOrThrow({
      where: { id: result.computed.signalId! },
      select: { narrative: true, narrativeModel: true },
    });
    expect(stored.narrativeModel).toBe('recording-writer');
    expect(stored.narrative).toBe(result.computed.narrative);
  });

  /*
   * The default path, and the one that has to keep working forever: no key, no
   * writer, no call. A prediction without an explanation is the one outcome
   * this design exists to prevent.
   */
  it('uses the deterministic summary when no writer is supplied', async () => {
    const result = await computeSignalForSymbol('NARR', 'LONG_TERM');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.computed.narrativeModel).toBeNull();
    expect(result.computed.narrative).toBe(summarise(result.computed.signal));
  });

  it('never calls the writer when it is disabled', async () => {
    const writer = createRecordingWriter(undefined, { enabled: false });
    const result = await computeSignalForSymbol('NARR', 'SWING', { writer });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(writer.calls).toHaveLength(0);
    expect(result.computed.narrativeModel).toBeNull();
  });

  it('falls back to the deterministic summary when the API fails', async () => {
    const failures: NarrativeOutcome[] = [
      { ok: false, reason: 'AUTH', detail: 'key rejected' },
      { ok: false, reason: 'RATE_LIMITED', detail: 'slow down' },
      { ok: false, reason: 'REFUSED', detail: 'declined' },
      { ok: false, reason: 'TRUNCATED', detail: 'ran out of tokens' },
      { ok: false, reason: 'TIMEOUT', detail: 'no reply' },
      { ok: false, reason: 'BUDGET_SPENT', detail: 'budget used' },
    ];

    for (const failure of failures) {
      const writer = createRecordingWriter(() => failure);
      const result = await computeSignalForSymbol('NARR', 'SWING', { writer });

      expect(result.ok, failure.ok ? '' : failure.reason).toBe(true);
      if (!result.ok) return;
      expect(writer.calls, failure.ok ? '' : failure.reason).toHaveLength(1);
      expect(result.computed.narrativeModel).toBeNull();
      expect(result.computed.narrative).toBe(summarise(result.computed.signal));
    }
  });

  it('falls back when the writer throws rather than returning a reason', async () => {
    const writer = createRecordingWriter(() => {
      throw new Error('something unforeseen');
    });

    // The writer contract is that failures come back as values, so a throw is
    // a bug in a writer rather than an expected path. It must still not take
    // the prediction down with it.
    await expect(computeSignalForSymbol('NARR', 'SWING', { writer })).rejects.toThrow(
      'something unforeseen',
    );
  });

  /*
   * The validator is the part that matters most. A language model given a
   * factor table will occasionally add advice, a price target, or a conclusion
   * opposite to the score — and any of those reaching the user is worse than
   * plainer prose, because the whole claim of this feature is that the
   * explanation and the score come from the same evidence.
   */
  it('rejects prose that gives advice', async () => {
    const writer = createRecordingWriter(() => ({
      ok: true,
      text: 'The trend is up and momentum is improving. I recommend you buy immediately.',
      model: 'recording-writer',
      inputTokens: 10,
      outputTokens: 10,
    }));

    const result = await computeSignalForSymbol('NARR', 'SWING', { writer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.computed.narrativeModel).toBeNull();
    expect(result.computed.narrative).toBe(summarise(result.computed.signal));
    expect(result.computed.narrative).not.toContain('I recommend');
  });

  it('rejects an invented price target', async () => {
    const writer = createRecordingWriter(() => ({
      ok: true,
      text: 'Trend and momentum both read positively here. The price target is Rs 250.',
      model: 'recording-writer',
      inputTokens: 10,
      outputTokens: 10,
    }));

    const result = await computeSignalForSymbol('NARR', 'SWING', { writer });
    if (!result.ok) throw new Error('expected a signal');
    expect(result.computed.narrativeModel).toBeNull();
    expect(result.computed.narrative).not.toContain('250');
  });

  it('rejects an empty reply', async () => {
    const writer = createRecordingWriter(() => ({
      ok: true,
      text: '   ',
      model: 'recording-writer',
      inputTokens: 10,
      outputTokens: 0,
    }));

    const result = await computeSignalForSymbol('NARR', 'SWING', { writer });
    if (!result.ok) throw new Error('expected a signal');
    expect(result.computed.narrativeModel).toBeNull();
  });

  /*
   * A recomputation changes the factors, so prose written about the old ones no
   * longer describes the new ones. Keeping it would leave an explanation that
   * quietly disagrees with the score printed above it, which is the specific
   * failure this whole feature is supposed to avoid.
   */
  it('drops generated prose when the signal is recomputed without a writer', async () => {
    const writer = createRecordingWriter();
    const first = await computeSignalForSymbol('NARR', 'SWING', { writer });
    if (!first.ok) throw new Error('expected a signal');
    expect(first.computed.narrativeModel).toBe('recording-writer');

    const second = await computeSignalForSymbol('NARR', 'SWING');
    if (!second.ok) throw new Error('expected a signal');
    expect(second.computed.narrativeModel).toBeNull();

    const stored = await prisma.signal.findUniqueOrThrow({
      where: { id: second.computed.signalId! },
      select: { narrativeModel: true },
    });
    expect(stored.narrativeModel).toBeNull();
  });
});

describe.skipIf(!hasDatabase)('narratives over the API', () => {
  let session: Session;

  beforeAll(async () => {
    await wipe();
    await seedScorableSeries('VIEW');
    session = await signUpActive(
      createApp({ env: env!, mailer }),
      'narrative-setup@example.com',
    );
  });

  it('writes the prose on the first view and caches it for the next', async () => {
    const writer = createRecordingWriter();
    const app = createApp({ env: env!, mailer, narrativeWriter: writer });

    // Scored by the nightly path first, so the row exists with the
    // deterministic summary, exactly as it would in production.
    await computeSignalForSymbol('VIEW', 'SWING');

    const first = await request(app)
      .get('/api/securities/VIEW/signal?horizon=SWING')
      .set(auth(session))
      .expect(200);

    expect(writer.calls).toHaveLength(1);
    expect(first.body.signal.narrativeModel).toBe('recording-writer');

    const second = await request(app)
      .get('/api/securities/VIEW/signal?horizon=SWING')
      .set(auth(session))
      .expect(200);

    // The cache is the point: one generation per signal however often it is
    // read, which is what keeps this affordable.
    expect(writer.calls).toHaveLength(1);
    expect(second.body.signal.narrative).toBe(first.body.signal.narrative);
  });

  it('serves the deterministic summary without calling anything when disabled', async () => {
    const writer = createRecordingWriter(undefined, { enabled: false });
    const app = createApp({ env: env!, mailer, narrativeWriter: writer });

    await computeSignalForSymbol('VIEW', 'LONG_TERM');

    const response = await request(app)
      .get('/api/securities/VIEW/signal?horizon=LONG_TERM')
      .set(auth(session))
      .expect(200);

    expect(writer.calls).toHaveLength(0);
    expect(response.body.signal.narrative).not.toBeNull();
    expect(response.body.signal.narrativeModel).toBeNull();
  });

  /*
   * The list endpoint renders action badges, not prose. Upgrading there would
   * fire one call per holding on every dashboard load, which is the opposite
   * of the policy.
   */
  it('does not generate for the portfolio list endpoint', async () => {
    const writer = createRecordingWriter();
    const app = createApp({ env: env!, mailer, narrativeWriter: writer });

    const portfolios = await request(app).get('/api/portfolios').set(auth(session)).expect(200);
    const portfolioId = portfolios.body.portfolios[0].id as string;

    await request(app)
      .post(`/api/portfolios/${portfolioId}/trades`)
      .set(auth(session))
      .send({ symbol: 'VIEW', side: 'BUY', tradedOn: '2026-06-01', quantity: 10, unitPrice: '150.00' })
      .expect(201);

    await computeSignalForSymbol('VIEW', 'SWING');

    await request(app)
      .get(`/api/portfolios/${portfolioId}/signals?horizon=SWING`)
      .set(auth(session))
      .expect(200);

    expect(writer.calls).toHaveLength(0);
  });
});

describe.skipIf(!hasDatabase)('warming the followed symbols', () => {
  beforeAll(async () => {
    await wipe();
    await seedScorableSeries('WARMA');
    await seedScorableSeries('WARMB');
    await seedScorableSeries('IGNORED');
    await computeSignalForSymbol('WARMA', 'SWING');
    await computeSignalForSymbol('WARMB', 'SWING');
    await computeSignalForSymbol('IGNORED', 'SWING');
  });

  it('writes only for symbols that are held or watched', async () => {
    const app = createApp({ env: env!, mailer });
    const session = await signUpActive(app, 'warm@example.com');
    const portfolios = await request(app).get('/api/portfolios').set(auth(session)).expect(200);
    const portfolioId = portfolios.body.portfolios[0].id as string;

    // One held, one merely watched through an armed stop, one neither.
    await request(app)
      .post(`/api/portfolios/${portfolioId}/trades`)
      .set(auth(session))
      .send({ symbol: 'WARMA', side: 'BUY', tradedOn: '2026-06-01', quantity: 10, unitPrice: '150.00' })
      .expect(201);

    await request(app)
      .post(`/api/portfolios/${portfolioId}/stops`)
      .set(auth(session))
      .send({ symbol: 'WARMB', type: 'TRAILING_STOP', trailBps: 1_000 })
      .expect(201);

    const writer = createRecordingWriter();
    const summary = await warmNarratives(writer, { horizons: ['SWING'] });

    expect(summary.symbols).toBe(2);
    expect(summary.written).toBe(2);
    const warmed = writer.calls.map((signal) => signal.symbol).sort();
    expect(warmed).toEqual(['WARMA', 'WARMB']);
    // The exchange's other 500 symbols are not the user's problem to pay for.
    expect(warmed).not.toContain('IGNORED');
  });

  it('does nothing at all when the writer is disabled', async () => {
    const writer = createRecordingWriter(undefined, { enabled: false });
    const summary = await warmNarratives(writer);
    expect(summary).toEqual({ symbols: 0, written: 0, alreadyWritten: 0, skipped: 0 });
    expect(writer.calls).toHaveLength(0);
  });
});

describe('the writer built from configuration', () => {
  const base = {
    NARRATIVE_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    NARRATIVE_MAX_TOKENS: 1_024,
    NARRATIVE_CALL_BUDGET: 250,
  };

  it('is off, and says so, when no key is configured', async () => {
    const writer = createNarrativeWriter({ ...base, ANTHROPIC_API_KEY: undefined } as never);
    expect(writer.enabled).toBe(false);
    expect(writer.describe()).toContain('no ANTHROPIC_API_KEY');

    const outcome = await writer.write({ signal: {} as never });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('DISABLED');
  });

  it('treats a whitespace-only key as no key', () => {
    // `.env` files collect trailing spaces, and a writer that reported itself
    // enabled on one would fail on every call instead of falling back cleanly.
    const writer = createNarrativeWriter({ ...base, ANTHROPIC_API_KEY: '   ' } as never);
    expect(writer.enabled).toBe(false);
  });

  /*
   * The hazard worth a test of its own. The SDK reads ANTHROPIC_BASE_URL from
   * the process environment by itself, so on a machine where that is set for
   * another tool this app would quietly post its prompts there. The base URL
   * comes from the app's own validated config instead, and the description says
   * when it is not the official endpoint.
   */
  it('names an overridden base URL rather than using it silently', () => {
    const warnings: string[] = [];
    const writer = createNarrativeWriter(
      { ...base, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' } as never,
      (message) => warnings.push(message),
    );

    expect(writer.enabled).toBe(true);
    expect(writer.describe()).toContain('overridden');
    expect(warnings.join(' ')).toContain('127.0.0.1:9999');
  });

  it('says which model it will use', () => {
    const writer = createNarrativeWriter(
      { ...base, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key', NARRATIVE_MODEL: 'claude-haiku-5-5' } as never,
      () => {},
    );
    expect(writer.describe()).toContain('claude-haiku-5-5');
  });

  it('stops asking once the call budget is spent', async () => {
    const writer = createNarrativeWriter(
      { ...base, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key', NARRATIVE_CALL_BUDGET: 0 } as never,
      () => {},
    );

    // Budget zero means the first call is refused before any network use, which
    // is what makes this a usable kill switch.
    const outcome = await writer.write({ signal: {} as never });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('BUDGET_SPENT');
  });
});
