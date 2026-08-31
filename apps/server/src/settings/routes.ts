import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireAuth, requireRole } from '../identity/require-auth.js';
import type { Database } from '../platform/db/types.js';
import { printerSettingsSchema, receiptSettingsSchema, restaurantSettingsSchema } from './schema.js';
import { getAllSettings, getSetting, saveSetting } from './service.js';

export interface SettingsPluginOptions {
  db: Kysely<Database>;
}

/**
 * Reading settings is open to any signed-in user: the restaurant's own
 * name and receipt wording are on every bill the staff already print,
 * and the order screens need them to show a header. Writing is
 * admin-only, and the printer group is admin-only to READ as well — a
 * network address is infrastructure, not something a waiter's tablet
 * needs or should display.
 */
export const settingsRoutes: FastifyPluginAsync<SettingsPluginOptions> = async (fastify, { db }) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/settings',
    {
      schema: {
        response: {
          200: z.object({ restaurant: restaurantSettingsSchema, receipt: receiptSettingsSchema }),
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const all = await getAllSettings(db);
      // Deliberately not the printer group — see the note above.
      return { restaurant: all.restaurant, receipt: all.receipt };
    },
  );

  app.get(
    '/api/settings/printer',
    { schema: { response: { 200: printerSettingsSchema } } },
    async (request, reply) => {
      requireRole(request, reply, 'admin');
      return getSetting(db, 'printer');
    },
  );

  app.put(
    '/api/settings/restaurant',
    { schema: { body: restaurantSettingsSchema, response: { 200: restaurantSettingsSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      return saveSetting(db, 'restaurant', request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.put(
    '/api/settings/receipt',
    { schema: { body: receiptSettingsSchema, response: { 200: receiptSettingsSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      return saveSetting(db, 'receipt', request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );

  app.put(
    '/api/settings/printer',
    { schema: { body: printerSettingsSchema, response: { 200: printerSettingsSchema } } },
    async (request, reply) => {
      const actor = requireRole(request, reply, 'admin');
      return saveSetting(db, 'printer', request.body, { actorId: actor.userId, terminalId: actor.terminalId });
    },
  );
};
