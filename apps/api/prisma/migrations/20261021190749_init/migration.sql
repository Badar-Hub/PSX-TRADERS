-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- CreateEnum
CREATE TYPE "CostBasisMethod" AS ENUM ('FIFO', 'LIFO', 'AVERAGE');

-- CreateEnum
CREATE TYPE "LotSource" AS ENUM ('PURCHASE', 'BONUS', 'RIGHT', 'SPLIT', 'TRANSFER_IN');

-- CreateEnum
CREATE TYPE "CorporateActionType" AS ENUM ('CASH_DIVIDEND', 'BONUS', 'RIGHT', 'SPLIT', 'REVERSE_SPLIT', 'MERGER', 'DELISTING');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('DETECTED', 'CONFIRMED', 'REJECTED', 'APPLIED');

-- CreateEnum
CREATE TYPE "CashFlowType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'RIGHTS_SUBSCRIPTION', 'FRACTIONAL_SETTLEMENT', 'TAX', 'FEE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "MarketSegment" AS ENUM ('EQUITY', 'FUTURE', 'INDEX_FUTURE', 'DEBT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ListingKind" AS ENUM ('EQUITY', 'RIGHT', 'FUTURE', 'ETF', 'PREFERENCE');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('QUARTER', 'HALF_YEAR', 'FULL_YEAR');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('RUNNING', 'SUCCESS', 'NO_FILE', 'FAILED');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('STOP_LOSS', 'TRAILING_STOP', 'TAKE_PROFIT', 'PRICE_ALERT', 'INDICATOR_ALERT');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('ARMED', 'TRIGGERED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RuleTrigger" AS ENUM ('CLOSE', 'INTRADAY_LOW', 'INTRADAY_HIGH');

-- CreateEnum
CREATE TYPE "SignalHorizon" AS ENUM ('SWING', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "SignalAction" AS ENUM ('STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL');

-- CreateEnum
CREATE TYPE "FactorCategory" AS ENUM ('TREND', 'MOMENTUM', 'VOLATILITY', 'VOLUME', 'PATTERN', 'VALUATION', 'GROWTH', 'QUALITY', 'LEVERAGE', 'MARKET');

-- CreateEnum
CREATE TYPE "SignalOutcome" AS ENUM ('PENDING', 'HIT', 'MISS', 'NEUTRAL', 'VOIDED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "isTaxFiler" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brokerage_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brokerName" TEXT,
    "brokerageBps" INTEGER NOT NULL DEFAULT 15,
    "brokerageMinimum" BIGINT NOT NULL DEFAULT 0,
    "brokeragePerShare" BIGINT NOT NULL DEFAULT 0,
    "salesTaxOnBrokerageBps" INTEGER NOT NULL DEFAULT 1300,
    "cdcBps" INTEGER NOT NULL DEFAULT 1,
    "secpBps" INTEGER NOT NULL DEFAULT 1,
    "fixedPerOrder" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brokerage_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "costBasisMethod" "CostBasisMethod" NOT NULL DEFAULT 'FIFO',
    "isPaperTrading" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "securities" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "sectorCode" TEXT,
    "segment" "MarketSegment" NOT NULL DEFAULT 'EQUITY',
    "listing" "ListingKind" NOT NULL DEFAULT 'EQUITY',
    "baseSymbol" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenOn" DATE,
    "lastSeenOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "securities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_bars" (
    "securityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" BIGINT NOT NULL,
    "high" BIGINT NOT NULL,
    "low" BIGINT NOT NULL,
    "close" BIGINT NOT NULL,
    "volume" INTEGER NOT NULL,
    "ldcp" BIGINT,
    "closeOutsideRange" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_bars_pkey" PRIMARY KEY ("securityId","date")
);

-- CreateTable
CREATE TABLE "ingest_runs" (
    "id" TEXT NOT NULL,
    "tradingDay" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'psx-data-portal',
    "status" "IngestStatus" NOT NULL,
    "barsInserted" INTEGER NOT NULL DEFAULT 0,
    "barsUpdated" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "actionsFound" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ingest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fundamentals" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "periodType" "PeriodType" NOT NULL,
    "epsPaisa" BIGINT,
    "revenuePaisa" BIGINT,
    "netIncomePaisa" BIGINT,
    "equityPaisa" BIGINT,
    "totalDebtPaisa" BIGINT,
    "bookValuePaisa" BIGINT,
    "dividendPaisa" BIGINT,
    "roeBps" INTEGER,
    "debtToEquityBps" INTEGER,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fundamentals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "tradedOn" DATE NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "brokerage" BIGINT NOT NULL DEFAULT 0,
    "salesTax" BIGINT NOT NULL DEFAULT 0,
    "cdc" BIGINT NOT NULL DEFAULT 0,
    "secp" BIGINT NOT NULL DEFAULT 0,
    "otherFees" BIGINT NOT NULL DEFAULT 0,
    "charges" BIGINT NOT NULL DEFAULT 0,
    "netCashFlow" BIGINT NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'ACTIVE',
    "reversesTradeId" TEXT,
    "note" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_lots" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "openTradeId" TEXT,
    "source" "LotSource" NOT NULL DEFAULT 'PURCHASE',
    "openedOn" DATE NOT NULL,
    "originalQuantity" INTEGER NOT NULL,
    "remainingQuantity" INTEGER NOT NULL,
    "originalCostBasis" BIGINT NOT NULL,
    "remainingCostBasis" BIGINT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_consumptions" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "taxLotId" TEXT NOT NULL,
    "sellTradeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "costBasis" BIGINT NOT NULL,
    "proceeds" BIGINT NOT NULL,
    "realisedPnl" BIGINT NOT NULL,
    "holdingDays" INTEGER NOT NULL,
    "soldOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_cycles" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "cycleIndex" INTEGER NOT NULL,
    "openedOn" DATE NOT NULL,
    "closedOn" DATE,
    "sharesBought" INTEGER NOT NULL,
    "sharesSold" INTEGER NOT NULL,
    "totalInvested" BIGINT NOT NULL,
    "totalProceeds" BIGINT NOT NULL,
    "realisedPnl" BIGINT NOT NULL,
    "entryAveragePrice" BIGINT NOT NULL,
    "exitAveragePrice" BIGINT,
    "holdingDays" INTEGER,
    "isBuyBack" BOOLEAN NOT NULL DEFAULT false,
    "previousExitPrice" BIGINT,
    "daysOutOfPosition" INTEGER,
    "buyBackAdvantage" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "position_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_transactions" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "type" "CashFlowType" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "taxWithheld" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "corporateActionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_actions" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "type" "CorporateActionType" NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'DETECTED',
    "exDate" DATE NOT NULL,
    "recordDate" DATE,
    "payDate" DATE,
    "amountPerShare" BIGINT,
    "taxWithheldBps" INTEGER,
    "bonusRatioBps" INTEGER,
    "splitRatioBps" INTEGER,
    "rightsRatioBps" INTEGER,
    "subscriptionPrice" BIGINT,
    "detectedFromDelta" BIGINT,
    "detectedRatio" DOUBLE PRECISION,
    "isAmbiguous" BOOLEAN NOT NULL DEFAULT false,
    "detectionNote" TEXT,
    "announcementUrl" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corporate_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_action_applications" (
    "id" TEXT NOT NULL,
    "corporateActionId" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "sharesHeldOnExDate" INTEGER NOT NULL,
    "sharesAdded" INTEGER NOT NULL DEFAULT 0,
    "grossCash" BIGINT NOT NULL DEFAULT 0,
    "taxWithheld" BIGINT NOT NULL DEFAULT 0,
    "netCash" BIGINT NOT NULL DEFAULT 0,
    "cashPaid" BIGINT NOT NULL DEFAULT 0,
    "fractionalEntitlement" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corporate_action_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "type" "RuleType" NOT NULL,
    "status" "RuleStatus" NOT NULL DEFAULT 'ARMED',
    "triggerOn" "RuleTrigger" NOT NULL DEFAULT 'CLOSE',
    "thresholdPrice" BIGINT,
    "trailAmount" BIGINT,
    "trailBps" INTEGER,
    "highWaterMark" BIGINT,
    "effectiveStop" BIGINT,
    "quantity" INTEGER,
    "note" TEXT,
    "armedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "lastCheckedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "triggeredOn" DATE NOT NULL,
    "triggerPrice" BIGINT NOT NULL,
    "stopAtTrigger" BIGINT,
    "highWaterMark" BIGINT,
    "message" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "horizon" "SignalHorizon" NOT NULL,
    "asOf" DATE NOT NULL,
    "action" "SignalAction" NOT NULL,
    "scoreX100" INTEGER NOT NULL,
    "confidenceBps" INTEGER NOT NULL,
    "missingFactors" INTEGER NOT NULL DEFAULT 0,
    "narrative" TEXT,
    "narrativeModel" TEXT,
    "outcome" "SignalOutcome" NOT NULL DEFAULT 'PENDING',
    "priceAtSignal" BIGINT,
    "priceAtOutcome" BIGINT,
    "settledAt" TIMESTAMP(3),
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_factors" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "FactorCategory" NOT NULL,
    "scoreX100" INTEGER NOT NULL,
    "weightBps" INTEGER NOT NULL,
    "contributionX100" INTEGER NOT NULL,
    "value" DOUBLE PRECISION,
    "display" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "barDates" DATE[],

    CONSTRAINT "signal_factors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_expiresAt_idx" ON "refresh_tokens"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "brokerage_accounts_userId_idx" ON "brokerage_accounts"("userId");

-- CreateIndex
CREATE INDEX "portfolios_userId_idx" ON "portfolios"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_userId_name_key" ON "portfolios"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "securities_symbol_key" ON "securities"("symbol");

-- CreateIndex
CREATE INDEX "securities_segment_isActive_idx" ON "securities"("segment", "isActive");

-- CreateIndex
CREATE INDEX "securities_baseSymbol_idx" ON "securities"("baseSymbol");

-- CreateIndex
CREATE INDEX "daily_bars_date_idx" ON "daily_bars"("date");

-- CreateIndex
CREATE INDEX "ingest_runs_status_tradingDay_idx" ON "ingest_runs"("status", "tradingDay");

-- CreateIndex
CREATE UNIQUE INDEX "ingest_runs_tradingDay_source_key" ON "ingest_runs"("tradingDay", "source");

-- CreateIndex
CREATE INDEX "fundamentals_securityId_periodEnd_idx" ON "fundamentals"("securityId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "fundamentals_securityId_periodEnd_periodType_key" ON "fundamentals"("securityId", "periodEnd", "periodType");

-- CreateIndex
CREATE UNIQUE INDEX "trades_reversesTradeId_key" ON "trades"("reversesTradeId");

-- CreateIndex
CREATE INDEX "trades_portfolioId_securityId_tradedOn_idx" ON "trades"("portfolioId", "securityId", "tradedOn");

-- CreateIndex
CREATE INDEX "trades_portfolioId_tradedOn_idx" ON "trades"("portfolioId", "tradedOn");

-- CreateIndex
CREATE INDEX "trades_securityId_tradedOn_idx" ON "trades"("securityId", "tradedOn");

-- CreateIndex
CREATE UNIQUE INDEX "tax_lots_openTradeId_key" ON "tax_lots"("openTradeId");

-- CreateIndex
CREATE INDEX "tax_lots_portfolioId_securityId_remainingQuantity_idx" ON "tax_lots"("portfolioId", "securityId", "remainingQuantity");

-- CreateIndex
CREATE INDEX "tax_lots_portfolioId_securityId_openedOn_idx" ON "tax_lots"("portfolioId", "securityId", "openedOn");

-- CreateIndex
CREATE INDEX "lot_consumptions_portfolioId_soldOn_idx" ON "lot_consumptions"("portfolioId", "soldOn");

-- CreateIndex
CREATE INDEX "lot_consumptions_sellTradeId_idx" ON "lot_consumptions"("sellTradeId");

-- CreateIndex
CREATE INDEX "lot_consumptions_taxLotId_idx" ON "lot_consumptions"("taxLotId");

-- CreateIndex
CREATE INDEX "position_cycles_portfolioId_closedOn_idx" ON "position_cycles"("portfolioId", "closedOn");

-- CreateIndex
CREATE UNIQUE INDEX "position_cycles_portfolioId_securityId_cycleIndex_key" ON "position_cycles"("portfolioId", "securityId", "cycleIndex");

-- CreateIndex
CREATE INDEX "cash_transactions_portfolioId_occurredOn_idx" ON "cash_transactions"("portfolioId", "occurredOn");

-- CreateIndex
CREATE INDEX "corporate_actions_status_exDate_idx" ON "corporate_actions"("status", "exDate");

-- CreateIndex
CREATE INDEX "corporate_actions_exDate_idx" ON "corporate_actions"("exDate");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_actions_securityId_type_exDate_key" ON "corporate_actions"("securityId", "type", "exDate");

-- CreateIndex
CREATE INDEX "corporate_action_applications_portfolioId_idx" ON "corporate_action_applications"("portfolioId");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_action_applications_corporateActionId_portfolioId_key" ON "corporate_action_applications"("corporateActionId", "portfolioId");

-- CreateIndex
CREATE INDEX "alert_rules_status_securityId_idx" ON "alert_rules"("status", "securityId");

-- CreateIndex
CREATE INDEX "alert_rules_portfolioId_status_idx" ON "alert_rules"("portfolioId", "status");

-- CreateIndex
CREATE INDEX "alert_events_ruleId_triggeredOn_idx" ON "alert_events"("ruleId", "triggeredOn");

-- CreateIndex
CREATE INDEX "alert_events_notifiedAt_idx" ON "alert_events"("notifiedAt");

-- CreateIndex
CREATE INDEX "signals_horizon_asOf_idx" ON "signals"("horizon", "asOf");

-- CreateIndex
CREATE INDEX "signals_outcome_asOf_idx" ON "signals"("outcome", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "signals_securityId_horizon_asOf_engineVersion_key" ON "signals"("securityId", "horizon", "asOf", "engineVersion");

-- CreateIndex
CREATE INDEX "signal_factors_signalId_idx" ON "signal_factors"("signalId");

-- CreateIndex
CREATE UNIQUE INDEX "signal_factors_signalId_key_key" ON "signal_factors"("signalId", "key");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brokerage_accounts" ADD CONSTRAINT "brokerage_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "brokerage_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_bars" ADD CONSTRAINT "daily_bars_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_reversesTradeId_fkey" FOREIGN KEY ("reversesTradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_lots" ADD CONSTRAINT "tax_lots_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_lots" ADD CONSTRAINT "tax_lots_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_lots" ADD CONSTRAINT "tax_lots_openTradeId_fkey" FOREIGN KEY ("openTradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_taxLotId_fkey" FOREIGN KEY ("taxLotId") REFERENCES "tax_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_sellTradeId_fkey" FOREIGN KEY ("sellTradeId") REFERENCES "trades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_cycles" ADD CONSTRAINT "position_cycles_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_cycles" ADD CONSTRAINT "position_cycles_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_corporateActionId_fkey" FOREIGN KEY ("corporateActionId") REFERENCES "corporate_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_action_applications" ADD CONSTRAINT "corporate_action_applications_corporateActionId_fkey" FOREIGN KEY ("corporateActionId") REFERENCES "corporate_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_action_applications" ADD CONSTRAINT "corporate_action_applications_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_factors" ADD CONSTRAINT "signal_factors_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
