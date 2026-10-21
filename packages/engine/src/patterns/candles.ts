/**
 * Candlestick pattern detection.
 *
 * Two things separate this from shape matching.
 *
 * **Context is required.** A hammer is a reversal signal at the bottom of a
 * decline. The identical shape partway up a rally is just a day with a long
 * lower wick, and calling it bullish is how a pattern engine ends up firing
 * constantly and meaning nothing. Every reversal pattern here checks the trend
 * it is supposed to be reversing, and will not report itself without it.
 *
 * **Strength is graded, not boolean.** A body that engulfs the previous one by
 * a hair is weaker evidence than one that swallows it whole, and the factor
 * score should reflect that rather than treating both as "engulfing: true".
 *
 * Every match carries the bar indices it formed on, so the chart can highlight
 * exactly the candles behind a prediction when the user asks why.
 */

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PatternDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface PatternMatch {
  key: string;
  label: string;
  direction: PatternDirection;
  /** 0..100, how closely the formation matches its ideal proportions. */
  strength: number;
  /** Bars forming the pattern, oldest first, as indices into the input. */
  barIndices: number[];
  /** One sentence, generated from the numbers rather than a fixed string. */
  description: string;
}

interface BarMetrics {
  body: number;
  absBody: number;
  range: number;
  upperShadow: number;
  lowerShadow: number;
  isBullish: boolean;
  isBearish: boolean;
  midpoint: number;
}

function metrics(bar: Bar): BarMetrics {
  const body = bar.close - bar.open;
  return {
    body,
    absBody: Math.abs(body),
    range: bar.high - bar.low,
    upperShadow: bar.high - Math.max(bar.open, bar.close),
    lowerShadow: Math.min(bar.open, bar.close) - bar.low,
    isBullish: bar.close > bar.open,
    isBearish: bar.close < bar.open,
    midpoint: (bar.high + bar.low) / 2,
  };
}

/**
 * Average body size over the bars before `index`, used to judge whether a body
 * is unusually large for this stock rather than large in absolute terms.
 */
function averageBody(bars: readonly Bar[], index: number, lookback = 10): number {
  const start = Math.max(0, index - lookback);
  let sum = 0;
  let count = 0;
  for (let i = start; i < index; i += 1) {
    const bar = bars[i];
    if (bar === undefined) continue;
    sum += Math.abs(bar.close - bar.open);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Direction of the run leading into `index`, measured over `period` bars.
 *
 * Returns the percentage change. Reversal patterns require this to oppose the
 * direction they predict, which is the context check described at the top.
 */
function priorTrend(bars: readonly Bar[], index: number, period = 5): number | null {
  const start = index - period;
  if (start < 0) return null;
  const from = bars[start]?.close;
  const to = bars[index - 1]?.close;
  if (from === undefined || to === undefined || from === 0) return null;
  return ((to - from) / from) * 100;
}

/** Scales a ratio into a 0..100 strength, saturating at `ideal`. */
function gradeStrength(actual: number, minimum: number, ideal: number): number {
  if (actual <= minimum) return 0;
  if (actual >= ideal) return 100;
  return Math.round(((actual - minimum) / (ideal - minimum)) * 100);
}

const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;

type Detector = (bars: readonly Bar[], index: number) => PatternMatch | null;

/**
 * Engulfing: a body that completely covers the previous one, after a run the
 * other way. The strongest and most reliable of the two-bar reversals.
 */
const engulfing: Detector = (bars, index) => {
  const current = bars[index];
  const previous = bars[index - 1];
  if (current === undefined || previous === undefined) return null;

  const c = metrics(current);
  const p = metrics(previous);
  if (c.absBody === 0 || p.absBody === 0) return null;

  const covers = current.close > previous.open && current.open < previous.close;
  const coversDown = current.close < previous.open && current.open > previous.close;

  const trend = priorTrend(bars, index);
  if (trend === null) return null;

  const ratio = c.absBody / p.absBody;

  if (c.isBullish && p.isBearish && covers && trend < 0) {
    return {
      key: 'bullish_engulfing',
      label: 'Bullish engulfing',
      direction: 'BULLISH',
      strength: gradeStrength(ratio, 1, 2.5),
      barIndices: [index - 1, index],
      description:
        `A bullish body ${ratio.toFixed(1)}x the previous day's engulfed it entirely, ` +
        `after a ${pct(trend)} slide.`,
    };
  }

  if (c.isBearish && p.isBullish && coversDown && trend > 0) {
    return {
      key: 'bearish_engulfing',
      label: 'Bearish engulfing',
      direction: 'BEARISH',
      strength: gradeStrength(ratio, 1, 2.5),
      barIndices: [index - 1, index],
      description:
        `A bearish body ${ratio.toFixed(1)}x the previous day's engulfed it entirely, ` +
        `after a ${pct(trend)} run up.`,
    };
  }

  return null;
};

/** Hammer and shooting star: a long shadow rejecting one direction. */
const hammerOrStar: Detector = (bars, index) => {
  const bar = bars[index];
  if (bar === undefined) return null;
  const m = metrics(bar);
  if (m.range === 0 || m.absBody === 0) return null;

  const trend = priorTrend(bars, index);
  if (trend === null) return null;

  const lowerRatio = m.lowerShadow / m.absBody;
  const upperRatio = m.upperShadow / m.absBody;

  // A hammer needs a long lower shadow, a small upper one, and a decline to
  // reverse. Without the decline it is just a wick.
  if (lowerRatio >= 2 && upperRatio <= 0.5 && trend < -2) {
    return {
      key: 'hammer',
      label: 'Hammer',
      direction: 'BULLISH',
      strength: gradeStrength(lowerRatio, 2, 4),
      barIndices: [index],
      description:
        `Price fell intraday then closed back near the high, leaving a lower shadow ` +
        `${lowerRatio.toFixed(1)}x the body, after a ${pct(trend)} decline.`,
    };
  }

  if (upperRatio >= 2 && lowerRatio <= 0.5 && trend > 2) {
    return {
      key: 'shooting_star',
      label: 'Shooting star',
      direction: 'BEARISH',
      strength: gradeStrength(upperRatio, 2, 4),
      barIndices: [index],
      description:
        `Price rallied intraday then gave it all back, leaving an upper shadow ` +
        `${upperRatio.toFixed(1)}x the body, after a ${pct(trend)} advance.`,
    };
  }

  return null;
};

/** Doji: open and close almost equal. Indecision, not direction. */
const doji: Detector = (bars, index) => {
  const bar = bars[index];
  if (bar === undefined) return null;
  const m = metrics(bar);
  if (m.range === 0) return null;

  const bodyShare = m.absBody / m.range;
  if (bodyShare > 0.05) return null;

  const average = averageBody(bars, index);
  // A doji after a run of similarly tiny bodies says nothing; it is only
  // informative when the stock has been making real moves.
  if (average > 0 && m.range < average) return null;

  return {
    key: 'doji',
    label: 'Doji',
    direction: 'NEUTRAL',
    strength: gradeStrength(1 - bodyShare, 0.95, 1),
    barIndices: [index],
    description:
      `Opened and closed at virtually the same price across a range of ` +
      `${m.range.toFixed(2)}: buyers and sellers in balance.`,
  };
};

/** Morning and evening star: a three-bar reversal around a small middle body. */
const star: Detector = (bars, index) => {
  const third = bars[index];
  const second = bars[index - 1];
  const first = bars[index - 2];
  if (third === undefined || second === undefined || first === undefined) return null;

  const t = metrics(third);
  const s = metrics(second);
  const f = metrics(first);
  if (f.absBody === 0 || t.absBody === 0) return null;

  // The middle bar must be small relative to the two around it: that is the
  // hesitation the pattern is about.
  const smallMiddle = s.absBody < f.absBody * 0.5 && s.absBody < t.absBody * 0.5;
  if (!smallMiddle) return null;

  const trend = priorTrend(bars, index - 2);
  if (trend === null) return null;

  const recovery = t.absBody / f.absBody;

  if (f.isBearish && t.isBullish && third.close > f.midpoint && trend < 0) {
    return {
      key: 'morning_star',
      label: 'Morning star',
      direction: 'BULLISH',
      strength: gradeStrength(recovery, 0.5, 1.2),
      barIndices: [index - 2, index - 1, index],
      description:
        `A heavy down day, then a day of hesitation, then a recovery closing above ` +
        `the midpoint of the decline.`,
    };
  }

  if (f.isBullish && t.isBearish && third.close < f.midpoint && trend > 0) {
    return {
      key: 'evening_star',
      label: 'Evening star',
      direction: 'BEARISH',
      strength: gradeStrength(recovery, 0.5, 1.2),
      barIndices: [index - 2, index - 1, index],
      description:
        `A strong up day, then a day of hesitation, then a reversal closing below ` +
        `the midpoint of the advance.`,
    };
  }

  return null;
};

/** Three soldiers and crows: three consecutive bodies in the same direction. */
const threeInARow: Detector = (bars, index) => {
  const window = [bars[index - 2], bars[index - 1], bars[index]];
  if (window.some((bar) => bar === undefined)) return null;
  const [first, second, third] = window as [Bar, Bar, Bar];

  const ms = [metrics(first), metrics(second), metrics(third)];
  if (ms.some((m) => m.range === 0)) return null;

  // Each body must dominate its own range. Comparing against the average body
  // alone is not enough: three doji in a row have a tiny average too, so they
  // pass that test while being the opposite of what this pattern describes.
  if (ms.some((m) => m.absBody / m.range < 0.5)) return null;

  // And they must be real moves for this stock, not three small bars during a
  // quiet stretch.
  const average = averageBody(bars, index - 2);
  if (average > 0 && ms.some((m) => m.absBody < average * 0.5)) return null;

  const allBullish = ms.every((m) => m.isBullish);
  const allBearish = ms.every((m) => m.isBearish);

  const bodyShare = ms.reduce((sum, m) => sum + m.absBody / m.range, 0) / 3;

  if (allBullish && second.close > first.close && third.close > second.close) {
    return {
      key: 'three_white_soldiers',
      label: 'Three white soldiers',
      direction: 'BULLISH',
      strength: gradeStrength(bodyShare, 0.5, 0.85),
      barIndices: [index - 2, index - 1, index],
      description: `Three consecutive higher closes with solid bodies: steady accumulation.`,
    };
  }

  if (allBearish && second.close < first.close && third.close < second.close) {
    return {
      key: 'three_black_crows',
      label: 'Three black crows',
      direction: 'BEARISH',
      strength: gradeStrength(bodyShare, 0.5, 0.85),
      barIndices: [index - 2, index - 1, index],
      description: `Three consecutive lower closes with solid bodies: persistent selling.`,
    };
  }

  return null;
};

/** Marubozu: a body filling almost the whole range, with no shadows. */
const marubozu: Detector = (bars, index) => {
  const bar = bars[index];
  if (bar === undefined) return null;
  const m = metrics(bar);
  if (m.range === 0) return null;

  const bodyShare = m.absBody / m.range;
  if (bodyShare < 0.95) return null;

  const average = averageBody(bars, index);
  if (average > 0 && m.absBody < average) return null;

  return {
    key: m.isBullish ? 'bullish_marubozu' : 'bearish_marubozu',
    label: m.isBullish ? 'Bullish marubozu' : 'Bearish marubozu',
    direction: m.isBullish ? 'BULLISH' : 'BEARISH',
    strength: gradeStrength(bodyShare, 0.95, 1),
    barIndices: [index],
    description:
      `${m.isBullish ? 'Opened at the low and closed at the high' : 'Opened at the high and closed at the low'}: ` +
      `one side controlled the whole session.`,
  };
};

/** Piercing line and dark cloud cover: a half-reversal through the midpoint. */
const piercing: Detector = (bars, index) => {
  const current = bars[index];
  const previous = bars[index - 1];
  if (current === undefined || previous === undefined) return null;

  const c = metrics(current);
  const p = metrics(previous);
  if (c.absBody === 0 || p.absBody === 0) return null;

  const trend = priorTrend(bars, index);
  if (trend === null) return null;

  const previousMid = (previous.open + previous.close) / 2;

  // Opens beyond the previous body, then closes back past its midpoint: not a
  // full engulfing, but more than a pause.
  if (
    c.isBullish &&
    p.isBearish &&
    current.open < previous.close &&
    current.close > previousMid &&
    current.close < previous.open &&
    trend < 0
  ) {
    const penetration = (current.close - previous.close) / p.absBody;
    return {
      key: 'piercing_line',
      label: 'Piercing line',
      direction: 'BULLISH',
      strength: gradeStrength(penetration, 0.5, 0.9),
      barIndices: [index - 1, index],
      description:
        `Opened below the previous close then recovered ` +
        `${(penetration * 100).toFixed(0)}% of the prior day's fall.`,
    };
  }

  if (
    c.isBearish &&
    p.isBullish &&
    current.open > previous.close &&
    current.close < previousMid &&
    current.close > previous.open &&
    trend > 0
  ) {
    const penetration = (previous.close - current.close) / p.absBody;
    return {
      key: 'dark_cloud_cover',
      label: 'Dark cloud cover',
      direction: 'BEARISH',
      strength: gradeStrength(penetration, 0.5, 0.9),
      barIndices: [index - 1, index],
      description:
        `Opened above the previous close then gave back ` +
        `${(penetration * 100).toFixed(0)}% of the prior day's gain.`,
    };
  }

  return null;
};

const DETECTORS: Detector[] = [
  engulfing,
  hammerOrStar,
  star,
  threeInARow,
  marubozu,
  piercing,
  doji,
];

export interface DetectOptions {
  /** Report patterns whose final bar falls within this many bars of the end. */
  lookback?: number;
  /** Discard matches weaker than this, 0..100. */
  minStrength?: number;
}

/**
 * Finds patterns near the end of the series.
 *
 * Scoped to recent bars because a pattern from three months ago is history, not
 * a signal. Returns them newest first so the most recent evidence leads.
 */
export function detectPatterns(
  bars: readonly Bar[],
  options: DetectOptions = {},
): PatternMatch[] {
  const lookback = options.lookback ?? 5;
  const minStrength = options.minStrength ?? 1;

  const matches: PatternMatch[] = [];
  const start = Math.max(0, bars.length - lookback);

  for (let index = bars.length - 1; index >= start; index -= 1) {
    for (const detect of DETECTORS) {
      const match = detect(bars, index);
      if (match !== null && match.strength >= minStrength) matches.push(match);
    }
  }

  return matches;
}

/** Exposed for tests and for a per-bar view in the UI. */
export function detectAtBar(bars: readonly Bar[], index: number): PatternMatch[] {
  return DETECTORS.map((detect) => detect(bars, index)).filter(
    (match): match is PatternMatch => match !== null,
  );
}

export { metrics as barMetrics, priorTrend };
