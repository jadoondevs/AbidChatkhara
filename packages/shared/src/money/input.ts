import { paisa, type Paisa } from './paisa.js';

/**
 * Parse what a human typed in RUPEES into `Paisa`. Staff type "250" or
 * "250.50"; this is the only sanctioned way that becomes 25000 or 25050
 * — a UI must never reach for `Number(text) * 100` itself, for the same
 * reason nothing outside this module multiplies or divides a money value
 * (see paisa.ts and the money-arithmetic guard).
 *
 * Returns null for anything that isn't a non-negative amount with at
 * most two decimal places, so a caller can hold the raw text and simply
 * not commit an unparseable value — never silently coercing "12.345" or
 * "abc" into a number that looks plausible.
 */
export function parseRupees(input: string): Paisa | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;

  const rupees = Number(match[1]);
  const paisaPart = Number((match[2] ?? '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(rupees) || !Number.isSafeInteger(paisaPart)) return null;
  return paisa(rupees * 100 + paisaPart);
}

/**
 * The inverse, for pre-filling an input with an existing amount:
 * `toRupeeInput(paisa(25050))` -> `"250.50"`. Plain digits and a dot —
 * no currency symbol or thousands separators, since this is meant to go
 * back into a text field that `parseRupees` will read again. Use
 * `format()` for anything a person only reads.
 */
export function toRupeeInput(amount: Paisa): string {
  const sign = amount < 0 ? '-' : '';
  const magnitude = Math.abs(amount);
  const rupees = Math.floor(magnitude / 100);
  const paisaPart = magnitude % 100;
  return `${sign}${rupees}.${String(paisaPart).padStart(2, '0')}`;
}
