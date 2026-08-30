import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const server = await createUser(ctx.db, { name: 'Server', pin: '1234', role: 'server' }, { actorId: admin.id, terminalId: 'seed' });
  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server };
}

async function loginAs(app: FastifyInstance, userId: number, pin: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId, pin, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('shifts routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('rejects a server from opening a shift, allows a cashier-or-above; open/close/Z-report/payout-sheet all work end to end', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const serverToken = await loginAs(app, started.server.id, '1234');
    const adminToken = await loginAs(app, started.admin.id, '9999');

    const deniedRes = await app.inject({
      method: 'POST',
      url: '/api/shifts',
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { openingCashMinor: 5_000_00 },
    });
    expect(deniedRes.statusCode).toBe(403);

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/shifts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { openingCashMinor: 5_000_00 },
    });
    expect(openRes.statusCode).toBe(201);
    const shift = openRes.json() as { id: number };

    const openShiftRes = await app.inject({ method: 'GET', url: '/api/shifts/open', headers: { authorization: `Bearer ${serverToken}` } });
    expect(openShiftRes.json()).toMatchObject({ id: shift.id });

    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/shifts/${shift.id}/close`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { countedCashMinor: 5_000_00 },
    });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.json()).toMatchObject({ varianceMinor: 0 });

    const zReportRes = await app.inject({ method: 'GET', url: `/api/shifts/${shift.id}/z-report`, headers: { authorization: `Bearer ${serverToken}` } });
    expect(zReportRes.json()).toMatchObject({ customerSalesMinor: 0, combinedSalesMinor: 0 });

    const payoutRes = await app.inject({ method: 'GET', url: `/api/shifts/${shift.id}/payout-sheet`, headers: { authorization: `Bearer ${serverToken}` } });
    expect(payoutRes.json()).toEqual([]);
  });

  it('refusing to close reports the blocking orders in the response body', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const adminToken = await loginAs(app, started.admin.id, '9999');

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/shifts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { openingCashMinor: 0 },
    });
    const shift = openRes.json() as { id: number };

    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { orderType: 'takeaway' },
    });

    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/shifts/${shift.id}/close`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { countedCashMinor: 0 },
    });
    expect(closeRes.statusCode).toBe(422);
    const body = closeRes.json() as { blockingOrders: { id: number; status: string }[] };
    expect(body.blockingOrders).toHaveLength(1);
    expect(body.blockingOrders[0]?.status).toBe('open');
  });
});
