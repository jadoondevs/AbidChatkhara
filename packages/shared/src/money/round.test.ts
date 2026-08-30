import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { paisa } from './paisa.js';
import { roundToRupee } from './round.js';

describe('roundToRupee', () => {
  it('leaves an exact rupee amount unchanged', () => {
    const { total, adjustment } = roundToRupee(paisa(1_234_00));
    expect(total).toBe(1_234_00);
    expect(adjustment).toBe(0);
  });

  it('rounds a remainder under 50 paisa down', () => {
    const { total, adjustment } = roundToRupee(paisa(1_234_49));
    expect(total).toBe(1_234_00);
    expect(adjustment).toBe(-49);
  });

  it('rounds a remainder of exactly 50 paisa up (half up)', () => {
    const { total, adjustment } = roundToRupee(paisa(1_234_50));
    expect(total).toBe(1_235_00);
    expect(adjustment).toBe(50);
  });

  it('rounds a remainder over 50 paisa up', () => {
    const { total, adjustment } = roundToRupee(paisa(1_234_99));
    expect(total).toBe(1_235_00);
    expect(adjustment).toBe(1);
  });

  it('rounds zero to zero', () => {
    const { total, adjustment } = roundToRupee(paisa(0));
    expect(total).toBe(0);
    expect(adjustment).toBe(0);
  });

  it('property: total is always a multiple of 100 paisa and adjustment is total - amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), (amountRaw) => {
        const amount = paisa(amountRaw);
        const { total, adjustment } = roundToRupee(amount);
        // `===` (not `.toBe`/Object.is) because a negative exact multiple
        // of 100 (e.g. -100 % 100) is JS's -0, numerically equal to 0.
        expect(total % 100 === 0).toBe(true);
        expect(total - amount).toBe(adjustment);
        // Half-up: the rounded total is never more than 50 paisa away from the amount.
        expect(Math.abs(total - amount)).toBeLessThanOrEqual(50);
      }),
      { numRuns: 2000 },
    );
  });
});
