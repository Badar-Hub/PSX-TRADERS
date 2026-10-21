import {
  ZERO,
  addPaisa,
  applyBasisPoints,
  multiplyByQuantity,
  paisa,
  roundToPaisa,
  type Paisa,
} from './money.js';
import type { TradeSide } from './types.js';

/**
 * Trade charges, modelled as configuration rather than constants.
 *
 * Every component here is negotiable, provincial, or set by statute that
 * changes with each finance act, so hard-coding the rates would bake in numbers
 * that are wrong by the next budget. A schedule is attached to a brokerage
 * account, and the engine simply applies whatever it is told.
 *
 * IMPORTANT: the defaults below are plausible starting values, NOT verified
 * current statutory rates. Before trusting a P&L figure, set these from an
 * actual contract note. The shape is the contract; the numbers are the user's.
 */
export interface ChargeSchedule {
  /** Broker commission in basis points of trade value (1 bp = 0.01%). */
  brokerageBps: number;
  /** Floor on commission per order, whatever the bps works out to. */
  brokerageMinimum: Paisa;
  /** Some brokers bill per share instead of by value; applied if non-zero. */
  brokeragePerShare: Paisa;
  /** Provincial sales tax charged ON the commission, in bps. */
  salesTaxOnBrokerageBps: number;
  /** CDC / custody charge in bps of trade value. */
  cdcBps: number;
  /** SECP / exchange levy in bps of trade value. */
  secpBps: number;
  /** Any further fixed per-order charge. */
  fixedPerOrder: Paisa;
}

/**
 * A deliberately conservative placeholder. Treat as "roughly the right order of
 * magnitude for a retail PSX account" and replace from a real contract note.
 */
export const PLACEHOLDER_CHARGE_SCHEDULE: ChargeSchedule = {
  brokerageBps: 15,
  brokerageMinimum: paisa(0),
  brokeragePerShare: paisa(0),
  salesTaxOnBrokerageBps: 1300,
  cdcBps: 1,
  secpBps: 1,
  fixedPerOrder: paisa(0),
};

export interface ChargeBreakdown {
  brokerage: Paisa;
  salesTax: Paisa;
  cdc: Paisa;
  secp: Paisa;
  fixed: Paisa;
  total: Paisa;
}

export const NO_CHARGES: ChargeBreakdown = {
  brokerage: ZERO,
  salesTax: ZERO,
  cdc: ZERO,
  secp: ZERO,
  fixed: ZERO,
  total: ZERO,
};

/**
 * Computes the charges on one order.
 *
 * Charges are kept itemised rather than collapsed to a single number because
 * the user will want to see why a trade cost what it did, and because only some
 * components are deductible when the tax report is produced.
 */
export function computeCharges(
  unitPrice: Paisa,
  quantity: number,
  schedule: ChargeSchedule,
): ChargeBreakdown {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Charge quantity must be a positive whole number, got ${quantity}`);
  }
  const grossValue = multiplyByQuantity(unitPrice, quantity);

  const byValue = applyBasisPoints(grossValue, schedule.brokerageBps);
  const byShare = multiplyByQuantity(schedule.brokeragePerShare, quantity);
  const brokerage = paisa(Math.max(byValue, byShare, schedule.brokerageMinimum));

  const salesTax = applyBasisPoints(brokerage, schedule.salesTaxOnBrokerageBps);
  const cdc = applyBasisPoints(grossValue, schedule.cdcBps);
  const secp = applyBasisPoints(grossValue, schedule.secpBps);
  const fixed = schedule.fixedPerOrder;

  return {
    brokerage,
    salesTax,
    cdc,
    secp,
    fixed,
    total: addPaisa(brokerage, salesTax, cdc, secp, fixed),
  };
}

/**
 * Net cash effect of an order: what actually leaves or reaches the account.
 *
 * A buy costs the trade value plus charges; a sell returns the trade value less
 * charges. Charges therefore always work against the user, which is why they
 * are added to a buy's cost basis and subtracted from a sell's proceeds rather
 * than reported separately. That is also what makes the resulting P&L the real
 * number rather than the gross one.
 */
export function netCashFlow(
  side: TradeSide,
  unitPrice: Paisa,
  quantity: number,
  charges: ChargeBreakdown,
): Paisa {
  const grossValue = multiplyByQuantity(unitPrice, quantity);
  return side === 'BUY'
    ? addPaisa(grossValue, charges.total)
    : paisa(grossValue - charges.total);
}

/**
 * Capital gains tax configuration.
 *
 * In Pakistan CGT on listed securities is withheld by NCCPL rather than paid by
 * the investor directly, the rate depends on filer status, and holding period
 * has mattered differently across finance acts. So this is configuration too,
 * and the engine reports an *estimate* clearly labelled as one.
 */
export interface CgtSchedule {
  /** Rate applied to a realised gain, in basis points. */
  rateBps: number;
  /**
   * Whether realised losses may offset gains within the same tax year. When
   * true the report nets them before applying the rate.
   */
  allowLossOffset: boolean;
}

export const PLACEHOLDER_CGT_FILER: CgtSchedule = {
  rateBps: 1250,
  allowLossOffset: true,
};

export const PLACEHOLDER_CGT_NON_FILER: CgtSchedule = {
  rateBps: 2500,
  allowLossOffset: true,
};

/**
 * Estimates CGT on a set of realised gains and losses.
 *
 * Returns an estimate, not a filing. Presented to the user as "estimated tax
 * withheld" so it is never mistaken for tax advice.
 */
export function estimateCgt(realisedAmounts: Paisa[], schedule: CgtSchedule): Paisa {
  const gains = realisedAmounts.filter((amount) => amount > 0);
  const losses = realisedAmounts.filter((amount) => amount < 0);

  const taxable = schedule.allowLossOffset
    ? addPaisa(...gains, ...losses)
    : addPaisa(...gains);

  if (taxable <= 0) return ZERO;
  return roundToPaisa((taxable * schedule.rateBps) / 10_000);
}
