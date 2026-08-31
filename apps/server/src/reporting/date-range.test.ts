import { describe, expect, it } from 'vitest';
import { endOfLocalDay, resolveDateRange, startOfLocalDay } from './date-range.js';

describe('resolveDateRange', () => {
  it('turns a single date into that whole local day', () => {
    const range = resolveDateRange({ date: '2026-08-31' });
    expect(range.fromInclusive).toBe(startOfLocalDay('2026-08-31').toISOString());
    expect(range.toExclusive).toBe(startOfLocalDay('2026-09-01').toISOString());
  });

  it('makes the same day in From and To mean that day, not an empty range', () => {
    const range = resolveDateRange({ from: '2026-08-31', to: '2026-08-31' });
    expect(range.fromInclusive).toBe(startOfLocalDay('2026-08-31').toISOString());
    expect(range.toExclusive).toBe(startOfLocalDay('2026-09-01').toISOString());
    // The whole bug this fixes: the window must not be empty.
    expect(new Date(range.toExclusive as string).getTime()).toBeGreaterThan(new Date(range.fromInclusive as string).getTime());
  });

  it('covers a multi-day range inclusive of the last day', () => {
    const range = resolveDateRange({ from: '2026-08-01', to: '2026-08-31' });
    expect(range.fromInclusive).toBe(startOfLocalDay('2026-08-01').toISOString());
    expect(range.toExclusive).toBe(startOfLocalDay('2026-09-01').toISOString());
  });

  it('accepts an open-ended day range at either end', () => {
    expect(resolveDateRange({ from: '2026-08-01' }).toExclusive).toBeUndefined();
    expect(resolveDateRange({ to: '2026-08-01' }).fromInclusive).toBeUndefined();
  });

  it('passes exact instants through untouched, so existing callers are unaffected', () => {
    const range = resolveDateRange({ fromInclusive: '2026-08-31T06:00:00.000Z', toExclusive: '2026-08-31T18:00:00.000Z' });
    expect(range).toEqual({ fromInclusive: '2026-08-31T06:00:00.000Z', toExclusive: '2026-08-31T18:00:00.000Z' });
  });

  it('prefers a single date over any other form given at the same time', () => {
    const range = resolveDateRange({ date: '2026-08-31', from: '2020-01-01', to: '2020-01-02', fromInclusive: '2019-01-01T00:00:00.000Z' });
    expect(range.fromInclusive).toBe(startOfLocalDay('2026-08-31').toISOString());
  });

  it('returns an unbounded range when nothing is given', () => {
    expect(resolveDateRange({})).toEqual({});
  });

  it('resolves days in local time, so a day boundary is local midnight', () => {
    const start = startOfLocalDay('2026-08-31');
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getDate()).toBe(31);
    expect(start.getMonth()).toBe(7);
  });

  it('ends a day by rolling the calendar date, including across a month boundary', () => {
    const end = endOfLocalDay('2026-08-31');
    expect(end.getDate()).toBe(1);
    expect(end.getMonth()).toBe(8);
    expect(end.getHours()).toBe(0);
  });

  it('rolls across a year boundary', () => {
    const end = endOfLocalDay('2026-12-31');
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(0);
    expect(end.getDate()).toBe(1);
  });

  it('handles a leap day', () => {
    const end = endOfLocalDay('2028-02-29');
    expect(end.getMonth()).toBe(2);
    expect(end.getDate()).toBe(1);
  });
});
