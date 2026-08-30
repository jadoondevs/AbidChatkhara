import { paisaSchema } from '@pos/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { waiterPayoutTotals } from '../gratuity/service.js';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import { closeShift, getOpenShift, getShift, getZReport, listShifts, openShift, ShiftCloseBlockedError, ShiftStateError } from './service.js';

const shiftSchema = z.object({
  id: z.number().int(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  openedBy: z.number().int(),
  closedBy: z.number().int().nullable(),
  openingCashMinor: z.number().int(),
  countedCashMinor: z.number().int().nullable(),
  expectedCashMinor: z.number().int().nullable(),
  varianceMinor: z.number().int().nullable(),
});

const blockingOrderSchema = z.object({
  id: z.number().int(),
  orderType: z.string(),
  status: z.string(),
  tableLabel: z.string().nullable(),
});

const zReportSchema = z.object({
  shift: shiftSchema,
  customerSalesMinor: z.number().int(),
  consumptionMinor: z.number().int(),
  combinedSalesMinor: z.number().int(),
  taxCollectedMinor: z.number().int(),
  serviceChargeCollectedMinor: z.number().int(),
  roundingAdjustmentMinor: z.number().int(),
  paymentMethodBreakdown: z.array(z.object({ paymentMethodId: z.number().int(), paymentMethodName: z.string(), totalMinor: z.number().int() })),
});

const payoutLineSchema = z.object({ waiterId: z.number().int(), waiterName: z.string(), totalMinor: z.number().int() });

export interface ShiftsPluginOptions {
  db: Kysely<Database>;
}

/** Shift open/close (spec, screen 12) — gated at cashier+, the role
 * actually responsible for cash custody; reads (the open shift, a
 * shift's own Z-report/payout sheet) are open to any authenticated
 * user, same as every other read-only surface here. */
export const shiftsRoutes: FastifyPluginAsync<ShiftsPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ShiftCloseBlockedError) {
      reply.code(422).send({ error: error.message, blockingOrders: error.blockingOrders });
      return;
    }
    if (error instanceof ShiftStateError) {
      reply.code(422).send({ error: error.message });
      return;
    }
    throw error;
  });

  app.get('/api/shifts', { schema: { response: { 200: z.array(shiftSchema) } } }, async (request, reply) => {
    requireAuth(request, reply);
    return listShifts(db);
  });

  app.get('/api/shifts/open', { schema: { response: { 200: shiftSchema.nullable() } } }, async (request, reply) => {
    requireAuth(request, reply);
    return getOpenShift(db);
  });

  app.get(
    '/api/shifts/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }), response: { 200: shiftSchema, 404: z.object({ error: z.string() }) } } },
    async (request, reply) => {
      requireAuth(request, reply);
      const shift = await getShift(db, request.params.id);
      if (!shift) {
        reply.code(404);
        return { error: `shift ${request.params.id} not found` };
      }
      return shift;
    },
  );

  app.post(
    '/api/shifts',
    { schema: { body: z.object({ openingCashMinor: paisaSchema }), response: { 201: shiftSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'cashier');
      reply.code(201);
      return openShift(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.post(
    '/api/shifts/:id/close',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ countedCashMinor: paisaSchema }),
        response: { 200: shiftSchema, 422: z.object({ error: z.string(), blockingOrders: z.array(blockingOrderSchema).optional() }) },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'cashier');
      return closeShift(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.get(
    '/api/shifts/:id/z-report',
    { schema: { params: z.object({ id: z.coerce.number().int() }), response: { 200: zReportSchema } } },
    async (request, reply) => {
      requireAuth(request, reply);
      return getZReport(db, request.params.id);
    },
  );

  app.get(
    '/api/shifts/:id/payout-sheet',
    { schema: { params: z.object({ id: z.coerce.number().int() }), response: { 200: z.array(payoutLineSchema) } } },
    async (request, reply) => {
      requireAuth(request, reply);
      return waiterPayoutTotals(db, { shiftId: request.params.id });
    },
  );
};
