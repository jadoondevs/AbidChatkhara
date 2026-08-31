import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { paisa } from './paisa.js';
import { roundToRupee, roundUpTo } from './round.js';

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

describe('roundUpTo', () => {
  it('leaves an amount that is already a multiple of the step alone', () => {
    expect(roundUpTo(paisa(500_00), 500_00)).toBe(500_00);
    expect(roundUpTo(paisa(0), 100_00)).toBe(0);
  });

  it('rounds up to the next multiple', () => {
    expect(roundUpTo(paisa(1_800_00), 500_00)).toBe(2_000_00);
    expect(roundUpTo(paisa(1_800_00), 1000_00)).toBe(2_000_00);
    expect(roundUpTo(paisa(1_800_00), 100_00)).toBe(1_800_00);
    expect(roundUpTo(paisa(1_801_00), 100_00)).toBe(1_900_00);
  });

  it('rounds up by a single paisa when that is all it takes', () => {
    expect(roundUpTo(paisa(1), 100)).toBe(100);
    expect(roundUpTo(paisa(99), 100)).toBe(100);
    expect(roundUpTo(paisa(101), 100)).toBe(200);
  });

  it('rounds a negative amount towards zero, to the next multiple up', () => {
    expect(roundUpTo(paisa(-150), 100)).toBe(-100);
    expect(roundUpTo(paisa(-100), 100)).toBe(-100);
  });

  it('never returns less than the amount it was given', () => {
    for (const amount of [0, 1, 99, 100, 12_345, 1_800_00]) {
      for (const step of [1, 100, 500_00]) {
        expect(roundUpTo(paisa(amount), step)).toBeGreaterThanOrEqual(amount);
      }
    }
  });

  it('always returns a multiple of the step', () => {
    for (const amount of [1, 99, 12_345, 1_800_00]) {
      for (const step of [100, 500_00, 1000_00]) {
        expect(roundUpTo(paisa(amount), step) % step).toBe(0);
      }
    }
  });

  it('rejects a step that is not a positive integer', () => {
    expect(() => roundUpTo(paisa(100), 0)).toThrow(/positive integer/);
    expect(() => roundUpTo(paisa(100), -100)).toThrow(/positive integer/);
    expect(() => roundUpTo(paisa(100), 1.5)).toThrow(/positive integer/);
  });
});
