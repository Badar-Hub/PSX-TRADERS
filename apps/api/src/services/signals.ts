import {
  buildContext,
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
}

export interface ComputedSignal {
  signal: ScoredSignal;
  /** The deterministic explanation; the LLM pass can replace it later. */
  narrative: string;
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
  const narrative = summarise(signal);

  if (options.persist === false) {
    return { ok: true, computed: { signal, narrative, signalId: null } };
  }

  const signalId = await persistSignal(security.id, signal, narrative, context.dates);
  return { ok: true, computed: { signal, narrative, signalId } };
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
        missingFactors: signal.missingFactors,
        narrative,
        priceAtSignal: BigInt(paisa(Math.round(signal.priceAtSignal * 100))),
        engineVersion: signal.engineVersion,
      },
      update: {
        action: signal.action,
        scoreX100: Math.round(signal.score * 100),
        confidenceBps: Math.round(signal.confidence * 10_000),
        missingFactors: signal.missingFactors,
        narrative,
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
  missingFactors: number;
  narrative: string | null;
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
    missingFactors: row.missingFactors,
    narrative: row.narrative,
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
