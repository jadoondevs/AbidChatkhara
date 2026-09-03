import { describe, expect, it } from 'vitest';
import { abs, add, compare, divideBy, isNegative, isPositive, isZero, max, min, mulQty, negate, paisa, ratio, sub, sum, ZERO } from './paisa.js';

describe('paisa', () => {
  it('accepts integers', () => {
    expect(paisa(0)).toBe(0);
    expect(paisa(-500)).toBe(-500);
  });

  it('rejects non-integers', () => {
    expect(() => paisa(1.5)).toThrow(/integers/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => paisa(NaN)).toThrow(/integers/);
    expect(() => paisa(Infinity)).toThrow(/integers/);
  });
});

describe('add / sub / sum / negate', () => {
  it('adds any number of values', () => {
    expect(add(paisa(100), paisa(250), paisa(-50))).toBe(300);
    expect(add()).toBe(0);
  });

  it('subtracts', () => {
    expect(sub(paisa(500), paisa(200))).toBe(300);
    expect(sub(paisa(200), paisa(500))).toBe(-300);
  });

  it('sums an array', () => {
    expect(sum([paisa(1), paisa(2), paisa(3)])).toBe(6);
    expect(sum([])).toBe(0);
  });

  it('negates', () => {
    expect(negate(paisa(500))).toBe(-500);
    expect(negate(paisa(-500))).toBe(500);
    expect(negate(ZERO)).toBe(0);
  });
});

describe('divideBy', () => {
  it('averages an amount over a count', () => {
    expect(divideBy(paisa(45_000), 3)).toBe(15_000);
    expect(divideBy(paisa(100), 1)).toBe(100);
  });

  it('rounds, because paisa are indivisible', () => {
    // Rs 10.00 over 3 bills is Rs 3.33 and a paisa goes missing. That is
    // why this is display-only — `distribute` is what to use when the
    // parts have to add back up.
    expect(divideBy(paisa(1000), 3)).toBe(333);
    expect(divideBy(paisa(1000), 7)).toBe(143);
  });

  it('rejects a non-integer count', () => {
    expect(() => divideBy(paisa(100), 1.5)).toThrow(/integer/);
  });

  it('rejects zero and negative counts', () => {
    expect(() => divideBy(paisa(100), 0)).toThrow(/positive/);
    expect(() => divideBy(paisa(100), -2)).toThrow(/positive/);
  });
});

describe('ratio', () => {
  it('gives the fraction one amount is of another', () => {
    expect(ratio(paisa(2500), paisa(10_000))).toBe(0.25);
    expect(ratio(paisa(10_000), paisa(10_000))).toBe(1);
  });

  it('gives 0 for a zero total rather than NaN', () => {
    // A day with no sales reads "0%", not "NaN%".
    expect(ratio(paisa(0), paisa(0))).toBe(0);
    expect(ratio(paisa(500), paisa(0))).toBe(0);
  });
});

describe('mulQty', () => {
  it('multiplies a Paisa amount by an integer quantity', () => {
    expect(mulQty(paisa(15_000), 3)).toBe(45_000);
    expect(mulQty(paisa(15_000), 0)).toBe(0);
  });

  it('rejects a non-integer quantity', () => {
    expect(() => mulQty(paisa(100), 1.5)).toThrow(/integer/);
  });

  it('rejects a negative quantity', () => {
    expect(() => mulQty(paisa(100), -1)).toThrow(/negative/);
  });
});

describe('comparisons', () => {
  it('compare', () => {
    expect(compare(paisa(1), paisa(2))).toBe(-1);
    expect(compare(paisa(2), paisa(1))).toBe(1);
    expect(compare(paisa(2), paisa(2))).toBe(0);
  });

  it('max / min', () => {
    expect(max(paisa(1), paisa(2))).toBe(2);
    expect(min(paisa(1), paisa(2))).toBe(1);
  });

  it('abs', () => {
    expect(abs(paisa(-50))).toBe(50);
    expect(abs(paisa(50))).toBe(50);
  });

  it('isZero / isPositive / isNegative', () => {
    expect(isZero(ZERO)).toBe(true);
    expect(isPositive(paisa(1))).toBe(true);
    expect(isNegative(paisa(-1))).toBe(true);
    expect(isZero(paisa(1))).toBe(false);
  });
});
