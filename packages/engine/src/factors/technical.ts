import {
  adx,
  atrPercent,
  bollinger,
  ema,
  latest,
  macd,
  obv,
  roc,
  rsi,
  volumeRatio,
} from '../indicators/index.js';
import { detectPatterns } from '../patterns/candles.js';
import {
  clampScore,
  closes,
  highs,
  lows,
  pct,
  scaleBetween,
  volumes,
  type Factor,
  type FactorEvaluation,
} from './types.js';

/**
 * Technical factors: trend, momentum, volatility, volume, patterns and
 * relative strength.
 *
 * These are what the swing horizon leans on, and they are available for every
 * stock with enough price history, which on the PSX is a far larger set than
 * the stocks with usable published fundamentals.
 */

/**
 * Moving-average alignment: the clearest single statement of trend.
 *
 * Scored on the stack rather than on crossovers, because a crossover is a
 * moment and a stack is a state. 20 above 50 above 200 is an uptrend on every
 * timeframe at once; the inverse is a downtrend; the mixed cases in between are
 * scored by how much of the structure is intact.
 */
export const emaAlignment: Factor = {
  key: 'ema_alignment',
  label: 'Moving average alignment',
  category: 'TREND',
  minBars: 200,
  evaluate: (ctx): FactorEvaluation | null => {
    const price = closes(ctx.bars);
    const e20 = latest(ema(price, 20));
    const e50 = latest(ema(price, 50));
    const e200 = latest(ema(price, 200));
    if (e20 === null || e50 === null || e200 === null) return null;

    const relation = (a: number, b: number) => (a > b ? 1 : -1);
    // Three pairwise comparisons, each worth a third of the score.
    const structure = relation(e20, e50) + relation(e50, e200) + relation(e20, e200);
    const score = clampScore((structure / 3) * 85);

    const order =
      e20 > e50 && e50 > e200
        ? '20 > 50 > 200'
        : e20 < e50 && e50 < e200
          ? '20 < 50 < 200'
          : 'mixed';

    const reason =
      order === '20 > 50 > 200'
        ? `The 20, 50 and 200-day averages are stacked bullishly, so the trend points up on every timeframe.`
        : order === '20 < 50 < 200'
          ? `The 20, 50 and 200-day averages are stacked bearishly, so the trend points down on every timeframe.`
          : `The moving averages are not aligned, which is what a trend looks like while it is turning.`;

    return {
      score,
      value: structure,
      display: order,
      reason,
    };
  },
};

/** Distance from the 200-day average: how extended the trend is. */
export const priceVsLongAverage: Factor = {
  key: 'price_vs_ema200',
  label: 'Price against the 200-day average',
  category: 'TREND',
  minBars: 200,
  evaluate: (ctx): FactorEvaluation | null => {
    const price = closes(ctx.bars);
    const last = price[price.length - 1];
    const e200 = latest(ema(price, 200));
    if (last === undefined || e200 === null || e200 === 0) return null;

    const distance = ((last - e200) / e200) * 100;

    // Above the long average is bullish, but a long way above is stretched
    // rather than more bullish, so the score tops out and then eases back.
    const score =
      distance >= 0
        ? clampScore(distance > 30 ? 80 - (distance - 30) * 2 : distance * 2.6)
        : clampScore(distance < -30 ? -80 - (distance + 30) * 2 : distance * 2.6);

    return {
      score,
      value: Number(distance.toFixed(2)),
      display: `${pct(distance)} vs 200-day`,
      reason:
        distance >= 0
          ? `Trading ${pct(distance)} above its 200-day average${distance > 30 ? ', which is stretched far enough that a pullback would be ordinary' : ''}.`
          : `Trading ${pct(distance)} below its 200-day average${distance < -30 ? ', which is oversold enough that a bounce would be ordinary' : ''}.`,
    };
  },
};

/**
 * ADX: whether there is a trend at all.
 *
 * Direction comes from the alignment factor; this says whether that direction
 * means anything. Without it a stock drifting sideways under a bullish stack
 * scores the same as one genuinely trending, which is the most common way a
 * trend-following signal misleads.
 */
export const trendStrength: Factor = {
  key: 'adx_strength',
  label: 'Trend strength',
  category: 'TREND',
  minBars: 40,
  evaluate: (ctx): FactorEvaluation | null => {
    const value = latest(adx(highs(ctx.bars), lows(ctx.bars), closes(ctx.bars), 14));
    if (value === null) return null;

    const price = closes(ctx.bars);
    const e50 = latest(ema(price, 50));
    const last = price[price.length - 1];
    if (e50 === null || last === undefined) return null;

    // ADX is directionless, so the sign comes from where price sits relative to
    // its 50-day average, and the magnitude from the strength reading.
    const direction = last >= e50 ? 1 : -1;
    const magnitude = value < 20 ? 0 : scaleBetween(Math.min(value, 50), 20, 50);
    const score = clampScore(direction * Math.abs(magnitude) * 0.8);

    const describe =
      value < 20 ? 'no real trend' : value < 25 ? 'a weak trend' : value < 40 ? 'a solid trend' : 'a very strong trend';

    return {
      score,
      value: Number(value.toFixed(1)),
      display: `ADX ${value.toFixed(0)}`,
      reason:
        value < 20
          ? `ADX of ${value.toFixed(0)} means ${describe}: price is ranging, so trend signals carry little weight here.`
          : `ADX of ${value.toFixed(0)} indicates ${describe} ${direction > 0 ? 'upward' : 'downward'}.`,
    };
  },
};

/** RSI: overbought and oversold, read as mean reversion. */
export const rsiFactor: Factor = {
  key: 'rsi_14',
  label: 'RSI (14)',
  category: 'MOMENTUM',
  minBars: 20,
  evaluate: (ctx): FactorEvaluation | null => {
    const value = latest(rsi(closes(ctx.bars), 14));
    if (value === null) return null;

    // Oversold reads bullish and overbought bearish, so the scale is inverted:
    // 30 maps to +100 and 70 to -100, with 50 neutral.
    const score = clampScore(scaleBetween(value, 70, 30) * 0.9);

    const state =
      value >= 70 ? 'overbought' : value <= 30 ? 'oversold' : value >= 55 ? 'firm' : value <= 45 ? 'soft' : 'neutral';

    return {
      score,
      value: Number(value.toFixed(1)),
      display: `RSI ${value.toFixed(1)}`,
      reason:
        value >= 70
          ? `RSI of ${value.toFixed(1)} is overbought: the move has run hot and often pauses from here.`
          : value <= 30
            ? `RSI of ${value.toFixed(1)} is oversold: selling has been heavy enough that bounces are common from here.`
            : `RSI of ${value.toFixed(1)} is ${state}, with room to move either way.`,
    };
  },
};

/** MACD: the momentum cross, scored by histogram and its direction. */
export const macdFactor: Factor = {
  key: 'macd',
  label: 'MACD',
  category: 'MOMENTUM',
  minBars: 40,
  evaluate: (ctx): FactorEvaluation | null => {
    const price = closes(ctx.bars);
    const result = macd(price);
    const histogram = result.histogram;

    const current = latest(histogram);
    if (current === null) return null;

    const index = histogram.length - 1;
    const previous = index >= 1 ? (histogram[index - 1] ?? null) : null;

    const last = price[price.length - 1] ?? 1;
    // Normalised by price so the reading is comparable between a Rs 20 stock
    // and a Rs 2,000 one.
    const normalised = (current / last) * 100;
    let score = clampScore(normalised * 120);

    let crossed = '';
    if (previous !== null) {
      if (previous <= 0 && current > 0) {
        // A fresh cross is stronger evidence than a histogram that has been
        // positive for weeks.
        score = clampScore(score + 30);
        crossed = ' and has just crossed above its signal line';
      } else if (previous >= 0 && current < 0) {
        score = clampScore(score - 30);
        crossed = ' and has just crossed below its signal line';
      }
    }

    return {
      score,
      value: Number(current.toFixed(3)),
      display: `${current >= 0 ? 'above' : 'below'} signal`,
      reason: `MACD is ${current >= 0 ? 'above' : 'below'} its signal line${crossed}, which points momentum ${current >= 0 ? 'up' : 'down'}.`,
    };
  },
};

/** Rate of change: the plain question of how much it has moved. */
export const rateOfChange: Factor = {
  key: 'roc_20',
  label: 'Rate of change (20 days)',
  category: 'MOMENTUM',
  minBars: 25,
  evaluate: (ctx): FactorEvaluation | null => {
    const value = latest(roc(closes(ctx.bars), 20));
    if (value === null) return null;

    const score = clampScore(value * 4);

    return {
      score,
      value: Number(value.toFixed(2)),
      display: pct(value),
      reason: `${pct(value)} over the last 20 sessions.`,
    };
  },
};

/** Bollinger position: where price sits in its own recent range. */
export const bollingerPosition: Factor = {
  key: 'bollinger_position',
  label: 'Bollinger band position',
  category: 'VOLATILITY',
  minBars: 25,
  evaluate: (ctx): FactorEvaluation | null => {
    const result = bollinger(closes(ctx.bars), 20, 2);
    const position = latest(result.percentB);
    const width = latest(result.bandwidth);
    if (position === null) return null;

    // Riding the upper band is strength, not a sell. Scored with the trend
    // rather than against it, unlike RSI.
    const score = clampScore((position - 0.5) * 120);

    const where =
      position > 1
        ? 'above the upper band'
        : position > 0.8
          ? 'near the upper band'
          : position < 0
            ? 'below the lower band'
            : position < 0.2
              ? 'near the lower band'
              : 'mid-band';

    const squeeze = width !== null && width < 8 ? ` Bands are tight (${width.toFixed(1)}%), which often precedes a larger move.` : '';

    return {
      score,
      value: Number(position.toFixed(3)),
      display: where,
      reason: `Price is ${where} of its 20-day range.${squeeze}`,
    };
  },
};

/**
 * Volatility regime.
 *
 * Deliberately a small negative weight rather than a directional call. High
 * volatility does not predict direction; it means any position needs to be
 * smaller, and it makes every other signal less reliable. Scoring it as
 * bearish would be wrong, so it is scored as a mild drag on conviction.
 */
export const volatilityRegime: Factor = {
  key: 'atr_percent',
  label: 'Volatility',
  category: 'VOLATILITY',
  minBars: 20,
  evaluate: (ctx): FactorEvaluation | null => {
    const value = latest(atrPercent(highs(ctx.bars), lows(ctx.bars), closes(ctx.bars), 14));
    if (value === null) return null;

    const score = clampScore(value <= 2 ? 20 : value >= 6 ? -60 : 20 - ((value - 2) / 4) * 80);

    const regime = value < 1.5 ? 'quiet' : value < 3 ? 'normal' : value < 5 ? 'elevated' : 'very high';

    return {
      score,
      value: Number(value.toFixed(2)),
      display: `ATR ${value.toFixed(1)}%`,
      reason:
        `Daily range averages ${value.toFixed(1)}% of price (${regime}), which sets how wide a stop has to be` +
        `${value >= 5 ? ' and argues for a smaller position' : ''}.`,
    };
  },
};

/** Volume surge: whether today's move carried participation. */
export const volumeSurge: Factor = {
  key: 'volume_ratio',
  label: 'Volume against average',
  category: 'VOLUME',
  minBars: 25,
  evaluate: (ctx): FactorEvaluation | null => {
    const ratio = latest(volumeRatio(volumes(ctx.bars), 20));
    if (ratio === null) return null;

    const bars = ctx.bars;
    const last = bars[bars.length - 1];
    const previous = bars[bars.length - 2];
    if (last === undefined || previous === undefined) return null;

    const up = last.close >= previous.close;
    // Volume confirms whichever way price went. Heavy volume on a down day is
    // distribution, not strength.
    const conviction = Math.min(ratio, 3);
    const magnitude = conviction <= 1 ? (conviction - 1) * 40 : (conviction - 1) * 45;
    const score = clampScore((up ? 1 : -1) * magnitude);

    return {
      score,
      value: Number(ratio.toFixed(2)),
      display: `${ratio.toFixed(1)}x average`,
      reason:
        ratio >= 1.5
          ? `Volume ran ${ratio.toFixed(1)}x its 20-day average on ${up ? 'an up' : 'a down'} day, so the move carried real participation.`
          : ratio <= 0.6
            ? `Volume was only ${ratio.toFixed(1)}x average, so there is little conviction behind the move.`
            : `Volume was ${ratio.toFixed(1)}x average: an ordinary session.`,
    };
  },
};

/** OBV trend: accumulation or distribution over the last month. */
export const accumulation: Factor = {
  key: 'obv_trend',
  label: 'Accumulation (OBV)',
  category: 'VOLUME',
  minBars: 30,
  evaluate: (ctx): FactorEvaluation | null => {
    const series = obv(closes(ctx.bars), volumes(ctx.bars));
    const current = latest(series);
    const index = series.length - 1 - 20;
    const past = index >= 0 ? (series[index] ?? null) : null;
    if (current === null || past === null) return null;

    const totalVolume = volumes(ctx.bars)
      .slice(-20)
      .reduce((sum, value) => sum + value, 0);
    if (totalVolume === 0) return null;

    // Net signed volume as a share of all volume traded: +1 means every share
    // changed hands on an up day.
    const netShare = (current - past) / totalVolume;
    const score = clampScore(netShare * 160);

    return {
      score,
      value: Number(netShare.toFixed(3)),
      display: netShare >= 0 ? 'accumulating' : 'distributing',
      reason:
        netShare >= 0.15
          ? `Volume has been concentrated on up days over the last month: accumulation.`
          : netShare <= -0.15
            ? `Volume has been concentrated on down days over the last month: distribution.`
            : `Up-day and down-day volume are roughly balanced over the last month.`,
    };
  },
};

/**
 * Candlestick patterns.
 *
 * Aggregated into one factor rather than one per pattern, so a day that happens
 * to satisfy three overlapping definitions does not get counted three times.
 * The strongest match leads and the rest adjust it.
 */
export const candlestickPatterns: Factor = {
  key: 'candlestick',
  label: 'Candlestick patterns',
  category: 'PATTERN',
  minBars: 15,
  evaluate: (ctx): FactorEvaluation | null => {
    const matches = detectPatterns(ctx.bars, { lookback: 3, minStrength: 20 });
    if (matches.length === 0) return null;

    const directional = matches.filter((match) => match.direction !== 'NEUTRAL');
    if (directional.length === 0) {
      const neutral = matches[0];
      if (neutral === undefined) return null;
      return {
        score: 0,
        value: null,
        display: neutral.label,
        reason: `${neutral.label}: ${neutral.description}`,
        barIndices: neutral.barIndices,
      };
    }

    const strongest = directional.reduce((best, match) =>
      match.strength > best.strength ? match : best,
    );

    let score = (strongest.direction === 'BULLISH' ? 1 : -1) * strongest.strength * 0.75;

    // A second pattern pointing the same way reinforces; one pointing the other
    // way means the signals are in conflict and neither should be trusted much.
    for (const match of directional) {
      if (match === strongest) continue;
      const agrees = match.direction === strongest.direction;
      score += (agrees ? 1 : -1) * (strongest.direction === 'BULLISH' ? 1 : -1) * match.strength * 0.2;
    }

    const barIndices = [...new Set(directional.flatMap((match) => match.barIndices))].sort(
      (a, b) => a - b,
    );

    const others = directional.filter((match) => match !== strongest);
    const extra =
      others.length === 0
        ? ''
        : ` Also present: ${others.map((match) => match.label.toLowerCase()).join(', ')}.`;

    return {
      score: clampScore(score),
      value: strongest.strength,
      display: strongest.label,
      reason: `${strongest.label}. ${strongest.description}${extra}`,
      barIndices,
    };
  },
};

/**
 * Relative strength against the index.
 *
 * The question this answers is whether the stock is moving because the market
 * is, or on its own account. A 10% gain in a market up 12% is underperformance,
 * and an engine without this factor would score it as momentum.
 */
export const relativeStrength: Factor = {
  key: 'relative_strength',
  label: 'Strength against the index',
  category: 'MARKET',
  minBars: 30,
  evaluate: (ctx): FactorEvaluation | null => {
    const market = ctx.marketBars;
    if (market === undefined || market.length < 25) return null;

    const stockRoc = latest(roc(closes(ctx.bars), 20));
    const marketRoc = latest(roc(closes(market), 20));
    if (stockRoc === null || marketRoc === null) return null;

    const difference = stockRoc - marketRoc;
    const score = clampScore(difference * 6);

    return {
      score,
      value: Number(difference.toFixed(2)),
      display: `${pct(difference)} vs index`,
      reason:
        difference >= 0
          ? `Up ${pct(stockRoc)} over 20 sessions against the index's ${pct(marketRoc)}: outperforming by ${pct(difference)}.`
          : `${pct(stockRoc)} over 20 sessions against the index's ${pct(marketRoc)}: lagging by ${pct(Math.abs(difference))}.`,
    };
  },
};

export const TECHNICAL_FACTORS: Factor[] = [
  emaAlignment,
  priceVsLongAverage,
  trendStrength,
  rsiFactor,
  macdFactor,
  rateOfChange,
  bollingerPosition,
  volatilityRegime,
  volumeSurge,
  accumulation,
  candlestickPatterns,
  relativeStrength,
];
