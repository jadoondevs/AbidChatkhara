import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { defaultsFor } from './schema.js';

async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('settings routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  async function setup() {
    const context = createTestDb();
    const admin = await createUser(
      context.db,
      { name: 'Admin', username: 'admin', password: '9999', role: 'admin' },
      { actorId: null, terminalId: 'seed' },
    );
    const seedActor = { actorId: admin.id, terminalId: 'seed' };
    const manager = await createUser(context.db, { name: 'Manager', username: 'manager', password: '2222', role: 'manager' }, seedActor);
    const server = await createUser(context.db, { name: 'Server', username: 'server', password: '1234', role: 'server' }, seedActor);
    const instance = await buildApp({ db: context.db, logger: false });
    return { ctx: context, app: instance, admin, manager, server };
  }

  it('lets an admin save and read back the restaurant details', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');

    const save = await app.inject({
      method: 'PUT',
      url: '/api/settings/restaurant',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...defaultsFor('restaurant'), name: 'Demo Karahi House', phone: '000-0000000' },
    });
    expect(save.statusCode).toBe(200);

    const read = await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${token}` } });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { restaurant: { name: string } }).restaurant.name).toBe('Demo Karahi House');
  });

  it('lets any signed-in user READ the restaurant and receipt settings', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.server.username, '1234');

    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('receipt');
  });

  it('never exposes the printer address through the general settings route', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.server.username, '1234');

    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).not.toHaveProperty('printer');
  });

  it('refuses a non-admin trying to WRITE settings', async () => {
    const started = await setup();
    ({ app, ctx } = started);

    for (const [user, password] of [
      [started.manager, '2222'],
      [started.server, '1234'],
    ] as const) {
      const token = await loginAs(app, user.username, password);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/restaurant',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...defaultsFor('restaurant'), name: 'Not allowed' },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('refuses a non-admin trying to read the printer configuration', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.manager.username, '2222');

    const res = await app.inject({ method: 'GET', url: '/api/settings/printer', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses settings requests with no session at all', async () => {
    ({ app, ctx } = await setup());
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/receipt', payload: defaultsFor('receipt') })).statusCode).toBe(401);
  });

  it('rejects a malformed settings body with a 400, not a 500', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/printer',
      headers: { authorization: `Bearer ${token}` },
      payload: { host: 'printer.local', port: 70_000, enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('persists receipt configuration across requests', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');
    const auth = { authorization: `Bearer ${token}` };

    await app.inject({
      method: 'PUT',
      url: '/api/settings/receipt',
      headers: auth,
      payload: { ...defaultsFor('receipt'), footerMessage: 'Shukriya!', showWaiter: false },
    });

    const read = await app.inject({ method: 'GET', url: '/api/settings', headers: auth });
    const receipt = (read.json() as { receipt: { footerMessage: string; showWaiter: boolean } }).receipt;
    expect(receipt.footerMessage).toBe('Shukriya!');
    expect(receipt.showWaiter).toBe(false);
  });

  it('persists printer configuration for an admin', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');
    const auth = { authorization: `Bearer ${token}` };

    await app.inject({ method: 'PUT', url: '/api/settings/printer', headers: auth, payload: { host: '10.0.0.50', port: 9100, enabled: true } });
    const read = await app.inject({ method: 'GET', url: '/api/settings/printer', headers: auth });
    expect(read.json()).toEqual({ host: '10.0.0.50', port: 9100, enabled: true });
  });
});
