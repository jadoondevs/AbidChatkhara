import { paisa, type Paisa } from './paisa.js';

/**
 * Floor division for bigints, rounding towards -Infinity (unlike bigint's
 * native `/`, which truncates towards zero). `divisor` must be positive.
 */
function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const q = dividend / divisor;
  const r = dividend % divisor;
  return r !== 0n && r < 0n !== divisor < 0n ? q - 1n : q;
}

/**
 * Split `total` paisa across `weights` in proportion to each weight,
 * using the largest-remainder method, so the parts always sum to exactly
 * `total` — never a paisa more or less.
 *
 * This is the one primitive behind both order-discount proration (weights
 * are each line's gross amount) and partner allocation (weights are each
 * partner's basis-point share). See docs/decisions/002-largest-remainder-allocation.md.
 *
 * Algorithm (matches the spec's allocation-engine pseudocode exactly):
 *   1. exact_i = total * weight_i / sum(weights)   (computed exactly, via bigint)
 *   2. floor_i = floor(exact_i)
 *   3. remainder = total - sum(floor_i)   (always a whole number of parts, 0 <= remainder < weights.length)
 *   4. give the remainder one paisa at a time to the parts with the largest
 *      fractional remainder, breaking ties by ascending index in `weights`
 *      — so callers that want "partner_id ascending" or similar simply pass
 *      weights pre-sorted by that key.
 *
 * All arithmetic is done in bigint so there is no floating-point rounding
 * anywhere in the split, regardless of how large the amounts are.
 *
 * Throws if `weights` contains a negative or non-integer value, or if the
 * weights sum to zero while `total` is non-zero (there is no proportion to
 * split by). Zero-value lines are the normal case of an all-zero `total`
 * with any weights, and always distribute to all-zero parts without error.
 */
export function distribute(total: Paisa, weights: readonly number[]): Paisa[] {
  if (weights.length === 0) {
    if (total !== 0) {
      throw new Error('distribute: cannot split a non-zero total across zero parts');
    }
    return [];
  }

  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) {
      throw new Error(`distribute: weights must be non-negative integers; got ${w}`);
    }
  }

  const weightSum = weights.reduce((a, b) => a + b, 0);

  if (weightSum === 0) {
    if (total !== 0) {
      throw new Error('distribute: weights sum to zero but total is non-zero — nothing to distribute by');
    }
    return weights.map(() => paisa(0));
  }

  const totalBig = BigInt(total);
  const sumBig = BigInt(weightSum);

  const floors: bigint[] = [];
  const remainders: bigint[] = []; // 0 <= remainder_i < sumBig, the numerator of the fractional part over sumBig

  for (const w of weights) {
    const numerator = totalBig * BigInt(w);
    const q = floorDiv(numerator, sumBig);
    const r = numerator - q * sumBig;
    floors.push(q);
    remainders.push(r);
  }

  const floorTotal = floors.reduce((a, b) => a + b, 0n);
  const remainingParts = totalBig - floorTotal;

  // Give the remaining whole parts to the largest fractional remainders,
  // ties broken by ascending index (stable sort preserves input order).
  const order = weights
    .map((_, index) => index)
    .sort((a, b) => {
      const ra = remainders[a] as bigint;
      const rb = remainders[b] as bigint;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });

  const result = [...floors];
  let left = remainingParts;
  for (const index of order) {
    if (left <= 0n) break;
    result[index] = (result[index] as bigint) + 1n;
    left -= 1n;
  }

  if (left !== 0n) {
    // Cannot happen given the math above; kept as a loud, defensive check
    // per the spec's "assert the sum, fail loudly, never write a partial
    // allocation" requirement.
    throw new Error(
      `distribute: internal invariant violated — ${left} paisa left undistributed`,
    );
  }

  const out = result.map((v) => paisa(Number(v)));
  const actualSum = out.reduce((a, b) => a + b, 0);
  if (actualSum !== total) {
    throw new Error(
      `distribute: result sums to ${actualSum}, expected ${total} — refusing to return a partial split`,
    );
  }
  return out;
}

/** A share of a base amount, in basis points (10000 = 100%). */
export interface BasisPointShare {
  readonly key: string;
  readonly shareBp: number;
}

/**
 * Split `base` across ownership shares expressed in basis points. Shares
 * must sum to exactly 10000 (100%) — that invariant is enforced where
 * shares are written (see partners/), but this function re-checks it
 * defensively before ever producing an allocation.
 *
 * `shares` must be pre-sorted by `key` ascending (e.g. partner_id
 * ascending) so remainder ties resolve deterministically in that order.
 */
export function splitByShares(base: Paisa, shares: readonly BasisPointShare[]): Paisa[] {
  const bpSum = shares.reduce((a, s) => a + s.shareBp, 0);
  if (shares.length > 0 && bpSum !== 10_000) {
    throw new Error(`splitByShares: shares must sum to 10000 basis points; got ${bpSum}`);
  }
  return distribute(
    base,
    shares.map((s) => s.shareBp),
  );
}

/**
 * Prorate an order-level discount (or any single total) across lines in
 * proportion to each line's weight (typically gross amount), so the
 * prorated parts sum to exactly the discount.
 *
 * `weights` must be non-negative; pass lines in a stable, deterministic
 * order (e.g. line id ascending) so remainder ties resolve consistently.
 */
export function prorate(total: Paisa, weights: readonly Paisa[]): Paisa[] {
  return distribute(total, weights);
}
