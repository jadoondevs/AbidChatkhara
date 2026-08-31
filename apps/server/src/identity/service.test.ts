import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../platform/db/test-helpers.js';
import { changeUserRole, createUser, getUser, listUsers, setUserActive } from './service.js';

describe('identity/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  it('creates a user and records an audit entry with no actor (system bootstrap)', async () => {
    ctx = createTestDb();
    const admin = await createUser(
      ctx.db,
      { name: 'Ayesha', username: 'ayesha', password: '1234', role: 'admin' },
      { actorId: null, terminalId: 'seed' },
    );
    expect(admin).toMatchObject({ name: 'Ayesha', role: 'admin', active: true });

    const audit = await ctx.db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow();
    expect(audit.actor_id).toBeNull();
    expect(audit.action).toBe('user.create');
    expect(audit.entity).toBe('user');
    expect(audit.entity_id).toBe(String(admin.id));
  });

  it('lists only active users by default, all users with includeInactive', async () => {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '1111', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 't1' };
    const server = await createUser(ctx.db, { name: 'Bilal', username: 'bilal', password: '2222', role: 'server' }, actor);
    await setUserActive(ctx.db, server.id, false, actor);

    const active = await listUsers(ctx.db);
    expect(active.map((u) => u.name).sort()).toEqual(['Admin']);

    const all = await listUsers(ctx.db, { includeInactive: true });
    expect(all.map((u) => u.name).sort()).toEqual(['Admin', 'Bilal']);
  });

  it('setUserActive records before/after and toggles active', async () => {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '1111', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 't1' };
    const server = await createUser(ctx.db, { name: 'Chand', username: 'chand', password: '3333', role: 'server' }, actor);

    const deactivated = await setUserActive(ctx.db, server.id, false, actor);
    expect(deactivated.active).toBe(false);

    const audit = await ctx.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'user.deactivate')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(audit.before_json ?? '{}')).toMatchObject({ active: true });
    expect(JSON.parse(audit.after_json ?? '{}')).toMatchObject({ active: false });
  });

  it('changeUserRole updates the role and records the change', async () => {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '1111', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 't1' };
    const server = await createUser(ctx.db, { name: 'Dilshad', username: 'dilshad', password: '4444', role: 'server' }, actor);

    const promoted = await changeUserRole(ctx.db, server.id, 'cashier', actor);
    expect(promoted.role).toBe('cashier');

    const fetched = await getUser(ctx.db, server.id);
    expect(fetched?.role).toBe('cashier');
  });

  it('setUserActive throws for an unknown user', async () => {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '1111', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    await expect(setUserActive(ctx.db, 9999, false, { actorId: admin.id, terminalId: 't1' })).rejects.toThrow(/not found/);
  });
});
