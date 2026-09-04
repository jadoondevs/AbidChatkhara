import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const server = await createUser(
    ctx.db,
    { name: 'Server', username: 'server', password: '1234', role: 'server' },
    { actorId: admin.id, terminalId: 'seed' },
  );
  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server };
}

async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('catalog routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('rejects an unauthenticated request', async () => {
    ({ app, ctx } = await setup());
    const res = await app.inject({ method: 'GET', url: '/api/categories' });
    expect(res.statusCode).toBe(401);
  });

  it('lets any authenticated staff read the menu, but only a manager+ create a category', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const serverToken = await loginAs(app, started.server.username, '1234');

    const readRes = await app.inject({ method: 'GET', url: '/api/categories', headers: { authorization: `Bearer ${serverToken}` } });
    expect(readRes.statusCode).toBe(200);

    const writeRes = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { name: 'Mains' },
    });
    expect(writeRes.statusCode).toBe(403);
  });

  it('drives a full create-category -> create-item -> set-price -> menu flow over HTTP', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');
    const auth = { authorization: `Bearer ${token}` };

    const categoryRes = await app.inject({ method: 'POST', url: '/api/categories', headers: auth, payload: { name: 'Mains' } });
    expect(categoryRes.statusCode).toBe(201);
    const category = categoryRes.json() as { id: number };

    const itemRes = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: auth,
      payload: { categoryId: category.id, name: 'Chicken Karahi' },
    });
    expect(itemRes.statusCode).toBe(201);
    const item = itemRes.json() as { id: number };

    const priceRes = await app.inject({
      method: 'POST',
      url: `/api/items/${item.id}/price`,
      headers: auth,
      payload: { priceMinor: 85000 },
    });
    expect(priceRes.statusCode).toBe(201);

    const menuRes = await app.inject({ method: 'GET', url: `/api/menu?categoryId=${category.id}`, headers: auth });
    expect(menuRes.statusCode).toBe(200);
    expect(menuRes.json()).toEqual([
      { id: item.id, categoryId: category.id, name: 'Chicken Karahi', active: true, priceMinor: 85000, available: true, modifierGroupIds: [] },
    ]);
  });
});
