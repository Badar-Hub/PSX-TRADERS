import {
  buildContext,
  chooseNarrative,
  scoreSignal,
  settleSignal,
  summarise,
  type Fundamentals,
  type ScoredSignal,
  type SignalRefusal,
} from '@psx/engine';
import { paisa, type Candle, type IsoDate, type SignalHorizon } from '@psx/shared';
import { notFound } from '../http/errors.js';
import { fromIsoDateColumn, toIsoDateColumn, toPaisa } from '../db/paisa.js';
import { prisma } from '../db/prisma.js';
import type { NarrativeWriter } from './narrative.js';

/**
 * Computing, storing and settling predictions.
 *
 * A signal is persisted with the whole factor table that produced it, not just
 * its score. That is what lets the app answer "why" months later, and what
 * keeps an old prediction auditable after the weights have been retuned: the
 * engine version is stored alongside, so a signal is always interpretable
 * against the model that made it.
 *
 * Settling is the other half. Without it the engine is an opinion; with it the
 * app can report its own hit rate, which is the only honest basis for asking
 * the user to trust it.
 */

/** How long each horizon is given before its prediction is judged. */
const HORIZON_SESSIONS: Readonly<Record<SignalHorizon, number>> = {
  SWING: 20,
  LONG_TERM: 120,
};

/** Bars loaded for scoring. 300 covers the 200-day factors with room to spare. */
const HISTORY_BARS = 300;

export interface ComputeOptions {
  /** Recompute even if a signal already exists for this day and version. */
  force?: boolean;
  persist?: boolean;
  /**
   * Supply a writer to have the LLM write the prose over the factor table.
   *
   * Omitted, the deterministic summary is used, which is what the nightly
   * refresh does for every liquid symbol on the exchange. Scoring 880 signals
   * is free; writing 880 narratives is not, and almost none of them would ever
   * be read.
   */
  writer?: NarrativeWriter;
}

export interface ComputedSignal {
  signal: ScoredSignal;
  narrative: string;
  /** The model that wrote the prose, or null when it is the deterministic one. */
  narrativeModel: string | null;
  signalId: string | null;
}

export type ComputeResult =
  | { ok: true; computed: ComputedSignal }
  | { ok: false; refusal: SignalRefusal };

async function loadCandles(securityId: string, limit = HISTORY_BARS): Promise<Candle[]> {
  const rows = await prisma.dailyBar.findMany({
    where: { securityId },
    orderBy: { date: 'desc' },
    take: limit,
    select: { date: true, open: true, high: true, low: true, close: true, volume: true, ldcp: true },
  });

  // Fetched newest first so the limit takes the most recent window; the engine
  // wants oldest first.
  return rows.reverse().map((row) => ({
    date: toIsoDateColumn(row.date),
    open: toPaisa(row.open),
    high: toPaisa(row.high),
    low: toPaisa(row.low),
    close: toPaisa(row.close),
    volume: row.volume,
    ldcp: row.ldcp === null ? null : toPaisa(row.ldcp),
  }));
}

/**
 * The most recent fundamentals for a security, if any have been entered.
 *
 * Nothing populates this table automatically yet: the exchange's bulk files
 * carry no earnings. The factors handle its absence by reporting as missing
 * rather than scoring neutral, so a long-term signal without it is visibly
 * thinner instead of quietly wrong.
 */
async function loadFundamentals(securityId: string): Promise<Fundamentals | undefined> {
  const row = await prisma.fundamental.findFirst({
    where: { securityId },
    orderBy: { periodEnd: 'desc' },
  });
  if (row === null) return undefined;

  const toRupees = (value: bigint | null): number | undefined =>
    value === null ? undefined : Number(value) / 100;

  const fundamentals: Fundamentals = {
    ...(row.epsPaisa !== null ? { eps: toRupees(row.epsPaisa) } : {}),
    ...(row.bookValuePaisa !== null ? { bookValuePerShare: toRupees(row.bookValuePaisa) } : {}),
    ...(row.dividendPaisa !== null ? { dividendPerShare: toRupees(row.dividendPaisa) } : {}),
    ...(row.roeBps !== null ? { roePct: row.roeBps / 100 } : {}),
    ...(row.debtToEquityBps !== null ? { debtToEquity: row.debtToEquityBps / 10_000 } : {}),
  };

  return Object.keys(fundamentals).length === 0 ? undefined : fundamentals;
}

export async function computeSignalForSymbol(
  symbol: string,
  horizon: SignalHorizon,
  options: ComputeOptions = {},
): Promise<ComputeResult> {
  const security = await prisma.security.findUnique({
    where: { symbol },
    select: { id: true, symbol: true },
  });
  if (security === null) throw notFound('Security');

  const candles = await loadCandles(security.id);
  const fundamentals = await loadFundamentals(security.id);

  const context = buildContext({
    symbol: security.symbol,
    candles,
    horizon,
    ...(fundamentals !== undefined ? { fundamentals } : {}),
  });

  const result = scoreSignal(context);
  if (!result.ok) return { ok: false, refusal: result };

  const signal = result.signal;
  const { text: narrative, model: narrativeModel } = await writeNarrative(signal, options.writer);

  if (options.persist === false) {
    return { ok: true, computed: { signal, narrative, narrativeModel, signalId: null } };
  }

  const signalId = await persistSignal(
    security.id,
    signal,
    narrative,
    narrativeModel,
    context.dates,
  );
  return { ok: true, computed: { signal, narrative, narrativeModel, signalId } };
}

/**
 * The prose for one signal, preferring the model and falling back silently.
 *
 * Every path through here returns usable text. `chooseNarrative` in the engine
 * runs the generated prose past `validateNarrative` first — which rejects
 * advice, invented price targets and anything contradicting the score — and
 * returns the deterministic summary if it fails. So the model can be absent,
 * broken, rate-limited, refused, truncated or simply wrong, and the user still
 * gets an explanation built from the same numbers as the score.
 */
async function writeNarrative(
  signal: ScoredSignal,
  writer: NarrativeWriter | undefined,
  log: (message: string) => void = console.log,
): Promise<{ text: string; model: string | null }> {
  if (writer === undefined || !writer.enabled) {
    return { text: summarise(signal), model: null };
  }

  const outcome = await writer.write({ signal });

  if (!outcome.ok) {
    // Logged at every severity because the operator cannot tell from the UI:
    // a fallback looks exactly like a signal that was never upgraded.
    log(`[narrative] ${signal.symbol} ${signal.horizon}: ${outcome.reason} — ${outcome.detail}`);
    return { text: summarise(signal), model: null };
  }

  const chosen = chooseNarrative(signal, outcome.text);
  if (chosen.source === 'deterministic') {
    log(
      `[narrative] ${signal.symbol} ${signal.horizon}: rejected the generated prose ` +
        `(${chosen.problems.map((problem) => problem.code).join(', ')})`,
    );
    return { text: chosen.text, model: null };
  }

  return { text: chosen.text, model: outcome.model };
}

/**
 * Writes the LLM prose onto a stored signal, if it does not have it yet.
 *
 * Called when a prediction is actually opened, which is the policy: narratives
 * are generated for what gets read, not for every symbol on the exchange. The
 * `narrativeModel` column is the cache key — null means the row still carries
 * the deterministic summary, so this is the one and only generation per signal
 * however many times it is viewed.
 *
 * It recomputes the score rather than rebuilding a `ScoredSignal` from the
 * stored rows. Scoring is pure arithmetic over bars already in memory,
 * measured in milliseconds, and it guarantees the prose was validated against
 * exactly the factors being stored beside it. Reconstructing the signal from
 * the database would risk validating against one thing and showing another.
 */
export async function ensureNarrative(
  symbol: string,
  horizon: SignalHorizon,
  writer: NarrativeWriter,
): Promise<SignalView | null> {
  const existing = await getLatestSignal(symbol, horizon);
  if (existing === null) return null;
  if (!writer.enabled || existing.narrativeModel !== null) return existing;

  const result = await computeSignalForSymbol(symbol, horizon, { writer });
  if (!result.ok) return existing;

  return (await getLatestSignal(symbol, horizon)) ?? existing;
}

export interface WarmSummary {
  symbols: number;
  written: number;
  alreadyWritten: number;
  skipped: number;
}

/**
 * Writes the prose ahead of time for the symbols that are actually followed.
 *
 * The nightly job rescores every liquid symbol on the exchange — around 440,
 * on two horizons — and writing prose for all of them would be nearly nine
 * hundred calls a night, almost none of it ever read. So the night warms only
 * what someone has shown an interest in: anything held, and anything with an
 * armed stop or target on it. That is a handful of symbols, it is ready before
 * the market opens, and everything else is written on the first view instead.
 *
 * "Engaged with" is taken from trades and alert rules rather than from the
 * positions service. A symbol that was sold last week still has a signal worth
 * reading if the user is watching it for a re-entry, and a replayed position
 * of zero would exclude it.
 */
export async function warmNarratives(
  writer: NarrativeWriter,
  options: { horizons?: readonly SignalHorizon[] } = {},
): Promise<WarmSummary> {
  const horizons = options.horizons ?? (['SWING', 'LONG_TERM'] as const);
  const summary: WarmSummary = { symbols: 0, written: 0, alreadyWritten: 0, skipped: 0 };

  if (!writer.enabled) return summary;

  const [traded, watched] = await Promise.all([
    prisma.trade.findMany({
      where: { status: 'ACTIVE' },
      distinct: ['securityId'],
      select: { security: { select: { symbol: true } } },
    }),
    prisma.alertRule.findMany({
      where: { status: 'ARMED' },
      distinct: ['securityId'],
      select: { security: { select: { symbol: true } } },
    }),
  ]);

  const symbols = [
    ...new Set([
      ...traded.map((row) => row.security.symbol),
      ...watched.map((row) => row.security.symbol),
    ]),
  ].sort();

  summary.symbols = symbols.length;

  for (const symbol of symbols) {
    for (const horizon of horizons) {
      const before = await getLatestSignal(symbol, horizon);
      if (before === null) {
        summary.skipped += 1;
        continue;
      }
      if (before.narrativeModel !== null) {
        summary.alreadyWritten += 1;
        continue;
      }

      const after = await ensureNarrative(symbol, horizon, writer);
      if (after?.narrativeModel !== null && after?.narrativeModel !== undefined) {
        summary.written += 1;
      } else {
        // Fell back to the deterministic summary. The reason is already logged
        // by writeNarrative; counted here so the job's line adds up.
        summary.skipped += 1;
      }
    }
  }

  return summary;
}

/**
 * Stores the signal and its factors.
 *
 * Scores are kept as integers: a score times 100, weights and confidence in
 * basis points. Same reason money is integer paisa — a stored float invites
 * comparisons that differ by 1e-15 and totals that do not reconcile when read
 * back.
 */
async function persistSignal(
  securityId: string,
  signal: ScoredSignal,
  narrative: string,
  narrativeModel: string | null,
  dates: readonly IsoDate[],
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const stored = await tx.signal.upsert({
      where: {
        securityId_horizon_asOf_engineVersion: {
          securityId,
          horizon: signal.horizon,
          asOf: fromIsoDateColumn(signal.asOf),
          engineVersion: signal.engineVersion,
        },
      },
      create: {
        securityId,
        horizon: signal.horizon,
        asOf: fromIsoDateColumn(signal.asOf),
        action: signal.action,
        scoreX100: Math.round(signal.score * 100),
        confidenceBps: Math.round(signal.confidence * 10_000),
        coverageBps: Math.round(signal.coverage * 10_000),
        agreementBps: Math.round(signal.agreement * 10_000),
        missingFactors: signal.missingFactors,
        narrative,
        narrativeModel,
        priceAtSignal: BigInt(paisa(Math.round(signal.priceAtSignal * 100))),
        engineVersion: signal.engineVersion,
      },
      update: {
        action: signal.action,
        scoreX100: Math.round(signal.score * 100),
        confidenceBps: Math.round(signal.confidence * 10_000),
        coverageBps: Math.round(signal.coverage * 10_000),
        agreementBps: Math.round(signal.agreement * 10_000),
        missingFactors: signal.missingFactors,
        narrative,
        // Replaced, not preserved: prose written about the previous factor
        // table no longer describes this one, and keeping it would leave an
        // explanation that quietly disagrees with the score above it.
        narrativeModel,
        priceAtSignal: BigInt(paisa(Math.round(signal.priceAtSignal * 100))),
        // A recomputation supersedes the old outcome, since the factors behind
        // it have changed.
        outcome: 'PENDING',
        priceAtOutcome: null,
        settledAt: null,
      },
      select: { id: true },
    });

    // Replaced wholesale: a recomputation may drop a factor that previously
    // reported, and leaving the stale row would make the stored table
    // disagree with the score beside it.
    await tx.signalFactor.deleteMany({ where: { signalId: stored.id } });

    await tx.signalFactor.createMany({
      data: signal.factors.map((factor) => ({
        signalId: stored.id,
        key: factor.key,
        label: factor.label,
        category: factor.category,
        scoreX100: Math.round(factor.score * 100),
        weightBps: Math.round(factor.weight * 10_000),
        contributionX100: Math.round(factor.contribution * 100),
        value: factor.value,
        display: factor.display,
        reason: factor.reason,
        barDates: (factor.barIndices ?? [])
          .map((index) => dates[index])
          .filter((date): date is IsoDate => date !== undefined)
          .map(fromIsoDateColumn),
      })),
    });

    return stored.id;
  });
}

export interface SignalView {
  id: string;
  symbol: string;
  securityName: string;
  horizon: SignalHorizon;
  asOf: IsoDate;
  action: string;
  score: number;
  confidence: number;
  /**
   * The two terms confidence is the product of. Null on rows scored before
   * they were stored.
   *
   * Served so a client never has to derive its own version: the signal page
   * used to compute coverage by counting factors and called it "% of the
   * model", which disagreed with the weighted figure the engine had already
   * computed and the narrative already quoted.
   */
  coverage: number | null;
  agreement: number | null;
  missingFactors: number;
  narrative: string | null;
  /** Which model wrote the prose, or null for the deterministic summary. The
   * clients show this, because a reader is entitled to know whether an
   * explanation was written by a language model. */
  narrativeModel: string | null;
  priceAtSignal: number | null;
  engineVersion: string;
  outcome: string;
  factors: Array<{
    key: string;
    label: string;
    category: string;
    score: number;
    weight: number;
    contribution: number;
    value: number | null;
    display: string;
    reason: string;
    barDates: IsoDate[];
  }>;
  byCategory: Array<{ category: string; contribution: number }>;
}

export async function getLatestSignal(
  symbol: string,
  horizon: SignalHorizon,
): Promise<SignalView | null> {
  const row = await prisma.signal.findFirst({
    where: { security: { symbol }, horizon },
    orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }],
    include: {
      security: { select: { symbol: true, name: true } },
      factors: { orderBy: { contributionX100: 'desc' } },
    },
  });
  return row === null ? null : toSignalView(row);
}

export async function getSignalById(id: string): Promise<SignalView> {
  const row = await prisma.signal.findUnique({
    where: { id },
    include: {
      security: { select: { symbol: true, name: true } },
      factors: true,
    },
  });
  if (row === null) throw notFound('Signal');
  return toSignalView(row);
}

type SignalRow = Awaited<ReturnType<typeof getLatestSignalRow>>;
async function getLatestSignalRow() {
  return prisma.signal.findFirstOrThrow({
    include: { security: { select: { symbol: true, name: true } }, factors: true },
  });
}

function toSignalView(row: NonNullable<SignalRow>): SignalView {
  const factors = row.factors
    .map((factor) => ({
      key: factor.key,
      label: factor.label,
      category: factor.category as string,
      score: factor.scoreX100 / 100,
      weight: factor.weightBps / 10_000,
      contribution: factor.contributionX100 / 100,
      value: factor.value,
      display: factor.display,
      reason: factor.reason,
      barDates: factor.barDates.map(toIsoDateColumn),
    }))
    // Biggest movers first: the explanation should open with what decided it.
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const grouped = new Map<string, number>();
  for (const factor of factors) {
    grouped.set(factor.category, (grouped.get(factor.category) ?? 0) + factor.contribution);
  }

  return {
    id: row.id,
    symbol: row.security.symbol,
    securityName: row.security.name,
    horizon: row.horizon,
    asOf: toIsoDateColumn(row.asOf),
    action: row.action,
    score: row.scoreX100 / 100,
    confidence: row.confidenceBps / 10_000,
    // Null on rows scored before these were stored; the next nightly fills them.
    coverage: row.coverageBps === null ? null : row.coverageBps / 10_000,
    agreement: row.agreementBps === null ? null : row.agreementBps / 10_000,
    missingFactors: row.missingFactors,
    narrative: row.narrative,
    narrativeModel: row.narrativeModel,
    // Integer paisa, like every other amount the API returns. Dividing by 100
    // here handed clients rupees as a float instead — 400.27999999999997 for a
    // close of 40028 paisa — so the one client that renders the field divided
    // again and showed a four-hundred-rupee share as Rs 4.00.
    priceAtSignal: row.priceAtSignal === null ? null : Number(row.priceAtSignal),
    engineVersion: row.engineVersion,
    outcome: row.outcome,
    factors,
    byCategory: [...grouped.entries()]
      .map(([category, contribution]) => ({
        category,
        contribution: Number(contribution.toFixed(2)),
      }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
  };
}

export interface RefreshSummary {
  computed: number;
  refused: number;
  refusals: Array<{ symbol: string; horizon: SignalHorizon; code: string; reason: string }>;
}

/**
 * Recomputes signals for the symbols worth spending the effort on.
 *
 * Scoped by liquidity rather than running the whole board: most of the roughly
 * 500 listings are too thinly traded for the engine to say anything about, and
 * it would refuse them anyway.
 */
export async function refreshSignals(
  options: { symbols?: readonly string[]; minVolume?: number; horizons?: readonly SignalHorizon[] } = {},
): Promise<RefreshSummary> {
  const horizons = options.horizons ?? (['SWING', 'LONG_TERM'] as const);
  const symbols = options.symbols ?? (await liquidSymbols(options.minVolume ?? 100_000));

  const summary: RefreshSummary = { computed: 0, refused: 0, refusals: [] };

  for (const symbol of symbols) {
    for (const horizon of horizons) {
      const result = await computeSignalForSymbol(symbol, horizon);
      if (result.ok) summary.computed += 1;
      else {
        summary.refused += 1;
        summary.refusals.push({
          symbol,
          horizon,
          code: result.refusal.code,
          reason: result.refusal.reason,
        });
      }
    }
  }

  return summary;
}

/**
 * Symbols worth scoring: liquid, and still trading.
 *
 * The recency condition is not redundant with the volume one. A symbol that was
 * heavily traded until it was suspended still has a high 20-session average,
 * and scoring it produces a signal stamped with the date it stopped trading —
 * which reads as a current prediction and is not one. Requiring its latest bar
 * to be near the market's latest keeps those out.
 */
export async function liquidSymbols(minVolume = 100_000, maxStaleDays = 5): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ symbol: string }>>`
    SELECT s."symbol"
    FROM "securities" s
    JOIN (
      SELECT "securityId",
             AVG("volume") AS avg_volume,
             COUNT(*) AS days,
             MAX("date") AS last_date
      FROM (
        SELECT "securityId", "volume", "date",
               ROW_NUMBER() OVER (PARTITION BY "securityId" ORDER BY "date" DESC) AS rn
        FROM "daily_bars"
      ) recent
      WHERE rn <= 20
      GROUP BY "securityId"
    ) v ON v."securityId" = s."id"
    WHERE s."segment" = 'EQUITY'
      AND v.avg_volume >= ${minVolume}
      AND v.days >= 20
      AND v.last_date >= (SELECT MAX("date") FROM "daily_bars") - ${maxStaleDays}::int
    ORDER BY v.avg_volume DESC
  `;
  return rows.map((row) => row.symbol);
}

export interface SettleSummary {
  settled: number;
  hits: number;
  misses: number;
  neutral: number;
}

/**
 * Judges predictions whose horizon has elapsed.
 *
 * A directional call is scored against a threshold rather than any move at
 * all, so a stock drifting sideways counts as neutral instead of flattering a
 * BUY. The threshold scales with the horizon, because 3% is a real move over
 * three weeks and noise over six months.
 */
export async function settleDueSignals(): Promise<SettleSummary> {
  const summary: SettleSummary = { settled: 0, hits: 0, misses: 0, neutral: 0 };

  for (const horizon of ['SWING', 'LONG_TERM'] as const) {
    const sessions = HORIZON_SESSIONS[horizon];
    const threshold = horizon === 'SWING' ? 3 : 10;

    const pending = await prisma.signal.findMany({
      where: { horizon, outcome: 'PENDING', priceAtSignal: { not: null } },
      include: { security: { select: { id: true } } },
      orderBy: { asOf: 'asc' },
      take: 500,
    });

    for (const signal of pending) {
      // The bar `sessions` trading days after the signal, if it exists yet.
      const laterBars = await prisma.dailyBar.findMany({
        where: { securityId: signal.securityId, date: { gt: signal.asOf } },
        orderBy: { date: 'asc' },
        take: sessions,
        select: { close: true, date: true },
      });

      if (laterBars.length < sessions) continue;

      const finalBar = laterBars[laterBars.length - 1];
      if (finalBar === undefined || signal.priceAtSignal === null) continue;

      const priceAtSignal = Number(signal.priceAtSignal) / 100;
      const priceNow = Number(finalBar.close) / 100;

      const outcome = settleSignal({ action: signal.action }, priceAtSignal, priceNow, threshold);

      await prisma.signal.update({
        where: { id: signal.id },
        data: {
          outcome,
          priceAtOutcome: finalBar.close,
          settledAt: new Date(),
        },
      });

      summary.settled += 1;
      if (outcome === 'HIT') summary.hits += 1;
      else if (outcome === 'MISS') summary.misses += 1;
      else summary.neutral += 1;
    }
  }

  return summary;
}

export interface AccuracyReport {
  horizon: SignalHorizon;
  engineVersion: string;
  settled: number;
  hits: number;
  misses: number;
  neutral: number;
  /** Hits over decided predictions, excluding the neutral ones. */
  hitRate: number | null;
  byAction: Array<{ action: string; settled: number; hits: number; hitRate: number | null }>;
}

/**
 * The engine's own track record.
 *
 * Neutral outcomes are excluded from the hit rate rather than counted as
 * losses: the prediction was directional and the market did nothing, which is
 * neither right nor wrong. Including them would understate accuracy in quiet
 * markets and flatter it in volatile ones.
 */
export async function accuracyReport(): Promise<AccuracyReport[]> {
  const rows = await prisma.signal.groupBy({
    by: ['horizon', 'engineVersion', 'action', 'outcome'],
    where: { outcome: { in: ['HIT', 'MISS', 'NEUTRAL'] } },
    _count: { _all: true },
  });

  const keyed = new Map<string, AccuracyReport>();

  for (const row of rows) {
    const key = `${row.horizon}|${row.engineVersion}`;
    const existing =
      keyed.get(key) ??
      ({
        horizon: row.horizon,
        engineVersion: row.engineVersion,
        settled: 0,
        hits: 0,
        misses: 0,
        neutral: 0,
        hitRate: null,
        byAction: [],
      } satisfies AccuracyReport);

    const count = row._count._all;
    existing.settled += count;
    if (row.outcome === 'HIT') existing.hits += count;
    else if (row.outcome === 'MISS') existing.misses += count;
    else existing.neutral += count;

    const action = existing.byAction.find((entry) => entry.action === row.action);
    if (action === undefined) {
      existing.byAction.push({
        action: row.action,
        settled: count,
        hits: row.outcome === 'HIT' ? count : 0,
        hitRate: null,
      });
    } else {
      action.settled += count;
      if (row.outcome === 'HIT') action.hits += count;
    }

    keyed.set(key, existing);
  }

  for (const report of keyed.values()) {
    const decided = report.hits + report.misses;
    report.hitRate = decided === 0 ? null : Number((report.hits / decided).toFixed(3));
    for (const action of report.byAction) {
      action.hitRate = action.settled === 0 ? null : Number((action.hits / action.settled).toFixed(3));
    }
    report.byAction.sort((a, b) => b.settled - a.settled);
  }

  return [...keyed.values()];
}
