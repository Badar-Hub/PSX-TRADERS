/**
 * The shapes the API returns.
 *
 * Hand-written rather than imported from the API package. The web app is a
 * separate deployable that talks to the API over HTTP, and importing its
 * internal types would let an incompatible change compile cleanly here while
 * breaking at runtime against a deployed API of a different version. Declaring
 * the wire format separately makes it a contract rather than an assumption.
 *
 * All amounts are integer paisa.
 */

export interface Portfolio {
  id: string;
  name: string;
  costBasisMethod: 'FIFO' | 'LIFO' | 'AVERAGE';
  isPaperTrading: boolean;
  accountId: string | null;
  tradeCount?: number;
  createdAt: string;
}

export interface Lot {
  id: string;
  openedOn: string;
  quantity: number;
  costBasis: number;
  source: string;
}

export interface Position {
  symbol: string;
  name: string;
  quantity: number;
  costBasis: number;
  averageCost: number | null;
  marketPrice: number | null;
  priceAsOf: string | null;
  marketValue: number | null;
  unrealisedPnl: number | null;
  unrealisedPnlBps: number | null;
  realisedPnl: number;
  weightBps: number | null;
  lots: Lot[];
}

export interface PortfolioSummary {
  portfolioId: string;
  name: string;
  costBasisMethod: string;
  isPaperTrading: boolean;
  investedCost: number;
  marketValue: number | null;
  unrealisedPnl: number | null;
  realisedPnl: number;
  hasMissingPrices: boolean;
  positionCount: number;
  positions: Position[];
}

export interface Trade {
  id: string;
  symbol: string;
  securityName: string;
  side: 'BUY' | 'SELL';
  tradedOn: string;
  sequence: number;
  quantity: number;
  unitPrice: number;
  grossValue: number;
  charges: {
    brokerage: number;
    salesTax: number;
    cdc: number;
    secp: number;
    otherFees: number;
    total: number;
  };
  netCashFlow: number;
  status: 'ACTIVE' | 'REVERSED';
  reversesTradeId: string | null;
  note: string | null;
  externalRef: string | null;
  createdAt: string;
}

export interface SecurityLine {
  symbol: string;
  sharesSold: number;
  proceeds: number;
  costBasis: number;
  realisedPnl: number;
  sellCharges: number;
  dividendIncome: number;
  unrealisedPnl: number | null;
  totalReturn: number;
}

export interface TradeHighlight {
  symbol: string;
  tradeId: string;
  soldOn: string;
  realisedPnl: number;
}

export interface PnlReport {
  portfolioId: string;
  portfolioName: string;
  isPaperTrading: boolean;
  from: string;
  to: string;
  realisedGains: number;
  realisedLosses: number;
  realisedNet: number;
  dividendGross: number;
  dividendTaxWithheld: number;
  dividendNet: number;
  chargesPaid: number;
  bankedNet: number;
  unrealisedPnl: number | null;
  totalReturn: number | null;
  estimatedCgt: number | null;
  cgtBasis: { rateBps: number; filerStatus: string; isEstimate: true } | null;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  payoffRatio: number | null;
  bestTrade: TradeHighlight | null;
  worstTrade: TradeHighlight | null;
  bySecurity: SecurityLine[];
  pricesMissingFor: string[];
}

export interface SignalFactor {
  key: string;
  label: string;
  category: string;
  /** -100..100 */
  score: number;
  /** 0..1, already renormalised over the factors that reported. */
  weight: number;
  contribution: number;
  value: number | null;
  display: string;
  reason: string;
  /** Bars the factor fired on, for highlighting on the chart. */
  barDates: string[];
}

export interface Signal {
  id: string;
  symbol: string;
  securityName: string;
  horizon: 'SWING' | 'LONG_TERM';
  asOf: string;
  action: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  score: number;
  confidence: number;
  /** The two terms confidence multiplies. Null on signals scored before they were stored. */
  coverage: number | null;
  agreement: number | null;
  missingFactors: number;
  narrative: string | null;
  /**
   * The model that wrote the prose, or null when the deterministic summariser
   * did. Shown, not hidden: a reader deciding what to do with their money is
   * entitled to know whether a language model wrote the explanation.
   */
  narrativeModel: string | null;
  priceAtSignal: number | null;
  engineVersion: string;
  outcome: string;
  factors: SignalFactor[];
  byCategory: Array<{ category: string; contribution: number }>;
}

/** A refusal is a legitimate answer, not an error. */
export interface SignalResponse {
  signal: Signal | null;
  source?: 'stored' | 'computed';
  refusal?: { code: string; reason: string };
}

export interface PositionCycle {
  index: number;
  symbol: string;
  openedOn: string;
  closedOn: string | null;
  isOpen: boolean;
  sharesBought: number;
  sharesSold: number;
  totalInvested: number;
  totalProceeds: number;
  realisedPnl: number;
  entryAveragePrice: number;
  exitAveragePrice: number | null;
  holdingDays: number | null;
}

export interface BuyBack {
  symbol: string;
  buyTradeId: string;
  boughtOn: string;
  quantity: number;
  buyPrice: number;
  previousExitPrice: number;
  previousExitOn: string;
  previousExitQuantity: number;
  daysOut: number;
  priceChangeBps: number;
  /** Positive when the repurchase was cheaper than the exit. */
  advantage: number;
  fullyExited: boolean;
}

export interface Coverage {
  firstDay: string | null;
  lastDay: string | null;
  tradingDaysStored: number;
  securities: number;
  barRows: number;
  missingDays: string[];
}

export type RuleStatus = 'ARMED' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED';
export type RuleTrigger = 'CLOSE' | 'INTRADAY_LOW' | 'INTRADAY_HIGH';
export type StopType = 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT';

export interface StopEvent {
  id: string;
  triggeredOn: string;
  triggerPrice: number;
  stopAtTrigger: number | null;
  highWaterMark: number | null;
  message: string;
  acknowledgedAt: string | null;
}

export interface StopRule {
  id: string;
  symbol: string;
  securityName: string;
  type: string;
  status: RuleStatus;
  triggerOn: RuleTrigger;
  thresholdPrice: number | null;
  trailAmount: number | null;
  trailBps: number | null;
  highWaterMark: number | null;
  effectiveStop: number | null;
  quantity: number | null;
  note: string | null;
  armedAt: string;
  expiresAt: string | null;
  lastCheckedOn: string | null;
  marketPrice: number | null;
  priceAsOf: string | null;
  /** Basis points of headroom above the level; negative means already through. */
  headroomBps: number | null;
  valueAtStop: number | null;
  sharesHeld: number | null;
  events: StopEvent[];
}

export interface StopSuggestion {
  symbol: string;
  marketPrice: number;
  priceAsOf: string;
  atr: number | null;
  trailBps: number | null;
  suggestedStop: number | null;
  multiple: number;
  reason: string;
}

export interface StopBacktest {
  symbol: string;
  from: string;
  to: string;
  barsConsidered: number;
  trailBps: number | null;
  trailAmount: number | null;
  triggeredOn: string | null;
  triggerPrice: number | null;
  stopAtTrigger: number | null;
  highWaterMark: number | null;
  finalClose: number;
  versusHoldingBps: number | null;
  verdict: string;
}

export interface StopEvaluation {
  rulesChecked: number;
  triggered: number;
  moved: number;
  expired: number;
  skipped: number;
  notes: string[];
}

export interface MarketDay {
  date: string;
  /** Index level, based at 1,000 on the first stored session. */
  level: number;
  /** Change in index points against the previous stored session. */
  change: number;
  changeBps: number;
  /** The median stock move that day. Diverges from the mean in a narrow market. */
  medianChangeBps: number;
  advances: number;
  declines: number;
  unchanged: number;
  /** Stocks that met the volume floor and so counted toward the level. */
  counted: number;
  volume: number;
  tradedValue: number;
}

export interface MarketStatus {
  /** Oldest first, as a chart reads. */
  series: MarketDay[];
  latest: MarketDay | null;
  previous: MarketDay | null;
  minVolume: number;
  base: number;
  /** What the index is, in one sentence. Shown rather than paraphrased. */
  basis: string;
}

/**
 * How one indicator is conventionally read.
 *
 * Education, not advice: it explains what the indicator measures and the
 * condition that would change its reading. Nothing here says what to buy, and
 * an engine test asserts as much.
 */
export interface FactorGuidance {
  reads: string;
  watchFor: string;
  caveat: string;
}
