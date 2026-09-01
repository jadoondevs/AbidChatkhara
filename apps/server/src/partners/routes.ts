import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import {
  checkOwnershipIntegrity,
  createPartner,
  getActiveItemOwnership,
  getActiveModifierOwnership,
  getPartnerRecord,
  listPartners,
  renamePartner,
  setItemOwnership,
  setModifierOwnership,
  setPartnerActive,
} from './service.js';

const partnerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  joinedAt: z.string(),
  leftAt: z.string().nullable(),
});

const ownershipSplitEntrySchema = z.object({ partnerId: z.number().int(), shareBp: z.number().int().positive().max(10_000) });
const ownershipShareSchema = z.object({ partnerId: z.number().int(), shareBp: z.number().int() });
const integrityViolationSchema = z.object({ kind: z.enum(['item', 'modifier']), id: z.number().int(), totalShareBp: z.number().int() });

export interface PartnersPluginOptions {
  db: Kysely<Database>;
}

/** Ownership edits require manager role and are written to the audit
 * log (spec) — every mutation below is gated at `requireRole(..., 'manager')`. */
export const partnersRoutes: FastifyPluginAsync<PartnersPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/partners',
    {
      schema: {
        querystring: z.object({ includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(partnerSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listPartners(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/partners',
    { schema: { body: z.object({ name: z.string().min(1) }), response: { 201: partnerSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createPartner(db, request.body.name, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/partners/:id/active',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ active: z.boolean() }),
        response: { 200: partnerSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return setPartnerActive(db, request.params.id, request.body.active, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.get(
    '/api/items/:id/ownership',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.array(ownershipShareSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return getActiveItemOwnership(db, request.params.id);
    },
  );

  app.put(
    '/api/items/:id/ownership',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ split: z.array(ownershipSplitEntrySchema) }),
        response: { 200: z.array(ownershipShareSchema) },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      const rows = await setItemOwnership(db, request.params.id, request.body.split, { actorId: actor.userId, terminalId: actor.terminalId });
      return rows.map((r) => ({ partnerId: r.partnerId, shareBp: r.shareBp }));
    },
  );

  app.get(
    '/api/modifiers/:id/ownership',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: z.array(ownershipShareSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return getActiveModifierOwnership(db, request.params.id);
    },
  );

  app.put(
    '/api/modifiers/:id/ownership',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ split: z.array(ownershipSplitEntrySchema) }),
        response: { 200: z.array(ownershipShareSchema) },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      const rows = await setModifierOwnership(db, request.params.id, request.body.split, { actorId: actor.userId, terminalId: actor.terminalId });
      return rows.map((r) => ({ partnerId: r.partnerId, shareBp: r.shareBp }));
    },
  );

  app.get(
    '/api/partners/ownership-integrity',
    { schema: { response: { 200: z.array(integrityViolationSchema) } } },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      return checkOwnershipIntegrity(db);
    },
  );

  app.patch(
    '/api/partners/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() }),
        response: { 200: partnerSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      const context = { actorId: actor.userId, terminalId: actor.terminalId };

      // Name and active state are separate operations with separate
      // audit entries — a rename is not a deactivation, and a caller
      // sending both gets both recorded.
      if (request.body.name !== undefined) {
        await renamePartner(db, request.params.id, request.body.name, context);
      }
      if (request.body.active !== undefined) {
        await setPartnerActive(db, request.params.id, request.body.active, context);
      }

      const record = await getPartnerRecord(db, request.params.id);
      if (!record) throw new Error(`partner ${request.params.id} not found`);
      return record.partner;
    },
  );

  /** A partner's own record: what they own today, and what they have
   * actually been credited — at the shares each sale was written at. */
  app.get(
    '/api/partners/:id/record',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
        response: {
          200: z.object({
            partner: partnerSchema,
            ownedItems: z.array(z.object({ itemId: z.number().int(), itemName: z.string(), shareBp: z.number().int() })),
            recentAllocations: z.array(
              z.object({
                orderId: z.number().int(),
                invoiceNo: z.number().int().nullable(),
                closedAt: z.string().nullable(),
                itemName: z.string(),
                qty: z.number().int(),
                shareBpSnapshot: z.number().int(),
                amountMinor: z.number().int(),
                isReversal: z.boolean(),
              }),
            ),
            totalAllocatedMinor: z.number().int(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      const record = await getPartnerRecord(db, request.params.id, { limit: request.query.limit });
      if (!record) {
        reply.code(404);
        return { error: `partner ${request.params.id} not found` };
      }
      return record;
    },
  );
};
