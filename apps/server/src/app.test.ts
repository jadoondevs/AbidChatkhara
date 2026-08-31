import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createUser } from './identity/service.js';
import { createTestDb } from './platform/db/test-helpers.js';

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
      payload: { username: started.server.username, password: '1234', terminalId: 'till-1' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token, user } = loginRes.json() as { token: string; user: { id: number; name: string; username: string; role: string } };
    expect(user).toEqual({ id: started.server.id, name: 'Server', username: 'server', role: 'server' });

    const meRes = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toEqual({ id: started.server.id, name: 'Server', username: 'server', role: 'server' });
  });

  it('rejects login with the wrong password', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: started.server.username, password: '0000', terminalId: 'till-1' },
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
      payload: { username: started.server.username, password: '1234', terminalId: 'till-1' },
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
      payload: { username: started.admin.username, password: '9999', terminalId: 'till-1' },
    });
    const { token } = loginRes.json() as { token: string };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Ehsan', username: 'ehsan', password: '5555', role: 'cashier' },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json()).toMatchObject({ name: 'Ehsan', role: 'cashier', active: true });
  });

  it('rejects a malformed login body with a 400, not a 500', async () => {
    ({ app, ctx } = await setup());
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 42 } });
    expect(res.statusCode).toBe(400);
  });

  describe('serving the built PWA', () => {
    it('without a frontend build, every non-API path 404s and the API is unaffected', async () => {
      ({ app, ctx } = await setup());
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    });

    it('with a build, serves index.html at the root, falls back to it for client-side routes, and still 404s /api/* as JSON', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'pos-frontend-'));
      writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>POS</title>');
      writeFileSync(path.join(dir, 'app.js'), 'console.log("built asset");');

      const started = await setup();
      ctx = started.ctx;
      await started.app.close();
      app = await buildApp({ db: ctx.db, logger: false, frontendDir: dir });

      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('<title>POS</title>');

      // A real built asset is served as itself...
      expect((await app.inject({ method: 'GET', url: '/app.js' })).statusCode).toBe(200);

      // ...while a client-side route the server knows nothing about
      // falls back to the shell, so a reload on /orders/42/bill works.
      const deepLink = await app.inject({ method: 'GET', url: '/orders/42/bill' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain('<title>POS</title>');

      // But an unknown API path must stay a JSON 404 — never an HTML
      // page a fetch would choke on.
      const missingApi = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json()).toMatchObject({ error: expect.stringContaining('/api/nope') });

      rmSync(dir, { recursive: true, force: true });
    });
  });
});
