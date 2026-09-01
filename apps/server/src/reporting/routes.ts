import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { waiterPayoutTotals } from '../gratuity/service.js';
import { requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import { toCsv } from './csv.js';
import { dateFilterSchema, resolveDateRange } from '../platform/date-range.js';
import {
  allocationReconciliation,
  consumptionReport,
  dailySalesReport,
  itemMixReport,
  partnerItemBills,
  partnerStatement,
  voidAndDiscountReport,
} from './service.js';

/**
 * Every report takes the same date filter — a single `date`, an
 * inclusive `from`/`to` day pair, or exact `fromInclusive`/`toExclusive`
 * instants. See reporting/date-range.ts for what each means and why the
 * day forms exist at all.
 */
const dateRangeQuerySchema = dateFilterSchema.extend({
  format: z.enum(['json', 'csv']).optional(),
});

/**
 * Every report is CSV-exportable (spec). Rather than a bespoke CSV shape
 * per report, this flattens whatever JSON payload the report already
 * returns: an array response becomes one CSV row per element; a single
 * object response (dailySalesReport, partnerStatement) becomes one row
 * of its own top-level fields. A field that's itself an array or object
 * (paymentMethodBreakdown, serviceChargeByWaiter, items) is JSON-encoded
 * inside its own cell rather than getting its own set of columns — a
 * pragmatic choice that keeps one export path for every report instead
 * of a second, nested CSV format.
 */
function sendReport(
  reply: FastifyReply,
  format: 'json' | 'csv' | undefined,
  payload: unknown,
  /** What to export when the flattened top-level object would lose the
   * detail that makes the report worth exporting — the consumption
   * report's per-item lines, say, which are an array inside the object
   * and would otherwise be JSON-encoded into a single cell. */
  csvRows?: readonly Record<string, unknown>[],
): unknown {
  if (format !== 'csv') return payload;

  const rows = csvRows ?? (Array.isArray(payload) ? (payload as Record<string, unknown>[]) : [payload as Record<string, unknown>]);
  const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
  reply.header('content-type', 'text/csv; charset=utf-8');
  return toCsv(rows, columns);
}

export interface ReportingPluginOptions {
  db: Kysely<Database>;
}

/**
 * No dedicated response schema per route: a route can answer either a
 * report's own JSON shape or a CSV string depending on `?format=csv`,
 * and Zod response validation would have to accept both — simpler to
 * leave response validation off here and let each report's own service
 * function (already fully typed) be the source of truth for the JSON
 * shape. Every report is manager+ — this is financial/audit data, not
 * day-to-day order-taking.
 */
export const reportingRoutes: FastifyPluginAsync<ReportingPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/api/reports/daily-sales', { schema: { querystring: dateRangeQuerySchema } }, async (request, reply) => {
    requireRole(request, reply, 'manager');
    const report = await dailySalesReport(db, { ...request.query, ...resolveDateRange(request.query) });
    return sendReport(reply, request.query.format, report);
  });

  app.get(
    '/api/reports/partners/:id/statement',
    { schema: { params: z.object({ id: z.coerce.number().int() }), querystring: dateRangeQuerySchema } },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      const statement = await partnerStatement(db, request.params.id, resolveDateRange(request.query));
      return sendReport(reply, request.query.format, statement);
    },
  );

  app.get(
    '/api/reports/partners/:id/items/:itemId/bills',
    { schema: { params: z.object({ id: z.coerce.number().int(), itemId: z.coerce.number().int() }), querystring: dateRangeQuerySchema } },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      const bills = await partnerItemBills(db, request.params.id, request.params.itemId, resolveDateRange(request.query));
      return sendReport(reply, request.query.format, bills);
    },
  );

  app.get('/api/reports/allocation-reconciliation', { schema: { querystring: dateRangeQuerySchema } }, async (request, reply) => {
    requireRole(request, reply, 'manager');
    const reconciliation = await allocationReconciliation(db, { ...request.query, ...resolveDateRange(request.query) });
    return sendReport(reply, request.query.format, reconciliation);
  });

  app.get('/api/reports/item-mix', { schema: { querystring: dateRangeQuerySchema } }, async (request, reply) => {
    requireRole(request, reply, 'manager');
    const lines = await itemMixReport(db, { ...request.query, ...resolveDateRange(request.query) });
    return sendReport(reply, request.query.format, lines);
  });

  app.get(
    '/api/reports/consumption',
    { schema: { querystring: dateRangeQuerySchema.extend({ personId: z.coerce.number().int().optional() }) } },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      const report = await consumptionReport(db, { ...request.query, ...resolveDateRange(request.query) });
      // The CSV is the per-item detail, not the summary object: a
      // spreadsheet of "who ate what" is the entire reason to export
      // this report, and it is the one thing a flattened summary row
      // would bury inside a JSON-encoded cell.
      return sendReport(reply, request.query.format, report, report.lines as unknown as Record<string, unknown>[]);
    },
  );

  app.get(
    '/api/reports/service-charge',
    { schema: { querystring: dateRangeQuerySchema.extend({ shiftId: z.coerce.number().int().optional() }) } },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      const lines = await waiterPayoutTotals(db, { ...request.query, ...resolveDateRange(request.query) });
      return sendReport(reply, request.query.format, lines);
    },
  );

  app.get(
    '/api/reports/void-and-discount',
    { schema: { querystring: dateRangeQuerySchema.extend({ actorId: z.coerce.number().int().optional() }) } },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      const entries = await voidAndDiscountReport(db, { ...request.query, ...resolveDateRange(request.query) });
      return sendReport(reply, request.query.format, entries);
    },
  );
};
