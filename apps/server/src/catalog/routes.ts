import { paisaSchema } from '@pos/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import {
  clearItemModifierPrice,
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  getPriceHistory,
  linkModifierGroup,
  listCategories,
  listItemModifierPrices,
  listItems,
  listMenu,
  listModifierGroups,
  listModifierGroupsForItem,
  listModifiers,
  removeItem,
  setAvailability,
  setItemModifierPrice,
  setItemPrice,
  unlinkModifierGroup,
  updateCategory,
  updateItem,
  updateModifier,
  updateModifierGroup,
} from './service.js';

const categorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
});

const itemSchema = z.object({
  id: z.number().int(),
  categoryId: z.number().int(),
  name: z.string(),
  active: z.boolean(),
});

const itemPriceSchema = z.object({
  id: z.number().int(),
  itemId: z.number().int(),
  priceMinor: z.number().int(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});

const modifierGroupSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  minSelect: z.number().int(),
  maxSelect: z.number().int(),
});

const modifierSchema = z.object({
  id: z.number().int(),
  groupId: z.number().int(),
  name: z.string(),
  priceDeltaMinor: z.number().int(),
});

const availabilitySchema = z.object({
  itemId: z.number().int(),
  available: z.boolean(),
  changedBy: z.number().int().nullable(),
  changedAt: z.string(),
});

const menuItemSchema = z.object({
  id: z.number().int(),
  categoryId: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  priceMinor: z.number().int().nullable(),
  available: z.boolean(),
});

export interface CatalogPluginOptions {
  db: Kysely<Database>;
}

export const catalogRoutes: FastifyPluginAsync<CatalogPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ---- categories ----

  app.get(
    '/api/categories',
    {
      schema: {
        querystring: z.object({ includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(categorySchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listCategories(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/categories',
    {
      schema: {
        body: z.object({ name: z.string().min(1), sortOrder: z.number().int().optional() }),
        response: { 201: categorySchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createCategory(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/categories/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ name: z.string().min(1).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }),
        response: { 200: categorySchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return updateCategory(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- items ----

  app.get(
    '/api/items',
    {
      schema: {
        querystring: z.object({ categoryId: z.coerce.number().int().optional(), includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(itemSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listItems(db, request.query);
    },
  );

  app.post(
    '/api/items',
    {
      schema: {
        body: z.object({ categoryId: z.number().int(), name: z.string().min(1) }),
        response: { 201: itemSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createItem(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/items/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ name: z.string().min(1).optional(), categoryId: z.number().int().optional(), active: z.boolean().optional() }),
        response: { 200: itemSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return updateItem(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- item price ----

  app.post(
    '/api/items/:id/price',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ priceMinor: paisaSchema }),
        response: { 201: itemPriceSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return setItemPrice(db, request.params.id, request.body.priceMinor, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  app.get(
    '/api/items/:id/price-history',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.array(itemPriceSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return getPriceHistory(db, request.params.id);
    },
  );

  /**
   * Take an item off the menu. Deleted outright if it was never sold,
   * retired if it was — the server decides, and says which it did, so
   * the screen can tell the manager rather than guess.
   */
  app.delete(
    '/api/items/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.object({ outcome: z.enum(['deleted', 'retired']) }) },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      const outcome = await removeItem(db, request.params.id, { actorId: actor.userId, terminalId: actor.terminalId });
      return { outcome };
    },
  );

  // ---- what a modifier costs on THIS item ----

  app.get(
    '/api/items/:id/modifier-prices',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.array(z.object({ modifierId: z.number().int(), priceDeltaMinor: paisaSchema })) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listItemModifierPrices(db, request.params.id);
    },
  );

  app.put(
    '/api/items/:id/modifier-prices/:modifierId',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int(), modifierId: z.coerce.number().int() }),
        body: z.object({ priceDeltaMinor: paisaSchema }),
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      await setItemModifierPrice(db, request.params.id, request.params.modifierId, request.body.priceDeltaMinor, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/items/:id/modifier-prices/:modifierId',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int(), modifierId: z.coerce.number().int() }),
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      await clearItemModifierPrice(db, request.params.id, request.params.modifierId, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
      return reply.code(204).send();
    },
  );

  // ---- availability ----

  app.patch(
    '/api/items/:id/availability',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ available: z.boolean() }),
        response: { 200: availabilitySchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return setAvailability(db, request.params.id, request.body.available, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  // ---- modifier groups ----

  app.get('/api/modifier-groups', { schema: { response: { 200: z.array(modifierGroupSchema) } } }, async (request, reply) => {
    requireAuth(request, reply);
    return listModifierGroups(db);
  });

  app.post(
    '/api/modifier-groups',
    {
      schema: {
        body: z.object({ name: z.string().min(1), minSelect: z.number().int().min(0), maxSelect: z.number().int().min(0) }),
        response: { 201: modifierGroupSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createModifierGroup(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/modifier-groups/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ name: z.string().min(1).optional(), minSelect: z.number().int().min(0).optional(), maxSelect: z.number().int().min(0).optional() }),
        response: { 200: modifierGroupSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return updateModifierGroup(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- modifiers ----

  app.get(
    '/api/modifiers',
    {
      schema: {
        querystring: z.object({ groupId: z.coerce.number().int().optional() }),
        response: { 200: z.array(modifierSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listModifiers(db, request.query);
    },
  );

  app.post(
    '/api/modifiers',
    {
      schema: {
        body: z.object({ groupId: z.number().int(), name: z.string().min(1), priceDeltaMinor: paisaSchema }),
        response: { 201: modifierSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createModifier(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/modifiers/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ name: z.string().min(1).optional(), priceDeltaMinor: paisaSchema.optional() }),
        response: { 200: modifierSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return updateModifier(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  // ---- item <-> modifier group links ----

  app.get(
    '/api/items/:id/modifier-groups',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.array(modifierGroupSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listModifierGroupsForItem(db, request.params.id);
    },
  );

  app.post(
    '/api/items/:id/modifier-groups',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ groupId: z.number().int() }),
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      await linkModifierGroup(db, request.params.id, request.body.groupId, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/items/:id/modifier-groups/:groupId',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int(), groupId: z.coerce.number().int() }),
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      await unlinkModifierGroup(db, request.params.id, request.params.groupId, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
      return reply.code(204).send();
    },
  );

  // ---- combined menu view (order screen's item grid) ----

  app.get(
    '/api/menu',
    {
      schema: {
        querystring: z.object({ categoryId: z.coerce.number().int().optional(), includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(menuItemSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listMenu(db, request.query);
    },
  );
};
