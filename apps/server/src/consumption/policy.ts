import { paisa, splitByShares, type Paisa } from '@pos/shared';
import type { MealPolicy } from './tables.js';

export interface MealChargeResult {
  /** What the person actually pays. */
  readonly chargedMinor: Paisa;
  /** menuValueMinor - chargedMinor: the gap that must be settled some
   * other way (house_expense / payroll_deduction / partner_personal) —
   * see docs/decisions/009. Always exact: chargedMinor + settlementMinor
   * === menuValueMinor, by construction (both come out of the same
   * splitByShares call for the 'discounted' case, and are hardcoded
   * complements of each other for every other policy). */
  readonly settlementMinor: Paisa;
}

/**
 * Pure function: what a person owes for a meal worth `menuValueMinor`,
 * given their own meal policy — no database, no I/O, exhaustively
 * tested, same shape as partners/engine.ts's allocateOne. Never called
 * directly by ordering (which only needs to know a person exists, is
 * active, and is the right kind); consumption/service.ts calls this at
 * settlement time, against the *snapshotted* policy, never a stale read
 * from earlier in the order's life.
 *
 * - free / payroll_deduction: nothing is collected at the register —
 *   the whole value is settled another way, either given away
 *   (typically house_expense or partner_personal) or recovered later
 *   through payroll. The two policies charge identically; what differs
 *   is only which settlement_type the caller is expected to use (see
 *   docs/decisions/009).
 * - full_price: the person pays exactly what a customer would.
 * - discounted: split by meal_discount_bp using the same exact,
 *   remainder-safe primitive the money pipeline uses everywhere else —
 *   never independent rounding that could drift from menuValueMinor.
 */
export function computeMealCharge(menuValueMinor: Paisa, mealPolicy: MealPolicy, mealDiscountBp: number): MealChargeResult {
  if (mealPolicy === 'full_price') {
    return { chargedMinor: menuValueMinor, settlementMinor: paisa(0) };
  }
  if (mealPolicy === 'free' || mealPolicy === 'payroll_deduction') {
    return { chargedMinor: paisa(0), settlementMinor: menuValueMinor };
  }

  // discounted
  if (!Number.isInteger(mealDiscountBp) || mealDiscountBp < 0 || mealDiscountBp > 10_000) {
    throw new Error(`meal_discount_bp must be an integer between 0 and 10000; got ${mealDiscountBp}`);
  }
  const [chargedMinor, settlementMinor] = splitByShares(menuValueMinor, [
    { key: '0-charged', shareBp: 10_000 - mealDiscountBp },
    { key: '1-settlement', shareBp: mealDiscountBp },
  ]) as [Paisa, Paisa];
  return { chargedMinor, settlementMinor };
}
