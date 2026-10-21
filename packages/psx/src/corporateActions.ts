import { paisa, type Paisa } from '@psx/shared';
import type { PsxDailyBar } from './parse/closingSummary.js';

/**
 * Detects corporate actions from the price series itself.
 *
 * Corporate actions are the thing most likely to silently corrupt a portfolio's
 * cost basis, and on the PSX they are frequent. The usual way to get them is to
 * parse the exchange's announcements, which are prose and arrive as PDFs.
 *
 * There is a much better signal sitting in the daily file. Each row carries
 * LDCP, the previous day's closing price, and on an ordinary day it equals the
 * close published the day before. On an ex-date it does not: the exchange
 * reduces the reference price by the value of the entitlement, so the gap
 * between the two is the action itself.
 *
 * On 21 Oct 2026 this fired for 21 of 489 equities, and every single delta was
 * an exact multiple of Rs 0.25 (0.25, 0.50, 1.00, 1.25, 1.50, 2.50, 3.50, 4.00,
 * 5.00, 6.00, 6.50, 10.00, 15.00) with the price always adjusted downward. Cash
 * dividends are declared in such units; arbitrary values would not line up this
 * way. That regularity is what makes the rule below trustworthy rather than a
 * guess, and it is asserted as a test against the fixtures.
 *
 * These are *candidates*, not confirmations. The exchange's announcements
 * remain authoritative, and a detection should be shown to the user for
 * acknowledgement before it is allowed to rewrite a cost basis. What this buys
 * is that nothing is ever missed silently: the portfolio can flag "ENGRO went
 * ex-dividend at Rs 10.00 on 21 Oct, confirm?" the morning it happens.
 */

export type AdjustmentKind = 'CASH_DIVIDEND' | 'SPLIT_OR_BONUS' | 'UNEXPLAINED';

export interface PriceAdjustment {
  symbol: string;
  /** The ex-date: the trading day whose LDCP was adjusted. */
  date: string;
  /** Close published on the previous trading day. */
  previousClose: Paisa;
  /** LDCP published on `date`, which disagrees with `previousClose`. */
  publishedLdcp: Paisa;
  /** previousClose - publishedLdcp. Positive when the price was marked down. */
  delta: Paisa;
  /** previousClose / publishedLdcp, the lens through which a split shows up. */
  impliedRatio: number;
  likely: AdjustmentKind;
  /** Per-share cash amount, when the delta reads as a dividend. */
  dividendPerShare: Paisa | null;
  /** Share multiplier, when the gap reads as a bonus or split. */
  shareRatio: number | null;
  /**
   * True when the gap fits both a dividend and a bonus issue. The user is asked
   * which it was rather than being told, since the two have very different
   * effects on a cost basis.
   */
  ambiguous: boolean;
}

/** Ratios a bonus or split issue realistically produces on the PSX. */
const COMMON_SHARE_RATIOS = [1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2, 2.5, 3, 4, 5, 10];

export interface DetectOptions {
  /**
   * Ignore gaps at or below this many paisa. The exchange rounds its reference
   * prices, so a one or two paisa difference is noise rather than an action.
   */
  tolerancePaisa?: number;
  /** Dividends are declared in these units; 25 paisa covers everything observed. */
  dividendStepPaisa?: number;
  /** How close an implied ratio must be to a common one, as a fraction. */
  ratioTolerance?: number;
}

/**
 * Compares two consecutive trading days and reports every symbol whose
 * reference price moved for a reason other than trading.
 *
 * `previousDay` and `today` must be adjacent trading days; passing a gap means
 * an intervening ex-date is attributed to the wrong session.
 */
export function detectAdjustments(
  previousDay: readonly PsxDailyBar[],
  today: readonly PsxDailyBar[],
  options: DetectOptions = {},
): PriceAdjustment[] {
  const tolerance = options.tolerancePaisa ?? 2;
  const dividendStep = options.dividendStepPaisa ?? 25;
  const ratioTolerance = options.ratioTolerance ?? 0.005;

  const priorClose = new Map<string, Paisa>();
  for (const bar of previousDay) priorClose.set(bar.symbol, bar.close);

  const adjustments: PriceAdjustment[] = [];

  for (const bar of today) {
    if (bar.ldcp === null) continue;
    const previousClose = priorClose.get(bar.symbol);
    if (previousClose === undefined) continue;

    const delta = paisa(previousClose - bar.ldcp);
    if (Math.abs(delta) <= tolerance) continue;

    const impliedRatio = bar.ldcp === 0 ? Number.POSITIVE_INFINITY : previousClose / bar.ldcp;

    const looksLikeDividend = delta > 0 && delta % dividendStep === 0;
    const matchedRatio =
      COMMON_SHARE_RATIOS.find(
        (ratio) => Math.abs(impliedRatio - ratio) / ratio <= ratioTolerance,
      ) ?? null;

    let likely: AdjustmentKind = 'UNEXPLAINED';
    let dividendPerShare: Paisa | null = null;
    let shareRatio: number | null = null;
    let ambiguous = false;

    // Order matters here. A 2:1 split halves the reference price, and half of a
    // round price is itself a multiple of 25 paisa, so the dividend rule would
    // happily claim it and report a Rs 50 dividend on a Rs 100 share. No listed
    // company pays a third of its share price as a single cash dividend, so a
    // large clean ratio is read as a split first.
    if (matchedRatio !== null && matchedRatio >= 1.5) {
      likely = 'SPLIT_OR_BONUS';
      shareRatio = matchedRatio;
    } else if (looksLikeDividend) {
      likely = 'CASH_DIVIDEND';
      dividendPerShare = delta;
      // A modest ratio such as 1.1 fits a 10% bonus issue and a 9% dividend
      // equally well. Both readings are recorded so the confirmation prompt can
      // say so instead of asserting the wrong one.
      if (matchedRatio !== null) {
        ambiguous = true;
        shareRatio = matchedRatio;
      }
    } else if (matchedRatio !== null) {
      likely = 'SPLIT_OR_BONUS';
      shareRatio = matchedRatio;
    }

    adjustments.push({
      symbol: bar.symbol,
      date: bar.date,
      previousClose,
      publishedLdcp: bar.ldcp,
      delta,
      impliedRatio,
      likely,
      dividendPerShare,
      shareRatio,
      ambiguous,
    });
  }

  return adjustments;
}

/**
 * Renders an adjustment as the sentence the user is asked to confirm.
 *
 * Kept here beside the detector so the wording cannot drift from the rule that
 * produced it.
 */
export function describeAdjustment(adjustment: PriceAdjustment): string {
  const rupees = (value: Paisa) => (value / 100).toFixed(2);

  switch (adjustment.likely) {
    case 'CASH_DIVIDEND':
      if (adjustment.ambiguous) {
        return `${adjustment.symbol} went ex-entitlement on ${adjustment.date}: this reads either as a Rs ${rupees(adjustment.delta)} dividend or as a ${adjustment.shareRatio}x bonus issue. Which was it?`;
      }
      return `${adjustment.symbol} went ex-dividend on ${adjustment.date}: reference price cut by Rs ${rupees(adjustment.delta)} per share.`;
    case 'SPLIT_OR_BONUS':
      return `${adjustment.symbol} appears to have gone ex-bonus or ex-split on ${adjustment.date}: reference price scaled by about ${adjustment.shareRatio}x.`;
    case 'UNEXPLAINED':
    default:
      return `${adjustment.symbol} had its reference price changed by Rs ${rupees(adjustment.delta)} on ${adjustment.date} for no reason this system recognises; check the exchange announcements.`;
  }
}
