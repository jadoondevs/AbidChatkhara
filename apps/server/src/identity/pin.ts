import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const PIN_PATTERN = /^\d{4,8}$/;

/** Hash a PIN for storage. Never store or log a raw PIN anywhere else. */
export function hashPin(pin: string): string {
  if (!PIN_PATTERN.test(pin)) {
    throw new Error('PIN must be 4-8 digits');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(pin, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verify a PIN against a stored hash in constant time (with respect to
 * the comparison itself — this is a PIN pad on a local network, not a
 * public login form, but there is no reason to take the timing-side-channel
 * risk when `timingSafeEqual` is free).
 */
export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts as [string, string, string];
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
