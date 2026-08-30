import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { catalogRoutes } from './catalog/routes.js';
import { resolveSession } from './identity/auth.js';
import { identityRoutes } from './identity/routes.js';
import type { Database } from './platform/db/types.js';

export interface BuildAppOptions {
  readonly db: Kysely<Database>;
  readonly logger?: boolean;
}

/**
 * Build (but do not start listening on) the Fastify app: one process
 * serving the JSON API and, once the frontend milestone lands, the built
 * PWA — see ARCHITECTURE.md for why there is only ever one server.
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Resolves a bearer token into request.actor for EVERY route below,
  // regardless of which module registers it — installed here, on the
  // root instance, before any route plugin, because a hook registered
  // inside a plugin only applies within that plugin's own encapsulation
  // (see identity/require-auth.ts).
  app.addHook('preHandler', async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const token = header.slice('Bearer '.length);
    const session = await resolveSession(opts.db, token);
    if (session) request.actor = session;
  });

  app.get(
    '/api/health',
    { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
    async () => ({ ok: true as const }),
  );

  await app.register(identityRoutes, { db: opts.db });
  await app.register(catalogRoutes, { db: opts.db });

  // TODO(frontend milestone): register @fastify/static against
  // apps/frontend/dist and fall through to index.html for client-side
  // routing on any path that isn't /api/*. Until the frontend exists
  // there is nothing to serve, so every non-API path 404s.

  return app;
}
