import { paisa, paisaSchema } from '@pos/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import { getOrderHistory } from './history.js';
import {
  addLine,
  billOrder,
  ConcurrentModificationError,
  createOrder,
  getFloorBoard,
  getOrder,
  listOrders,
  OrderStateError,
  previewBillTotals,
  removeLine,
  reopenOrder,
  setDiscount,
  setLineQty,
  voidLine,
  voidOrder,
} from './service.js';

const orderTypeSchema = z.enum(['dine_in', 'takeaway', 'delivery']);
const orderChannelSchema = z.enum(['customer', 'staff_meal', 'owner_meal']);
const orderStatusSchema = z.enum(['open', 'billed', 'closed', 'voided']);

const orderLineModifierSchema = z.object({
  id: z.number().int(),
  modifierId: z.number().int(),
  modifierName: z.string(),
  priceDeltaMinor: z.number().int(),
  grossMinor: z.number().int(),
  proratedDiscountMinor: z.number().int(),
  netSalesMinor: z.number().int(),
  allocationBaseMinor: z.number().int(),
});

const orderLineSchema = z.object({
  id: z.number().int(),
  itemId: z.number().int(),
  itemName: z.string(),
  qty: z.number().int(),
  unitPriceMinor: z.number().int(),
  grossMinor: z.number().int(),
  proratedDiscountMinor: z.number().int(),
  netSalesMinor: z.number().int(),
  allocationBaseMinor: z.number().int(),
  voided: z.boolean(),
  voidReason: z.string().nullable(),
  voidApprovedBy: z.number().int().nullable(),
  voidKind: z.enum(['correction', 'void']).nullable(),
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
  firstBilledAt: z.string().nullable(),
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
  serviceChargeRateBp: z.number().int().nullable(),
  roundingAdjustmentMinor: z.number().int(),
  totalMinor: z.number().int(),
  version: z.number().int(),
});

const orderDetailSchema = orderSummarySchema.extend({
  lines: z.array(orderLineSchema),
  paidMinor: z.number().int(),
  balanceMinor: z.number().int(),
});

const floorOrderSchema = orderSummarySchema.extend({
  paidMinor: z.number().int(),
  balanceMinor: z.number().int(),
});

const floorBoardSchema = z.object({
  open: z.array(floorOrderSchema),
  awaitingPayment: z.array(floorOrderSchema),
  completed: z.array(floorOrderSchema),
});

const billTotalsSchema = z.object({
  subtotalMinor: z.number().int(),
  orderDiscountMinor: z.number().int(),
  netSalesMinor: z.number().int(),
  taxMinor: z.number().int(),
  serviceChargeMinor: z.number().int(),
  serviceChargeRateBp: z.number().int().nullable(),
  serviceChargeName: z.string(),
  roundingAdjustmentMinor: z.number().int(),
  totalMinor: z.number().int(),
});

const historicalPaymentSchema = z.object({
  id: z.number().int(),
  methodName: z.string(),
  methodKind: z.string(),
  amountMinor: z.number().int(),
  referenceNo: z.string().nullable(),
  accountId: z.number().int().nullable(),
  accountLabel: z.string().nullable(),
  accountNumber: z.string().nullable(),
  accountBankName: z.string().nullable(),
  tenderedMinor: z.number().int().nullable(),
  changeMinor: z.number().int().nullable(),
  receivedAt: z.string(),
  receivedByName: z.string().nullable(),
  isRefund: z.boolean(),
  reversedByPaymentId: z.number().int().nullable(),
});

const orderHistorySchema = z.object({
  order: orderDetailSchema,
  waiterName: z.string().nullable(),
  openedByName: z.string().nullable(),
  closedByName: z.string().nullable(),
  beneficiaryName: z.string().nullable(),
  payments: z.array(historicalPaymentSchema),
  paidMinor: z.number().int(),
  balanceMinor: z.number().int(),
  changeGivenMinor: z.number().int(),
  partnerAllocations: z.array(
    z.object({
      partnerId: z.number().int(),
      partnerName: z.string(),
      amountMinor: z.number().int(),
      shareBpSnapshot: z.number().int(),
    }),
  ),
});

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

  // The floor board's three lists in one call — see getFloorBoard for
  // why the split is computed here rather than by each screen.
  app.get(
    '/api/orders/board',
    {
      schema: {
        querystring: z.object({ completedLimit: z.coerce.number().int().min(0).max(200).optional() }),
        response: { 200: floorBoardSchema },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return getFloorBoard(db, { completedLimit: request.query.completedLimit });
    },
  );

  app.get(
    '/api/orders/:id/bill-preview',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        // No override given means "what would the configured rule
        // charge?" — which is what the bill screen asks before a
        // cashier touches anything.
        querystring: z.object({ serviceChargeMinor: z.coerce.number().int().optional() }),
        response: { 200: billTotalsSchema },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const override = request.query.serviceChargeMinor;
      return previewBillTotals(db, request.params.id, override === undefined ? undefined : paisa(override));
    },
  );

  app.patch(
    '/api/orders/:id/lines/:lineId/qty',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int(), lineId: z.coerce.number().int() }),
        body: z.object({ qty: z.number().int().positive() }),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      return setLineQty(db, request.params.id, request.params.lineId, request.body, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  // Removing a mis-tapped line from a bill that has never been printed.
  // Deliberately NOT manager-gated: the service refuses the moment the
  // order has been billed, at which point the caller has to come back
  // through the void route above with a manager and a reason.
  app.delete(
    '/api/orders/:id/lines/:lineId',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int(), lineId: z.coerce.number().int() }),
        response: { 200: orderDetailSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      return removeLine(db, request.params.id, request.params.lineId, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  /**
   * The complete record of one order — what was on it, what it came to,
   * and how it was paid. Read-only: opening an order must never change
   * it, so this route touches nothing.
   *
   * Any signed-in user may read it: a cashier looking up the bill they
   * settled ten minutes ago is the main reason it exists, and the
   * figures on it are the ones already printed on the customer's own
   * receipt.
   */
  app.get(
    '/api/orders/:id/history',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: orderHistorySchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const history = await getOrderHistory(db, request.params.id);
      if (!history) {
        reply.code(404);
        return { error: `order ${request.params.id} not found` };
      }
      return history;
    },
  );
};
