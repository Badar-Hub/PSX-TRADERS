import {
  ZERO,
  addPaisa,
  compareIsoDates,
  estimateCgt,
  type CgtSchedule,
  type IsoDate,
  type Paisa,
} from '@psx/shared';
import type { ActionResult } from './actions.js';
import type { Position, Realisation } from './replay.js';

/**
 * Assembles the profit and loss statement.
 *
 * The statement separates three things that a single "profit" number runs
 * together, and that a trader needs apart:
 *
 *   - **Realised** gains and losses, which are settled and taxable.
 *   - **Dividend income**, which is income rather than capital gain and is
 *     taxed differently.
 *   - **Unrealised** gains, which are an opinion about open positions and can
 *     evaporate before they are ever banked.
 *
 * Charges are reported as their own line rather than being buried in the cost
 * basis they adjust. They are already deducted from every figure here, so the
 * line is informational: it is the number that tells you whether trading
 * frequently is quietly eating the edge.
 */

export interface SecurityRealisations {
  symbol: string;
  realisations: readonly Realisation[];
}

export interface DividendRecord {
  symbol: string;
  paidOn: IsoDate;
  result: ActionResult;
}

export interface StatementInput {
  from: IsoDate;
  to: IsoDate;
  /** Realised sales, grouped by security. Filtered to the period internally. */
  realisations: readonly SecurityRealisations[];
  /** Dividends and other cash from corporate actions. */
  dividends?: readonly DividendRecord[];
  /** Open positions, for the unrealised line. Omit to leave it unreported. */
  positions?: readonly Position[];
  /** Buy-side charges in the period, which realisations alone do not capture. */
  purchaseCharges?: Paisa;
  cgt?: CgtSchedule;
}

export interface SecurityLine {
  symbol: string;
  sharesSold: number;
  proceeds: Paisa;
  costBasis: Paisa;
  realisedPnl: Paisa;
  sellCharges: Paisa;
  dividendIncome: Paisa;
  unrealisedPnl: Paisa | null;
  /** Realised plus dividends plus unrealised, where known. */
  totalReturn: Paisa;
}

export interface ProfitAndLossStatement {
  from: IsoDate;
  to: IsoDate;

  realisedGains: Paisa;
  realisedLosses: Paisa;
  realisedNet: Paisa;

  dividendGross: Paisa;
  dividendTaxWithheld: Paisa;
  dividendNet: Paisa;

  /** All charges in the period, buy and sell. Already deducted above. */
  chargesPaid: Paisa;

  /** Realised net plus dividends received. What the period actually banked. */
  bankedNet: Paisa;

  unrealisedPnl: Paisa | null;
  /** Banked plus unrealised, where positions were supplied. */
  totalReturn: Paisa | null;

  /**
   * Estimated capital gains tax on the period's realised result.
   *
   * An estimate, not a filing. CGT on listed securities in Pakistan is withheld
   * by NCCPL at rates that depend on filer status and change with each finance
   * act, so the rate comes from configuration and the figure is labelled as an
   * estimate everywhere it is shown.
   */
  estimatedCgt: Paisa | null;

  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  /** Fraction of closed sales that made money, 0..1. Null with no trades. */
  winRate: number | null;
  /**
   * Average win divided by average loss. Above 1 means the winners are bigger
   * than the losers, which is what lets a sub-50% win rate still be profitable.
   */
  payoffRatio: number | null;
  bestTrade: TradeHighlight | null;
  worstTrade: TradeHighlight | null;

  bySecurity: SecurityLine[];
}

export interface TradeHighlight {
  symbol: string;
  tradeId: string;
  soldOn: IsoDate;
  realisedPnl: Paisa;
}

function withinPeriod(date: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return compareIsoDates(date, from) >= 0 && compareIsoDates(date, to) <= 0;
}

export function buildStatement(input: StatementInput): ProfitAndLossStatement {
  const { from, to } = input;
  if (compareIsoDates(from, to) > 0) {
    throw new Error(`Statement period runs backwards: ${from} to ${to}`);
  }

  const dividendsBySymbol = new Map<string, { gross: Paisa; tax: Paisa; net: Paisa }>();
  for (const record of input.dividends ?? []) {
    if (!withinPeriod(record.paidOn, from, to)) continue;
    const existing = dividendsBySymbol.get(record.symbol) ?? { gross: ZERO, tax: ZERO, net: ZERO };
    dividendsBySymbol.set(record.symbol, {
      gross: addPaisa(existing.gross, record.result.grossCash),
      tax: addPaisa(existing.tax, record.result.taxWithheld),
      net: addPaisa(existing.net, record.result.netCash),
    });
  }

  const positionsBySymbol = new Map<string, Position>();
  for (const position of input.positions ?? []) positionsBySymbol.set(position.symbol, position);

  const lines: SecurityLine[] = [];
  const highlights: TradeHighlight[] = [];

  let realisedGains: Paisa = ZERO;
  let realisedLosses: Paisa = ZERO;
  let sellCharges: Paisa = ZERO;
  let tradeCount = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  const winAmounts: number[] = [];
  const lossAmounts: number[] = [];

  const symbols = new Set<string>([
    ...input.realisations.map((entry) => entry.symbol),
    ...dividendsBySymbol.keys(),
    ...positionsBySymbol.keys(),
  ]);

  for (const symbol of symbols) {
    const group = input.realisations.find((entry) => entry.symbol === symbol);
    const inPeriod = (group?.realisations ?? []).filter((r) => withinPeriod(r.soldOn, from, to));

    let proceeds: Paisa = ZERO;
    let costBasis: Paisa = ZERO;
    let realisedPnl: Paisa = ZERO;
    let charges: Paisa = ZERO;
    let sharesSold = 0;

    for (const realisation of inPeriod) {
      proceeds = addPaisa(proceeds, realisation.netProceeds);
      costBasis = addPaisa(costBasis, realisation.costBasis);
      realisedPnl = addPaisa(realisedPnl, realisation.realisedPnl);
      charges = addPaisa(charges, realisation.charges);
      sharesSold += realisation.quantity;

      tradeCount += 1;
      if (realisation.realisedPnl > 0) {
        winningTrades += 1;
        winAmounts.push(realisation.realisedPnl);
        realisedGains = addPaisa(realisedGains, realisation.realisedPnl);
      } else if (realisation.realisedPnl < 0) {
        losingTrades += 1;
        lossAmounts.push(Math.abs(realisation.realisedPnl));
        realisedLosses = addPaisa(realisedLosses, realisation.realisedPnl);
      }

      highlights.push({
        symbol,
        tradeId: realisation.tradeId,
        soldOn: realisation.soldOn,
        realisedPnl: realisation.realisedPnl,
      });
    }

    sellCharges = addPaisa(sellCharges, charges);

    const dividend = dividendsBySymbol.get(symbol);
    const unrealised = positionsBySymbol.get(symbol)?.unrealisedPnl ?? null;
    const dividendIncome = dividend?.net ?? ZERO;

    // Skip a security with nothing to report in this period.
    if (inPeriod.length === 0 && dividendIncome === 0 && unrealised === null) continue;

    lines.push({
      symbol,
      sharesSold,
      proceeds,
      costBasis,
      realisedPnl,
      sellCharges: charges,
      dividendIncome,
      unrealisedPnl: unrealised,
      totalReturn: addPaisa(realisedPnl, dividendIncome, unrealised ?? ZERO),
    });
  }

  lines.sort((a, b) => b.totalReturn - a.totalReturn);

  const dividendGross = addPaisa(...[...dividendsBySymbol.values()].map((d) => d.gross));
  const dividendTaxWithheld = addPaisa(...[...dividendsBySymbol.values()].map((d) => d.tax));
  const dividendNet = addPaisa(...[...dividendsBySymbol.values()].map((d) => d.net));

  const realisedNet = addPaisa(realisedGains, realisedLosses);
  const bankedNet = addPaisa(realisedNet, dividendNet);

  const positionsSupplied = (input.positions ?? []).length > 0;
  const unrealisedPnl = positionsSupplied
    ? addPaisa(
        ...(input.positions ?? []).map((position) => position.unrealisedPnl ?? ZERO),
      )
    : null;

  const sorted = [...highlights].sort((a, b) => b.realisedPnl - a.realisedPnl);

  const averageWin = mean(winAmounts);
  const averageLoss = mean(lossAmounts);

  return {
    from,
    to,
    realisedGains,
    realisedLosses,
    realisedNet,
    dividendGross,
    dividendTaxWithheld,
    dividendNet,
    chargesPaid: addPaisa(sellCharges, input.purchaseCharges ?? ZERO),
    bankedNet,
    unrealisedPnl,
    totalReturn: unrealisedPnl === null ? null : addPaisa(bankedNet, unrealisedPnl),
    estimatedCgt:
      input.cgt === undefined
        ? null
        : estimateCgt(
            // Per-sale amounts, so loss offsetting is applied by the schedule
            // rather than assumed here.
            input.realisations.flatMap((entry) =>
              entry.realisations
                .filter((r) => withinPeriod(r.soldOn, from, to))
                .map((r) => r.realisedPnl),
            ),
            input.cgt,
          ),
    tradeCount,
    winningTrades,
    losingTrades,
    winRate: tradeCount === 0 ? null : winningTrades / tradeCount,
    payoffRatio:
      averageWin === null || averageLoss === null || averageLoss === 0
        ? null
        : Math.round((averageWin / averageLoss) * 100) / 100,
    bestTrade: sorted[0] ?? null,
    worstTrade: sorted.length > 1 ? (sorted[sorted.length - 1] ?? null) : null,
    bySecurity: lines,
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
