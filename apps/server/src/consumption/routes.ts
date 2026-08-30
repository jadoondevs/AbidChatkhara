import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import { createPerson, listConsumptionRecords, listPersons, updatePerson } from './service.js';

const personKindSchema = z.enum(['staff', 'partner']);
const mealPolicySchema = z.enum(['free', 'discounted', 'full_price', 'payroll_deduction']);
const settlementTypeSchema = z.enum(['house_expense', 'payroll_deduction', 'partner_personal']);

const personSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: personKindSchema,
  active: z.boolean(),
  mealPolicy: mealPolicySchema,
  mealDiscountBp: z.number().int(),
});

const consumptionRecordSchema = z.object({
  id: z.number().int(),
  orderId: z.number().int(),
  personId: z.number().int(),
  personName: z.string(),
  policySnapshot: z.object({ mealPolicy: mealPolicySchema, mealDiscountBp: z.number().int() }),
  menuValueMinor: z.number().int(),
  chargedMinor: z.number().int(),
  settlementMinor: z.number().int(),
  settlementType: settlementTypeSchema.nullable(),
  createdAt: z.string(),
});

export interface ConsumptionPluginOptions {
  db: Kysely<Database>;
}

/** People config (spec screen 10) — staff and partners, with a meal
 * policy per person — plus the itemised consumption-record listing
 * behind the per-person report (spec: "provide a per-person consumption
 * report for any date range"). Creating and editing people is manager+,
 * same gating as partner config; reading either is any authenticated
 * user, since the staff-meal flow (ordering) needs the person list to
 * let the cashier "pick person first". */
export const consumptionRoutes: FastifyPluginAsync<ConsumptionPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/people',
    {
      schema: {
        querystring: z.object({ kind: personKindSchema.optional(), includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(personSchema) },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return listPersons(db, { kind: request.query.kind, includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/people',
    {
      schema: {
        body: z.object({
          name: z.string().min(1),
          kind: personKindSchema,
          mealPolicy: mealPolicySchema,
          mealDiscountBp: z.number().int().min(0).max(10_000).optional(),
        }),
        response: { 201: personSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      reply.code(201);
      return createPerson(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/people/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({
          name: z.string().min(1).optional(),
          active: z.boolean().optional(),
          mealPolicy: mealPolicySchema.optional(),
          mealDiscountBp: z.number().int().min(0).max(10_000).optional(),
        }),
        response: { 200: personSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'manager');
      return updatePerson(db, request.params.id, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.get(
    '/api/consumption-records',
    {
      schema: {
        querystring: z.object({
          personId: z.coerce.number().int().optional(),
          fromInclusive: z.string().optional(),
          toExclusive: z.string().optional(),
        }),
        response: { 200: z.array(consumptionRecordSchema) },
      },
    },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      return listConsumptionRecords(db, request.query);
    },
  );
};
