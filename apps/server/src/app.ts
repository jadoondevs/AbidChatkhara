import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { billingRoutes } from './billing/routes.js';
import { catalogRoutes } from './catalog/routes.js';
import { consumptionRoutes } from './consumption/routes.js';
import { resolveSession } from './identity/auth.js';
import { identityRoutes } from './identity/routes.js';
import { orderingRoutes } from './ordering/routes.js';
import { partnersRoutes } from './partners/routes.js';
import type { Database } from './platform/db/types.js';
import type { PrinterTarget } from './platform/printing/client.js';
import { reportingRoutes } from './reporting/routes.js';
import { settingsRoutes } from './settings/routes.js';
import { shiftsRoutes } from './shifts/routes.js';
import { taxRoutes } from './tax/routes.js';

export interface BuildAppOptions {
  readonly db: Kysely<Database>;
  readonly logger?: boolean;
  /** The printer this server booted with (POS_PRINTER_HOST). Used only
   * as a fallback: an address configured in Settings wins, so an admin
   * can move the printer without touching the machine's environment —
   * see settings/service.ts's resolvePrinterTarget. null on both, and
   * print routes respond 503 instead of connecting anywhere. */
  readonly printer?: PrinterTarget | null;
  /** Absolute path to the built PWA (apps/frontend/dist). Omitted in
   * tests and whenever the frontend hasn't been built — the API then
   * serves itself and every non-API path 404s, which is exactly what a
   * server-only deployment or a `vite dev` session wants. */
  readonly frontendDir?: string | null;
}

/**
 * Build (but do not start listening on) the Fastify app: one process
 * serving both the JSON API and the built PWA over the restaurant's
 * local network — see ARCHITECTURE.md for why there is only ever one
 * server.
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
  await app.register(orderingRoutes, { db: opts.db });
  await app.register(partnersRoutes, { db: opts.db });
  await app.register(consumptionRoutes, { db: opts.db });
  await app.register(taxRoutes, { db: opts.db });
  await app.register(shiftsRoutes, { db: opts.db });
  await app.register(reportingRoutes, { db: opts.db });
  await app.register(settingsRoutes, { db: opts.db });
  await app.register(billingRoutes, { db: opts.db, printer: opts.printer ?? null });

  // The built PWA, served by this same process (spec: "a single process
  // serving both a JSON API and the built frontend over the local
  // network"). Registered LAST so no static file can ever shadow an API
  // route, and only when a build actually exists — a server-only
  // deployment, the test suite, and a `vite dev` session all run without
  // it and simply 404 every non-API path.
  if (opts.frontendDir) {
    await app.register(fastifyStatic, { root: opts.frontendDir, wildcard: false });

    // Client-side routing: any GET that isn't an API call and isn't a
    // real file falls through to index.html, so a reload on
    // /orders/42/bill works. Never for /api/*, which must keep
    // returning a real 404 rather than an HTML page a fetch can't parse.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: `route ${request.method} ${request.url} not found` });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
