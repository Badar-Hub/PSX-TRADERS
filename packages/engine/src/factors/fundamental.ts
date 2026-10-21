import { clampScore, pct, scaleBetween, type Bar, type Factor, type FactorEvaluation } from './types.js';

/**
 * Fundamental factors: valuation, growth, quality and leverage.
 *
 * These carry most of the weight on the long-term horizon and very little on
 * the swing horizon, which is the main thing that makes the two predictions
 * different rather than the same number relabelled.
 *
 * Every one returns null without data, and on the PSX that will be the common
 * case at first: the exchange's bulk files carry no earnings, so fundamentals
 * arrive by manual entry or a paid feed. The aggregator reports how many
 * factors were missing so a long-term signal built only on price data is
 * visibly thinner rather than quietly overconfident.
 */

/** Latest close, which every valuation ratio is measured against. */
const currentPrice = (bars: readonly Bar[]): number | null => bars[bars.length - 1]?.close ?? null;

/**
 * P/E against the sector rather than against an absolute threshold.
 *
 * A P/E of 12 is expensive for a Pakistani cement producer and cheap for a
 * consumer staple. Judging it against the sector is the only version of this
 * factor that transfers across the board.
 */
export const peVsSector: Factor = {
  key: 'pe_vs_sector',
  label: 'P/E against the sector',
  category: 'VALUATION',
  minBars: 1,
  evaluate: (ctx): FactorEvaluation | null => {
    const eps = ctx.fundamentals?.eps;
    const sectorPe = ctx.fundamentals?.sectorPe;
    const price = currentPrice(ctx.bars);
    if (eps === undefined || sectorPe === undefined || price === null) return null;
    // A loss-making company has no meaningful P/E; reporting one would be
    // arithmetic rather than analysis.
    if (eps <= 0 || sectorPe <= 0) return null;

    const pe = price / eps;
    const relative = pe / sectorPe;

    // Half the sector multiple scores +100, double scores -100.
    const score = clampScore(scaleBetween(relative, 2, 0.5));

    return {
      score,
      value: Number(pe.toFixed(2)),
      display: `P/E ${pe.toFixed(1)} vs ${sectorPe.toFixed(1)}`,
      reason:
        relative < 0.85
          ? `Trading on ${pe.toFixed(1)}x earnings against a sector average of ${sectorPe.toFixed(1)}x: cheap relative to peers.`
          : relative > 1.15
            ? `Trading on ${pe.toFixed(1)}x earnings against a sector average of ${sectorPe.toFixed(1)}x: expensive relative to peers.`
            : `Trading on ${pe.toFixed(1)}x earnings, in line with the sector's ${sectorPe.toFixed(1)}x.`,
    };
  },
};

/** Price to book: the balance-sheet view of value. */
export const priceToBook: Factor = {
  key: 'price_to_book',
  label: 'Price to book',
  category: 'VALUATION',
  minBars: 1,
  evaluate: (ctx): FactorEvaluation | null => {
    const book = ctx.fundamentals?.bookValuePerShare;
    const price = currentPrice(ctx.bars);
    if (book === undefined || book <= 0 || price === null) return null;

    const pb = price / book;
    // Below book is cheap, 3x and above is dear.
    const score = clampScore(scaleBetween(pb, 3, 0.7));

    return {
      score,
      value: Number(pb.toFixed(2)),
      display: `P/B ${pb.toFixed(2)}`,
      reason:
        pb < 1
          ? `Priced at ${pb.toFixed(2)}x book value, below the net assets on the balance sheet.`
          : `Priced at ${pb.toFixed(2)}x book value.`,
    };
  },
};

/** Dividend yield, which on the PSX is a large part of the return. */
export const dividendYield: Factor = {
  key: 'dividend_yield',
  label: 'Dividend yield',
  category: 'VALUATION',
  minBars: 1,
  evaluate: (ctx): FactorEvaluation | null => {
    const dividend = ctx.fundamentals?.dividendPerShare;
    const price = currentPrice(ctx.bars);
    if (dividend === undefined || price === null || price === 0) return null;

    const yieldPct = (dividend / price) * 100;
    // Nothing paid is not a negative: a growth company reinvesting is a
    // different proposition, not a worse one. So the floor is neutral.
    const score = clampScore(yieldPct <= 0 ? 0 : scaleBetween(Math.min(yieldPct, 12), 0, 10));

    return {
      score,
      value: Number(yieldPct.toFixed(2)),
      display: `${yieldPct.toFixed(1)}% yield`,
      reason:
        yieldPct >= 8
          ? `Yielding ${yieldPct.toFixed(1)}%, a substantial income return while held.`
          : yieldPct > 0
            ? `Yielding ${yieldPct.toFixed(1)}%.`
            : `Pays no dividend.`,
    };
  },
};

/** Earnings growth: the engine of a long-term return. */
export const earningsGrowth: Factor = {
  key: 'eps_growth',
  label: 'Earnings growth',
  category: 'GROWTH',
  minBars: 1,
  evaluate: (ctx): FactorEvaluation | null => {
    const growth = ctx.fundamentals?.epsGrowthPct;
    if (growth === undefined) return null;

    // -20% scores -100, +30% scores +100. Beyond that, more growth does not
    // make the case much stronger and often is not sustainable.
    const score = clampScore(scaleBetween(Math.max(-40, Math.min(60, growth)), -20, 30));

    return {
      score,
      value: Number(growth.toFixed(2)),
      display: pct(growth),
      reason:
        growth >= 15
          ? `Earnings per share grew ${pct(growth)} year on year.`
          : growth >= 0
            ? `Earnings per share grew ${pct(growth)}, modest but positive.`
            : `Earnings per share fell ${pct(Math.abs(growth))} year on year.`,
    };
  },
};

/**
 * Revenue growth, as a check on earnings growth.
 *
 * Earnings can be grown for a while by cutting costs; revenue growth is harder
 * to manufacture. The two disagreeing is itself informative, which is why both
 * are scored rather than only the headline figure.
 */
export const revenueGrowth: Factor = {
  key: 'revenue_growth',
  label: 'Revenue growth',
  category: 'GROWTH',
  minBars: 1,
  evaluate: (ctx): FactorEvaluation | null => {
    const growth = ctx.fundamentals?.revenueGrowthPct;
    if (growth === undefined) return null;

    const score = clampScore(scaleBetween(Math.max(-30, Math.min(50, growth)), -15, 25));

    const eps = ctx.fundamentals?.epsGrowthPct;
    const divergence =
      eps !== undefined && eps > 10 && growth < 0
        ? ` Earnings are up while revenue is down, so the growth is coming from margins rather than sales.`
        : '';

    return {
      score,
      value: Number(growth.toFixed(2)),
      display: pct(growth),
      reason: `Revenue ${growth >= 0 ? 'grew' : 'fell'} ${pct(Math.abs(growth))} year on year.${divergence}`,
    };
  },
};

/** Return on equity: how well the business uses its capital. */
export const returnOnEquity: Factor = {
  key: 'roe',
  label: 'Return on equity',
  category: 'QUALITY',
  minBars: 1,
  evaluate: (ctx): FactorEvaluation | null => {
    const roe = ctx.fundamentals?.roePct;
    if (roe === undefined) return null;

    const score = clampScore(scaleBetween(Math.max(-10, Math.min(40, roe)), 0, 25));

    return {
      score,
      value: Number(roe.toFixed(2)),
      display: `ROE ${roe.toFixed(1)}%`,
      reason:
        roe >= 20
          ? `Return on equity of ${roe.toFixed(1)}%: the business compounds capital well.`
          : roe >= 10
            ? `Return on equity of ${roe.toFixed(1)}%: respectable.`
            : roe >= 0
              ? `Return on equity of only ${roe.toFixed(1)}%: capital is working hard for little.`
              : `Return on equity is negative at ${roe.toFixed(1)}%: the business is losing money.`,
    };
  },
};

/**
 * Debt to equity.
 *
 * Weighted more heavily than it would be in a lower-rate market. Pakistani
 * policy rates have spent long stretches in the teens or higher, and at those
 * rates a leveraged balance sheet is the single most common reason an otherwise
 * sound company runs into trouble.
 */
export const leverage: Factor = {
  key: 'debt_to_equity',
  label: 'Debt to equity',
  category: 'LEVERAGE',
  minBars: 1,
  evaluate: (ctx): FactorEvaluation | null => {
    const ratio = ctx.fundamentals?.debtToEquity;
    if (ratio === undefined || ratio < 0) return null;

    // No debt scores +100, 2x equity scores -100.
    const score = clampScore(scaleBetween(Math.min(ratio, 3), 2, 0));

    return {
      score,
      value: Number(ratio.toFixed(2)),
      display: `D/E ${ratio.toFixed(2)}`,
      reason:
        ratio <= 0.3
          ? `Debt of ${ratio.toFixed(2)}x equity: a conservative balance sheet.`
          : ratio <= 1
            ? `Debt of ${ratio.toFixed(2)}x equity: manageable.`
            : `Debt of ${ratio.toFixed(2)}x equity, which is heavy at Pakistani interest rates.`,
    };
  },
};

export const FUNDAMENTAL_FACTORS: Factor[] = [
  peVsSector,
  priceToBook,
  dividendYield,
  earningsGrowth,
  revenueGrowth,
  returnOnEquity,
  leverage,
];
