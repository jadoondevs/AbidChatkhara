import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import { createRider, listRiders, renameRider, setRiderActive } from './service.js';

const riderSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
});

export interface RidersPluginOptions {
  db: Kysely<Database>;
}

/** Delivery riders. Reading the list is open to any signed-in user — the
 * new-order dialog needs it to fill the rider picker, exactly as it reads
 * the waiter roster — while creating/renaming/retiring a rider is a
 * manager action and audited. */
export const ridersRoutes: FastifyPluginAsync<RidersPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/riders',
    { schema: { querystring: z.object({ includeInactive: z.coerce.boolean().optional() }), response: { 200: z.array(riderSchema) } } },
    async (request, reply) => {
      requireAuth(request, reply);
      return listRiders(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post('/api/riders', { schema: { body: z.object({ name: z.string().min(1) }), response: { 201: riderSchema } } }, async (request, reply) => {
    const actor = requireRole(request, reply, 'manager');
    reply.code(201);
    return createRider(db, request.body.name, { actorId: actor.userId, terminalId: actor.terminalId });
  });

  app.patch(
    '/api/riders/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ name: z.string().min(1) }), response: { 200: riderSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return renameRider(db, request.params.id, request.body.name, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/riders/:id/active',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ active: z.boolean() }), response: { 200: riderSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return setRiderActive(db, request.params.id, request.body.active, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );
};
