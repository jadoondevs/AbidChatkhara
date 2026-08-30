import { paisa } from '@pos/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createPaymentMethod, recordPayment } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const server = await createUser(ctx.db, { name: 'Server', pin: '1234', role: 'server' }, { actorId: admin.id, terminalId: 'seed' });
  const seedActor = { actorId: admin.id, terminalId: 'seed' };

  const category = await createCategory(ctx.db, { name: 'Mains' }, seedActor);
  const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, seedActor);
  await setItemPrice(ctx.db, item.id, paisa(1000_00), seedActor);
  const partner = await createPartner(ctx.db, 'Alice', seedActor);
  await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], seedActor);
  const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, seedActor);

  const order = await createOrder(ctx.db, { orderType: 'takeaway' }, seedActor);
  await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, seedActor);
  const billed = await billOrder(ctx.db, order.id, {}, seedActor);
  await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, seedActor);

  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server, item, partner };
}

async function loginAs(app: FastifyInstance, userId: number, pin: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId, pin, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('reporting routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('rejects a server (manager+ only) and returns JSON for a manager', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const serverToken = await loginAs(app, started.server.id, '1234');
    const adminToken = await loginAs(app, started.admin.id, '9999');

    const deniedRes = await app.inject({ method: 'GET', url: '/api/reports/daily-sales', headers: { authorization: `Bearer ${serverToken}` } });
    expect(deniedRes.statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: '/api/reports/daily-sales', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ customerSalesMinor: 1000_00 });
  });

  it('exports the same report as CSV when format=csv', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const adminToken = await loginAs(app, started.admin.id, '9999');

    const res = await app.inject({ method: 'GET', url: '/api/reports/daily-sales?format=csv', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('customerSalesMinor');
    expect(res.body).toContain('100000'); // Rs 1000 in paisa
  });

  it('the partner statement route, list-shaped reports, and CSV export all work end to end', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const adminToken = await loginAs(app, started.admin.id, '9999');

    const statementRes = await app.inject({
      method: 'GET',
      url: `/api/reports/partners/${started.partner.id}/statement`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(statementRes.json()).toMatchObject({ partnerName: 'Alice', totalAllocatedMinor: 1000_00, reconciliation: { varianceMinor: 0 } });

    const itemMixRes = await app.inject({ method: 'GET', url: '/api/reports/item-mix', headers: { authorization: `Bearer ${adminToken}` } });
    expect(itemMixRes.json()).toMatchObject([{ itemName: 'Karahi', qty: 1 }]);

    const itemMixCsvRes = await app.inject({ method: 'GET', url: '/api/reports/item-mix?format=csv', headers: { authorization: `Bearer ${adminToken}` } });
    expect(itemMixCsvRes.headers['content-type']).toContain('text/csv');
    expect(itemMixCsvRes.body).toContain('Karahi');

    const voidReportRes = await app.inject({ method: 'GET', url: '/api/reports/void-and-discount', headers: { authorization: `Bearer ${adminToken}` } });
    expect(voidReportRes.json()).toEqual([]);
  });
});
