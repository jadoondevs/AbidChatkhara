import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import { createTaxRule, listTaxRules, updateTaxRule } from './service.js';

const orderTypeSchema = z.enum(['dine_in', 'takeaway', 'delivery']);

const taxRuleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  rateBp: z.number().int(),
  appliesToCategoryId: z.number().int().nullable(),
  appliesToOrderType: orderTypeSchema.nullable(),
  inclusive: z.boolean(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  active: z.boolean(),
});

export interface TaxPluginOptions {
  db: Kysely<Database>;
}

/** Tax rule config — no dedicated screen in the spec's 12-screen list
 * (the module ships disabled, "build the module and schema now"), so
 * this is reachable only via the API for now, gated the same as every
 * other config surface: manager+ to write, any authenticated user to
 * read. */
export const taxRoutes: FastifyPluginAsync<TaxPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/tax-rules',
    {
      schema: {
        querystring: z.object({ includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(taxRuleSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listTaxRules(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/tax-rules',
    {
      schema: {
        body: z.object({
          name: z.string().min(1),
          rateBp: z.number().int().min(0),
          appliesToCategoryId: z.number().int().optional(),
          appliesToOrderType: orderTypeSchema.optional(),
          inclusive: z.boolean().optional(),
          validFrom: z.string().optional(),
          validTo: z.string().optional(),
        }),
        response: { 201: taxRuleSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createTaxRule(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/tax-rules/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ name: z.string().min(1).optional(), active: z.boolean().optional(), validTo: z.string().optional() }),
        response: { 200: taxRuleSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return updateTaxRule(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );
};
