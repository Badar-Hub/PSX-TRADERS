import {
  ZERO,
  addPaisa,
  allocateInteger,
  allocatePaisa,
  applyBasisPoints,
  multiplyByQuantity,
  paisa,
  subPaisa,
  type IsoDate,
  type Paisa,
} from '@psx/shared';
import { LedgerError, openLot, totalCostBasis, totalQuantity, type OpenLot } from './lots.js';

/**
 * Applies a corporate action to a set of tax lots.
 *
 * This is the module that stops a portfolio quietly going wrong. A bonus issue
 * raises the share count with no cash changing hands; if it is not applied, the
 * position looks as though it lost a tenth of its value per share overnight for
 * no reason, and every subsequent gain is computed against a cost basis spread
 * over too few shares. The same goes for splits. Dividends are gentler but add
 * up: income that never appears means the portfolio understates what it made.
 *
 * Two rules run through all of it:
 *
 * 1. **A bonus or split never changes the total cost basis.** No money was
 *    spent, so nothing was bought. The basis is spread over more shares, which
 *    lowers the per-share cost and leaves the overall gain untouched.
 * 2. **Entitlements are computed on the whole holding, then distributed.** The
 *    registrar issues against the registered position, not lot by lot, so
 *    anything else loses shares to rounding.
 */

export type CorporateActionInput =
  | {
      id: string;
      type: 'CASH_DIVIDEND';
      exDate: IsoDate;
      /** Gross cash per share held. */
      amountPerShare: Paisa;
      /** Tax deducted at source, in basis points of the gross. */
      taxWithheldBps?: number;
    }
  | {
      id: string;
      type: 'BONUS';
      exDate: IsoDate;
      /** New shares per share held: 0.1 for a 10% bonus issue. */
      newSharesPerShare: number;
      policy?: BonusLotPolicy;
    }
  | {
      id: string;
      type: 'SPLIT';
      exDate: IsoDate;
      /** Share multiplier: 2 for a 2-for-1 split, 0.1 for a 1-for-10 reverse. */
      multiplier: number;
    }
  | {
      id: string;
      type: 'RIGHT';
      exDate: IsoDate;
      /** Entitlement per share held, for reporting what was available. */
      entitlementPerShare: number;
      subscriptionPrice: Paisa;
      /** Shares actually taken up. Zero means the right lapsed or was sold. */
      subscribedShares: number;
      charges?: Paisa;
    };

/**
 * Where bonus shares land.
 *
 * `DILUTE_ORIGIN` adds them to the lots that earned them, preserving each lot's
 * acquisition date and total cost while lowering its per-share cost. This is
 * the economically faithful view and the default.
 *
 * `NEW_ZERO_COST_LOT` instead opens a lot dated the ex-date with no cost. That
 * matters only if a tax treatment requires bonus shares to carry their own
 * acquisition date, since under FIFO the two policies dispose of shares in a
 * different order and so produce different holding periods.
 */
export type BonusLotPolicy = 'DILUTE_ORIGIN' | 'NEW_ZERO_COST_LOT';

export interface ActionResult {
  lots: OpenLot[];
  /** Shares added by a bonus, split or rights subscription. */
  sharesAdded: number;
  /** Gross dividend before tax. */
  grossCash: Paisa;
  taxWithheld: Paisa;
  /** Dividend actually received, net of tax withheld at source. */
  netCash: Paisa;
  /** Cash spent subscribing to a rights issue. */
  cashPaid: Paisa;
  /**
   * Entitlement left over after whole shares were issued. The exchange pays
   * these in cash, so they are reported rather than silently dropped.
   */
  fractionalEntitlement: number;
  note: string;
}

const EMPTY_RESULT = {
  sharesAdded: 0,
  grossCash: ZERO,
  taxWithheld: ZERO,
  netCash: ZERO,
  cashPaid: ZERO,
  fractionalEntitlement: 0,
};

export function applyCorporateAction(
  lots: readonly OpenLot[],
  action: CorporateActionInput,
): ActionResult {
  switch (action.type) {
    case 'CASH_DIVIDEND':
      return applyDividend(lots, action);
    case 'BONUS':
      return applyBonus(lots, action);
    case 'SPLIT':
      return applySplit(lots, action);
    case 'RIGHT':
      return applyRights(lots, action);
    default: {
      const exhaustive: never = action;
      throw new LedgerError(`Unsupported corporate action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * A dividend pays cash and leaves the lots alone.
 *
 * The cost basis is deliberately untouched. Treating a dividend as a return of
 * capital would reduce the basis and inflate the eventual capital gain, which
 * is both wrong and taxed differently from the income it actually is.
 */
function applyDividend(
  lots: readonly OpenLot[],
  action: Extract<CorporateActionInput, { type: 'CASH_DIVIDEND' }>,
): ActionResult {
  const quantity = totalQuantity(lots);
  const grossCash = multiplyByQuantity(action.amountPerShare, quantity);
  const taxWithheld =
    action.taxWithheldBps === undefined ? ZERO : applyBasisPoints(grossCash, action.taxWithheldBps);

  return {
    ...EMPTY_RESULT,
    lots: [...lots],
    grossCash,
    taxWithheld,
    netCash: subPaisa(grossCash, taxWithheld),
    note:
      quantity === 0
        ? `No position on ${action.exDate}; dividend not applicable.`
        : `Dividend on ${quantity} share(s) at ${(action.amountPerShare / 100).toFixed(2)} per share.`,
  };
}

function applyBonus(
  lots: readonly OpenLot[],
  action: Extract<CorporateActionInput, { type: 'BONUS' }>,
): ActionResult {
  if (action.newSharesPerShare <= 0) {
    throw new LedgerError(`Bonus ratio must be positive, got ${action.newSharesPerShare}`);
  }
  const quantity = totalQuantity(lots);
  if (quantity === 0) {
    return {
      ...EMPTY_RESULT,
      lots: [...lots],
      note: `No position on ${action.exDate}; bonus issue not applicable.`,
    };
  }

  const entitlement = quantity * action.newSharesPerShare;
  const wholeShares = Math.floor(entitlement);
  const fractionalEntitlement = round6(entitlement - wholeShares);

  const policy = action.policy ?? 'DILUTE_ORIGIN';

  if (policy === 'NEW_ZERO_COST_LOT') {
    const zeroCostLot: OpenLot = {
      id: `${action.id}-bonus`,
      openedOn: action.exDate,
      quantity: wholeShares,
      costBasis: ZERO,
      source: 'BONUS',
    };
    return {
      ...EMPTY_RESULT,
      lots: wholeShares > 0 ? [...lots, zeroCostLot] : [...lots],
      sharesAdded: wholeShares,
      fractionalEntitlement,
      note: `${wholeShares} bonus share(s) added as a separate zero-cost lot dated ${action.exDate}.`,
    };
  }

  // Spread the entitlement across lots by holding, then leave each lot's cost
  // basis exactly as it was: more shares, same money, lower per-share cost.
  const additions = allocateInteger(
    wholeShares,
    lots.map((lot) => lot.quantity),
  );

  return {
    ...EMPTY_RESULT,
    lots: lots.map((lot, index) => ({
      ...lot,
      quantity: lot.quantity + (additions[index] ?? 0),
    })),
    sharesAdded: wholeShares,
    fractionalEntitlement,
    note: `${wholeShares} bonus share(s) spread across ${lots.length} lot(s); total cost basis unchanged.`,
  };
}

function applySplit(
  lots: readonly OpenLot[],
  action: Extract<CorporateActionInput, { type: 'SPLIT' }>,
): ActionResult {
  if (action.multiplier <= 0) {
    throw new LedgerError(`Split multiplier must be positive, got ${action.multiplier}`);
  }
  const quantity = totalQuantity(lots);
  if (quantity === 0) {
    return {
      ...EMPTY_RESULT,
      lots: [...lots],
      note: `No position on ${action.exDate}; split not applicable.`,
    };
  }

  const target = quantity * action.multiplier;
  const wholeTarget = Math.floor(target);
  const fractionalEntitlement = round6(target - wholeTarget);

  // Allocate the post-split total across lots rather than scaling each one, so
  // the parts still add up to the new holding after rounding.
  const newQuantities = allocateInteger(
    wholeTarget,
    lots.map((lot) => lot.quantity),
  );

  // A reverse split can round a small lot to nothing. Its cost basis cannot be
  // discarded, so it is redistributed over the lots that survive.
  const survivors = lots
    .map((lot, index) => ({ lot, quantity: newQuantities[index] ?? 0 }))
    .filter((entry) => entry.quantity > 0);

  if (survivors.length === 0) {
    throw new LedgerError(
      `A ${action.multiplier}x split of ${quantity} share(s) leaves no whole shares; ` +
        `this needs handling as a cash settlement, not a split.`,
    );
  }

  const basisTotal = totalCostBasis(lots);
  const redistributed = allocatePaisa(
    basisTotal,
    survivors.map((entry) => entry.quantity),
  );

  return {
    ...EMPTY_RESULT,
    lots: survivors.map((entry, index) => ({
      ...entry.lot,
      quantity: entry.quantity,
      costBasis: redistributed[index] ?? ZERO,
      source: entry.lot.source === 'PURCHASE' ? 'PURCHASE' : entry.lot.source,
    })),
    sharesAdded: wholeTarget - quantity,
    fractionalEntitlement,
    note: `Holding re-based from ${quantity} to ${wholeTarget} share(s) at ${action.multiplier}x; total cost basis unchanged.`,
  };
}

/**
 * A rights issue is a purchase, not a free entitlement.
 *
 * Shares taken up cost real money at the subscription price, so they open a
 * normal lot dated the ex-date. Letting a right lapse costs nothing and adds
 * nothing, which is why `subscribedShares` of zero is a valid, quiet outcome.
 */
function applyRights(
  lots: readonly OpenLot[],
  action: Extract<CorporateActionInput, { type: 'RIGHT' }>,
): ActionResult {
  const quantity = totalQuantity(lots);
  const entitled = Math.floor(quantity * action.entitlementPerShare);

  if (action.subscribedShares < 0 || !Number.isInteger(action.subscribedShares)) {
    throw new LedgerError(
      `Subscribed shares must be a non-negative whole number, got ${action.subscribedShares}`,
    );
  }
  if (action.subscribedShares > entitled) {
    throw new LedgerError(
      `Cannot subscribe to ${action.subscribedShares} share(s): the holding of ${quantity} ` +
        `is entitled to ${entitled}.`,
    );
  }

  if (action.subscribedShares === 0) {
    return {
      ...EMPTY_RESULT,
      lots: [...lots],
      note:
        entitled === 0
          ? `No entitlement on ${action.exDate}.`
          : `Right to ${entitled} share(s) not taken up; nothing added.`,
    };
  }

  const charges = action.charges ?? ZERO;
  const lot = openLot({
    id: `${action.id}-rights`,
    openedOn: action.exDate,
    quantity: action.subscribedShares,
    unitPrice: action.subscriptionPrice,
    charges,
    source: 'RIGHT',
  });

  return {
    ...EMPTY_RESULT,
    lots: [...lots, lot],
    sharesAdded: action.subscribedShares,
    cashPaid: addPaisa(
      multiplyByQuantity(action.subscriptionPrice, action.subscribedShares),
      charges,
    ),
    note: `Subscribed to ${action.subscribedShares} of ${entitled} right share(s) at ${(action.subscriptionPrice / 100).toFixed(2)}.`,
  };
}

/** Keeps a fractional entitlement readable instead of 0.30000000000000004. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Applies a sequence of actions in date order.
 *
 * Order matters and compounds: a bonus issue followed by a split is not the
 * same holding as a split followed by a bonus.
 */
export function applyCorporateActions(
  lots: readonly OpenLot[],
  actions: readonly CorporateActionInput[],
): { lots: OpenLot[]; results: ActionResult[] } {
  const ordered = [...actions].sort((a, b) =>
    a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : a.id < b.id ? -1 : 1,
  );

  let current: OpenLot[] = [...lots];
  const results: ActionResult[] = [];
  for (const action of ordered) {
    const result = applyCorporateAction(current, action);
    current = result.lots;
    results.push(result);
  }
  return { lots: current, results };
}

export function netCashFromActions(results: readonly ActionResult[]): Paisa {
  return subPaisa(
    addPaisa(...results.map((r) => r.netCash)),
    addPaisa(...results.map((r) => r.cashPaid)),
  );
}
