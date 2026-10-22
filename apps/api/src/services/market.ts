import { paisa, type Paisa } from '@psx/shared';
import { prisma } from '../db/prisma.js';
import { toIsoDateColumn } from '../db/paisa.js';

/**
 * Market status: where the whole market went, and how broadly.
 *
 * ## Why this is not the KSE-100
 *
 * It would be, if the data were available. PSX's bulk archive — the official
 * dated files this app is built on — publishes per-symbol closes and index
 * *futures*, but not the KSE-100 spot level. The only index points in the file
 * are contracts like `KSE30-OCT`, and a series built from the near-month
 * contract jumps several hundred points at every monthly roll, because the
 * next contract trades at a different basis. That is a worse lie than not
 * having the number.
 *
 * Replicating the KSE-100 is also not possible from what is stored: it is
 * free-float market-capitalisation weighted, which needs shares outstanding
 * and free-float factors for each of its hundred constituents. The
 * fundamentals table is empty and these files do not carry either figure.
 *
 * So what is computed here is stated for what it is: an equal-weighted index
 * over the liquid PSX equities this app stores, based at 1,000 on the first
 * stored trading day. It answers "which way did the market go, and by how
 * much" honestly. It is not comparable to a KSE-100 quote and the UI says so
 * rather than letting a number that looks like points be mistaken for them.
 *
 * ## Two decisions inside it
 *
 * The daily move uses `close` against `ldcp`, the exchange's own published
 * previous-close, rather than against the prior stored bar. LDCP is already
 * adjusted for a stock going ex-dividend or ex-bonus — that disagreement is
 * precisely how this app detects corporate actions — so using it keeps a
 * dividend from reading as a market-wide fall. It is also the basis PSX itself
 * quotes the day's change on.
 *
 * Equal weighting, not traded-value weighting. Value weighting sounds more
 * representative and is not: a single block trade in one share would swing the
 * whole index for a day. Equal weighting over a liquidity-filtered universe
 * says "the typical liquid stock moved this much", which is a claim the data
 * actually supports.
 */

/** Minimum daily volume for a stock to count toward the index. */
const DEFAULT_MIN_VOLUME = 25_000;

export interface MarketDay {
  date: string;
  /** Index level, based at 1,000 on the first stored day. */
  level: number;
  /** Change in index points against the previous stored day. */
  change: number;
  changeBps: number;
  /**
   * The median stock's move that day, in basis points.
   *
   * Reported beside the mean because the two can disagree sharply and the
   * disagreement is the point. An equal-weighted index rose a third over the
   * stored history while the median liquid stock fell two-fifths: a rally
   * carried by a minority of names. A single average would hide that, and the
   * user would read "market up" as "my stocks probably up".
   */
  medianChangeBps: number;
  advances: number;
  declines: number;
  unchanged: number;
  /** Stocks that met the volume floor and so counted toward the level. */
  counted: number;
  volume: number;
  tradedValue: Paisa;
}

export interface MarketStatus {
  /** Oldest first, as a chart reads. */
  series: MarketDay[];
  latest: MarketDay | null;
  previous: MarketDay | null;
  /** The volume floor applied, so the figure can be reproduced. */
  minVolume: number;
  base: number;
  /** What the index is, in one sentence, carried to every client. */
  basis: string;
}

interface Row {
  date: Date;
  advances: bigint;
  declines: bigint;
  unchanged: bigint;
  counted: bigint;
  volume: bigint | null;
  traded_value: bigint | null;
  mean_return: string | null;
  median_return: string | null;
}

/**
 * The market's daily aggregates, straight out of Postgres.
 *
 * One grouped query over every stored bar rather than a stored projection.
 * It is a hundred thousand rows aggregated on an indexed date column, which
 * Postgres does in milliseconds, and it means there is no table that can fall
 * out of step with the bars it summarises.
 */
export async function getMarketStatus(
  options: { days?: number; minVolume?: number } = {},
): Promise<MarketStatus> {
  const minVolume = options.minVolume ?? DEFAULT_MIN_VOLUME;
  const days = options.days ?? 250;

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      b."date",
      COUNT(*) FILTER (WHERE b."close" > b."ldcp")  AS advances,
      COUNT(*) FILTER (WHERE b."close" < b."ldcp")  AS declines,
      COUNT(*) FILTER (WHERE b."close" = b."ldcp")  AS unchanged,
      COUNT(*)                                       AS counted,
      SUM(b."volume")::bigint                        AS volume,
      SUM(b."close" * b."volume")::bigint            AS traded_value,
      AVG((b."close"::numeric - b."ldcp"::numeric) / b."ldcp"::numeric) AS mean_return,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY (b."close"::numeric - b."ldcp"::numeric) / b."ldcp"::numeric
      ) AS median_return
    FROM "daily_bars" b
    JOIN "securities" s ON s."id" = b."securityId"
    WHERE s."segment" = 'EQUITY'
      -- Ordinary shares only. A rights letter is a different instrument: it
      -- trades for a few paisa and expires, so a one-paisa tick is a 100% move
      -- and eighteen of them dominated this index until they were excluded.
      -- One letter going from 1 paisa to 76 is a +7,500% day, and the market
      -- did not have one.
      AND s."listing" = 'EQUITY'
      AND b."ldcp" IS NOT NULL
      AND b."ldcp" > 0
      AND b."volume" >= ${minVolume}
    GROUP BY b."date"
    ORDER BY b."date" ASC
  `;

  /*
   * The level is chained from the first stored day, then the window is sliced
   * off the end.
   *
   * Chaining before slicing matters: compute it over the last 60 days only and
   * the base moves every time the window does, so the same date shows a
   * different level depending on how much of the chart you asked for.
   */
  const base = 1_000;
  let level = base;
  const all: MarketDay[] = [];

  for (const row of rows) {
    const meanReturn = row.mean_return === null ? 0 : Number(row.mean_return);
    const previousLevel = level;
    // The first stored day has no prior day in the series, so it sits at the
    // base rather than being moved by its own LDCP-to-close change.
    if (all.length > 0) level = previousLevel * (1 + meanReturn);

    all.push({
      date: toIsoDateColumn(row.date),
      level: Math.round(level * 100) / 100,
      change: all.length === 0 ? 0 : Math.round((level - previousLevel) * 100) / 100,
      changeBps: all.length === 0 ? 0 : Math.round(meanReturn * 10_000),
      medianChangeBps: Math.round(Number(row.median_return ?? 0) * 10_000),
      advances: Number(row.advances),
      declines: Number(row.declines),
      unchanged: Number(row.unchanged),
      counted: Number(row.counted),
      volume: Number(row.volume ?? 0n),
      tradedValue: paisa(Number(row.traded_value ?? 0n)),
    });
  }

  const series = all.slice(-days);

  return {
    series,
    latest: all[all.length - 1] ?? null,
    previous: all[all.length - 2] ?? null,
    minVolume,
    base,
    basis:
      `Equal-weighted index of ordinary PSX shares trading at least ` +
      `${minVolume.toLocaleString('en-US')} shares that day, based at ` +
      `${base.toLocaleString('en-US')} on the first stored session. Rights letters are excluded: ` +
      `they trade for a few paisa, so a single tick is a double-digit percentage move. Daily ` +
      `moves are each stock's close against the exchange's published previous close, so a stock ` +
      `going ex-dividend does not read as a market-wide fall. ` +
      `Because every stock counts equally and the universe is re-formed each day, the level can ` +
      `drift well away from the median stock — when it does, the rally or fall is being carried ` +
      `by a minority of names, which is what the breadth figures show. ` +
      `This is not the KSE-100: that index is free-float capitalisation weighted, and the ` +
      `exchange's bulk archive publishes neither its level nor the share counts needed to ` +
      `rebuild it.`,
  };
}
