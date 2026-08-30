import { describe, expect, it } from 'vitest';
import { paisaSchema } from './schema.js';

describe('paisaSchema', () => {
  it('parses a non-negative integer into a branded Paisa value', () => {
    expect(paisaSchema.parse(500)).toBe(500);
    expect(paisaSchema.parse(0)).toBe(0);
  });

  it('rejects a negative amount', () => {
    expect(() => paisaSchema.parse(-1)).toThrow();
  });

  it('rejects a non-integer amount', () => {
    expect(() => paisaSchema.parse(1.5)).toThrow();
  });

  it('rejects a non-number', () => {
    expect(() => paisaSchema.parse('500')).toThrow();
  });
});
