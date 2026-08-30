import { describe, expect, it } from 'vitest';
import { format } from './format.js';
import { paisa } from './paisa.js';

describe('format', () => {
  it('formats a plain amount', () => {
    expect(format(paisa(500))).toBe('Rs 5.00');
  });

  it('formats paisa correctly', () => {
    expect(format(paisa(505))).toBe('Rs 5.05');
    expect(format(paisa(50))).toBe('Rs 0.50');
    expect(format(paisa(5))).toBe('Rs 0.05');
  });

  it('groups thousands', () => {
    expect(format(paisa(123_456_78))).toBe('Rs 123,456.78');
    expect(format(paisa(1_234_56))).toBe('Rs 1,234.56');
    expect(format(paisa(12_345_678_90))).toBe('Rs 12,345,678.90');
  });

  it('formats zero', () => {
    expect(format(paisa(0))).toBe('Rs 0.00');
  });

  it('formats negative amounts with a leading sign before Rs', () => {
    expect(format(paisa(-500))).toBe('-Rs 5.00');
    expect(format(paisa(-5))).toBe('-Rs 0.05');
  });
});
