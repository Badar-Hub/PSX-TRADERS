import {
  applyBasisPoints,
  paisa,
  type Paisa,
  type RuleTrigger,
  type RuleType,
} from '@psx/shared';

/**
 * Stop-loss, trailing stop and take-profit evaluation.
 *
 * These are alerts, not orders. PSX brokers do not generally expose an order
 * API to retail, so nothing here sells anything: it tells the user a level has
 * been breached and leaves the decision to them. That is also why a trigger is
 * recorded as an event with the numbers that caused it, rather than as a fill.
 *
 * The whole module is pure. A rule's stored state goes in, one bar goes in, and
 * what should change comes out; the caller writes it. That makes the awkward
 * cases — a gap straight through a stop, a bar that both raises a trail and
 * breaches it — testable without a database, which is the only way to be sure
 * they behave the same next year.
 *
 * ## The decision that matters most
 *
 * On end-of-day data a bar gives four prices and no order. When a bar's high
 * would raise a trailing stop *and* its low would breach the raised stop, the
 * answer depends on which came first, and the data does not say.
 *
 * So the trigger is always tested against the stop as it stood at the start of
 * the bar, and the trail ratchets afterwards. A stop is never claimed to have
 * fired at a level that only existed because of a high that may have come later
 * the same day. The effect is to report triggers slightly later and slightly
 * lower than a perfectly-informed broker would — which is the direction an
 * honest tool should err in, because the alternative is telling someone they
 * got out at a price they could not have got.
 */

export class StopError extends Error {}

/** The persisted state of one rule, as the evaluator needs to see it. */
export interface StopRule {
  type: RuleType;
  triggerOn: RuleTrigger;
  /** STOP_LOSS and TAKE_PROFIT: the level watched. */
  thresholdPrice: Paisa | null;
  /** TRAILING_STOP: the trail as a fixed distance. */
  trailAmount: Paisa | null;
  /** TRAILING_STOP: the trail as a fraction of the high-water mark. */
  trailBps: number | null;
  /** TRAILING_STOP: the best price seen since arming. Follows up, never down. */
  highWaterMark: Paisa | null;
  /** TRAILING_STOP: the level in force, derived from the mark and the trail. */
  effectiveStop: Paisa | null;
  /** Null means it never expires. */
  expiresAt: Date | null;
}

/** One bar to evaluate against. Paisa throughout, like the stored series. */
export interface StopBar {
  date: string;
  high: Paisa;
  low: Paisa;
  close: Paisa;
}

export type StopOutcome =
  /** The level was breached. The caller records an event and disarms the rule. */
  | {
      kind: 'TRIGGERED';
      /** The price that breached it. */
      triggerPrice: Paisa;
      /** The level in force when it broke, which a trail will have moved. */
      stopAtTrigger: Paisa;
      highWaterMark: Paisa | null;
      /** How far past the level the price went, in basis points of the level. */
      overshootBps: number;
      message: string;
    }
  /** A trailing stop ratcheted up. Nothing fired; the new state must be saved. */
  | {
      kind: 'MOVED';
      highWaterMark: Paisa;
      effectiveStop: Paisa;
      /** What it moved from, for the explanation. */
      previousStop: Paisa;
      message: string;
    }
  /** Still armed, nothing to write but the date it was last checked. */
  | { kind: 'UNCHANGED'; effectiveStop: Paisa | null; headroomBps: number | null }
  /** Past its expiry. The caller marks it EXPIRED. */
  | { kind: 'EXPIRED'; message: string }
  /** Not evaluable. The reason is shown, never swallowed. */
  | { kind: 'SKIPPED'; reason: StopSkipReason; message: string };

export type StopSkipReason =
  /** PRICE_ALERT and INDICATOR_ALERT have no evaluator yet. */
  | 'UNSUPPORTED_TYPE'
  /** A rule whose own fields cannot describe a level. */
  | 'INCOMPLETE_RULE';

/** The types this module evaluates. The enum has more; these are implemented. */
export const EVALUATED_TYPES: readonly RuleType[] = ['STOP_LOSS', 'TRAILING_STOP', 'TAKE_PROFIT'];

/** True when a rule type watches for a fall rather than a rise. */
export function isProtective(type: RuleType): boolean {
  return type === 'STOP_LOSS' || type === 'TRAILING_STOP';
}

/**
 * The price a rule watches on a given bar.
 *
 * `CLOSE` is the default and the only basis that needs no caveat: a close is a
 * price the user could have acted on. The intraday bases answer a different
 * question — "was this level touched at any point today" — which is the right
 * question for a protective stop and the wrong one for deciding what you would
 * have received.
 */
export function watchedPrice(rule: Pick<StopRule, 'type' | 'triggerOn'>, bar: StopBar): Paisa {
  if (rule.triggerOn === 'CLOSE') return bar.close;
  if (rule.triggerOn === 'INTRADAY_LOW') return bar.low;
  return bar.high;
}

/**
 * The price a trailing stop's high-water mark follows.
 *
 * It matches the trigger basis. A stop that triggers on the close trails the
 * highest close, and one that triggers intraday trails the highest high —
 * mixing them would trail a stop up to a high the trigger basis never sees,
 * which tightens the stop for a reason the user cannot observe.
 */
export function ratchetPrice(rule: Pick<StopRule, 'triggerOn'>, bar: StopBar): Paisa {
  return rule.triggerOn === 'CLOSE' ? bar.close : bar.high;
}

/**
 * The stop implied by a high-water mark and a trail.
 *
 * A fixed `trailAmount` keeps the same rupee distance however far the stock
 * runs; `trailBps` widens with the price, which is usually what someone means
 * by "a 10% trailing stop". Exactly one must be set.
 */
export function stopFromTrail(
  highWaterMark: Paisa,
  trail: { trailAmount: Paisa | null; trailBps: number | null },
): Paisa {
  const hasAmount = trail.trailAmount !== null;
  const hasBps = trail.trailBps !== null;

  if (hasAmount === hasBps) {
    throw new StopError('a trailing stop needs exactly one of trailAmount or trailBps');
  }

  if (hasAmount) {
    const amount = trail.trailAmount as Paisa;
    if (amount <= 0) throw new StopError('trailAmount must be positive');
    // Clamped at zero rather than allowed negative: a trail wider than the
    // price itself is a mistake, but a negative stop would be a nonsense the
    // rest of the system would have to keep re-checking for.
    return paisa(Math.max(0, highWaterMark - amount));
  }

  const bps = trail.trailBps as number;
  if (bps <= 0) throw new StopError('trailBps must be positive');
  if (bps >= 10_000) throw new StopError('trailBps must be under 10000, which is the price itself');
  return paisa(highWaterMark - applyBasisPoints(highWaterMark, bps));
}

/**
 * The opening state for a new trailing stop.
 *
 * Armed from the current price, so the stop starts one trail below where the
 * stock is now. Arming from the position's cost instead would put the stop
 * below water on a holding that has already fallen, which is a stop-loss, not
 * a trailing stop — and the user asked for the one they asked for.
 */
export function armTrailingStop(
  price: Paisa,
  trail: { trailAmount: Paisa | null; trailBps: number | null },
): { highWaterMark: Paisa; effectiveStop: Paisa } {
  return { highWaterMark: price, effectiveStop: stopFromTrail(price, trail) };
}

/** Distance from a price to a level, in basis points of the level. */
function distanceBps(price: Paisa, level: Paisa): number {
  if (level <= 0) return 0;
  return Math.round(((price - level) / level) * 10_000);
}

/**
 * Evaluate one rule against one bar.
 *
 * Deliberately one bar at a time. Replaying a whole series is
 * `replayStops`, which calls this; keeping the single step pure is what makes
 * the nightly job and a historical replay provably agree.
 */
export function evaluateStop(rule: StopRule, bar: StopBar): StopOutcome {
  if (!EVALUATED_TYPES.includes(rule.type)) {
    return {
      kind: 'SKIPPED',
      reason: 'UNSUPPORTED_TYPE',
      message:
        `${rule.type} has no evaluator yet, so this rule will not fire. Stop-loss, ` +
        `trailing stop and take-profit are evaluated.`,
    };
  }

  // Expiry is checked against the bar's own date, not the clock. A replay over
  // last month must expire a rule on the day it expired, not today.
  if (rule.expiresAt !== null && bar.date > toIsoDate(rule.expiresAt)) {
    return {
      kind: 'EXPIRED',
      message: `Expired on ${formatTradingDay(toIsoDate(rule.expiresAt))}, before the ${formatTradingDay(bar.date)} close.`,
    };
  }

  const price = watchedPrice(rule, bar);

  if (rule.type === 'TRAILING_STOP') return evaluateTrailing(rule, bar, price);

  const level = rule.thresholdPrice;
  if (level === null) {
    return {
      kind: 'SKIPPED',
      reason: 'INCOMPLETE_RULE',
      message: `A ${rule.type} rule needs a price to watch, and this one has none.`,
    };
  }

  const breached = rule.type === 'STOP_LOSS' ? price <= level : price >= level;

  if (!breached) {
    return {
      kind: 'UNCHANGED',
      effectiveStop: level,
      headroomBps: Math.abs(distanceBps(price, level)),
    };
  }

  return {
    kind: 'TRIGGERED',
    triggerPrice: price,
    stopAtTrigger: level,
    highWaterMark: null,
    overshootBps: Math.abs(distanceBps(price, level)),
    message: describeTrigger(rule, bar, price, level, null),
  };
}

function evaluateTrailing(rule: StopRule, bar: StopBar, price: Paisa): StopOutcome {
  const mark = rule.highWaterMark;
  if (mark === null) {
    return {
      kind: 'SKIPPED',
      reason: 'INCOMPLETE_RULE',
      message:
        'A trailing stop needs the high-water mark it is trailing from, and this one ' +
        'has none. Arming it records the price at the time.',
    };
  }

  let inForce: Paisa;
  try {
    // Recomputed rather than trusted: a stored effectiveStop that disagrees
    // with the mark and the trail would silently decide when someone's holding
    // gets sold. The stored value is a cache for display, not the authority.
    inForce = stopFromTrail(mark, rule);
  } catch (error) {
    return {
      kind: 'SKIPPED',
      reason: 'INCOMPLETE_RULE',
      message: error instanceof StopError ? error.message : 'The trail is not usable.',
    };
  }

  /*
   * The trigger is tested first, against the stop as it stood at the start of
   * the bar — see the note at the top of this file. A bar that both makes a new
   * high and breaches the old stop is reported as a trigger at the old level,
   * because the data cannot say the high came first.
   */
  if (price <= inForce) {
    return {
      kind: 'TRIGGERED',
      triggerPrice: price,
      stopAtTrigger: inForce,
      highWaterMark: mark,
      overshootBps: Math.abs(distanceBps(price, inForce)),
      message: describeTrigger(rule, bar, price, inForce, mark),
    };
  }

  const candidate = ratchetPrice(rule, bar);
  if (candidate > mark) {
    const moved = stopFromTrail(candidate, rule);
    return {
      kind: 'MOVED',
      highWaterMark: candidate,
      effectiveStop: moved,
      previousStop: inForce,
      message:
        `${formatTradingDay(bar.date)}: new high of ${rupees(candidate)} lifted the stop from ` +
        `${rupees(inForce)} to ${rupees(moved)}.`,
    };
  }

  return { kind: 'UNCHANGED', effectiveStop: inForce, headroomBps: distanceBps(price, inForce) };
}

/**
 * The sentence attached to a trigger.
 *
 * Written here, next to the comparison that produced it, for the same reason
 * the prediction engine writes its factor reasons where it scores them: an
 * explanation assembled somewhere else can drift from what actually happened,
 * and then it is worse than no explanation.
 */
function describeTrigger(
  rule: StopRule,
  bar: StopBar,
  price: Paisa,
  level: Paisa,
  mark: Paisa | null,
): string {
  const basis =
    rule.triggerOn === 'CLOSE'
      ? 'closed at'
      : rule.triggerOn === 'INTRADAY_LOW'
        ? 'traded as low as'
        : 'traded as high as';

  const gapped = rule.triggerOn === 'CLOSE' && isProtective(rule.type) && bar.high < level;

  const head =
    rule.type === 'TAKE_PROFIT'
      ? `${formatTradingDay(bar.date)}: ${basis} ${rupees(price)}, at or above the ${rupees(level)} target.`
      : `${formatTradingDay(bar.date)}: ${basis} ${rupees(price)}, at or below the ${rupees(level)} stop.`;

  const trail =
    mark === null
      ? ''
      : ` The stop had trailed up from a high of ${rupees(mark)}.`;

  // A bar whose whole range sat under the stop means the level was never
  // available: the price gapped through it overnight. Saying so is the
  // difference between a useful alert and one that implies a fill at the stop.
  const gap = gapped
    ? ' The whole day traded below the stop, so the level itself was never available — ' +
      'the price gapped through it.'
    : '';

  return `${head}${trail}${gap}`;
}

/** Paisa to a plain rupee string for the messages above. */
function rupees(value: Paisa): string {
  const whole = Math.trunc(Math.abs(value) / 100);
  const fraction = Math.abs(value) % 100;
  const sign = value < 0 ? '-' : '';
  return `Rs ${sign}${whole.toLocaleString('en-US')}.${String(fraction).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-02-09" to "9 Feb 2026", for the prose in a stored message.
 *
 * Exported so the API's backtest verdict reads the same as the trigger
 * messages. An ISO date is unambiguous but sits badly in a sentence, and a
 * panel that shows both formats at once looks like two systems talking.
 *
 * Parsed by pattern rather than by `new Date`, so a trading day never slides
 * to the previous one for a reader east of UTC.
 */
export function formatTradingDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  if (name === undefined) return iso;
  return `${Number(day)} ${name} ${year}`;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface ReplayStep {
  bar: StopBar;
  outcome: StopOutcome;
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** The rule's state after the replay, for the caller to persist or compare. */
  finalState: Pick<StopRule, 'highWaterMark' | 'effectiveStop'>;
  /** The first trigger, if any. A rule fires once and then is no longer armed. */
  triggered: ReplayStep | null;
}

/**
 * Run a rule over a series, stopping at the first trigger.
 *
 * Two uses, and the second is why it exists. The nightly job replays the bars
 * since a rule was last checked, so a day the job did not run does not go
 * unexamined. And the UI can replay a proposed trail over past prices to show
 * where it would have taken the user out — which is the only way to tell
 * whether a 5% trail on a given stock is protection or just noise.
 */
export function replayStops(rule: StopRule, bars: readonly StopBar[]): ReplayResult {
  const steps: ReplayStep[] = [];
  let state: StopRule = { ...rule };

  for (const bar of bars) {
    const outcome = evaluateStop(state, bar);
    steps.push({ bar, outcome });

    if (outcome.kind === 'TRIGGERED' || outcome.kind === 'EXPIRED') {
      return {
        steps,
        finalState: { highWaterMark: state.highWaterMark, effectiveStop: state.effectiveStop },
        triggered: outcome.kind === 'TRIGGERED' ? { bar, outcome } : null,
      };
    }

    if (outcome.kind === 'MOVED') {
      state = {
        ...state,
        highWaterMark: outcome.highWaterMark,
        effectiveStop: outcome.effectiveStop,
      };
    }
  }

  return {
    steps,
    finalState: { highWaterMark: state.highWaterMark, effectiveStop: state.effectiveStop },
    triggered: null,
  };
}

/**
 * A trail width scaled to how much the stock actually moves, in basis points.
 *
 * A flat percentage is the wrong unit for a stop: 5% is noise on a volatile
 * small cap and a catastrophe on a utility. `multiple` ATRs below the price is
 * the width that adapts, and two to three is the usual range — tight enough to
 * limit the loss, wide enough not to be taken out by an ordinary day.
 *
 * Returned as basis points of the price so a caller can store it as a trail and
 * have it widen as the stock runs, rather than freezing today's volatility into
 * a fixed rupee distance.
 */
export function trailBpsFromAtr(
  price: Paisa,
  atrValue: number,
  multiple = 2.5,
): number | null {
  if (price <= 0 || !Number.isFinite(atrValue) || atrValue <= 0) return null;
  if (multiple <= 0) throw new StopError('the ATR multiple must be positive');

  const bps = Math.round(((atrValue * multiple) / price) * 10_000);
  // Floored at 1% and capped at 50%. Below one percent a stop is inside the
  // bid-ask noise of most PSX mid caps; above fifty it is not protecting
  // anything, and in both cases the ATR that produced it is suspect.
  if (bps < 100) return 100;
  if (bps > 5_000) return 5_000;
  return bps;
}
