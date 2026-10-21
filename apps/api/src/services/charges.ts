import {
  computeCharges,
  type ChargeBreakdown,
  type ChargeSchedule,
  type Paisa,
} from '@psx/shared';
import type { BrokerageAccount } from '@prisma/client';
import { toPaisa } from '../db/paisa.js';

/**
 * Turns a stored brokerage account into the charge schedule the engine wants.
 *
 * Rates live on the account because they are negotiated per account: two
 * accounts with the same broker can differ, and every rate here changes with
 * each finance act or provincial budget. Nothing is hard-coded in the engine.
 */
export function scheduleFromAccount(account: BrokerageAccount): ChargeSchedule {
  return {
    brokerageBps: account.brokerageBps,
    brokerageMinimum: toPaisa(account.brokerageMinimum),
    brokeragePerShare: toPaisa(account.brokeragePerShare),
    salesTaxOnBrokerageBps: account.salesTaxOnBrokerageBps,
    cdcBps: account.cdcBps,
    secpBps: account.secpBps,
    fixedPerOrder: toPaisa(account.fixedPerOrder),
  };
}

export interface ChargeOverrides {
  brokerage?: Paisa;
  salesTax?: Paisa;
  cdc?: Paisa;
  secp?: Paisa;
  otherFees?: Paisa;
}

/**
 * Works out the charges on an order.
 *
 * The client may send the figures straight off a contract note, in which case
 * they are used as given: the broker's own numbers beat anything computed here,
 * and reconciling against the statement matters more than internal consistency.
 * Otherwise they are derived from the account's schedule, or are zero when the
 * portfolio has no account attached (as a paper portfolio will not).
 */
export function resolveCharges(
  unitPrice: Paisa,
  quantity: number,
  account: BrokerageAccount | null,
  overrides: ChargeOverrides | undefined,
): ChargeBreakdown {
  const hasOverride =
    overrides !== undefined &&
    (overrides.brokerage !== undefined ||
      overrides.salesTax !== undefined ||
      overrides.cdc !== undefined ||
      overrides.secp !== undefined ||
      overrides.otherFees !== undefined);

  if (hasOverride) {
    const brokerage = overrides.brokerage ?? (0 as Paisa);
    const salesTax = overrides.salesTax ?? (0 as Paisa);
    const cdc = overrides.cdc ?? (0 as Paisa);
    const secp = overrides.secp ?? (0 as Paisa);
    const fixed = overrides.otherFees ?? (0 as Paisa);
    return {
      brokerage,
      salesTax,
      cdc,
      secp,
      fixed,
      total: (brokerage + salesTax + cdc + secp + fixed) as Paisa,
    };
  }

  if (account === null) {
    const zero = 0 as Paisa;
    return { brokerage: zero, salesTax: zero, cdc: zero, secp: zero, fixed: zero, total: zero };
  }

  return computeCharges(unitPrice, quantity, scheduleFromAccount(account));
}
