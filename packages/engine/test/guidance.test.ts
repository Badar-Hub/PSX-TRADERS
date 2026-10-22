import { describe, expect, it } from 'vitest';
import { ALL_FACTORS } from '../src/scoring.js';
import { FACTOR_GUIDANCE, guidanceFor } from '../src/factors/guidance.js';

/**
 * Guidance exists for every factor, and says nothing that amounts to advice.
 *
 * The second half is the point. The app refuses to tell anyone what to buy —
 * `validateNarrative` rejects prose that does, and the narrative prompt
 * forbids it — so a guidance panel that slipped into recommendations would
 * make the product incoherent and would be the one part of it no check
 * covered. These assertions are that check.
 */

describe('factor guidance', () => {
  it('covers every factor the engine can score', () => {
    const missing = ALL_FACTORS.filter((factor) => guidanceFor(factor.key) === null);
    // A new factor without guidance would ship a blank panel, so this fails
    // when one is added rather than letting it through.
    expect(missing.map((factor) => factor.key)).toEqual([]);
  });

  it('writes guidance for no factor the engine does not have', () => {
    const keys = new Set(ALL_FACTORS.map((factor) => factor.key));
    const orphans = Object.keys(FACTOR_GUIDANCE).filter((key) => !keys.has(key));
    expect(orphans).toEqual([]);
  });

  it('never tells the reader what to do', () => {
    const advice = [
      'you should buy',
      'you should sell',
      'we recommend',
      'i recommend',
      'my advice',
      'guaranteed',
      'will rise',
      'will fall',
      'price target',
    ];

    for (const [key, guidance] of Object.entries(FACTOR_GUIDANCE)) {
      const text = `${guidance.reads} ${guidance.watchFor} ${guidance.caveat}`.toLowerCase();
      for (const phrase of advice) {
        expect(text, `${key} contains "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('gives every factor all three parts, each a real sentence', () => {
    for (const [key, guidance] of Object.entries(FACTOR_GUIDANCE)) {
      for (const part of ['reads', 'watchFor', 'caveat'] as const) {
        expect(guidance[part].length, `${key}.${part} too short`).toBeGreaterThan(40);
        expect(guidance[part].trim(), `${key}.${part} not a sentence`).toMatch(/\.$/);
      }
    }
  });

  /*
   * A caveat per factor is not decoration. Every one of these indicators has a
   * standard misreading, and the candlestick and RSI entries in particular
   * exist to say so where a user is most likely to over-trust them.
   */
  it('says where the convention is weakest, including for the weakest factor', () => {
    expect(guidanceFor('candlestick')?.caveat.toLowerCase()).toContain('weakest');
    expect(guidanceFor('rsi_14')?.caveat.toLowerCase()).toContain('trend');
  });
});
