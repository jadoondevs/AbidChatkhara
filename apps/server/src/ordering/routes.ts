import { paisaSchema } from '@pos/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import {
  addLine,
  billOrder,
  ConcurrentModificationError,
  createOrder,
  getOrder,
  listOrders,
  OrderStateError,
  reopenOrder,
  setDiscount,
  voidLine,
  voidOrder,
} from './service.js';

const orderTypeSchema = z.enum(['dine_in', 'takeaway', 'delivery']);
const orderChannelSchema = z.enum(['customer', 'staff_meal', 'owner_meal']);
const orderStatusSchema = z.enum(['open', 'billed', 'closed', 'voided']);

const orderLineModifierSchema = z.object({
  id: z.number().int(),
  modifierId: z.number().int(),
  priceDeltaMinor: z.number().int(),
  grossMinor: z.number().int(),
  proratedDiscountMinor: z.number().int(),
  netSalesMinor: z.number().int(),
  allocationBaseMinor: z.number().int(),
});

const orderLineSchema = z.object({
  id: z.number().int(),
  itemId: z.number().int(),
  qty: z.number().int(),
  unitPriceMinor: z.number().int(),
  grossMinor: z.number().int(),
  proratedDiscountMinor: z.number().int(),
  netSalesMinor: z.number().int(),
  allocationBaseMinor: z.number().int(),
  voided: z.boolean(),
  voidReason: z.string().nullable(),
  voidApprovedBy: z.number().int().nullable(),
  modifiers: z.array(orderLineModifierSchema),
});

const orderSummarySchema = z.object({
  id: z.number().int(),
  invoiceNo: z.number().int().nullable(),
  orderType: orderTypeSchema,
  channel: orderChannelSchema,
  tableLabel: z.string().nullable(),
  waiterId: z.number().int().nullable(),
  beneficiaryPersonId: z.number().int().nullable(),
  shiftId: z.number().int().nullable(),
  openedAt: z.string(),
  billedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  openedBy: z.number().int(),
  closedBy: z.number().int().nullable(),
  status: orderStatusSchema,
  subtotalMinor: z.number().int(),
  orderDiscountMinor: z.number().int(),
  discountReason: z.string().nullable(),
  netSalesMinor: z.number().int(),
  taxMinor: z.number().int(),
  serviceChargeMinor: z.number().int(),
  roundingAdjustmentMinor: z.number().int(),
  totalMinor: z.number().int(),
  version: z.number().int(),
});

const orderDetailSchema = orderSummarySchema.extend({ lines: z.array(orderLineSchema) });
const errorSchema = z.object({ error: z.string() });

export interface OrderingPluginOptions {
  db: Kysely<Database>;
}

/**
 * Every route below takes an explicit :id — there is no "current order"
 * route, and never will be (see ARCHITECTURE.md, "no current order").
 */
export const orderingRoutes: FastifyPluginAsync<OrderingPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Domain errors (OrderStateError, ConcurrentModificationError) map to
  // specific, cashier-actionable HTTP statuses rather than a generic 500.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConcurrentModificationError) {
      reply.code(409).send({ error: error.message });
      return;
    }
    if (error instanceof OrderStateError) {
      reply.code(422).send({ error: error.message });
      return;
    }
    throw error;
  });

  app.get(
    '/api/orders',
    {
      schema: {
        querystring: z.object({ status: z.string().optional() }),
        response: { 200: z.array(orderSummarySchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const status = request.query.status?.split(',').map((s) => orderStatusSchema.parse(s));
      return listOrders(db, { status });
    },
  );

  app.get(
    '/api/orders/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: orderDetailSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const order = await getOrder(db, request.params.id);
      if (!order) {
        reply.code(404);
        return { error: `order ${request.params.id} not found` };
      }
      return order;
    },
  );

  app.post(
    '/api/orders',
    {
      schema: {
        body: z.object({
          orderType: orderTypeSchema,
          channel: orderChannelSchema.optional(),
          tableLabel: z.string().min(1).optional(),
          waiterId: z.number().int().optional(),
          beneficiaryPersonId: z.number().int().optional(),
        }),
        response: { 201: orderSummarySchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      reply.code(201);
      return createOrder(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.post(
    '/api/orders/:id/lines',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ itemId: z.number().int(), qty: z.number().int().positive(), modifierIds: z.array(z.number().int()).optional() }),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      return addLine(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.post(
    '/api/orders/:id/lines/:lineId/void',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int(), lineId: z.coerce.number().int() }),
        body: z.object({ reason: z.string().min(1) }),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      // Line void requires manager approval — the approving manager IS the actor.
      const actor = requireRole(request, reply, 'manager');
      return voidLine(db, request.params.id, request.params.lineId, request.body, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  app.patch(
    '/api/orders/:id/discount',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ discountMinor: paisaSchema, reason: z.string().min(1).optional() }),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      return setDiscount(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.post(
    '/api/orders/:id/bill',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ serviceChargeMinor: paisaSchema.optional() }).optional(),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      return billOrder(db, request.params.id, request.body ?? {}, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.post(
    '/api/orders/:id/reopen',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return reopenOrder(db, request.params.id, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.post(
    '/api/orders/:id/void',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ reason: z.string().min(1) }),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return voidOrder(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );
};
