import { describe, expect, it } from 'vitest';
import { maskAccountNumber } from './receipt-html.js';

describe('maskAccountNumber', () => {
  it('shows only the last four digits of a real account number', () => {
    expect(maskAccountNumber('0000000000001234')).toBe('••••1234');
    expect(maskAccountNumber('0300-1234567')).toBe('••••4567');
  });

  it('masks a short identifier completely rather than revealing all of it', () => {
    // "Last four" of a four-character identifier is the whole thing —
    // masking has to mean masking.
    expect(maskAccountNumber('1234')).toBe('••••');
    expect(maskAccountNumber('12')).toBe('••');
  });

  it('treats a missing or blank number as nothing to print', () => {
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber('')).toBeNull();
    expect(maskAccountNumber('   ')).toBeNull();
  });

  it('ignores surrounding whitespace when deciding what to show', () => {
    expect(maskAccountNumber('  0300-1234567  ')).toBe('••••4567');
  });

  it('never returns the full number it was given', () => {
    for (const value of ['0000000000001234', '0300-1234567', 'PK36SCBL0000001123456702']) {
      expect(maskAccountNumber(value)).not.toBe(value);
      expect(maskAccountNumber(value)).not.toContain(value.slice(0, -4));
    }
  });
});
