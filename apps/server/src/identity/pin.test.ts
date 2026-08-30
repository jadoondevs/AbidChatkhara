import { describe, expect, it } from 'vitest';
import { hashPin, verifyPin } from './pin.js';

describe('hashPin / verifyPin', () => {
  it('verifies the correct PIN against its own hash', () => {
    const hash = hashPin('4821');
    expect(verifyPin('4821', hash)).toBe(true);
  });

  it('rejects a wrong PIN', () => {
    const hash = hashPin('4821');
    expect(verifyPin('0000', hash)).toBe(false);
  });

  it('rejects a PIN that is not 4-8 digits', () => {
    expect(() => hashPin('123')).toThrow(/4-8 digits/);
    expect(() => hashPin('123456789')).toThrow(/4-8 digits/);
    expect(() => hashPin('abcd')).toThrow(/4-8 digits/);
  });

  it('never stores the raw PIN in the hash', () => {
    const hash = hashPin('1357');
    expect(hash).not.toContain('1357');
  });

  it('salts each hash differently, even for the same PIN', () => {
    const a = hashPin('2468');
    const b = hashPin('2468');
    expect(a).not.toBe(b);
    expect(verifyPin('2468', a)).toBe(true);
    expect(verifyPin('2468', b)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(verifyPin('1234', 'not-a-real-hash')).toBe(false);
  });
});
