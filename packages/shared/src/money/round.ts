import { paisa, type Paisa } from './paisa.js';

const RUPEE = 100;

export interface RoundedTotal {
  /** The amount rounded to the nearest whole rupee (a multiple of 100 paisa). */
  readonly total: Paisa;
  /** `total - amount`. Positive when rounded up, negative when rounded down. */
  readonly adjustment: Paisa;
}

/**
 * Round an amount to the nearest whole rupee, half up. The difference is
 * returned as `adjustment` — a house adjustment that must be recorded on
 * the order and never allocated to partners or added to service charge
 * (see docs/decisions/003-rounding-as-house-adjustment.md).
 *
 * "Half up" here means a paisa remainder of exactly 50 always rounds to
 * the higher rupee, for both positive and negative amounts (i.e. rounding
 * is towards +Infinity at the halfway point, not away from zero) — the
 * simplest, most predictable rule, and the one that matches how cashiers
 * round a bill by hand.
 */
export function roundToRupee(amount: Paisa): RoundedTotal {
  // Floored modulo: always in [0, 100) regardless of the sign of `amount`.
  const remainder = ((amount % RUPEE) + RUPEE) % RUPEE;
  const roundedDown = amount - remainder;
  const total = remainder >= 50 ? roundedDown + RUPEE : roundedDown;
  return { total: paisa(total), adjustment: paisa(total - amount) };
}

/**
 * The smallest multiple of `step` that is at least `amount` — "what is
 * the next round note up from this bill?".
 *
 * Used by the payment screen to suggest the notes a customer is likely
 * to hand over for a given total. It lives here rather than in that
 * screen because it is division on money, and every arithmetic operator
 * applied to a `Paisa` belongs in this module — the workspace guard
 * enforces exactly that (see docs/decisions/001).
 *
 * `step` is a plain count of paisa, not a `Paisa`: it is a denomination
 * (100 paisa, 500_00 paisa), not an amount of money in its own right.
 * Throws on a non-positive step rather than looping or dividing by zero.
 */
export function roundUpTo(amount: Paisa, step: number): Paisa {
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`roundUpTo: step must be a positive integer number of paisa, got ${step}`);
  }
  const remainder = ((amount % step) + step) % step;
  return paisa(remainder === 0 ? amount : amount + (step - remainder));
}
