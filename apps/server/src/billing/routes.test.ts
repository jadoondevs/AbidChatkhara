import { paisa } from '@pos/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const catalogActor = { actorId: admin.id, terminalId: 'seed' };
  const server = await createUser(ctx.db, { name: 'Server', pin: '1234', role: 'server' }, catalogActor);
  const category = await createCategory(ctx.db, { name: 'Mains' }, catalogActor);
  const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, catalogActor);
  await setItemPrice(ctx.db, item.id, paisa(500_00), catalogActor);

  // Closing an order allocates it to its owning partner(s) — an item
  // with no ownership configured has nowhere for a non-zero sale to go,
  // so every HTTP test here that closes an order needs one, same as
  // billing/service.test.ts's fixture.
  const partner = await createPartner(ctx.db, 'Alice', catalogActor);
  await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], catalogActor);

  const app = await buildApp({ db: ctx.db, logger: false, printer: null });
  return { ctx, app, admin, server, item, partner };
}

async function loginAs(app: FastifyInstance, userId: number, pin: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId, pin, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('billing routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('drives a full order -> bill -> pay -> closed flow over HTTP', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.id, '9999');
    const auth = { authorization: `Bearer ${token}` };

    const methodRes = await app.inject({ method: 'POST', url: '/api/payment-methods', headers: auth, payload: { code: 'cash', displayName: 'Cash', kind: 'cash' } });
    expect(methodRes.statusCode).toBe(201);
    const method = methodRes.json() as { id: number };

    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth, payload: { itemId: started.item.id, qty: 1 } });
    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: auth, payload: {} });
    const billed = billRes.json() as { totalMinor: number };

    const payRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/payments`,
      headers: auth,
      payload: { paymentMethodId: method.id, amountMinor: billed.totalMinor },
    });
    expect(payRes.statusCode).toBe(201);
    const paid = payRes.json() as { orderClosed: boolean; order: { status: string; invoiceNo: number } };
    expect(paid.orderClosed).toBe(true);
    expect(paid.order).toMatchObject({ status: 'closed', invoiceNo: 1 });
  });

  it('maps a double-close attempt to a clean 422, not a 500', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.id, '9999');
    const auth = { authorization: `Bearer ${token}` };

    const methodRes = await app.inject({ method: 'POST', url: '/api/payment-methods', headers: auth, payload: { code: 'cash', displayName: 'Cash', kind: 'cash' } });
    const method = methodRes.json() as { id: number };
    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth, payload: { itemId: started.item.id, qty: 1 } });
    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: auth, payload: {} });
    const billed = billRes.json() as { totalMinor: number };

    const payload = { paymentMethodId: method.id, amountMinor: billed.totalMinor };
    const first = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: auth, payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: auth, payload });
    expect(second.statusCode).toBe(422);
    expect(second.json()).toMatchObject({ error: expect.stringContaining('already settled') });
  });

  it('rejects a refund from a server, allows one from a manager', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const adminToken = await loginAs(app, started.admin.id, '9999');
    const serverToken = await loginAs(app, started.server.id, '1234');
    const authAdmin = { authorization: `Bearer ${adminToken}` };

    const methodRes = await app.inject({ method: 'POST', url: '/api/payment-methods', headers: authAdmin, payload: { code: 'cash', displayName: 'Cash', kind: 'cash' } });
    const method = methodRes.json() as { id: number };
    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: authAdmin, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/lines`, headers: authAdmin, payload: { itemId: started.item.id, qty: 1 } });
    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: authAdmin, payload: {} });
    const billed = billRes.json() as { totalMinor: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: authAdmin, payload: { paymentMethodId: method.id, amountMinor: billed.totalMinor } });

    const denied = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { reason: 'x' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/refund`, headers: authAdmin, payload: { reason: 'x' } });
    expect(allowed.statusCode).toBe(200);
  });

  it('print routes respond 503 when no printer is configured', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.id, '9999');
    const auth = { authorization: `Bearer ${token}` };
    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };

    const res = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/print-bill`, headers: auth });
    expect(res.statusCode).toBe(503);
  });
});
