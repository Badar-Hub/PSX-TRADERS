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
  missingFactors: number;
  narrative: string | null;
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
