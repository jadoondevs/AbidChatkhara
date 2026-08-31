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
  const catalogActor = { actorId: admin.id, terminalId: 'seed' };
  const server = await createUser(ctx.db, { name: 'Server', username: 'server', password: '1234', role: 'server' }, catalogActor);
  const category = await createCategory(ctx.db, { name: 'Mains' }, catalogActor);
  const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, catalogActor);
  await setItemPrice(ctx.db, item.id, paisa(500_00), catalogActor);

  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server, item };
}

async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('partners routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('rejects a server from setting ownership, allows a manager', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const serverToken = await loginAs(app, started.server.username, '1234');
    const adminToken = await loginAs(app, started.admin.username, '9999');

    const createPartnerRes = await app.inject({
      method: 'POST',
      url: '/api/partners',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Alice' },
    });
    expect(createPartnerRes.statusCode).toBe(201);
    const partner = createPartnerRes.json() as { id: number };

    const deniedRes = await app.inject({
      method: 'PUT',
      url: `/api/items/${started.item.id}/ownership`,
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { split: [{ partnerId: partner.id, shareBp: 10_000 }] },
    });
    expect(deniedRes.statusCode).toBe(403);

    const allowedRes = await app.inject({
      method: 'PUT',
      url: `/api/items/${started.item.id}/ownership`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { split: [{ partnerId: partner.id, shareBp: 10_000 }] },
    });
    expect(allowedRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/items/${started.item.id}/ownership`,
      headers: { authorization: `Bearer ${serverToken}` }, // reads are open to any authenticated staff
    });
    expect(getRes.json()).toEqual([{ partnerId: partner.id, shareBp: 10_000 }]);
  });

  it('rejects a split that does not sum to 10000, with a 500 mapped from a thrown Error', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const adminToken = await loginAs(app, started.admin.username, '9999');
    const createPartnerRes = await app.inject({
      method: 'POST',
      url: '/api/partners',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Alice' },
    });
    const partner = createPartnerRes.json() as { id: number };

    const res = await app.inject({
      method: 'PUT',
      url: `/api/items/${started.item.id}/ownership`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { split: [{ partnerId: partner.id, shareBp: 5000 }] },
    });
    expect(res.statusCode).toBe(500); // no domain-specific error mapping here yet, unlike ordering's routes
  });
});
