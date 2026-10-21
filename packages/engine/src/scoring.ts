import { actionForScore, type FactorScore, type Signal } from '@psx/shared';
import { latest, tradedDayRatio } from './indicators/index.js';
import { FUNDAMENTAL_FACTORS } from './factors/fundamental.js';
import { TECHNICAL_FACTORS } from './factors/technical.js';
import { volumes, type EngineContext, type Factor } from './factors/types.js';
import { ENGINE_VERSION, HORIZON_WEIGHTS, type FactorWeights } from './weights.js';

/**
 * Aggregates factors into a signal.
 *
 * Three decisions here carry most of the honesty of the output.
 *
 * **Missing factors are renormalised away, not scored as zero.** A stock with
 * no published earnings would otherwise have seven fundamental factors voting
 * "neutral", which on the long-term horizon is more than half the weight and
 * would pull every signal towards HOLD. Renormalising over the factors that
 * reported gives a real answer from the available evidence, and `missingFactors`
 * plus the coverage term in `confidence` say how much evidence that was.
 *
 * **The engine refuses rather than guesses.** Too little history, or a stock
 * that barely trades, returns a refusal with a reason instead of a signal. On
 * the PSX this matters: several hundred listings go days without a trade, and
 * indicators computed across those gaps describe the gaps. A system that always
 * produces an answer teaches the user to ignore it.
 *
 * **Confidence measures the evidence, not the odds.** It is coverage times
 * agreement: how much of the model had data, and how much those factors agreed
 * with each other. It is explicitly not a probability of being right — that is
 * what settling predictions against outcomes measures, and it is tracked
 * separately.
 */

export interface ScoreOptions {
  factors?: readonly Factor[];
  weights?: FactorWeights;
  /** Minimum share of recent sessions that must have traded, 0..1. */
  minTradedDayRatio?: number;
  engineVersion?: string;
}

export type SignalRefusalCode = 'INSUFFICIENT_HISTORY' | 'ILLIQUID' | 'NO_FACTORS';

export interface SignalRefusal {
  ok: false;
  code: SignalRefusalCode;
  /** Shown to the user in place of a prediction. */
  reason: string;
}

export interface SignalSuccess {
  ok: true;
  signal: ScoredSignal;
}

export interface ScoredSignal extends Signal {
  engineVersion: string;
  /** Weighted share of the model that had data, 0..1. */
  coverage: number;
  /** How closely the reporting factors agreed, 0..1. */
  agreement: number;
  /** The price the signal was computed from, for settling it later. */
  priceAtSignal: number;
}

export type SignalResult = SignalSuccess | SignalRefusal;

export const ALL_FACTORS: readonly Factor[] = [...TECHNICAL_FACTORS, ...FUNDAMENTAL_FACTORS];

export function scoreSignal(context: EngineContext, options: ScoreOptions = {}): SignalResult {
  const factors = options.factors ?? ALL_FACTORS;
  const weights = options.weights ?? HORIZON_WEIGHTS[context.horizon];
  const minTraded = options.minTradedDayRatio ?? 0.5;

  const bars = context.bars;
  const asOf = context.dates[context.dates.length - 1];
  const lastBar = bars[bars.length - 1];

  if (lastBar === undefined || asOf === undefined) {
    return {
      ok: false,
      code: 'INSUFFICIENT_HISTORY',
      reason: 'No price history for this symbol.',
    };
  }

  // The shortest factor that carries real weight needs about 30 bars; below
  // that the signal would rest on one or two readings.
  if (bars.length < 30) {
    return {
      ok: false,
      code: 'INSUFFICIENT_HISTORY',
      reason:
        `Only ${bars.length} sessions of price history. At least 30 are needed before ` +
        `the indicators mean anything, and 200 before the long-term trend factors report.`,
    };
  }

  const traded = latest(tradedDayRatio(volumes(bars), Math.min(20, bars.length)));
  if (traded !== null && traded < minTraded) {
    return {
      ok: false,
      code: 'ILLIQUID',
      reason:
        `${context.symbol} traded on only ${Math.round(traded * 100)}% of the last ` +
        `${Math.min(20, bars.length)} sessions. Indicators built across non-trading days ` +
        `describe the gaps rather than the stock, so no signal is produced.`,
    };
  }

  // Evaluate everything, keeping the refusals as well as the reports: the count
  // of what could not be assessed is part of the output.
  const reported: Array<{ factor: Factor; weight: number; evaluation: NonNullable<ReturnType<Factor['evaluate']>> }> =
    [];
  let missingFactors = 0;
  let totalModelWeight = 0;

  for (const factor of factors) {
    const weight = weights[factor.key] ?? 0;
    if (weight <= 0) continue;
    totalModelWeight += weight;

    if (bars.length < factor.minBars) {
      missingFactors += 1;
      continue;
    }

    const evaluation = factor.evaluate(context);
    if (evaluation === null) {
      missingFactors += 1;
      continue;
    }
    reported.push({ factor, weight, evaluation });
  }

  if (reported.length === 0) {
    return {
      ok: false,
      code: 'NO_FACTORS',
      reason: 'No factor could be evaluated from the available data.',
    };
  }

  const reportingWeight = reported.reduce((sum, entry) => sum + entry.weight, 0);

  // Renormalise so the reporting factors carry the whole decision between them.
  const factorScores: FactorScore[] = reported.map((entry) => {
    const normalisedWeight = entry.weight / reportingWeight;
    const contribution = entry.evaluation.score * normalisedWeight;
    return {
      key: entry.factor.key,
      label: entry.factor.label,
      category: entry.factor.category,
      score: entry.evaluation.score,
      weight: Number(normalisedWeight.toFixed(4)),
      contribution: Number(contribution.toFixed(2)),
      value: entry.evaluation.value,
      display: entry.evaluation.display,
      reason: entry.evaluation.reason,
      ...(entry.evaluation.barIndices !== undefined
        ? { barIndices: entry.evaluation.barIndices }
        : {}),
    };
  });

  const total = factorScores.reduce((sum, factor) => sum + factor.contribution, 0);
  const score = Math.max(-100, Math.min(100, Number(total.toFixed(2))));

  const coverage = totalModelWeight === 0 ? 0 : reportingWeight / totalModelWeight;

  // Agreement as a weighted mean absolute deviation from the aggregate. Chosen
  // over counting matching signs because it works when the total sits near zero,
  // where every sign comparison is arbitrary.
  //
  // Worth knowing when reading it: high agreement has two causes. Factors all
  // pointing the same way strongly, and factors all reporting "nothing much".
  // A ranging stock is the second kind and comes out confidently neutral, which
  // is the honest reading. A strong trend, by contrast, often scores lower,
  // because a trend far enough advanced to be obvious also leaves RSI
  // overbought, and that tension is real rather than a defect.
  const deviation = factorScores.reduce(
    (sum, factor) => sum + factor.weight * Math.abs(factor.score - score),
    0,
  );
  const agreement = Math.max(0, Math.min(1, 1 - deviation / 100));

  const confidence = Math.max(0, Math.min(1, coverage * agreement));

  // Biggest movers first: the explanation should open with what decided it.
  const ordered = [...factorScores].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
  );

  return {
    ok: true,
    signal: {
      symbol: context.symbol,
      horizon: context.horizon,
      asOf,
      action: actionForScore(score),
      score,
      confidence: Number(confidence.toFixed(3)),
      factors: ordered,
      missingFactors,
      narrative: null,
      engineVersion: options.engineVersion ?? ENGINE_VERSION,
      coverage: Number(coverage.toFixed(3)),
      agreement: Number(agreement.toFixed(3)),
      priceAtSignal: lastBar.close,
    },
  };
}

/**
 * Groups a signal's factors by category for display.
 *
 * The UI shows the breakdown by group so a user can see at a glance that, say,
 * the trend block is carrying the call while valuation argues against it.
 */
export function groupByCategory(
  signal: ScoredSignal,
): Array<{ category: string; contribution: number; factors: FactorScore[] }> {
  const groups = new Map<string, FactorScore[]>();
  for (const factor of signal.factors) {
    const existing = groups.get(factor.category);
    if (existing === undefined) groups.set(factor.category, [factor]);
    else existing.push(factor);
  }

  return [...groups.entries()]
    .map(([category, factors]) => ({
      category,
      contribution: Number(factors.reduce((sum, f) => sum + f.contribution, 0).toFixed(2)),
      factors,
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

/**
 * Settles a past prediction against what happened.
 *
 * This is what turns the engine from an opinion into something measurable. A
 * directional call is judged against a threshold rather than any move at all,
 * so drifting sideways counts as NEUTRAL instead of flattering a BUY.
 */
export function settleSignal(
  signal: Pick<Signal, 'action'>,
  priceAtSignal: number,
  priceNow: number,
  thresholdPct = 3,
): 'HIT' | 'MISS' | 'NEUTRAL' {
  if (priceAtSignal <= 0) return 'NEUTRAL';
  const change = ((priceNow - priceAtSignal) / priceAtSignal) * 100;

  if (Math.abs(change) < thresholdPct) return 'NEUTRAL';

  const bullish = signal.action === 'BUY' || signal.action === 'STRONG_BUY';
  const bearish = signal.action === 'SELL' || signal.action === 'STRONG_SELL';

  if (bullish) return change > 0 ? 'HIT' : 'MISS';
  if (bearish) return change < 0 ? 'HIT' : 'MISS';
  // A HOLD was right if the price went nowhere, which the threshold already
  // caught above; a large move either way means it was wrong.
  return 'MISS';
}
