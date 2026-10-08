import { paisaSchema } from '@pos/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import { dateFilterSchema, resolveDateRange } from '../platform/date-range.js';
import type { Database } from '../platform/db/types.js';
import {
  createPurchase,
  createPurchaseCategory,
  createPurchaseSource,
  deletePurchaseCategory,
  deletePurchaseSource,
  listPurchaseCategories,
  listPurchaseSources,
  listPurchases,
  purchaseReport,
  renamePurchaseCategory,
  renamePurchaseSource,
  setPurchaseCategoryActive,
  setPurchaseSourceActive,
  voidPurchase,
} from './service.js';

const purchaseCategorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
});

// A payment source has the same shape as a category — both are small
// owner-managed lists.
const purchaseSourceSchema = purchaseCategorySchema;

const purchaseSchema = z.object({
  id: z.number().int(),
  shiftId: z.number().int().nullable(),
  partnerId: z.number().int(),
  partnerName: z.string(),
  categoryId: z.number().int(),
  categoryName: z.string(),
  description: z.string().nullable(),
  amountMinor: z.number().int(),
  sourceId: z.number().int().nullable(),
  sourceName: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.number().int(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  voided: z.boolean(),
  voidedBy: z.number().int().nullable(),
  voidedByName: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
});

const purchaseGroupLineSchema = z.object({ id: z.number().int(), name: z.string(), count: z.number().int(), totalMinor: z.number().int() });

const purchaseReportSchema = z.object({
  totalMinor: z.number().int(),
  count: z.number().int(),
  byCategory: z.array(purchaseGroupLineSchema),
  byPartner: z.array(purchaseGroupLineSchema),
  bySource: z.array(purchaseGroupLineSchema),
  purchases: z.array(purchaseSchema),
});

const purchaseFilterSchema = dateFilterSchema.extend({
  shiftId: z.coerce.number().int().optional(),
  partnerId: z.coerce.number().int().optional(),
  categoryId: z.coerce.number().int().optional(),
  sourceId: z.coerce.number().int().optional(),
});

export interface PurchasesPluginOptions {
  db: Kysely<Database>;
}

/**
 * The purchase ledger and its category list.
 *
 * Reading the category list is open to any signed-in user (the purchase
 * form's picker needs it); managing it is a manager action. Recording a
 * purchase and reading the ledger are cashier+; voiding a purchase and the
 * purchases report are manager+ — the same financial/audit gating the
 * rest of the system uses.
 */
export const purchasesRoutes: FastifyPluginAsync<PurchasesPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ---- purchase categories (Settings) ----

  app.get(
    '/api/purchase-categories',
    { schema: { querystring: z.object({ includeInactive: z.coerce.boolean().optional() }), response: { 200: z.array(purchaseCategorySchema) } } },
    async (request, reply) => {
      requireAuth(request, reply);
      return listPurchaseCategories(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/purchase-categories',
    { schema: { body: z.object({ name: z.string().min(1), sortOrder: z.number().int().optional() }), response: { 201: purchaseCategorySchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createPurchaseCategory(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/purchase-categories/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ name: z.string().min(1) }), response: { 200: purchaseCategorySchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return renamePurchaseCategory(db, request.params.id, request.body.name, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/purchase-categories/:id/active',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ active: z.boolean() }), response: { 200: purchaseCategorySchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return setPurchaseCategoryActive(db, request.params.id, request.body.active, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.delete(
    '/api/purchase-categories/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }), response: { 200: z.object({ outcome: z.enum(['deleted', 'retired']) }) } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      const outcome = await deletePurchaseCategory(db, request.params.id, { actorId: actor.userId, terminalId: actor.terminalId });
      return { outcome };
    },
  );

  // ---- purchase payment sources (Settings) ----

  app.get(
    '/api/purchase-sources',
    { schema: { querystring: z.object({ includeInactive: z.coerce.boolean().optional() }), response: { 200: z.array(purchaseSourceSchema) } } },
    async (request, reply) => {
      requireAuth(request, reply);
      return listPurchaseSources(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/purchase-sources',
    { schema: { body: z.object({ name: z.string().min(1), sortOrder: z.number().int().optional() }), response: { 201: purchaseSourceSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createPurchaseSource(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/purchase-sources/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ name: z.string().min(1) }), response: { 200: purchaseSourceSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return renamePurchaseSource(db, request.params.id, request.body.name, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/purchase-sources/:id/active',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ active: z.boolean() }), response: { 200: purchaseSourceSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return setPurchaseSourceActive(db, request.params.id, request.body.active, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.delete(
    '/api/purchase-sources/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }), response: { 200: z.object({ outcome: z.enum(['deleted', 'retired']) }) } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      const outcome = await deletePurchaseSource(db, request.params.id, { actorId: actor.userId, terminalId: actor.terminalId });
      return { outcome };
    },
  );

  // ---- purchases ----

  app.get(
    '/api/purchases',
    { schema: { querystring: purchaseFilterSchema.extend({ includeVoided: z.coerce.boolean().optional() }), response: { 200: z.array(purchaseSchema) } } },
    async (request, reply) => {
      requireRole(request, reply, 'cashier');
      const { shiftId, partnerId, categoryId, sourceId, includeVoided, ...filter } = request.query;
      return listPurchases(db, {
        ...resolveDateRange(filter),
        ...(shiftId === undefined ? {} : { shiftId }),
        ...(partnerId === undefined ? {} : { partnerId }),
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(includeVoided === undefined ? {} : { includeVoided }),
      });
    },
  );

  app.post(
    '/api/purchases',
    {
      schema: {
        body: z.object({
          partnerId: z.number().int(),
          categoryId: z.number().int(),
          amountMinor: paisaSchema,
          sourceId: z.number().int().optional(),
          description: z.string().max(200).optional(),
          note: z.string().max(500).optional(),
        }),
        response: { 201: purchaseSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'cashier');
      reply.code(201);
      return createPurchase(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.post(
    '/api/purchases/:id/void',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ reason: z.string().min(1) }), response: { 200: purchaseSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return voidPurchase(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- report ----

  app.get('/api/reports/purchases', { schema: { querystring: purchaseFilterSchema, response: { 200: purchaseReportSchema } } }, async (request, reply) => {
    requireRole(request, reply, 'manager');
    const { shiftId, partnerId, categoryId, sourceId, ...filter } = request.query;
    return purchaseReport(db, {
      ...resolveDateRange(filter),
      ...(shiftId === undefined ? {} : { shiftId }),
      ...(partnerId === undefined ? {} : { partnerId }),
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(sourceId === undefined ? {} : { sourceId }),
    });
  });
};
