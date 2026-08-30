import { paisaSchema } from '@pos/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import { ConcurrentModificationError, OrderStateError } from '../ordering/service.js';
import type { Database } from '../platform/db/types.js';
import { PrintError, type PrinterTarget } from '../platform/printing/client.js';
import { printBill, printReceipt } from './printing.js';
import { createPaymentMethod, listPaymentMethods, recordPayment, refundOrder, settleConsumption, updatePaymentMethod } from './service.js';

const settlementTypeSchema = z.enum(['house_expense', 'payroll_deduction', 'partner_personal']);

const paymentMethodKindSchema = z.enum(['cash', 'wallet', 'bank_transfer', 'card']);

const paymentMethodSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  displayName: z.string(),
  kind: paymentMethodKindSchema,
  active: z.boolean(),
  sortOrder: z.number().int(),
  printOnBill: z.boolean(),
  accountTitle: z.string().nullable(),
  accountNumber: z.string().nullable(),
  bankName: z.string().nullable(),
  instructionsLine: z.string().nullable(),
});

const orderSummarySchema = z.object({
  id: z.number().int(),
  invoiceNo: z.number().int().nullable(),
  orderType: z.string(),
  channel: z.string(),
  tableLabel: z.string().nullable(),
  waiterId: z.number().int().nullable(),
  beneficiaryPersonId: z.number().int().nullable(),
  openedAt: z.string(),
  billedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  openedBy: z.number().int(),
  closedBy: z.number().int().nullable(),
  status: z.string(),
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

const paymentResultSchema = z.object({
  payment: z.object({
    id: z.number().int(),
    orderId: z.number().int(),
    paymentMethodId: z.number().int(),
    amountMinor: z.number().int(),
    referenceNo: z.string().nullable(),
    receivedBy: z.number().int(),
    receivedAt: z.string(),
    reversedByPaymentId: z.number().int().nullable(),
  }),
  changeMinor: z.number().int().nullable(),
  orderClosed: z.boolean(),
  order: orderSummarySchema,
  invoiceNo: z.number().int().nullable(),
});

const refundResultSchema = z.object({
  refundPaymentId: z.number().int(),
  amountMinor: z.number().int(),
  allocationsReversed: z.number().int(),
});

const consumptionRecordSchema = z.object({
  id: z.number().int(),
  orderId: z.number().int(),
  personId: z.number().int(),
  personName: z.string(),
  policySnapshot: z.object({
    mealPolicy: z.enum(['free', 'discounted', 'full_price', 'payroll_deduction']),
    mealDiscountBp: z.number().int(),
  }),
  menuValueMinor: z.number().int(),
  chargedMinor: z.number().int(),
  settlementMinor: z.number().int(),
  settlementType: settlementTypeSchema.nullable(),
  createdAt: z.string(),
});

const settleConsumptionResultSchema = z.object({
  consumptionRecord: consumptionRecordSchema,
  payment: paymentResultSchema.shape.payment.nullable(),
  order: orderSummarySchema,
  invoiceNo: z.number().int(),
});

export interface BillingPluginOptions {
  db: Kysely<Database>;
  printer: PrinterTarget | null;
}

export const billingRoutes: FastifyPluginAsync<BillingPluginOptions> = async (fastify, { db, printer }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Same pattern as ordering/routes.ts: domain errors map to specific,
  // cashier-actionable HTTP statuses, scoped to this plugin only.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConcurrentModificationError) {
      reply.code(409).send({ error: error.message });
      return;
    }
    if (error instanceof OrderStateError) {
      reply.code(422).send({ error: error.message });
      return;
    }
    if (error instanceof PrintError) {
      // The printer, not this server, is the thing that's broken — a
      // clear "try again" for the cashier, never a reason order-taking
      // or billing itself should be treated as having failed.
      reply.code(502).send({ error: error.message });
      return;
    }
    throw error;
  });

  // ---- payment methods ----

  app.get(
    '/api/payment-methods',
    {
      schema: {
        querystring: z.object({ includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(paymentMethodSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listPaymentMethods(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/payment-methods',
    {
      schema: {
        body: z.object({
          code: z.string().min(1),
          displayName: z.string().min(1),
          kind: paymentMethodKindSchema,
          sortOrder: z.number().int().optional(),
          printOnBill: z.boolean().optional(),
          accountTitle: z.string().optional(),
          accountNumber: z.string().optional(),
          bankName: z.string().optional(),
          instructionsLine: z.string().optional(),
        }),
        response: { 201: paymentMethodSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createPaymentMethod(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/payment-methods/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({
          displayName: z.string().min(1).optional(),
          active: z.boolean().optional(),
          sortOrder: z.number().int().optional(),
          printOnBill: z.boolean().optional(),
          accountTitle: z.string().optional(),
          accountNumber: z.string().optional(),
          bankName: z.string().optional(),
          instructionsLine: z.string().optional(),
        }),
        response: { 200: paymentMethodSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return updatePaymentMethod(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- payments and closing ----

  app.post(
    '/api/orders/:id/payments',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({
          paymentMethodId: z.number().int(),
          amountMinor: paisaSchema,
          referenceNo: z.string().optional(),
          tenderedMinor: paisaSchema.optional(),
        }),
        response: { 201: paymentResultSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      reply.code(201);
      return recordPayment(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- settling a staff/owner meal ----

  app.post(
    '/api/orders/:id/settle-consumption',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({
          settlementType: settlementTypeSchema.optional(),
          paymentMethodId: z.number().int().optional(),
          referenceNo: z.string().optional(),
        }),
        response: { 201: settleConsumptionResultSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      reply.code(201);
      return settleConsumption(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- refunds ----

  app.post(
    '/api/orders/:id/refund',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ reason: z.string().min(1), orderLineId: z.number().int().optional() }),
        response: { 200: refundResultSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return refundOrder(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- printing ----

  app.post(
    '/api/orders/:id/print-bill',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.object({ ok: z.literal(true) }), 503: z.object({ error: z.string() }) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      if (!printer) {
        reply.code(503);
        return { error: 'no printer configured (set POS_PRINTER_HOST)' };
      }
      await printBill(db, request.params.id, printer);
      return { ok: true as const };
    },
  );

  app.post(
    '/api/orders/:id/print-receipt',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.object({ ok: z.literal(true) }), 503: z.object({ error: z.string() }) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      if (!printer) {
        reply.code(503);
        return { error: 'no printer configured (set POS_PRINTER_HOST)' };
      }
      await printReceipt(db, request.params.id, printer);
      return { ok: true as const };
    },
  );
};
