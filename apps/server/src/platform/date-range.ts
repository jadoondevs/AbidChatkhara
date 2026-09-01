import { z } from 'zod';

/**
 * Turning what a user typed into a date filter into the half-open
 * instant range every report query actually uses.
 *
 * Queries want `fromInclusive`/`toExclusive` as exact instants, which
 * is the right shape for a query and the wrong shape for a person:
 * asked for "31 August", an operator types 31 August into both boxes
 * and gets nothing back, because the range is empty. So the
 * day-granular forms below are translated here, once, instead of every
 * caller being expected to remember to add a day.
 *
 * It lives in platform/ because it is pure date arithmetic that both
 * the reports and the orders lookup need, and neither of those should
 * have to import the other to ask what "today" means.
 *
 * Three accepted forms, in order of precedence:
 *
 *   date=2026-08-31                  — that one calendar day
 *   from=2026-08-31&to=2026-08-31    — inclusive at BOTH ends, so the
 *                                      same day in both boxes is that day
 *   fromInclusive=…&toExclusive=…    — exact instants, unchanged
 *
 * Days are resolved in the server's own local time. This is a
 * single-restaurant, single-machine system: the till, the server and
 * the staff are in one place, and "today" means the day the restaurant
 * is having. Storing UTC and querying local is exactly what makes a
 * report for 31 August contain the sales rung up on 31 August rather
 * than a window shifted by five hours.
 */
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const dateFilterSchema = z.object({
  date: z.string().regex(DAY_PATTERN).optional(),
  from: z.string().regex(DAY_PATTERN).optional(),
  to: z.string().regex(DAY_PATTERN).optional(),
  fromInclusive: z.string().optional(),
  toExclusive: z.string().optional(),
});

export type DateFilter = z.infer<typeof dateFilterSchema>;

export interface ResolvedDateRange {
  readonly fromInclusive?: string | undefined;
  readonly toExclusive?: string | undefined;
}

/** Local midnight starting the given calendar day. */
export function startOfLocalDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date, 0, 0, 0, 0);
}

/**
 * Local midnight ENDING the given calendar day — i.e. the start of the
 * next one. Built by adding a day to the date component rather than
 * adding 24 hours to an instant, so a day that is not 24 hours long
 * (any daylight-saving transition, should the region ever adopt one)
 * still ends where the calendar says it does.
 */
export function endOfLocalDay(day: string): Date {
  const start = startOfLocalDay(day);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
}

export function resolveDateRange(filter: DateFilter): ResolvedDateRange {
  if (filter.date) {
    return { fromInclusive: startOfLocalDay(filter.date).toISOString(), toExclusive: endOfLocalDay(filter.date).toISOString() };
  }

  if (filter.from !== undefined || filter.to !== undefined) {
    return {
      ...(filter.from ? { fromInclusive: startOfLocalDay(filter.from).toISOString() } : {}),
      // Inclusive of the whole `to` day — the entire point of this form.
      ...(filter.to ? { toExclusive: endOfLocalDay(filter.to).toISOString() } : {}),
    };
  }

  return {
    ...(filter.fromInclusive ? { fromInclusive: filter.fromInclusive } : {}),
    ...(filter.toExclusive ? { toExclusive: filter.toExclusive } : {}),
  };
}
