import { paisa } from '@pos/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const seedActor = { actorId: admin.id, terminalId: 'seed' };
  const server = await createUser(ctx.db, { name: 'Server', username: 'server', password: '1234', role: 'server' }, seedActor);
  const category = await createCategory(ctx.db, { name: 'Mains' }, seedActor);
  const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, seedActor);
  await setItemPrice(ctx.db, item.id, paisa(500_00), seedActor);

  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server, category };
}

async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('tax routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('rejects a server from creating a rule, allows a manager; reads are open to any authenticated staff', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const serverToken = await loginAs(app, started.server.username, '1234');
    const adminToken = await loginAs(app, started.admin.username, '9999');

    const deniedRes = await app.inject({
      method: 'POST',
      url: '/api/tax-rules',
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { name: 'GST', rateBp: 1_600, appliesToCategoryId: started.category.id },
    });
    expect(deniedRes.statusCode).toBe(403);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tax-rules',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'GST', rateBp: 1_600, appliesToCategoryId: started.category.id },
    });
    expect(createRes.statusCode).toBe(201);

    const listRes = await app.inject({ method: 'GET', url: '/api/tax-rules', headers: { authorization: `Bearer ${serverToken}` } });
    expect(listRes.json()).toMatchObject([{ name: 'GST', rateBp: 1_600, active: true }]);
  });
});
