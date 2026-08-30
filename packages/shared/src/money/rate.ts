import { paisa, type Paisa } from './paisa.js';

/** Floor division for bigints, rounding towards -Infinity (unlike bigint's
 * native `/`, which truncates towards zero) — same helper distribute.ts
 * keeps privately for its own bigint math; small enough not to share. */
function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const q = dividend / divisor;
  const r = dividend % divisor;
  return r !== 0n && r < 0n !== divisor < 0n ? q - 1n : q;
}

/**
 * `round_half_up(amountMinor * numeratorBp / denominatorBp)` — done in
 * bigint, so there is no floating-point rounding regardless of scale.
 * "Half up" matches `roundToRupee`'s own convention: a remainder of
 * exactly one half always rounds towards +Infinity, for both positive
 * and negative amounts.
 *
 * This is the one primitive behind tax computation (`tax/engine.ts`):
 * an *exclusive* rate adds `proportionalAmount(base, rateBp, 10_000)` on
 * top of `base`; an *inclusive* rate extracts
 * `proportionalAmount(base, rateBp, 10_000 + rateBp)` out of a `base`
 * that already contains it. Unlike `distribute`/`splitByShares`, this
 * isn't splitting a whole into parts that must sum back exactly — it's
 * a single proportional amount, the same kind of calculation any
 * accounting system does for a tax line, so ordinary round-half-up
 * (not largest-remainder) is the correct and simplest choice here.
 */
export function proportionalAmount(amountMinor: Paisa, numeratorBp: number, denominatorBp: number): Paisa {
  if (!Number.isInteger(numeratorBp) || numeratorBp < 0) {
    throw new Error(`proportionalAmount: numeratorBp must be a non-negative integer; got ${numeratorBp}`);
  }
  if (!Number.isInteger(denominatorBp) || denominatorBp <= 0) {
    throw new Error(`proportionalAmount: denominatorBp must be a positive integer; got ${denominatorBp}`);
  }

  const numerator = BigInt(amountMinor) * BigInt(numeratorBp);
  const denominator = BigInt(denominatorBp);
  const rounded = floorDiv(numerator * 2n + denominator, denominator * 2n);
  return paisa(Number(rounded));
}
