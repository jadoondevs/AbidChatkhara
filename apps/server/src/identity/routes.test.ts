import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { createUser } from './service.js';

async function login(app: FastifyInstance, username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, terminalId: 'till-1' } });
}

async function tokenFor(app: FastifyInstance, username: string, password: string): Promise<string> {
  return (await login(app, username, password)).json<{ token: string }>().token;
}

describe('identity routes — user and credential management', () => {
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
    const instance = await buildApp({ db: context.db, logger: false });
    return { ctx: context, app: instance, admin, manager };
  }

  it('signs a user in with a username and password', async () => {
    const started = await setup();
    ({ app, ctx } = started);

    const res = await login(app, 'admin', '9999');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: 'admin', role: 'admin' } });
  });

  it('rejects a wrong password and an unknown username identically', async () => {
    const started = await setup();
    ({ app, ctx } = started);

    const wrongPassword = await login(app, 'admin', 'not-the-one');
    const unknownUser = await login(app, 'nobody', '9999');
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
  });

  it('lets an admin create a user who can then sign in', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Sana Iqbal', username: 'sana', password: 'till-2026', role: 'cashier' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'sana', role: 'cashier', active: true });

    expect((await login(app, 'sana', 'till-2026')).statusCode).toBe(200);
  });

  it('never returns a credential hash in a user response', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Sana', username: 'sana', password: 'till-2026', role: 'cashier' },
    });
    expect(created.body).not.toContain('scrypt');
    expect(created.body).not.toContain('till-2026');

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: auth });
    expect(list.body).not.toContain('scrypt');
  });

  it('refuses a duplicate username with a 409 the admin can act on', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Another Admin', username: 'admin', password: '1234', role: 'cashier' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/already taken/);
  });

  it('treats a username as taken regardless of case', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Another Admin', username: 'ADMIN', password: '1234', role: 'cashier' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a username with characters a login form cannot round-trip', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Spacey', username: 'front desk', password: '1234', role: 'cashier' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets an admin reset a password, and the old one stops working', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const reset = await app.inject({
      method: 'PUT',
      url: `/api/users/${started.manager.id}/password`,
      headers: auth,
      payload: { password: 'brand-new-one' },
    });
    expect(reset.statusCode).toBe(200);

    expect((await login(app, 'manager', 'brand-new-one')).statusCode).toBe(200);
    expect((await login(app, 'manager', '2222')).statusCode).toBe(401);
  });

  it('records a password reset in the audit log without the password or its hash', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    await app.inject({
      method: 'PUT',
      url: `/api/users/${started.manager.id}/password`,
      headers: auth,
      payload: { password: 'brand-new-one' },
    });

    const entries = await started.ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'user.set_password').execute();
    expect(entries).toHaveLength(1);
    const serialised = JSON.stringify(entries[0]);
    expect(serialised).not.toContain('brand-new-one');
    expect(serialised).not.toContain('scrypt');
  });

  it('lets an admin rename a user and change their username', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${started.manager.id}`,
      headers: auth,
      payload: { name: 'Danish Raza', username: 'danish' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Danish Raza', username: 'danish' });

    expect((await login(app, 'danish', '2222')).statusCode).toBe(200);
    expect((await login(app, 'manager', '2222')).statusCode).toBe(401);
  });

  it('refuses to rename a user onto someone else’s username', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${started.manager.id}`,
      headers: auth,
      payload: { username: 'admin' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('allows a no-op username update on the same user', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${started.manager.id}`,
      headers: auth,
      payload: { username: 'manager', name: 'Still The Manager' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('deactivates a user, and a deactivated user cannot sign in', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    await app.inject({ method: 'PATCH', url: `/api/users/${started.manager.id}`, headers: auth, payload: { active: false } });
    const res = await login(app, 'manager', '2222');
    expect(res.statusCode).toBe(401);
  });

  it('refuses user management to a manager — this is admin-only', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'manager', '2222')}` };

    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Nope', username: 'nope', password: '1234', role: 'server' },
    });
    expect(create.statusCode).toBe(403);

    const reset = await app.inject({
      method: 'PUT',
      url: `/api/users/${started.admin.id}/password`,
      headers: auth,
      payload: { password: 'hijacked' },
    });
    expect(reset.statusCode).toBe(403);

    const rename = await app.inject({ method: 'PATCH', url: `/api/users/${started.admin.id}`, headers: auth, payload: { name: 'Nope' } });
    expect(rename.statusCode).toBe(403);
  });

  it('lets a manager LIST users, which the order screens need', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'manager', '2222')}` };

    const res = await app.inject({ method: 'GET', url: '/api/users', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown[]>()).toHaveLength(2);
  });

  it('rejects a password below the minimum length', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Short', username: 'short', password: '123', role: 'server' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a 4-digit PIN as a password, so existing credentials keep working', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const auth = { authorization: `Bearer ${await tokenFor(app, 'admin', '9999')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { name: 'Pin User', username: 'pinuser', password: '4321', role: 'server' },
    });
    expect(res.statusCode).toBe(201);
    expect((await login(app, 'pinuser', '4321')).statusCode).toBe(200);
  });
});
