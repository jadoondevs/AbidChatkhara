import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Session } from './auth.js';
import { hasAtLeastRole, type Role } from './roles.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the app-level auth preHandler (see app.ts) once the bearer
     * token resolves to a live session. Registered on the root app
     * instance, before any route plugin, so every module's routes get it
     * — a hook registered inside one plugin would only apply within that
     * plugin's own encapsulation, not to sibling plugins like catalog. */
    actor?: Session;
  }
}

/** Require a logged-in actor, or reply 401 and abort the handler. */
export function requireAuth(request: FastifyRequest, reply: FastifyReply): Session {
  if (!request.actor) {
    reply.code(401);
    throw new Error('unauthorized');
  }
  return request.actor;
}

/** Require a logged-in actor with at least `minimum` role, or reply 401/403 and abort. */
export function requireRole(request: FastifyRequest, reply: FastifyReply, minimum: Role): Session {
  const actor = requireAuth(request, reply);
  if (!hasAtLeastRole(actor.role, minimum)) {
    reply.code(403);
    throw new Error('forbidden');
  }
  return actor;
}
