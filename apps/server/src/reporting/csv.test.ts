import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';

describe('reporting/csv', () => {
  it('serializes a header row plus one row per input, in the given column order', () => {
    const csv = toCsv(
      [
        { name: 'Karahi', qty: 2, valueMinor: 1000_00 },
        { name: 'Biryani', qty: 1, valueMinor: 500_00 },
      ],
      ['name', 'qty', 'valueMinor'],
    );
    expect(csv).toBe('name,qty,valueMinor\r\nKarahi,2,100000\r\nBiryani,1,50000\r\n');
  });

  it('quotes a field containing a comma, doubling any embedded quotes', () => {
    const csv = toCsv([{ note: 'a "quoted", value' }], ['note']);
    expect(csv).toBe('note\r\n"a ""quoted"", value"\r\n');
  });

  it('quotes a field containing a newline', () => {
    const csv = toCsv([{ note: 'line one\nline two' }], ['note']);
    expect(csv).toBe('note\r\n"line one\nline two"\r\n');
  });

  it('renders null and undefined as an empty field', () => {
    const csv = toCsv([{ a: null, b: undefined }], ['a', 'b']);
    expect(csv).toBe('a,b\r\n,\r\n');
  });

  it('an empty row set still produces just the header', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b\r\n');
  });
});
