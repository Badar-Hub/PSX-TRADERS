import { describe, expect, it } from 'vitest';
import { paisa, rupeesToPaisa, type Paisa } from '@psx/shared';
import {
  armTrailingStop,
  evaluateStop,
  isProtective,
  ratchetPrice,
  replayStops,
  stopFromTrail,
  StopError,
  trailBpsFromAtr,
  watchedPrice,
  type StopBar,
  type StopRule,
} from '../src/stops.js';

const rs = (value: string): Paisa => rupeesToPaisa(value);

function bar(date: string, open: string, high: string, low: string, close: string): StopBar {
  void open;
  return { date, high: rs(high), low: rs(low), close: rs(close) };
}

function rule(overrides: Partial<StopRule> = {}): StopRule {
  return {
    type: 'STOP_LOSS',
    triggerOn: 'CLOSE',
    thresholdPrice: null,
    trailAmount: null,
    trailBps: null,
    highWaterMark: null,
    effectiveStop: null,
    expiresAt: null,
    ...overrides,
  };
}

describe('stopFromTrail', () => {
  it('places a fixed trail a constant distance below the mark', () => {
    expect(stopFromTrail(rs('100.00'), { trailAmount: rs('5.00'), trailBps: null })).toBe(9500);
  });

  it('places a basis-point trail proportionally below the mark', () => {
    // 10% of 100.00 is 10.00, so the stop sits at 90.00.
    expect(stopFromTrail(rs('100.00'), { trailAmount: null, trailBps: 1_000 })).toBe(9000);
    // And widens with the price: 10% of 450.00 is 45.00.
    expect(stopFromTrail(rs('450.00'), { trailAmount: null, trailBps: 1_000 })).toBe(40500);
  });

  it('refuses a trail given two ways, or no way at all', () => {
    expect(() => stopFromTrail(rs('100.00'), { trailAmount: rs('5.00'), trailBps: 500 })).toThrow(
      StopError,
    );
    expect(() => stopFromTrail(rs('100.00'), { trailAmount: null, trailBps: null })).toThrow(
      StopError,
    );
  });

  it('refuses a trail that is not a distance', () => {
    expect(() => stopFromTrail(rs('100.00'), { trailAmount: paisa(0), trailBps: null })).toThrow(
      StopError,
    );
    expect(() => stopFromTrail(rs('100.00'), { trailAmount: null, trailBps: 10_000 })).toThrow(
      StopError,
    );
  });

  it('clamps a trail wider than the price itself at zero rather than going negative', () => {
    expect(stopFromTrail(rs('10.00'), { trailAmount: rs('25.00'), trailBps: null })).toBe(0);
  });
});

describe('watchedPrice and ratchetPrice', () => {
  const day = bar('2026-10-20', '100.00', '110.00', '90.00', '105.00');

  it('watches the close by default', () => {
    expect(watchedPrice({ type: 'STOP_LOSS', triggerOn: 'CLOSE' }, day)).toBe(10500);
  });

  it('watches the low for an intraday stop and the high for an intraday target', () => {
    expect(watchedPrice({ type: 'STOP_LOSS', triggerOn: 'INTRADAY_LOW' }, day)).toBe(9000);
    expect(watchedPrice({ type: 'TAKE_PROFIT', triggerOn: 'INTRADAY_HIGH' }, day)).toBe(11000);
  });

  it('trails from the same basis it triggers on', () => {
    // Mixing them would trail the stop up to a high the trigger never sees.
    expect(ratchetPrice({ triggerOn: 'CLOSE' }, day)).toBe(10500);
    expect(ratchetPrice({ triggerOn: 'INTRADAY_LOW' }, day)).toBe(11000);
  });
});

describe('stop-loss', () => {
  const stop = rule({ type: 'STOP_LOSS', thresholdPrice: rs('95.00') });

  it('stays armed above the level and reports the headroom', () => {
    const outcome = evaluateStop(stop, bar('2026-10-20', '100', '101', '99', '100.00'));
    expect(outcome.kind).toBe('UNCHANGED');
    if (outcome.kind !== 'UNCHANGED') return;
    // 100.00 is 5.26% above a 95.00 stop.
    expect(outcome.headroomBps).toBe(526);
  });

  it('triggers at the level, not only below it', () => {
    const outcome = evaluateStop(stop, bar('2026-10-20', '96', '97', '95', '95.00'));
    expect(outcome.kind).toBe('TRIGGERED');
  });

  it('triggers on the close and reports how far through it went', () => {
    const outcome = evaluateStop(stop, bar('2026-10-20', '94', '94', '90', '90.00'));
    expect(outcome.kind).toBe('TRIGGERED');
    if (outcome.kind !== 'TRIGGERED') return;
    expect(outcome.triggerPrice).toBe(9000);
    expect(outcome.stopAtTrigger).toBe(9500);
    expect(outcome.overshootBps).toBe(526);
  });

  /*
   * The case a stop-loss exists for and the one most likely to be
   * misrepresented. If the day's entire range was below the stop, the price
   * gapped through overnight and the stop level was never on offer. An alert
   * that does not say so implies a sale at 95.00 that was never available.
   */
  it('says so when the price gapped straight through the level', () => {
    const outcome = evaluateStop(stop, bar('2026-10-20', '88', '89', '85', '86.00'));
    expect(outcome.kind).toBe('TRIGGERED');
    if (outcome.kind !== 'TRIGGERED') return;
    expect(outcome.message).toContain('gapped through');
  });

  it('does not claim a gap when the level traded during the day', () => {
    const outcome = evaluateStop(stop, bar('2026-10-20', '97', '98', '90', '91.00'));
    if (outcome.kind !== 'TRIGGERED') throw new Error('expected a trigger');
    expect(outcome.message).not.toContain('gapped through');
  });

  it('triggers on an intraday low that the close recovered from', () => {
    const intraday = rule({
      type: 'STOP_LOSS',
      thresholdPrice: rs('95.00'),
      triggerOn: 'INTRADAY_LOW',
    });
    const day = bar('2026-10-20', '100', '101', '94.00', '99.00');

    expect(evaluateStop(intraday, day).kind).toBe('TRIGGERED');
    // The same bar leaves a close-based stop untouched, which is the whole
    // difference between the two bases.
    expect(evaluateStop(rule({ type: 'STOP_LOSS', thresholdPrice: rs('95.00') }), day).kind).toBe(
      'UNCHANGED',
    );
  });
});

describe('take-profit', () => {
  const target = rule({ type: 'TAKE_PROFIT', thresholdPrice: rs('120.00') });

  it('triggers upwards, not downwards', () => {
    expect(evaluateStop(target, bar('2026-10-20', '118', '121', '117', '121.00')).kind).toBe(
      'TRIGGERED',
    );
    expect(evaluateStop(target, bar('2026-10-20', '100', '101', '99', '100.00')).kind).toBe(
      'UNCHANGED',
    );
  });

  it('is not protective, so it never reports a gap through the level', () => {
    expect(isProtective('TAKE_PROFIT')).toBe(false);
    const outcome = evaluateStop(target, bar('2026-10-20', '130', '135', '128', '130.00'));
    if (outcome.kind !== 'TRIGGERED') throw new Error('expected a trigger');
    expect(outcome.message).toContain('target');
    expect(outcome.message).not.toContain('gapped through');
  });
});

describe('trailing stop', () => {
  const trailing = (overrides: Partial<StopRule> = {}): StopRule =>
    rule({
      type: 'TRAILING_STOP',
      trailBps: 1_000,
      highWaterMark: rs('100.00'),
      effectiveStop: rs('90.00'),
      ...overrides,
    });

  it('arms one trail below the current price', () => {
    expect(armTrailingStop(rs('100.00'), { trailAmount: null, trailBps: 1_000 })).toEqual({
      highWaterMark: 10000,
      effectiveStop: 9000,
    });
  });

  it('ratchets up on a new high and lifts the stop with it', () => {
    const outcome = evaluateStop(trailing(), bar('2026-10-20', '105', '112', '104', '110.00'));
    expect(outcome.kind).toBe('MOVED');
    if (outcome.kind !== 'MOVED') return;
    expect(outcome.highWaterMark).toBe(11000);
    expect(outcome.effectiveStop).toBe(9900);
    expect(outcome.previousStop).toBe(9000);
  });

  it('never moves the stop down when the price falls', () => {
    const outcome = evaluateStop(trailing(), bar('2026-10-20', '96', '97', '93', '94.00'));
    expect(outcome.kind).toBe('UNCHANGED');
    if (outcome.kind !== 'UNCHANGED') return;
    expect(outcome.effectiveStop).toBe(9000);
  });

  it('triggers when the price falls through the trailed stop', () => {
    const outcome = evaluateStop(trailing(), bar('2026-10-20', '91', '92', '88', '89.00'));
    expect(outcome.kind).toBe('TRIGGERED');
    if (outcome.kind !== 'TRIGGERED') return;
    expect(outcome.stopAtTrigger).toBe(9000);
    expect(outcome.highWaterMark).toBe(10000);
    expect(outcome.message).toContain('trailed up from a high of Rs 100.00');
  });

  /*
   * The ordering case. This bar makes a new high of 130.00, which would lift
   * the stop to 117.00, and also closes at 85.00, which is below both the old
   * 90.00 stop and the lifted one.
   *
   * Reported against the old stop, because end-of-day data does not say whether
   * the high came before the close. Claiming 117.00 would tell the user they
   * got out 32 rupees higher than the evidence supports.
   */
  it('tests the trigger against the stop in force before the bar moved it', () => {
    const outcome = evaluateStop(
      trailing({ triggerOn: 'INTRADAY_LOW' }),
      bar('2026-10-20', '105', '130.00', '85.00', '86.00'),
    );
    expect(outcome.kind).toBe('TRIGGERED');
    if (outcome.kind !== 'TRIGGERED') return;
    expect(outcome.stopAtTrigger).toBe(9000);
    expect(outcome.highWaterMark).toBe(10000);
  });

  it('recomputes the stop from the mark rather than trusting a stale cache', () => {
    // A stored effectiveStop that disagrees with the mark and the trail must
    // not be what decides when someone's holding gets sold.
    const outcome = evaluateStop(
      trailing({ effectiveStop: rs('1.00') }),
      bar('2026-10-20', '91', '92', '88', '89.00'),
    );
    expect(outcome.kind).toBe('TRIGGERED');
    if (outcome.kind !== 'TRIGGERED') return;
    expect(outcome.stopAtTrigger).toBe(9000);
  });

  it('works the same with a fixed trail', () => {
    const fixed = trailing({ trailBps: null, trailAmount: rs('8.00') });
    const moved = evaluateStop(fixed, bar('2026-10-20', '105', '112', '104', '110.00'));
    if (moved.kind !== 'MOVED') throw new Error('expected a move');
    expect(moved.effectiveStop).toBe(10200);
  });

  it('refuses to evaluate a trail with no mark to trail from', () => {
    const outcome = evaluateStop(
      trailing({ highWaterMark: null }),
      bar('2026-10-20', '100', '101', '99', '100.00'),
    );
    expect(outcome.kind).toBe('SKIPPED');
    if (outcome.kind !== 'SKIPPED') return;
    expect(outcome.reason).toBe('INCOMPLETE_RULE');
  });
});

describe('expiry and unsupported types', () => {
  it('expires against the bar date, not the clock', () => {
    const expiring = rule({
      type: 'STOP_LOSS',
      thresholdPrice: rs('95.00'),
      expiresAt: new Date('2026-10-15T00:00:00Z'),
    });

    // A replay of an older bar must still see the rule as live.
    expect(evaluateStop(expiring, bar('2026-10-14', '100', '101', '99', '100.00')).kind).toBe(
      'UNCHANGED',
    );
    expect(evaluateStop(expiring, bar('2026-10-16', '100', '101', '99', '100.00')).kind).toBe(
      'EXPIRED',
    );
  });

  it('expires in preference to triggering once the date has passed', () => {
    const expired = rule({
      type: 'STOP_LOSS',
      thresholdPrice: rs('95.00'),
      expiresAt: new Date('2026-10-15T00:00:00Z'),
    });
    expect(evaluateStop(expired, bar('2026-10-20', '90', '91', '85', '85.00')).kind).toBe('EXPIRED');
  });

  it('says plainly that a price alert has no evaluator rather than silently never firing', () => {
    const outcome = evaluateStop(
      rule({ type: 'PRICE_ALERT', thresholdPrice: rs('95.00') }),
      bar('2026-10-20', '90', '91', '85', '85.00'),
    );
    expect(outcome.kind).toBe('SKIPPED');
    if (outcome.kind !== 'SKIPPED') return;
    expect(outcome.reason).toBe('UNSUPPORTED_TYPE');
  });

  it('refuses a threshold rule with no threshold', () => {
    const outcome = evaluateStop(
      rule({ type: 'STOP_LOSS', thresholdPrice: null }),
      bar('2026-10-20', '90', '91', '85', '85.00'),
    );
    expect(outcome.kind).toBe('SKIPPED');
  });
});

describe('replayStops', () => {
  const rising = [
    bar('2026-10-01', '100', '102', '99', '101.00'),
    bar('2026-10-02', '101', '106', '101', '105.00'),
    bar('2026-10-03', '105', '112', '104', '110.00'),
    bar('2026-10-06', '110', '111', '95', '96.00'),
  ];

  it('trails up through a rise and fires on the fall', () => {
    const start = rule({
      type: 'TRAILING_STOP',
      trailBps: 1_000,
      ...armTrailingStop(rs('100.00'), { trailAmount: null, trailBps: 1_000 }),
    });

    const result = replayStops(start, rising);

    // Three bars of trailing, then the trigger on the fourth.
    expect(result.steps.map((step) => step.outcome.kind)).toEqual([
      'MOVED',
      'MOVED',
      'MOVED',
      'TRIGGERED',
    ]);
    expect(result.triggered?.bar.date).toBe('2026-10-06');

    const fired = result.triggered?.outcome;
    if (fired?.kind !== 'TRIGGERED') throw new Error('expected a trigger');
    // The mark reached 110.00 on the third bar, so the stop was 99.00 — well
    // above the 90.00 it started at. That lift is the point of a trailing stop.
    expect(fired.stopAtTrigger).toBe(9900);
    expect(fired.highWaterMark).toBe(11000);
  });

  it('stops at the first trigger and does not evaluate later bars', () => {
    const start = rule({ type: 'STOP_LOSS', thresholdPrice: rs('100.50') });
    const result = replayStops(start, rising);
    // The very first bar closes at 101.00... above the stop. The second closes
    // at 105.00. Neither fires; the fall on the fourth does.
    expect(result.steps).toHaveLength(4);
    expect(result.triggered?.bar.date).toBe('2026-10-06');
  });

  it('returns the state a caller should persist when nothing fired', () => {
    const start = rule({
      type: 'TRAILING_STOP',
      trailBps: 1_000,
      ...armTrailingStop(rs('100.00'), { trailAmount: null, trailBps: 1_000 }),
    });

    const result = replayStops(start, rising.slice(0, 3));
    expect(result.triggered).toBeNull();
    expect(result.finalState).toEqual({ highWaterMark: 11000, effectiveStop: 9900 });
  });

  it('replays an empty series without inventing a step', () => {
    const result = replayStops(rule({ type: 'STOP_LOSS', thresholdPrice: rs('95.00') }), []);
    expect(result.steps).toHaveLength(0);
    expect(result.triggered).toBeNull();
  });
});

describe('trailBpsFromAtr', () => {
  it('scales the trail to how much the stock actually moves', () => {
    // An ATR of 4.00 on a 100.00 share at 2.5x is a 10.00 trail: 1000 bps.
    expect(trailBpsFromAtr(rs('100.00'), 400, 2.5)).toBe(1_000);
    // The same share with half the volatility gets half the trail.
    expect(trailBpsFromAtr(rs('100.00'), 200, 2.5)).toBe(500);
  });

  it('floors a trail that would sit inside the daily noise', () => {
    expect(trailBpsFromAtr(rs('100.00'), 1, 2.5)).toBe(100);
  });

  it('caps a trail that would not be protecting anything', () => {
    expect(trailBpsFromAtr(rs('100.00'), 9_000, 2.5)).toBe(5_000);
  });

  it('declines rather than guessing when there is no usable ATR', () => {
    expect(trailBpsFromAtr(rs('100.00'), 0)).toBeNull();
    expect(trailBpsFromAtr(rs('100.00'), Number.NaN)).toBeNull();
    expect(trailBpsFromAtr(paisa(0), 400)).toBeNull();
  });

  it('refuses a multiple that is not a width', () => {
    expect(() => trailBpsFromAtr(rs('100.00'), 400, 0)).toThrow(StopError);
  });
});
