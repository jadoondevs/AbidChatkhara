import { describe, expect, it } from 'vitest';
import { parseRupees, toRupeeInput } from './input.js';
import { paisa } from './paisa.js';

describe('parseRupees', () => {
  it('parses whole rupees and rupees with paisa', () => {
    expect(parseRupees('250')).toBe(25000);
    expect(parseRupees('250.50')).toBe(25050);
    expect(parseRupees('0.05')).toBe(5);
    expect(parseRupees('0')).toBe(0);
  });

  it('pads a single decimal digit to paisa, not to nothing', () => {
    expect(parseRupees('250.5')).toBe(25050); // Rs 250.50, not Rs 250.05
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRupees('  250.50 ')).toBe(25050);
  });

  it('refuses anything that is not a clean non-negative amount', () => {
    expect(parseRupees('')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('-5')).toBeNull();
    expect(parseRupees('12.345')).toBeNull(); // more precision than paisa can hold
    expect(parseRupees('1,000')).toBeNull();
    expect(parseRupees('1e3')).toBeNull();
    expect(parseRupees('.5')).toBeNull();
  });

  it('round-trips through toRupeeInput', () => {
    for (const minor of [0, 5, 100, 25050, 1_234_56]) {
      expect(parseRupees(toRupeeInput(paisa(minor)))).toBe(minor);
    }
  });
});

describe('toRupeeInput', () => {
  it('renders plain digits with two decimal places, no separators or symbol', () => {
    expect(toRupeeInput(paisa(0))).toBe('0.00');
    expect(toRupeeInput(paisa(5))).toBe('0.05');
    expect(toRupeeInput(paisa(123_456_78))).toBe('123456.78');
  });
});
