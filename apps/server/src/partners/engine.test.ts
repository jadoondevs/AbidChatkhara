import { paisa, sum } from '@pos/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateOne, type OwnershipShare } from './engine.js';

describe('allocateOne — property tests', () => {
  it('for any base amount and any valid share split, allocations sum exactly to the base', () => {
    // A "valid share split": basis points summing to exactly 10000,
    // pre-sorted by partnerId ascending as the engine requires.
    const validSplit = fc
      .array(fc.integer({ min: 1, max: 3000 }), { minLength: 1, maxLength: 10 })
      .map((raw) => {
        const total = raw.reduce((a, b) => a + b, 0);
        const scaled = raw.map((v) => Math.floor((v / total) * 10_000));
        const shortfall = 10_000 - scaled.reduce((a, b) => a + b, 0);
        scaled[scaled.length - 1] = (scaled[scaled.length - 1] ?? 0) + shortfall;
        return scaled.map((shareBp, i): OwnershipShare => ({ partnerId: i + 1, shareBp }));
      });

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000_00 }), validSplit, (baseRaw, shares) => {
        const base = paisa(baseRaw);
        const result = allocateOne({ key: 'line:1', allocationBaseMinor: base, shares, allocationBaseMode: 'NET_SALES_EX_TAX' });
        expect(sum(result.map((r) => r.amountMinor))).toBe(base);
        expect(result).toHaveLength(shares.length);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('allocateOne — the spec\'s required examples', () => {
  it('Rs 100 split three ways gives 3334 / 3333 / 3333 paisa, deterministically', () => {
    const shares: OwnershipShare[] = [
      { partnerId: 1, shareBp: 3334 },
      { partnerId: 2, shareBp: 3333 },
      { partnerId: 3, shareBp: 3333 },
    ];
    const result = allocateOne({ key: 'line:1', allocationBaseMinor: paisa(10_000), shares, allocationBaseMode: 'NET_SALES_EX_TAX' });
    expect(result.map((r) => r.amountMinor)).toEqual([3334, 3333, 3333]);
  });

  it('a single-owner item allocates 100% with zero remainder', () => {
    const shares: OwnershipShare[] = [{ partnerId: 7, shareBp: 10_000 }];
    const result = allocateOne({ key: 'line:1', allocationBaseMinor: paisa(123_456), shares, allocationBaseMode: 'NET_SALES_EX_TAX' });
    expect(result).toEqual([{ key: 'line:1', partnerId: 7, shareBpSnapshot: 10_000, amountMinor: 123_456, allocationBaseMode: 'NET_SALES_EX_TAX' }]);
  });

  it('zero-value and fully-discounted lines allocate zero without error', () => {
    const shares: OwnershipShare[] = [
      { partnerId: 1, shareBp: 5000 },
      { partnerId: 2, shareBp: 5000 },
    ];
    const result = allocateOne({ key: 'line:1', allocationBaseMinor: paisa(0), shares, allocationBaseMode: 'NET_SALES_EX_TAX' });
    expect(result.map((r) => r.amountMinor)).toEqual([0, 0]);
  });

  it('an item with no ownership configured and a zero base allocates nothing, without error', () => {
    const result = allocateOne({ key: 'line:1', allocationBaseMinor: paisa(0), shares: [], allocationBaseMode: 'NET_SALES_EX_TAX' });
    expect(result).toEqual([]);
  });

  it('refuses to allocate a non-zero base with no ownership configured, loudly', () => {
    expect(() =>
      allocateOne({ key: 'line:1', allocationBaseMinor: paisa(100), shares: [], allocationBaseMode: 'NET_SALES_EX_TAX' }),
    ).toThrow();
  });

  it('rejects shares that do not sum to 10000 basis points', () => {
    const shares: OwnershipShare[] = [{ partnerId: 1, shareBp: 5000 }]; // only 50%
    expect(() =>
      allocateOne({ key: 'line:1', allocationBaseMinor: paisa(1000), shares, allocationBaseMode: 'NET_SALES_EX_TAX' }),
    ).toThrow(/10000/);
  });

  it('a genuine remainder tie breaks by partner_id ascending, deterministically', () => {
    // Four equal owners (2500 bp each) and a base of 9 paisa: exact_i =
    // 9 * 2500 / 10000 = 2.25 for all four — an exact four-way tie on
    // the fractional part. floor = 2 each (sum 8), remainder = 1, so
    // exactly one partner gets the extra paisa — it must be the lowest
    // partner_id.
    const shares: OwnershipShare[] = [
      { partnerId: 10, shareBp: 2500 },
      { partnerId: 20, shareBp: 2500 },
      { partnerId: 30, shareBp: 2500 },
      { partnerId: 40, shareBp: 2500 },
    ];
    const result = allocateOne({ key: 'line:1', allocationBaseMinor: paisa(9), shares, allocationBaseMode: 'NET_SALES_EX_TAX' });
    expect(result.map((r) => [r.partnerId, r.amountMinor])).toEqual([
      [10, 3],
      [20, 2],
      [30, 2],
      [40, 2],
    ]);

    // And it's reproducible, not merely deterministic-by-luck.
    const again = allocateOne({ key: 'line:1', allocationBaseMinor: paisa(9), shares, allocationBaseMode: 'NET_SALES_EX_TAX' });
    expect(again).toEqual(result);
  });
});
