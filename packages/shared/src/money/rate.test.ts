import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { paisa } from './paisa.js';
import { proportionalAmount } from './rate.js';

describe('proportionalAmount', () => {
  it('an exclusive-style rate: 16% of Rs 100 is Rs 16', () => {
    expect(proportionalAmount(paisa(100_00), 1_600, 10_000)).toBe(1600);
  });

  it('an inclusive-style rate: the 16%-inclusive tax inside Rs 116 is Rs 16', () => {
    expect(proportionalAmount(paisa(116_00), 1_600, 11_600)).toBe(1600);
  });

  it('rounds exactly half up, matching roundToRupee\'s convention', () => {
    // 1 paisa at 50% => exact half (0.5), rounds up to 1.
    expect(proportionalAmount(paisa(1), 5_000, 10_000)).toBe(1);
    // 3 paisa at 50% => 1.5, rounds up to 2.
    expect(proportionalAmount(paisa(3), 5_000, 10_000)).toBe(2);
  });

  it('a zero rate yields zero; a 100% rate returns the amount unchanged', () => {
    expect(proportionalAmount(paisa(12_345), 0, 10_000)).toBe(0);
    expect(proportionalAmount(paisa(12_345), 10_000, 10_000)).toBe(12_345);
  });

  it('a zero amount always yields zero, at any rate', () => {
    expect(proportionalAmount(paisa(0), 1_600, 10_000)).toBe(0);
  });

  it('rejects an invalid numerator or denominator', () => {
    expect(() => proportionalAmount(paisa(100_00), -1, 10_000)).toThrow(/numeratorBp/);
    expect(() => proportionalAmount(paisa(100_00), 1.5, 10_000)).toThrow(/numeratorBp/);
    expect(() => proportionalAmount(paisa(100_00), 100, 0)).toThrow(/denominatorBp/);
    expect(() => proportionalAmount(paisa(100_00), 100, -10)).toThrow(/denominatorBp/);
  });

  describe('property: exclusive + inclusive round-trip', () => {
    it('extracting an inclusive rate from (base + its own exclusive tax) recovers the same tax, within a paisa of rounding', () => {
      fc.assert(
        fc.property(
          fc.record({ baseMinor: fc.integer({ min: 0, max: 10_000_000 }), rateBp: fc.integer({ min: 0, max: 10_000 }) }),
          ({ baseMinor, rateBp }) => {
            const exclusiveTax = proportionalAmount(paisa(baseMinor), rateBp, 10_000);
            const grossed = baseMinor + exclusiveTax;
            const inclusiveTax = proportionalAmount(paisa(grossed), rateBp, 10_000 + rateBp);
            // Two independent roundings can differ by at most 1 paisa.
            expect(Math.abs(inclusiveTax - exclusiveTax)).toBeLessThanOrEqual(1);
          },
        ),
      );
    });
  });
});
