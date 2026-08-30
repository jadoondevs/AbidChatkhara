/**
 * The only representation of money anywhere in this system: an integer
 * number of paisa (1/100 of a rupee), branded so the type checker can tell
 * a money value apart from an ordinary `number` (a quantity, a basis-point
 * share, a percentage) at the call site.
 *
 * See docs/decisions/001-integer-money-and-paisa-type.md for why.
 *
 * This module is the ONLY place allowed to multiply or divide a `Paisa`
 * value. Everywhere else, use these helpers. `packages/shared/src/money/no-bare-arithmetic.test.ts`
 * type-checks the whole workspace and fails the build if a `*` or `/`
 * appears on a Paisa-typed operand outside this directory.
 */

export type Paisa = number & { readonly __brand: 'Paisa' };

/**
 * Construct a `Paisa` from an integer. Throws on non-integers, NaN, or
 * infinities — those can never legitimately represent a count of paisa.
 */
export function paisa(value: number): Paisa {
  if (!Number.isInteger(value)) {
    throw new Error(`Paisa amounts must be integers; got ${value}`);
  }
  return value as Paisa;
}

export const ZERO: Paisa = paisa(0);

export function isZero(a: Paisa): boolean {
  return a === 0;
}

export function isNegative(a: Paisa): boolean {
  return a < 0;
}

export function isPositive(a: Paisa): boolean {
  return a > 0;
}

export function negate(a: Paisa): Paisa {
  // `0 - a` rather than `-a`: negating zero the latter way produces -0,
  // which is a distinct (if numerically equal) value from the 0 this
  // module always wants to hand back.
  return paisa(0 - a);
}

export function add(...values: readonly Paisa[]): Paisa {
  return paisa(values.reduce((total, v) => total + v, 0));
}

export function sub(a: Paisa, b: Paisa): Paisa {
  return paisa(a - b);
}

export function sum(values: readonly Paisa[]): Paisa {
  return add(...values);
}

/**
 * Multiply a money amount by a plain integer quantity — e.g.
 * `unit_price_minor * qty`. This is the one blessed multiplication of a
 * `Paisa` value by anything, because a quantity is a count, not money, so
 * there is no ambiguity about what the result means and no rounding to
 * distribute.
 */
export function mulQty(amount: Paisa, qty: number): Paisa {
  if (!Number.isInteger(qty)) {
    throw new Error(`Quantity must be an integer; got ${qty}`);
  }
  if (qty < 0) {
    throw new Error(`Quantity must not be negative; got ${qty}`);
  }
  return paisa(amount * qty);
}

export function compare(a: Paisa, b: Paisa): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function max(a: Paisa, b: Paisa): Paisa {
  return a >= b ? a : b;
}

export function min(a: Paisa, b: Paisa): Paisa {
  return a <= b ? a : b;
}

export function abs(a: Paisa): Paisa {
  return a < 0 ? negate(a) : a;
}
