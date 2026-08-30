import { paisa } from '@pos/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const catalogActor = { actorId: admin.id, terminalId: 'seed' };
  const server = await createUser(ctx.db, { name: 'Server', pin: '1234', role: 'server' }, catalogActor);

  const category = await createCategory(ctx.db, { name: 'Mains' }, catalogActor);
  const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, catalogActor);
  await setItemPrice(ctx.db, item.id, paisa(500_00), catalogActor);

  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server, item };
}

async function loginAs(app: FastifyInstance, userId: number, pin: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId, pin, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('ordering routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('rejects an unauthenticated request', async () => {
    ({ app, ctx } = await setup());
    const res = await app.inject({ method: 'POST', url: '/api/orders', payload: { orderType: 'takeaway' } });
    expect(res.statusCode).toBe(401);
  });

  it('drives a full open -> add line -> bill flow over HTTP, then reprints identically', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.server.id, '1234');
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    expect(createRes.statusCode).toBe(201);
    const order = createRes.json() as { id: number };

    const addLineRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines`,
      headers: auth,
      payload: { itemId: started.item.id, qty: 2 },
    });
    expect(addLineRes.statusCode).toBe(200);
    expect(addLineRes.json()).toMatchObject({ subtotalMinor: 1_000_00 });

    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: auth, payload: {} });
    expect(billRes.statusCode).toBe(200);
    expect(billRes.json()).toMatchObject({ status: 'billed', totalMinor: 1_000_00 });

    // Reprinting: GET returns the same stored totals, no state change.
    const getRes = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: auth });
    expect(getRes.json()).toMatchObject({ status: 'billed', totalMinor: 1_000_00 });
  });

  it('rejects a line void from a server, allows it from a manager', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const serverToken = await loginAs(app, started.server.id, '1234');
    const adminToken = await loginAs(app, started.admin.id, '9999');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { orderType: 'takeaway' },
    });
    const order = createRes.json() as { id: number };
    const addLineRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines`,
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { itemId: started.item.id, qty: 1 },
    });
    const lineId = (addLineRes.json() as { lines: { id: number }[] }).lines[0]!.id;

    const deniedRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines/${lineId}/void`,
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { reason: 'mistake' },
    });
    expect(deniedRes.statusCode).toBe(403);

    const allowedRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines/${lineId}/void`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: 'mistake' },
    });
    expect(allowedRes.statusCode).toBe(200);
    expect(allowedRes.json()).toMatchObject({ subtotalMinor: 0 });
  });

  it('maps an invalid state transition to 422, not a generic 500', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.id, '9999');
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const order = createRes.json() as { id: number };

    // No lines yet — billing must fail cleanly.
    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: auth, payload: {} });
    expect(billRes.statusCode).toBe(422);
    expect(billRes.json()).toMatchObject({ error: expect.stringContaining('no items to bill') });
  });

  it('lists orders filtered by status via the floor view query', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.id, '9999');
    const auth = { authorization: `Bearer ${token}` };

    await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const res = await app.inject({ method: 'GET', url: '/api/orders?status=open', headers: auth });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(1);
  });
});
