import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { distribute, prorate, splitByShares } from './distribute.js';
import { paisa, sum } from './paisa.js';

describe('distribute — property tests', () => {
  it('always sums to exactly the total, for any total and any non-negative integer weights', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_00, max: 1_000_000_00 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0)),
        (totalRaw, weights) => {
          const total = paisa(totalRaw);
          const parts = distribute(total, weights);
          expect(sum(parts)).toBe(total);
          expect(parts).toHaveLength(weights.length);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('never errors on an all-zero total, whatever the weights', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 0, maxLength: 12 }), (weights) => {
        const parts = distribute(paisa(0), weights);
        expect(parts.every((p) => p === 0)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('gives every paisa of the remainder to the largest fractional parts, ascending index on ties', () => {
    // Rs 100 split three equal ways: exact = 3333.33 each, remainder = 1,
    // all three fractional parts tie, so index 0 gets the extra paisa.
    expect(distribute(paisa(10_000), [1, 1, 1])).toEqual([3334, 3333, 3333]);
  });

  it('is deterministic — same inputs always give the same split', () => {
    const total = paisa(987_654);
    const weights = [37, 12, 51, 4, 4];
    const a = distribute(total, weights);
    const b = distribute(total, weights);
    expect(a).toEqual(b);
  });
});

describe('distribute — validation', () => {
  it('rejects negative weights', () => {
    expect(() => distribute(paisa(100), [-1, 5])).toThrow(/non-negative/);
  });

  it('rejects non-integer weights', () => {
    expect(() => distribute(paisa(100), [1.5, 5])).toThrow(/integers/);
  });

  it('rejects a non-zero total with no weights', () => {
    expect(() => distribute(paisa(100), [])).toThrow(/zero parts/);
  });

  it('rejects a non-zero total when weights sum to zero', () => {
    expect(() => distribute(paisa(100), [0, 0, 0])).toThrow(/nothing to distribute/);
  });
});

describe('splitByShares — property test: valid ownership splits sum exactly to the base', () => {
  // Generates a set of basis-point shares that sum to exactly 10000, the
  // way partner ownership is required to at any instant (see partners/).
  const validShareSplit = fc
    .array(fc.integer({ min: 1, max: 3000 }), { minLength: 1, maxLength: 8 })
    .map((raw) => {
      const total = raw.reduce((a, b) => a + b, 0);
      // Scale down to fit under 10000, then hand any leftover to the last
      // partner so the set sums to exactly 10000 — still "any valid split".
      const scaled = raw.map((v) => Math.floor((v / total) * 10_000));
      const shortfall = 10_000 - scaled.reduce((a, b) => a + b, 0);
      scaled[scaled.length - 1] = (scaled[scaled.length - 1] ?? 0) + shortfall;
      return scaled.map((shareBp, i) => ({ key: String(i).padStart(3, '0'), shareBp }));
    });

  it('sums exactly to the allocation base for any base amount and any valid split', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000_00 }), validShareSplit, (baseRaw, shares) => {
        const base = paisa(baseRaw);
        const parts = splitByShares(base, shares);
        expect(sum(parts)).toBe(base);
      }),
      { numRuns: 3000 },
    );
  });

  it('rejects shares that do not sum to 10000 basis points', () => {
    expect(() => splitByShares(paisa(1000), [{ key: 'a', shareBp: 5000 }])).toThrow(/10000/);
  });

  it('Rs 100 split three ways gives 3334 / 3333 / 3333 paisa, deterministically', () => {
    const shares = [
      { key: '001', shareBp: 3334 },
      { key: '002', shareBp: 3333 },
      { key: '003', shareBp: 3333 },
    ];
    expect(splitByShares(paisa(10_000), shares)).toEqual([3334, 3333, 3333]);
  });

  it('a single-owner item allocates 100% with zero remainder', () => {
    const shares = [{ key: 'only', shareBp: 10_000 }];
    expect(splitByShares(paisa(123_456), shares)).toEqual([123_456]);
  });

  it('zero-value and fully-discounted lines allocate zero without error', () => {
    const shares = [
      { key: 'a', shareBp: 5000 },
      { key: 'b', shareBp: 5000 },
    ];
    expect(splitByShares(paisa(0), shares)).toEqual([0, 0]);
  });
});

describe('prorate — property test: prorated discounts sum exactly to the discount', () => {
  // A discount is at most the subtotal it's discounting, so generate the
  // line weights first, then a discount amount bounded by their sum.
  const linesAndDiscount = fc
    .array(fc.integer({ min: 0, max: 1_000_00 }), { minLength: 1, maxLength: 10 })
    .filter((w) => w.some((x) => x > 0))
    .chain((weightsRaw) => {
      const grossTotal = weightsRaw.reduce((a, b) => a + b, 0);
      return fc.record({
        weightsRaw: fc.constant(weightsRaw),
        discountRaw: fc.integer({ min: 0, max: grossTotal }),
      });
    });

  it('sums exactly to the discount for any discount and any set of line weights', () => {
    fc.assert(
      fc.property(linesAndDiscount, ({ weightsRaw, discountRaw }) => {
        const weights = weightsRaw.map((w) => paisa(w));
        const discount = paisa(discountRaw);
        const parts = prorate(discount, weights);
        expect(sum(parts)).toBe(discount);
      }),
      { numRuns: 2000 },
    );
  });

  it('a 10% order discount on a two-item bill reduces each line by exactly 10% when it divides evenly', () => {
    const lineA = paisa(50_00); // Rs 500
    const lineB = paisa(30_00); // Rs 300
    const discount = paisa(8_00); // 10% of Rs 800 subtotal
    const [partA, partB] = prorate(discount, [lineA, lineB]);
    expect(partA).toBe(5_00); // exactly 10% of 5000
    expect(partB).toBe(3_00); // exactly 10% of 3000
    expect((partA ?? 0) + (partB ?? 0)).toBe(discount);
  });
});
