import { paisa, rupeesToPaisa, type Paisa, type RuleStatus, type RuleTrigger } from '@psx/shared';
import {
  armTrailingStop,
  atr,
  evaluateStop,
  formatTradingDay,
  replayStops,
  stopFromTrail,
  trailBpsFromAtr,
  type StopBar,
  type StopRule,
} from '@psx/engine';
import { prisma } from '../db/prisma.js';
import {
  fromIsoDateColumn,
  fromPaisa,
  fromPaisaOrNull,
  toIsoDateColumn,
  toPaisa,
  toPaisaOrNull,
} from '../db/paisa.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { loadOwnedPortfolio, resolveSecurity } from './trades.js';
import { getPortfolioPositions } from './positions.js';

/**
 * Stop-loss, trailing stop and take-profit rules.
 *
 * The arithmetic lives in `@psx/engine`; this file is the database around it.
 * Nothing here decides when a rule fires — it loads state, hands it and the
 * bars to the pure evaluator, and writes back what the evaluator says changed.
 * That division is deliberate: the part that could lose someone money is the
 * part with no I/O in it, and it is tested without a database.
 *
 * These are alerts, not orders. A trigger writes an `AlertEvent` and disarms
 * the rule; it never writes a trade. Selling is the user's decision, made with
 * their broker, and a tool that quietly recorded a sale that never happened
 * would corrupt the ledger it exists to keep honest.
 */

/** The rule types the engine evaluates, which is what the API accepts. */
const ACCEPTED_TYPES = ['STOP_LOSS', 'TRAILING_STOP', 'TAKE_PROFIT'] as const;
export type AcceptedRuleType = (typeof ACCEPTED_TYPES)[number];

export interface CreateStopInput {
  portfolioId: string;
  userId: string;
  symbol: string;
  type: AcceptedRuleType;
  triggerOn?: RuleTrigger;
  /** STOP_LOSS and TAKE_PROFIT: the level, as a rupee string. */
  thresholdPrice?: string;
  /** TRAILING_STOP: the trail as a rupee distance. */
  trailAmount?: string;
  /** TRAILING_STOP: the trail as basis points of the high-water mark. */
  trailBps?: number;
  quantity?: number;
  note?: string;
  expiresOn?: string;
}

export interface StopRuleView {
  id: string;
  symbol: string;
  securityName: string;
  type: string;
  status: RuleStatus;
  triggerOn: RuleTrigger;
  thresholdPrice: Paisa | null;
  trailAmount: Paisa | null;
  trailBps: number | null;
  highWaterMark: Paisa | null;
  effectiveStop: Paisa | null;
  quantity: number | null;
  note: string | null;
  armedAt: string;
  expiresAt: string | null;
  lastCheckedOn: string | null;
  /** Latest close, so the UI can show how close the rule is to firing. */
  marketPrice: Paisa | null;
  priceAsOf: string | null;
  /**
   * How far the price still has to travel before the rule fires, in basis
   * points of the level. Always signed the same way whichever kind of rule it
   * is: positive means safe, zero or negative means the last close would
   * already trigger it, which can only happen between an ingest and an
   * evaluation.
   *
   * Direction-free on purpose. A stop fires on a fall and a target on a rise,
   * so a raw "price above level" figure would read as danger for one and
   * safety for the other, and every consumer would have to re-derive which.
   */
  headroomBps: number | null;
  /** What the rule would protect or realise at its current level, if it fired. */
  valueAtStop: Paisa | null;
  /** Shares actually held, so the UI can flag a rule covering more than that. */
  sharesHeld: number | null;
  events: StopEventView[];
}

export interface StopEventView {
  id: string;
  triggeredOn: string;
  triggerPrice: Paisa;
  stopAtTrigger: Paisa | null;
  highWaterMark: Paisa | null;
  message: string;
  acknowledgedAt: string | null;
}

type RuleRow = Awaited<ReturnType<typeof loadRuleRows>>[number];

async function loadRuleRows(where: { portfolioId: string } | { id: string }) {
  return prisma.alertRule.findMany({
    where,
    orderBy: [{ status: 'asc' }, { armedAt: 'desc' }],
    include: {
      security: { select: { symbol: true, name: true } },
      events: { orderBy: { triggeredOn: 'desc' }, take: 10 },
    },
  });
}

/**
 * Creates a rule.
 *
 * A trailing stop is armed from the latest close rather than from a level the
 * user types, because that is what "trail ten percent" means — and the
 * high-water mark has to start somewhere the engine can defend. A rule on a
 * symbol with no price history is refused rather than armed to fire on the
 * first bar that arrives.
 */
export async function createStopRule(input: CreateStopInput): Promise<StopRuleView> {
  if (!ACCEPTED_TYPES.includes(input.type)) {
    throw badRequest(
      `Only ${ACCEPTED_TYPES.join(', ')} can be created. Price and indicator alerts are in the ` +
        `schema but have no evaluator yet, and a rule that never fires is worse than none.`,
    );
  }

  const ruleId = await prisma.$transaction(async (tx) => {
    await loadOwnedPortfolio(tx, input.portfolioId, input.userId);
    const security = await resolveSecurity(tx, input.symbol);

    const latest = await tx.dailyBar.findFirst({
      where: { securityId: security.id },
      orderBy: { date: 'desc' },
      select: { close: true, high: true, low: true, date: true },
    });

    const threshold =
      input.thresholdPrice === undefined ? null : rupeesToPaisa(input.thresholdPrice);
    const trailAmount = input.trailAmount === undefined ? null : rupeesToPaisa(input.trailAmount);
    const trailBps = input.trailBps ?? null;

    let highWaterMark: Paisa | null = null;
    let effectiveStop: Paisa | null = null;

    if (input.type === 'TRAILING_STOP') {
      if ((trailAmount === null) === (trailBps === null)) {
        throw badRequest('A trailing stop needs exactly one of trailAmount or trailBps.');
      }
      if (latest === null) {
        throw badRequest(
          `There is no stored price for ${security.symbol}, so a trailing stop has nothing to ` +
            `trail from. Run the ingest, or set a fixed stop-loss instead.`,
        );
      }
      const armed = armTrailingStop(toPaisa(latest.close), { trailAmount, trailBps });
      highWaterMark = armed.highWaterMark;
      effectiveStop = armed.effectiveStop;
    } else {
      if (threshold === null) {
        throw badRequest(`A ${input.type} rule needs a price to watch.`);
      }
      if (threshold <= 0) throw badRequest('The level must be above zero.');
      if (trailAmount !== null || trailBps !== null) {
        throw badRequest('A trail only applies to a trailing stop.');
      }

      /*
       * A stop-loss above the current price, or a target below it, would fire
       * on the very next bar. That is almost always a typo — the two numbers
       * transposed, or rupees entered where paisa were meant — and firing
       * immediately teaches the user to ignore the alerts.
       */
      if (latest !== null) {
        const close = toPaisa(latest.close);
        if (input.type === 'STOP_LOSS' && threshold >= close) {
          throw conflict(
            `A stop-loss at ${describe(threshold)} is at or above the last close of ` +
              `${describe(close)}, so it would fire immediately. Set it below the current price.`,
          );
        }
        if (input.type === 'TAKE_PROFIT' && threshold <= close) {
          throw conflict(
            `A target at ${describe(threshold)} is at or below the last close of ` +
              `${describe(close)}, so it would fire immediately. Set it above the current price.`,
          );
        }
      }
    }

    if (input.quantity !== undefined && input.quantity <= 0) {
      throw badRequest('The share count must be positive.');
    }

    const created = await tx.alertRule.create({
      data: {
        portfolioId: input.portfolioId,
        securityId: security.id,
        type: input.type,
        triggerOn: input.triggerOn ?? 'CLOSE',
        thresholdPrice: fromPaisaOrNull(threshold),
        trailAmount: fromPaisaOrNull(trailAmount),
        trailBps,
        highWaterMark: fromPaisaOrNull(highWaterMark),
        effectiveStop: fromPaisaOrNull(effectiveStop),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.expiresOn !== undefined
          ? { expiresAt: fromIsoDateColumn(input.expiresOn) }
          : {}),
        // Set to the latest stored bar so the first evaluation looks at bars
        // after arming, not at history the rule was never watching.
        ...(latest !== null ? { lastCheckedOn: latest.date } : {}),
      },
      select: { id: true },
    });

    return created.id;
  });

  const view = await getStopRule(ruleId, input.userId);
  if (view === null) throw notFound('Rule');
  return view;
}

export interface UpdateStopInput {
  userId: string;
  thresholdPrice?: string;
  trailAmount?: string;
  trailBps?: number;
  quantity?: number;
  note?: string | null;
  triggerOn?: RuleTrigger;
}

/**
 * Adjusts an armed rule.
 *
 * Widening a trailing stop's trail recomputes the level from the mark the rule
 * has already reached, so a trail loosened after a long run does not reset the
 * protection that run earned.
 */
export async function updateStopRule(
  ruleId: string,
  input: UpdateStopInput,
): Promise<StopRuleView> {
  await prisma.$transaction(async (tx) => {
    const rule = await tx.alertRule.findFirst({
      where: { id: ruleId, portfolio: { userId: input.userId } },
      include: { security: { select: { symbol: true } } },
    });
    if (rule === null) throw notFound('Rule');
    if (rule.status !== 'ARMED') {
      throw conflict(
        `That rule is ${rule.status.toLowerCase()}, so there is nothing to adjust. Create a new ` +
          `one — a rule's history is kept rather than rewritten.`,
      );
    }

    const threshold =
      input.thresholdPrice === undefined ? null : rupeesToPaisa(input.thresholdPrice);
    const trailAmount = input.trailAmount === undefined ? null : rupeesToPaisa(input.trailAmount);
    const trailBps = input.trailBps;

    if (rule.type === 'TRAILING_STOP') {
      if (threshold !== null) throw badRequest('A trailing stop has no fixed level to set.');

      const nextAmount = trailAmount ?? (trailBps !== undefined ? null : toPaisaOrNull(rule.trailAmount));
      const nextBps = trailBps ?? (trailAmount !== null ? null : rule.trailBps);
      const mark = toPaisaOrNull(rule.highWaterMark);

      if (mark === null) throw badRequest('That trailing stop has no high-water mark to trail.');
      if ((nextAmount === null) === (nextBps === null)) {
        throw badRequest('A trailing stop needs exactly one of trailAmount or trailBps.');
      }

      const stop = stopFromTrail(mark, { trailAmount: nextAmount, trailBps: nextBps });

      await tx.alertRule.update({
        where: { id: ruleId },
        data: {
          trailAmount: fromPaisaOrNull(nextAmount),
          trailBps: nextBps,
          effectiveStop: fromPaisa(stop),
          ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.triggerOn !== undefined ? { triggerOn: input.triggerOn } : {}),
        },
      });
      return;
    }

    if (trailAmount !== null || trailBps !== undefined) {
      throw badRequest('A trail only applies to a trailing stop.');
    }
    if (threshold !== null && threshold <= 0) throw badRequest('The level must be above zero.');

    await tx.alertRule.update({
      where: { id: ruleId },
      data: {
        ...(threshold !== null ? { thresholdPrice: fromPaisa(threshold) } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.triggerOn !== undefined ? { triggerOn: input.triggerOn } : {}),
      },
    });
  });

  const view = await getStopRule(ruleId, input.userId);
  if (view === null) throw notFound('Rule');
  return view;
}

/**
 * Cancels a rule.
 *
 * Marked CANCELLED rather than deleted, for the same reason a trade is
 * reversed rather than erased: "what was I protecting in March" has an answer
 * only if the rules that are no longer armed are still there.
 */
export async function cancelStopRule(ruleId: string, userId: string): Promise<StopRuleView> {
  const rule = await prisma.alertRule.findFirst({
    where: { id: ruleId, portfolio: { userId } },
    select: { id: true, status: true },
  });
  if (rule === null) throw notFound('Rule');
  if (rule.status !== 'ARMED') {
    throw conflict(`That rule is already ${rule.status.toLowerCase()}.`);
  }

  await prisma.alertRule.update({ where: { id: ruleId }, data: { status: 'CANCELLED' } });

  const view = await getStopRule(ruleId, userId);
  if (view === null) throw notFound('Rule');
  return view;
}

/** Marks a firing as seen, so the UI can stop drawing attention to it. */
export async function acknowledgeEvent(eventId: string, userId: string): Promise<StopEventView> {
  const event = await prisma.alertEvent.findFirst({
    where: { id: eventId, rule: { portfolio: { userId } } },
    select: { id: true },
  });
  if (event === null) throw notFound('Alert');

  const updated = await prisma.alertEvent.update({
    where: { id: eventId },
    data: { acknowledgedAt: new Date() },
  });

  return toEventView(updated);
}

export async function listStopRules(
  portfolioId: string,
  userId: string,
  filters: { status?: RuleStatus } = {},
): Promise<{ rules: StopRuleView[]; counts: Record<string, number> }> {
  await loadOwnedPortfolio(prisma, portfolioId, userId);

  const rows = await loadRuleRows({ portfolioId });
  const filtered =
    filters.status === undefined ? rows : rows.filter((row) => row.status === filters.status);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;

  return { rules: await decorate(filtered, portfolioId, userId), counts };
}

export async function getStopRule(ruleId: string, userId: string): Promise<StopRuleView | null> {
  const rows = await prisma.alertRule.findMany({
    where: { id: ruleId, portfolio: { userId } },
    include: {
      security: { select: { symbol: true, name: true } },
      events: { orderBy: { triggeredOn: 'desc' }, take: 10 },
    },
  });

  const row = rows[0];
  if (row === undefined) return null;

  const decorated = await decorate([row], row.portfolioId, userId);
  return decorated[0] ?? null;
}

/**
 * Adds the market context a rule is meaningless without.
 *
 * A stop at 95.00 means nothing on its own; "95.00, and the stock is at 103.40,
 * so 8% of headroom" is a thing the user can act on. The held share count comes
 * from the ledger so the UI can point out a rule covering 500 shares of a
 * 200-share holding, which is a mistake the rule itself cannot detect.
 */
async function decorate(
  rows: RuleRow[],
  portfolioId: string,
  userId: string,
): Promise<StopRuleView[]> {
  if (rows.length === 0) return [];

  const securityIds = [...new Set(rows.map((row) => row.securityId))];
  const bars = await prisma.dailyBar.findMany({
    where: { securityId: { in: securityIds } },
    orderBy: { date: 'desc' },
    distinct: ['securityId'],
    select: { securityId: true, close: true, date: true },
  });
  const priceBySecurity = new Map(
    bars.map((row) => [row.securityId, { price: toPaisa(row.close), date: toIsoDateColumn(row.date) }]),
  );

  // One positions read for the whole list rather than per rule.
  const summary = await getPortfolioPositions(portfolioId, userId);
  const heldBySymbol = new Map(summary.positions.map((p) => [p.symbol, p.quantity]));

  return rows.map((row) => {
    const market = priceBySecurity.get(row.securityId) ?? null;
    const level = levelOf(row);
    const quantity = row.quantity ?? heldBySymbol.get(row.security.symbol) ?? null;

    return {
      id: row.id,
      symbol: row.security.symbol,
      securityName: row.security.name,
      type: row.type,
      status: row.status,
      triggerOn: row.triggerOn,
      thresholdPrice: toPaisaOrNull(row.thresholdPrice),
      trailAmount: toPaisaOrNull(row.trailAmount),
      trailBps: row.trailBps,
      highWaterMark: toPaisaOrNull(row.highWaterMark),
      effectiveStop: toPaisaOrNull(row.effectiveStop),
      quantity: row.quantity,
      note: row.note,
      armedAt: row.armedAt.toISOString(),
      expiresAt: row.expiresAt === null ? null : toIsoDateColumn(row.expiresAt),
      lastCheckedOn: row.lastCheckedOn === null ? null : toIsoDateColumn(row.lastCheckedOn),
      marketPrice: market?.price ?? null,
      priceAsOf: market?.date ?? null,
      headroomBps:
        market === null || level === null || level <= 0
          ? null
          : Math.round(
              ((row.type === 'TAKE_PROFIT' ? level - market.price : market.price - level) /
                level) *
                10_000,
            ),
      valueAtStop: level === null || quantity === null ? null : ((level * quantity) as Paisa),
      sharesHeld: heldBySymbol.get(row.security.symbol) ?? 0,
      events: row.events.map(toEventView),
    };
  });
}

/** The level a rule is currently watching, whichever kind it is. */
function levelOf(row: {
  type: string;
  thresholdPrice: bigint | null;
  effectiveStop: bigint | null;
}): Paisa | null {
  return row.type === 'TRAILING_STOP'
    ? toPaisaOrNull(row.effectiveStop)
    : toPaisaOrNull(row.thresholdPrice);
}

function toEventView(row: {
  id: string;
  triggeredOn: Date;
  triggerPrice: bigint;
  stopAtTrigger: bigint | null;
  highWaterMark: bigint | null;
  message: string;
  acknowledgedAt: Date | null;
}): StopEventView {
  return {
    id: row.id,
    triggeredOn: toIsoDateColumn(row.triggeredOn),
    triggerPrice: toPaisa(row.triggerPrice),
    stopAtTrigger: toPaisaOrNull(row.stopAtTrigger),
    highWaterMark: toPaisaOrNull(row.highWaterMark),
    message: row.message,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  };
}

export interface EvaluationSummary {
  rulesChecked: number;
  triggered: number;
  moved: number;
  expired: number;
  skipped: number;
  /** One line per rule that did something, for the nightly job's log. */
  notes: string[];
}

/**
 * Evaluates every armed rule against the bars it has not seen.
 *
 * Replays from `lastCheckedOn` rather than looking only at the latest bar. If
 * the nightly job does not run for three days — a laptop asleep, a failed
 * ingest — a stop breached on the first of those days must still be reported,
 * and reported with that day's numbers rather than today's. Catching up is the
 * difference between an alert system and a cron job that happened to run.
 *
 * Idempotent: `lastCheckedOn` advances only over bars actually evaluated, so
 * running it twice in an evening reports nothing the second time.
 */
export async function evaluateArmedRules(
  options: { portfolioId?: string } = {},
): Promise<EvaluationSummary> {
  const summary: EvaluationSummary = {
    rulesChecked: 0,
    triggered: 0,
    moved: 0,
    expired: 0,
    skipped: 0,
    notes: [],
  };

  const armed = await prisma.alertRule.findMany({
    where: {
      status: 'ARMED',
      ...(options.portfolioId !== undefined ? { portfolioId: options.portfolioId } : {}),
    },
    include: { security: { select: { symbol: true } } },
    orderBy: { armedAt: 'asc' },
  });

  for (const row of armed) {
    summary.rulesChecked += 1;

    const bars = await prisma.dailyBar.findMany({
      where: {
        securityId: row.securityId,
        ...(row.lastCheckedOn !== null ? { date: { gt: row.lastCheckedOn } } : {}),
      },
      orderBy: { date: 'asc' },
      select: { date: true, high: true, low: true, close: true },
    });

    if (bars.length === 0) continue;

    const state: StopRule = {
      type: row.type,
      triggerOn: row.triggerOn,
      thresholdPrice: toPaisaOrNull(row.thresholdPrice),
      trailAmount: toPaisaOrNull(row.trailAmount),
      trailBps: row.trailBps,
      highWaterMark: toPaisaOrNull(row.highWaterMark),
      effectiveStop: toPaisaOrNull(row.effectiveStop),
      expiresAt: row.expiresAt,
    };

    const series: StopBar[] = bars.map((bar) => ({
      date: toIsoDateColumn(bar.date),
      high: toPaisa(bar.high),
      low: toPaisa(bar.low),
      close: toPaisa(bar.close),
    }));

    const result = replayStops(state, series);
    const last = result.steps[result.steps.length - 1];
    if (last === undefined) continue;

    const final = last.outcome;

    if (final.kind === 'TRIGGERED') {
      await prisma.$transaction([
        prisma.alertEvent.create({
          data: {
            ruleId: row.id,
            triggeredOn: fromIsoDateColumn(last.bar.date),
            triggerPrice: fromPaisa(final.triggerPrice),
            stopAtTrigger: fromPaisa(final.stopAtTrigger),
            highWaterMark: fromPaisaOrNull(final.highWaterMark),
            message: final.message,
          },
        }),
        prisma.alertRule.update({
          where: { id: row.id },
          data: {
            status: 'TRIGGERED',
            lastCheckedOn: fromIsoDateColumn(last.bar.date),
            // The mark and stop are frozen at what fired, so the event and the
            // rule tell the same story afterwards.
            highWaterMark: fromPaisaOrNull(final.highWaterMark),
            effectiveStop: fromPaisa(final.stopAtTrigger),
          },
        }),
      ]);
      summary.triggered += 1;
      summary.notes.push(`${row.security.symbol} ${row.type}: ${final.message}`);
      continue;
    }

    if (final.kind === 'EXPIRED') {
      await prisma.alertRule.update({
        where: { id: row.id },
        data: { status: 'EXPIRED', lastCheckedOn: fromIsoDateColumn(last.bar.date) },
      });
      summary.expired += 1;
      summary.notes.push(`${row.security.symbol} ${row.type}: ${final.message}`);
      continue;
    }

    if (final.kind === 'SKIPPED') {
      // Not advanced: a rule that cannot be evaluated has not been checked, and
      // pretending otherwise would hide it the moment the cause was fixed.
      summary.skipped += 1;
      summary.notes.push(`${row.security.symbol} ${row.type}: ${final.message}`);
      continue;
    }

    const moved = result.finalState;
    const didMove = result.steps.some((step) => step.outcome.kind === 'MOVED');

    await prisma.alertRule.update({
      where: { id: row.id },
      data: {
        lastCheckedOn: fromIsoDateColumn(last.bar.date),
        highWaterMark: fromPaisaOrNull(moved.highWaterMark),
        effectiveStop: fromPaisaOrNull(moved.effectiveStop),
      },
    });

    if (didMove) {
      summary.moved += 1;
      const lastMove = [...result.steps].reverse().find((step) => step.outcome.kind === 'MOVED');
      if (lastMove?.outcome.kind === 'MOVED') {
        summary.notes.push(`${row.security.symbol} trailing stop: ${lastMove.outcome.message}`);
      }
    }
  }

  return summary;
}

export interface SuggestedStop {
  symbol: string;
  marketPrice: Paisa;
  priceAsOf: string;
  /** ATR over the last 14 bars, in paisa, or null if there is too little data. */
  atr: Paisa | null;
  /** The suggested trail, scaled to the stock's own volatility. */
  trailBps: number | null;
  /** Where that trail would put the stop today. */
  suggestedStop: Paisa | null;
  multiple: number;
  reason: string;
}

/**
 * A trail width scaled to how much the symbol actually moves.
 *
 * Offered because the obvious choice — a round five or ten percent — is the
 * wrong unit. The same percentage is noise on a volatile small cap and a
 * disaster on a utility, and a user has no way to know which they are holding
 * without looking at the range. This answers that question with the stock's own
 * ATR, and says what it did, so the number is a suggestion rather than an
 * oracle.
 */
export async function suggestStop(
  symbol: string,
  options: { multiple?: number } = {},
): Promise<SuggestedStop> {
  const multiple = options.multiple ?? 2.5;
  const security = await prisma.security.findUnique({
    where: { symbol },
    select: { id: true, symbol: true },
  });
  if (security === null) throw notFound('Security');

  const bars = await prisma.dailyBar.findMany({
    where: { securityId: security.id },
    orderBy: { date: 'desc' },
    take: 60,
    select: { date: true, high: true, low: true, close: true },
  });

  const latest = bars[0];
  if (latest === undefined) {
    throw badRequest(`There is no stored price history for ${symbol}.`);
  }

  const ordered = [...bars].reverse();
  const price = toPaisa(latest.close);

  // ATR needs a run of bars to mean anything; below about 20 it is as noisy as
  // the thing it is meant to measure.
  if (ordered.length < 20) {
    return {
      symbol: security.symbol,
      marketPrice: price,
      priceAsOf: toIsoDateColumn(latest.date),
      atr: null,
      trailBps: null,
      suggestedStop: null,
      multiple,
      reason:
        `Only ${ordered.length} day${ordered.length === 1 ? '' : 's'} of history are stored for ` +
        `${security.symbol}, which is too few to measure its range. Pick the level yourself, or ` +
        `backfill more history first.`,
    };
  }

  const series = atr(
    ordered.map((bar) => Number(bar.high)),
    ordered.map((bar) => Number(bar.low)),
    ordered.map((bar) => Number(bar.close)),
    14,
  );
  const current = series[series.length - 1] ?? null;

  if (current === null) {
    return {
      symbol: security.symbol,
      marketPrice: price,
      priceAsOf: toIsoDateColumn(latest.date),
      atr: null,
      trailBps: null,
      suggestedStop: null,
      multiple,
      reason: `The average true range could not be computed for ${security.symbol}.`,
    };
  }

  const bps = trailBpsFromAtr(price, current, multiple);
  const stop = bps === null ? null : stopFromTrail(price, { trailAmount: null, trailBps: bps });

  return {
    symbol: security.symbol,
    marketPrice: price,
    priceAsOf: toIsoDateColumn(latest.date),
    atr: paisa(Math.round(current)),
    trailBps: bps,
    suggestedStop: stop,
    multiple,
    reason:
      bps === null
        ? `${security.symbol} has no usable range to scale a stop to.`
        : `${security.symbol} moves about ${describe(paisa(Math.round(current)))} on an ` +
          `average day, measured over the last 14 sessions. At ${multiple} times that, the ` +
          `trail is ${(bps / 100).toFixed(1)}% — wide enough that an ordinary day will not ` +
          `take you out, which is the point of sizing it to the stock rather than picking a ` +
          `round number.`,
  };
}

export interface BacktestResult {
  symbol: string;
  from: string;
  to: string;
  barsConsidered: number;
  trailBps: number | null;
  trailAmount: Paisa | null;
  /** Null when the trail survived the whole window without firing. */
  triggeredOn: string | null;
  triggerPrice: Paisa | null;
  stopAtTrigger: Paisa | null;
  /** Highest price reached before it fired, or over the window if it did not. */
  highWaterMark: Paisa | null;
  /** Close on the last bar of the window, for comparison with holding on. */
  finalClose: Paisa;
  /** What the trail returned against buying at the start and holding, in bps. */
  versusHoldingBps: number | null;
  verdict: string;
}

/**
 * Replays a proposed trail over stored history.
 *
 * The only honest way to answer "is a 10% trail right for this stock": run it
 * over the past year and see whether it protected a fall or simply sold a
 * holding that then recovered. It uses the same evaluator as the nightly job,
 * so what it shows is what the rule would actually have done — a separate
 * backtest with its own arithmetic would be a different system that happens to
 * share a name.
 *
 * Still a backtest, with everything that implies: one symbol, one window, and
 * no evidence that the next year resembles the last.
 */
export async function backtestTrail(
  symbol: string,
  trail: { trailBps?: number; trailAmount?: string },
  options: { bars?: number; triggerOn?: RuleTrigger } = {},
): Promise<BacktestResult> {
  const security = await prisma.security.findUnique({
    where: { symbol },
    select: { id: true, symbol: true },
  });
  if (security === null) throw notFound('Security');

  const trailBps = trail.trailBps ?? null;
  const trailAmount = trail.trailAmount === undefined ? null : rupeesToPaisa(trail.trailAmount);
  if ((trailBps === null) === (trailAmount === null)) {
    throw badRequest('Give exactly one of trailBps or trailAmount to test.');
  }

  const limit = options.bars ?? 250;
  const rows = await prisma.dailyBar.findMany({
    where: { securityId: security.id },
    orderBy: { date: 'desc' },
    take: limit,
    select: { date: true, high: true, low: true, close: true },
  });

  if (rows.length < 2) {
    throw badRequest(`There is not enough stored history for ${symbol} to replay a trail over.`);
  }

  const bars: StopBar[] = [...rows].reverse().map((bar) => ({
    date: toIsoDateColumn(bar.date),
    high: toPaisa(bar.high),
    low: toPaisa(bar.low),
    close: toPaisa(bar.close),
  }));

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const entry = first.close;

  const armed = armTrailingStop(entry, { trailAmount, trailBps });
  const state: StopRule = {
    type: 'TRAILING_STOP',
    triggerOn: options.triggerOn ?? 'CLOSE',
    thresholdPrice: null,
    trailAmount,
    trailBps,
    highWaterMark: armed.highWaterMark,
    effectiveStop: armed.effectiveStop,
    expiresAt: null,
  };

  // The first bar is the entry, so the replay starts after it.
  const result = replayStops(state, bars.slice(1));
  const fired = result.triggered;

  const exit = fired?.outcome.kind === 'TRIGGERED' ? fired.outcome.triggerPrice : last.close;
  const trailReturnBps = Math.round(((exit - entry) / entry) * 10_000);
  const holdReturnBps = Math.round(((last.close - entry) / entry) * 10_000);

  const verdict =
    fired === null
      ? `The trail was never hit: it would still be running, with the stop at ` +
        `${describe(result.finalState.effectiveStop ?? armed.effectiveStop)} after following a ` +
        `high of ${describe(result.finalState.highWaterMark ?? entry)}.`
      : trailReturnBps > holdReturnBps
        ? `The trail took you out on ${formatTradingDay(fired.bar.date)} at ${describe(exit)}, ` +
          `${formatBps(trailReturnBps)} on the entry — better than the ` +
          `${formatBps(holdReturnBps)} from holding to ${formatTradingDay(last.date)}. On this window it protected ` +
          `you.`
        : `The trail took you out on ${formatTradingDay(fired.bar.date)} at ${describe(exit)}, ` +
          `${formatBps(trailReturnBps)} on the entry, while holding to ${formatTradingDay(last.date)} returned ` +
          `${formatBps(holdReturnBps)}. On this window it sold a position that recovered, which ` +
          `is what too tight a trail costs.`;

  return {
    symbol: security.symbol,
    from: first.date,
    to: last.date,
    barsConsidered: bars.length,
    trailBps,
    trailAmount,
    triggeredOn: fired?.bar.date ?? null,
    triggerPrice: fired?.outcome.kind === 'TRIGGERED' ? fired.outcome.triggerPrice : null,
    stopAtTrigger: fired?.outcome.kind === 'TRIGGERED' ? fired.outcome.stopAtTrigger : null,
    highWaterMark: result.finalState.highWaterMark,
    finalClose: last.close,
    versusHoldingBps: trailReturnBps - holdReturnBps,
    verdict,
  };
}

/** Paisa as a rupee string, for the messages in this file. */
function describe(value: Paisa | null): string {
  if (value === null) return 'an unknown level';
  const whole = Math.trunc(value / 100);
  const fraction = Math.abs(value % 100);
  return `Rs ${whole.toLocaleString('en-US')}.${String(fraction).padStart(2, '0')}`;
}

function formatBps(bps: number): string {
  const value = bps / 100;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`;
}

/** Re-exported so a caller does not have to reach into the engine for it. */
export { evaluateStop };
