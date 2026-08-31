import { describe, expect, it } from 'vitest';
import {
  hashSecret,
  normaliseUsername,
  validateSecret,
  validateUsername,
  verifySecret,
} from './credentials.js';

describe('hashSecret / verifySecret', () => {
  it('verifies the secret it hashed, and rejects anything else', () => {
    const stored = hashSecret('9999');
    expect(verifySecret('9999', stored)).toBe(true);
    expect(verifySecret('9998', stored)).toBe(false);
    expect(verifySecret('', stored)).toBe(false);
  });

  it('accepts a long password, not just a numeric PIN', () => {
    const stored = hashSecret('correct horse battery staple');
    expect(verifySecret('correct horse battery staple', stored)).toBe(true);
    expect(verifySecret('correct horse battery stapl', stored)).toBe(false);
  });

  it('salts every hash, so two users with the same password do not share a hash', () => {
    expect(hashSecret('1234')).not.toBe(hashSecret('1234'));
  });

  it('never stores the raw secret', () => {
    expect(hashSecret('9999')).not.toContain('9999');
  });

  it('rejects a secret that is too short, too long, or space-padded', () => {
    expect(() => hashSecret('123')).toThrow(/between 4 and 128/);
    expect(() => hashSecret('x'.repeat(129))).toThrow(/between 4 and 128/);
    expect(() => hashSecret(' 1234')).toThrow(/space/);
    expect(() => hashSecret('1234 ')).toThrow(/space/);
    expect(() => validateSecret('1234')).not.toThrow();
  });

  it('returns false rather than throwing when the stored hash is malformed', () => {
    expect(verifySecret('1234', 'not-a-hash')).toBe(false);
    expect(verifySecret('1234', 'scrypt$$')).toBe(false);
    expect(verifySecret('1234', 'bcrypt$aa$bb')).toBe(false);
  });

  it('does not throw on an over-long attempt — a wrong password is not an error', () => {
    const stored = hashSecret('9999');
    expect(verifySecret('x'.repeat(500), stored)).toBe(false);
  });
});

describe('usernames', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(normaliseUsername('  Amina  ')).toBe('amina');
    expect(normaliseUsername('AMINA')).toBe('amina');
  });

  it('accepts letters, digits, dot, dash and underscore between alphanumerics', () => {
    expect(validateUsername('amina')).toBe('amina');
    expect(validateUsername('amina.1')).toBe('amina.1');
    expect(validateUsername('front_desk-2')).toBe('front_desk-2');
  });

  it('rejects names that are too short, too long, or badly bounded', () => {
    expect(() => validateUsername('ab')).toThrow();
    expect(() => validateUsername('a'.repeat(33))).toThrow();
    expect(() => validateUsername('.amina')).toThrow();
    expect(() => validateUsername('amina.')).toThrow();
    expect(() => validateUsername('am ina')).toThrow();
    expect(() => validateUsername('amina@pos')).toThrow();
  });
});
