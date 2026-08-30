import type { Paisa } from './paisa.js';

/**
 * Group the digits of a non-negative integer's decimal string with commas
 * every three digits (1234567 -> "1,234,567"). Written by hand rather than
 * via `Intl`/`toLocaleString` so formatting is identical on every machine
 * regardless of installed ICU data — this runs on an offline restaurant
 * server, not a browser with a guaranteed locale database.
 *
 * Deliberately simple thousands grouping, not South Asian lakh/crore
 * grouping — easy to swap for the latter later if the restaurant wants it.
 */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a `Paisa` amount as a PKR display string, e.g. `format(paisa(123456))`
 * -> `"Rs 1,234.56"`. This is the ONLY place money is turned into a
 * human-readable string — the presentation layer calls this, never bare
 * division of a Paisa value (see paisa.ts and the money-arithmetic guard).
 */
export function format(amount: Paisa): string {
  const sign = amount < 0 ? '-' : '';
  const magnitude = Math.abs(amount);
  const rupees = Math.floor(magnitude / 100);
  const paisaPart = magnitude % 100;
  return `${sign}Rs ${groupThousands(String(rupees))}.${String(paisaPart).padStart(2, '0')}`;
}
