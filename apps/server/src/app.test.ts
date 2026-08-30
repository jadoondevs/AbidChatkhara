import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createUser } from './identity/service.js';
import { createTestDb } from './platform/db/test-helpers.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const server = await createUser(
    ctx.db,
    { name: 'Server', pin: '1234', role: 'server' },
    { actorId: admin.id, terminalId: 'seed' },
  );
  const app = await buildApp({ db: ctx.db, logger: false });
  return { ctx, app, admin, server };
}

describe('app', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('GET /api/health responds ok', async () => {
    ({ app, ctx } = await setup());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('logs in via the HTTP route and can call an authenticated route with the token', async () => {
    const started = await setup();
    ({ app, ctx } = started);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: started.server.id, pin: '1234', terminalId: 'till-1' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token, user } = loginRes.json() as { token: string; user: { id: number; name: string; role: string } };
    expect(user).toEqual({ id: started.server.id, name: 'Server', role: 'server' });

    const meRes = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toEqual({ id: started.server.id, name: 'Server', role: 'server' });
  });

  it('rejects login with the wrong PIN', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: started.server.id, pin: '0000', terminalId: 'till-1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    ({ app, ctx } = await setup());
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request whose role is below what the route requires', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: started.server.id, pin: '1234', terminalId: 'till-1' },
    });
    const { token } = loginRes.json() as { token: string };

    // /api/users requires at least manager; this user is a server.
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it('lets an admin create a user via the HTTP route', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: started.admin.id, pin: '9999', terminalId: 'till-1' },
    });
    const { token } = loginRes.json() as { token: string };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Ehsan', pin: '5555', role: 'cashier' },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json()).toMatchObject({ name: 'Ehsan', role: 'cashier', active: true });
  });

  it('rejects a malformed login body with a 400, not a 500', async () => {
    ({ app, ctx } = await setup());
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'not-a-number' } });
    expect(res.statusCode).toBe(400);
  });
});
