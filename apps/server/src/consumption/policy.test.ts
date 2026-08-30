import { paisa } from '@pos/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeMealCharge } from './policy.js';
import type { MealPolicy } from './tables.js';

describe('consumption/policy', () => {
  it('free: nothing charged, the whole value needs settling', () => {
    const result = computeMealCharge(paisa(1000_00), 'free', 0);
    expect(result).toEqual({ chargedMinor: 0, settlementMinor: 1000_00 });
  });

  it('payroll_deduction: charges identically to free — settlement_type is what differs', () => {
    const result = computeMealCharge(paisa(1000_00), 'payroll_deduction', 0);
    expect(result).toEqual({ chargedMinor: 0, settlementMinor: 1000_00 });
  });

  it('full_price: the person pays the full menu value, nothing to settle', () => {
    const result = computeMealCharge(paisa(1000_00), 'full_price', 0);
    expect(result).toEqual({ chargedMinor: 1000_00, settlementMinor: 0 });
  });

  it('discounted: splits by meal_discount_bp exactly', () => {
    // 25% off Rs 1000 => charged 750, settled 250, no remainder drama.
    const result = computeMealCharge(paisa(1000_00), 'discounted', 2_500);
    expect(result).toEqual({ chargedMinor: 750_00, settlementMinor: 250_00 });
  });

  it('discounted: a non-round split still sums exactly (largest-remainder, deterministic)', () => {
    // Rs 100 at 33.33% off — not evenly divisible.
    const result = computeMealCharge(paisa(100_00), 'discounted', 3_333);
    expect(result.chargedMinor + result.settlementMinor).toBe(100_00);
  });

  it('discounted: rejects an out-of-range meal_discount_bp', () => {
    expect(() => computeMealCharge(paisa(100_00), 'discounted', 10_001)).toThrow(/meal_discount_bp/);
    expect(() => computeMealCharge(paisa(100_00), 'discounted', -1)).toThrow(/meal_discount_bp/);
  });

  it('a zero-value meal (e.g. every line voided) charges and settles zero without error, for every policy', () => {
    for (const policy of ['free', 'discounted', 'full_price', 'payroll_deduction'] as const) {
      expect(computeMealCharge(paisa(0), policy, 5_000)).toEqual({ chargedMinor: 0, settlementMinor: 0 });
    }
  });

  describe('property: charged + settlement always sums exactly to the menu value', () => {
    it('holds for any menu value, policy, and discount', () => {
      fc.assert(
        fc.property(
          fc.record({
            menuValueMinor: fc.integer({ min: 0, max: 10_000_000 }),
            policy: fc.constantFrom<MealPolicy>('free', 'discounted', 'full_price', 'payroll_deduction'),
            discountBp: fc.integer({ min: 0, max: 10_000 }),
          }),
          ({ menuValueMinor, policy, discountBp }) => {
            const result = computeMealCharge(paisa(menuValueMinor), policy, discountBp);
            expect(result.chargedMinor + result.settlementMinor).toBe(menuValueMinor);
            expect(result.chargedMinor).toBeGreaterThanOrEqual(0);
            expect(result.settlementMinor).toBeGreaterThanOrEqual(0);
          },
        ),
      );
    });
  });
});
