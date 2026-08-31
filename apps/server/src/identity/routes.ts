import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../platform/db/types.js';
import { login, logout } from './auth.js';
import { requireAuth, requireRole } from './require-auth.js';
import {
  changeUserRole,
  createUser,
  listUsers,
  setUserActive,
  setUserPassword,
  updateUser,
  UsernameTakenError,
} from './service.js';
import { MAX_SECRET_LENGTH, MIN_SECRET_LENGTH } from './credentials.js';

const roleSchema = z.enum(['server', 'cashier', 'manager', 'admin']);

const userSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  username: z.string(),
  role: roleSchema,
  active: z.boolean(),
});

const usernameSchema = z.string().min(3).max(32);
const passwordSchema = z.string().min(MIN_SECRET_LENGTH).max(MAX_SECRET_LENGTH);

const errorSchema = z.object({ error: z.string() });

export interface IdentityPluginOptions {
  db: Kysely<Database>;
}

/**
 * Auth and user-management routes. The bearer-token-to-actor preHandler
 * that these rely on (`request.actor`) is installed once, globally, in
 * app.ts — not here — so every module's routes get it, not just these.
 */
export const identityRoutes: FastifyPluginAsync<IdentityPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // A taken username is a 409 the admin can act on, not a 500. Every
  // other domain rule here (a bad username shape, too short a password)
  // is a plain Error from the service and stays a 400-family failure
  // carrying its own sentence.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UsernameTakenError) {
      reply.code(409).send({ error: error.message });
      return;
    }
    throw error;
  });

  app.post(
    '/api/auth/login',
    {
      schema: {
        body: z.object({
          username: usernameSchema,
          password: passwordSchema,
          terminalId: z.string().min(1),
        }),
        response: {
          200: z.object({ token: z.string(), user: userSummarySchema.omit({ active: true }) }),
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await login(db, request.body);
      if (!result.ok) {
        reply.code(401);
        return { error: result.reason };
      }
      return {
        token: result.token,
        user: {
          id: result.session.userId,
          name: result.session.name,
          username: result.session.username,
          role: result.session.role,
        },
      };
    },
  );

  app.post(
    '/api/auth/logout',
    { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (request, reply) => {
      requireAuth(request, reply);
      const token = (request.headers.authorization as string).slice('Bearer '.length);
      await logout(db, token);
      return { ok: true as const };
    },
  );

  app.get(
    '/api/auth/me',
    { schema: { response: { 200: userSummarySchema.omit({ active: true }) } } },
    async (request, reply) => {
      const actor = requireAuth(request, reply);
      return { id: actor.userId, name: actor.name, username: actor.username, role: actor.role };
    },
  );

  app.get(
    '/api/users',
    {
      schema: {
        querystring: z.object({ includeInactive: z.coerce.boolean().optional() }),
        response: { 200: z.array(userSummarySchema) },
      },
    },
    async (request, reply) => {
      requireRole(request, reply, 'manager');
      return listUsers(db, { includeInactive: request.query.includeInactive });
    },
  );

  app.post(
    '/api/users',
    {
      schema: {
        body: z.object({
          name: z.string().min(1),
          username: usernameSchema,
          password: passwordSchema,
          role: roleSchema,
        }),
        response: { 201: userSummarySchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      reply.code(201);
      return createUser(db, request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.patch(
    '/api/users/:id/active',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ active: z.boolean() }),
        response: { 200: userSummarySchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      return setUserActive(db, request.params.id, request.body.active, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  app.patch(
    '/api/users/:id/role',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ role: roleSchema }),
        response: { 200: userSummarySchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      return changeUserRole(db, request.params.id, request.body.role, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  app.patch(
    '/api/users/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({
          name: z.string().min(1).optional(),
          username: usernameSchema.optional(),
          role: roleSchema.optional(),
          active: z.boolean().optional(),
        }),
        response: { 200: userSummarySchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      return updateUser(db, request.params.id, request.body, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );

  app.put(
    '/api/users/:id/password',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ password: passwordSchema }),
        response: { 200: userSummarySchema },
      },
    },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      return setUserPassword(db, request.params.id, request.body.password, {
        actorId: actor.userId,
        terminalId: actor.terminalId,
      });
    },
  );
};
