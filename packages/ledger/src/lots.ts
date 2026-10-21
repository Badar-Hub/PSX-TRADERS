import {
  ZERO,
  addPaisa,
  allocatePaisa,
  daysBetween,
  multiplyByQuantity,
  paisa,
  subPaisa,
  type CostBasisMethod,
  type IsoDate,
  type Paisa,
} from '@psx/shared';

/**
 * Tax-lot accounting: matching a sale against the specific purchases it closes.
 *
 * Why lots rather than an average cost per holding. A sale realises a gain
 * against the particular shares it disposed of, and on the PSX capital gains
 * are assessed first-in-first-out. Collapsing a holding to one average cost
 * throws away the information needed to compute either the tax or an honest
 * per-trade result, and it cannot be recovered afterwards. So every purchase
 * opens a lot, and every sale consumes lots in a defined order, recording
 * exactly which ones it consumed.
 *
 * The invariant this module exists to protect: for any lot, the cost basis
 * consumed by sales plus the basis still open equals the basis it was opened
 * with, to the paisa, forever. Every split of an amount therefore goes through
 * `allocatePaisa`, which distributes a total without losing or inventing a
 * paisa. Rounding each share of a split independently is the usual way this
 * goes wrong, and the error is tiny per trade and unbounded over a few hundred.
 */

export class LedgerError extends Error {}

export class InsufficientSharesError extends LedgerError {
  constructor(
    readonly requested: number,
    readonly available: number,
    readonly symbol?: string,
  ) {
    super(
      `Cannot sell ${requested} share(s)${symbol ? ` of ${symbol}` : ''}: only ${available} held. ` +
        `Short selling is not modelled; check for a missing purchase or corporate action.`,
    );
  }
}

export type LotSource = 'PURCHASE' | 'BONUS' | 'RIGHT' | 'SPLIT' | 'TRANSFER_IN';

/** A purchase, or part of one, that has not yet been sold. */
export interface OpenLot {
  id: string;
  /** Trade date the lot was acquired, which starts its holding period. */
  openedOn: IsoDate;
  /** Shares still open in this lot. */
  quantity: number;
  /**
   * Total cost of the shares still open, inclusive of the buy-side charges
   * attributed to them. Per-share cost is derived, never stored, so that the
   * lot total stays the authoritative figure.
   */
  costBasis: Paisa;
  source: LotSource;
  /** The trade that opened it, for tracing a figure back to a contract note. */
  openTradeId?: string;
}

export interface SaleInput {
  soldOn: IsoDate;
  quantity: number;
  unitPrice: Paisa;
  /** Total sale-side charges, which reduce the proceeds. */
  charges: Paisa;
}

/** One lot consumed by one sale, and the gain or loss that realised. */
export interface LotAllocation {
  lotId: string;
  openedOn: IsoDate;
  quantitySold: number;
  /** Portion of the lot's cost basis consumed. */
  costBasis: Paisa;
  /** Portion of the sale's net proceeds attributed to these shares. */
  proceeds: Paisa;
  realisedPnl: Paisa;
  holdingDays: number;
  source: LotSource;
}

export interface SaleResult {
  allocations: LotAllocation[];
  /** Lots after the sale, with consumed quantity and basis removed. */
  remainingLots: OpenLot[];
  grossProceeds: Paisa;
  /** Gross less charges: what actually reaches the account. */
  netProceeds: Paisa;
  totalCostBasis: Paisa;
  realisedPnl: Paisa;
}

export function totalQuantity(lots: readonly OpenLot[]): number {
  return lots.reduce((sum, lot) => sum + lot.quantity, 0);
}

export function totalCostBasis(lots: readonly OpenLot[]): Paisa {
  return addPaisa(...lots.map((lot) => lot.costBasis));
}

/**
 * Average cost per share across a set of lots, rounded for display.
 *
 * Derived rather than stored: rounding it once and keeping it would make the
 * per-share figure disagree with the lot total it came from.
 */
export function averageCostPerShare(lots: readonly OpenLot[]): Paisa | null {
  const quantity = totalQuantity(lots);
  if (quantity === 0) return null;
  return paisa(Math.round(totalCostBasis(lots) / quantity));
}

/**
 * Orders lots for consumption.
 *
 * The tie-break on id is not cosmetic: two lots opened the same day must be
 * consumed in a stable order, or re-running the same trade history could
 * produce different holding periods and therefore a different tax figure.
 */
function orderForConsumption(lots: readonly OpenLot[], method: CostBasisMethod): OpenLot[] {
  const sorted = [...lots];
  switch (method) {
    case 'LIFO':
      sorted.sort((a, b) => (a.openedOn < b.openedOn ? 1 : a.openedOn > b.openedOn ? -1 : a.id < b.id ? -1 : 1));
      break;
    case 'FIFO':
    case 'AVERAGE':
    default:
      sorted.sort((a, b) => (a.openedOn < b.openedOn ? -1 : a.openedOn > b.openedOn ? 1 : a.id < b.id ? -1 : 1));
      break;
  }
  return sorted;
}

/**
 * Matches a sale against open lots and reports what it realised.
 *
 * Pure: it does not mutate `lots`, and returns the post-sale state alongside
 * the allocations so a caller can persist both in one transaction.
 */
export function matchSale(
  lots: readonly OpenLot[],
  sale: SaleInput,
  method: CostBasisMethod = 'FIFO',
  symbol?: string,
): SaleResult {
  if (!Number.isInteger(sale.quantity) || sale.quantity <= 0) {
    throw new LedgerError(`Sale quantity must be a positive whole number, got ${sale.quantity}`);
  }

  const available = totalQuantity(lots);
  if (sale.quantity > available) {
    throw new InsufficientSharesError(sale.quantity, available, symbol);
  }

  const grossProceeds = multiplyByQuantity(sale.unitPrice, sale.quantity);
  const netProceeds = subPaisa(grossProceeds, sale.charges);

  const ordered = orderForConsumption(lots, method);

  // Walk the ordered lots taking shares until the sale is filled.
  const consumption: Array<{ lot: OpenLot; quantity: number }> = [];
  let outstanding = sale.quantity;
  for (const lot of ordered) {
    if (outstanding === 0) break;
    if (lot.quantity <= 0) continue;
    const take = Math.min(lot.quantity, outstanding);
    consumption.push({ lot, quantity: take });
    outstanding -= take;
  }

  const quantities = consumption.map((entry) => entry.quantity);

  // Net proceeds are split by share count, so each allocation's proceeds are
  // its fair share of what the account actually received.
  const proceedsSplit = allocatePaisa(netProceeds, quantities);

  const costSplit =
    method === 'AVERAGE'
      ? averageCostSplit(lots, quantities, sale.quantity, available)
      : consumption.map((entry) =>
          // Split this lot's basis between the part sold and the part left.
          allocatePaisa(entry.lot.costBasis, [
            entry.quantity,
            entry.lot.quantity - entry.quantity,
          ])[0] ?? ZERO,
        );

  const allocations: LotAllocation[] = consumption.map((entry, index) => {
    const costBasis = costSplit[index] ?? ZERO;
    const proceeds = proceedsSplit[index] ?? ZERO;
    return {
      lotId: entry.lot.id,
      openedOn: entry.lot.openedOn,
      quantitySold: entry.quantity,
      costBasis,
      proceeds,
      realisedPnl: subPaisa(proceeds, costBasis),
      holdingDays: daysBetween(entry.lot.openedOn, sale.soldOn),
      source: entry.lot.source,
    };
  });

  const remainingLots = buildRemainingLots(lots, consumption, costSplit, method, available, sale.quantity);

  const consumedBasis = addPaisa(...allocations.map((a) => a.costBasis));

  return {
    allocations,
    remainingLots,
    grossProceeds,
    netProceeds,
    totalCostBasis: consumedBasis,
    realisedPnl: subPaisa(netProceeds, consumedBasis),
  };
}

/**
 * Average costing pools every lot and charges the sale at the pool rate.
 *
 * The pool total is split once between sold and unsold shares, then that single
 * figure is divided across the lots consumed. Going through the pool first is
 * what makes it average costing rather than FIFO with extra steps.
 */
function averageCostSplit(
  lots: readonly OpenLot[],
  quantities: number[],
  quantitySold: number,
  available: number,
): Paisa[] {
  const poolBasis = totalCostBasis(lots);
  const [costOfSale = ZERO] = allocatePaisa(poolBasis, [quantitySold, available - quantitySold]);
  return allocatePaisa(costOfSale, quantities);
}

function buildRemainingLots(
  lots: readonly OpenLot[],
  consumption: ReadonlyArray<{ lot: OpenLot; quantity: number }>,
  costSplit: readonly Paisa[],
  method: CostBasisMethod,
  available: number,
  quantitySold: number,
): OpenLot[] {
  const consumedQuantity = new Map<string, number>();
  const consumedBasis = new Map<string, Paisa>();
  consumption.forEach((entry, index) => {
    consumedQuantity.set(entry.lot.id, entry.quantity);
    consumedBasis.set(entry.lot.id, costSplit[index] ?? ZERO);
  });

  // Keep the caller's lot order, so persisted rows are not reshuffled by a sale.
  const survivors = lots
    .map((lot) => {
      const taken = consumedQuantity.get(lot.id) ?? 0;
      return { lot, quantity: lot.quantity - taken, taken };
    })
    .filter((entry) => entry.quantity > 0);

  if (method === 'AVERAGE') {
    // Under pooling every surviving share carries the same cost, so the
    // remaining pool is redistributed rather than each lot keeping its own
    // history. Allocating in one pass is what keeps the total exact.
    const poolBasis = totalCostBasis(lots);
    const [, remainingPool = ZERO] = allocatePaisa(poolBasis, [
      quantitySold,
      available - quantitySold,
    ]);
    const shares = allocatePaisa(
      remainingPool,
      survivors.map((entry) => entry.quantity),
    );
    return survivors.map((entry, index) => ({
      ...entry.lot,
      quantity: entry.quantity,
      costBasis: shares[index] ?? ZERO,
    }));
  }

  return survivors.map((entry) => ({
    ...entry.lot,
    quantity: entry.quantity,
    costBasis: subPaisa(entry.lot.costBasis, consumedBasis.get(entry.lot.id) ?? ZERO),
  }));
}

/**
 * Opens a lot from a purchase.
 *
 * Buy-side charges are folded into the cost basis rather than recorded
 * separately, because they are genuinely part of what the shares cost. Keeping
 * them out would overstate every gain by the brokerage paid to acquire it.
 */
export function openLot(input: {
  id: string;
  openedOn: IsoDate;
  quantity: number;
  unitPrice: Paisa;
  charges: Paisa;
  source?: LotSource;
  openTradeId?: string;
}): OpenLot {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new LedgerError(`Lot quantity must be a positive whole number, got ${input.quantity}`);
  }
  return {
    id: input.id,
    openedOn: input.openedOn,
    quantity: input.quantity,
    costBasis: addPaisa(multiplyByQuantity(input.unitPrice, input.quantity), input.charges),
    source: input.source ?? 'PURCHASE',
    ...(input.openTradeId !== undefined ? { openTradeId: input.openTradeId } : {}),
  };
}
