import { describe, expect, it } from 'vitest';
import { rupeesToPaisa } from '@psx/shared';
import type { BrokerageAccount } from '@prisma/client';
import { resolveCharges, scheduleFromAccount } from '../src/services/charges.js';

const rs = (value: string) => rupeesToPaisa(value);

function account(overrides: Partial<BrokerageAccount> = {}): BrokerageAccount {
  return {
    id: 'acct-1',
    userId: 'user-1',
    name: 'Main',
    brokerName: 'Test Broker',
    brokerageBps: 15,
    brokerageMinimum: 0n,
    brokeragePerShare: 0n,
    salesTaxOnBrokerageBps: 1300,
    cdcBps: 1,
    secpBps: 1,
    fixedPerOrder: 0n,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as BrokerageAccount;
}

describe('scheduleFromAccount', () => {
  it('converts the stored bigint amounts into paisa', () => {
    const schedule = scheduleFromAccount(
      account({ brokerageMinimum: 10_000n, fixedPerOrder: 2_500n }),
    );
    expect(schedule.brokerageMinimum).toBe(rs('100.00'));
    expect(schedule.fixedPerOrder).toBe(rs('25.00'));
    expect(schedule.brokerageBps).toBe(15);
  });
});

describe('resolveCharges', () => {
  it('derives charges from the account schedule', () => {
    const charges = resolveCharges(rs('170.00'), 100, account(), undefined);
    // 17,000.00 at 15 bp = 25.50 brokerage; 13% of that is 3.32 sales tax;
    // 1 bp each for CDC and SECP is 1.70 apiece.
    expect(charges.brokerage).toBe(rs('25.50'));
    expect(charges.salesTax).toBe(rs('3.32'));
    expect(charges.cdc).toBe(rs('1.70'));
    expect(charges.secp).toBe(rs('1.70'));
    expect(charges.total).toBe(rs('32.22'));
  });

  it('applies a commission floor on a small order', () => {
    const charges = resolveCharges(
      rs('10.00'),
      10,
      account({ brokerageMinimum: 5_000n }),
      undefined,
    );
    // 100.00 at 15 bp would be 0.15, so the 50.00 minimum governs.
    expect(charges.brokerage).toBe(rs('50.00'));
  });

  it('uses a per-share rate when it exceeds the value-based one', () => {
    const charges = resolveCharges(
      rs('2.00'),
      1000,
      account({ brokeragePerShare: 3n }),
      undefined,
    );
    // 2,000.00 at 15 bp is 3.00; 1000 shares at 3 paisa is 30.00.
    expect(charges.brokerage).toBe(rs('30.00'));
  });

  /**
   * The broker's own figures win. Reconciling against the contract note matters
   * more than internal consistency with a computed schedule.
   */
  it('uses supplied figures verbatim, overriding the schedule', () => {
    const charges = resolveCharges(rs('170.00'), 100, account(), {
      brokerage: rs('27.00'),
      salesTax: rs('3.51'),
      cdc: rs('1.00'),
      secp: rs('1.00'),
    });
    expect(charges.brokerage).toBe(rs('27.00'));
    expect(charges.total).toBe(rs('32.51'));
  });

  it('treats a partial override as complete, with the rest zero', () => {
    // Supplying only brokerage means the contract note showed only brokerage;
    // filling the gaps from the schedule would invent charges the broker did
    // not levy.
    const charges = resolveCharges(rs('170.00'), 100, account(), { brokerage: rs('27.00') });
    expect(charges.brokerage).toBe(rs('27.00'));
    expect(charges.salesTax).toBe(0);
    expect(charges.total).toBe(rs('27.00'));
  });

  it('charges nothing when the portfolio has no account, as a paper one will not', () => {
    const charges = resolveCharges(rs('170.00'), 100, null, undefined);
    expect(charges.total).toBe(0);
  });

  it('scales with order size', () => {
    const small = resolveCharges(rs('100.00'), 10, account(), undefined);
    const large = resolveCharges(rs('100.00'), 10_000, account(), undefined);
    expect(large.total).toBeGreaterThan(small.total);
  });
});
