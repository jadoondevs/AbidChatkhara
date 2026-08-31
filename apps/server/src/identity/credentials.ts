import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/**
 * The sign-in secret is whatever the user types into the password
 * field: a 4-digit PIN carried over from the tablet-era PIN pad, or a
 * real password typed on a PC keyboard. Both are hashed identically and
 * stored in the same column, so an existing PIN keeps working and a
 * user who is given a longer password does not need a different code
 * path (see migration 0011).
 *
 * The lower bound stays 4 so that already-issued PINs still verify.
 * Anything with a space at either end is rejected rather than trimmed:
 * silently trimming a secret means a user whose password ends in a
 * space can set one they can never type back identically.
 */
export const MIN_SECRET_LENGTH = 4;
export const MAX_SECRET_LENGTH = 128;

export function validateSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
    throw new Error(`password must be between ${MIN_SECRET_LENGTH} and ${MAX_SECRET_LENGTH} characters`);
  }
  if (secret !== secret.trim()) {
    throw new Error('password cannot start or end with a space');
  }
}

/** Hash a sign-in secret for storage. Never store or log a raw secret
 * anywhere else. */
export function hashSecret(secret: string): string {
  validateSecret(secret);
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(secret, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verify a secret against a stored hash in constant time (with respect
 * to the comparison itself). Never throws on a malformed secret — an
 * over-long or empty input is simply wrong, not an error the caller has
 * to distinguish from a wrong password, and throwing here would let a
 * login form tell an attacker which of the two it was.
 */
export function verifySecret(secret: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts as [string, string, string];
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;
  const actual = scryptSync(secret, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Usernames are matched exactly as typed except for case and
 * surrounding whitespace, both of which a keyboard user gets wrong
 * constantly (caps lock, a trailing space from a paste). Normalising on
 * the way in AND on the way to a lookup is what makes "Amina" and
 * "amina " the same account — and what makes the unique index on
 * `user.username` mean what it looks like it means.
 */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;

export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function validateUsername(username: string): string {
  const normalised = normaliseUsername(username);
  if (!USERNAME_PATTERN.test(normalised)) {
    throw new Error('username must be 3-32 characters of letters, digits, dot, dash or underscore, starting and ending with a letter or digit');
  }
  return normalised;
}
