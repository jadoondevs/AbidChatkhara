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
  const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const seedActor = { actorId: admin.id, terminalId: 'seed' };
  const server = await createUser(ctx.db, { name: 'Server', username: 'server', password: '1234', role: 'server' }, seedActor);

  const category = await createCategory(ctx.db, { name: 'Mains' }, seedActor);
  const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, seedActor);
  await setItemPrice(ctx.db, item.id, paisa(1000_00), seedActor);
  const partner = await createPartner(ctx.db, 'Alice', seedActor);
  await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], seedActor);

  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server, item };
}

async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('consumption routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('rejects a server from creating a person, allows a manager; reads are open to any authenticated staff', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const serverToken = await loginAs(app, started.server.username, '1234');
    const adminToken = await loginAs(app, started.admin.username, '9999');

    const deniedRes = await app.inject({
      method: 'POST',
      url: '/api/people',
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { name: 'Bilal', kind: 'staff', mealPolicy: 'free' },
    });
    expect(deniedRes.statusCode).toBe(403);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/people',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Bilal', kind: 'staff', mealPolicy: 'free' },
    });
    expect(createRes.statusCode).toBe(201);

    const listRes = await app.inject({ method: 'GET', url: '/api/people', headers: { authorization: `Bearer ${serverToken}` } });
    expect(listRes.json()).toMatchObject([{ name: 'Bilal', kind: 'staff', mealPolicy: 'free' }]);
  });

  it('the full staff-meal flow: create order with a beneficiary, bill, settle via the payment route, appears in consumption-records', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const adminToken = await loginAs(app, started.admin.username, '9999');

    const personRes = await app.inject({
      method: 'POST',
      url: '/api/people',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Bilal', kind: 'staff', mealPolicy: 'discounted', mealDiscountBp: 5_000 },
    });
    const person = personRes.json() as { id: number };

    const orderRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id },
    });
    expect(orderRes.statusCode).toBe(201);
    const order = orderRes.json() as { id: number };

    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { itemId: started.item.id, qty: 1 },
    });
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });

    const cashMethodRes = await app.inject({
      method: 'POST',
      url: '/api/payment-methods',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { code: 'cash', displayName: 'Cash', kind: 'cash' },
    });
    const cash = cashMethodRes.json() as { id: number };

    const settleRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/settle-consumption`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { paymentMethodId: cash.id, settlementType: 'house_expense' },
    });
    expect(settleRes.statusCode).toBe(201);
    const result = settleRes.json() as { payment: { amountMinor: number } | null; order: { status: string }; invoiceNo: number };
    expect(result.order.status).toBe('closed');
    expect(result.payment?.amountMinor).toBe(500_00); // 50% of Rs 1000

    const recordsRes = await app.inject({
      method: 'GET',
      url: '/api/consumption-records',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(recordsRes.json()).toMatchObject([{ personId: person.id, chargedMinor: 500_00, settlementMinor: 500_00 }]);
  });
});
