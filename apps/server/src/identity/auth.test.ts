import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../platform/db/test-helpers.js';
import { login, logout, resolveSession } from './auth.js';
import { createUser, setUserActive } from './service.js';

describe('identity/auth', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  it('logs in with the correct password and resolves the resulting token', async () => {
    ctx = createTestDb();
    const user = await createUser(ctx.db, { name: 'Ayesha', username: 'ayesha', password: '4821', role: 'cashier' }, { actorId: null, terminalId: 'seed' });

    const result = await login(ctx.db, { username: user.username, password: '4821', terminalId: 'till-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const session = await resolveSession(ctx.db, result.token);
    expect(session).toEqual({ userId: user.id, name: 'Ayesha', username: 'ayesha', role: 'cashier', terminalId: 'till-1' });
  });

  it('rejects the wrong password', async () => {
    ctx = createTestDb();
    const user = await createUser(ctx.db, { name: 'Ayesha', username: 'ayesha', password: '4821', role: 'cashier' }, { actorId: null, terminalId: 'seed' });
    const result = await login(ctx.db, { username: user.username, password: '0000', terminalId: 'till-1' });
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('rejects login for an unknown username', async () => {
    ctx = createTestDb();
    const result = await login(ctx.db, { username: 'nobody', password: '4821', terminalId: 'till-1' });
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('rejects login for a deactivated user', async () => {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '1111', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const user = await createUser(ctx.db, { name: 'Chand', username: 'chand', password: '4821', role: 'server' }, { actorId: admin.id, terminalId: 't1' });
    await setUserActive(ctx.db, user.id, false, { actorId: admin.id, terminalId: 't1' });

    const result = await login(ctx.db, { username: user.username, password: '4821', terminalId: 'till-1' });
    expect(result).toEqual({ ok: false, reason: 'inactive' });
  });

  it('resolveSession returns null for an unknown token', async () => {
    ctx = createTestDb();
    expect(await resolveSession(ctx.db, 'nonexistent-token')).toBeNull();
  });

  it('resolveSession returns null after logout', async () => {
    ctx = createTestDb();
    const user = await createUser(ctx.db, { name: 'Ayesha', username: 'ayesha', password: '4821', role: 'cashier' }, { actorId: null, terminalId: 'seed' });
    const result = await login(ctx.db, { username: user.username, password: '4821', terminalId: 'till-1' });
    if (!result.ok) throw new Error('unreachable');

    await logout(ctx.db, result.token);

    expect(await resolveSession(ctx.db, result.token)).toBeNull();
  });

  it('resolveSession returns null once a user is deactivated after login', async () => {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '1111', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const user = await createUser(ctx.db, { name: 'Chand', username: 'chand', password: '4821', role: 'server' }, { actorId: admin.id, terminalId: 't1' });
    const result = await login(ctx.db, { username: user.username, password: '4821', terminalId: 'till-1' });
    if (!result.ok) throw new Error('unreachable');

    await setUserActive(ctx.db, user.id, false, { actorId: admin.id, terminalId: 't1' });

    expect(await resolveSession(ctx.db, result.token)).toBeNull();
  });

  it('each login issues a distinct, unguessable token bound to its own terminal', async () => {
    ctx = createTestDb();
    const user = await createUser(ctx.db, { name: 'Ayesha', username: 'ayesha', password: '4821', role: 'cashier' }, { actorId: null, terminalId: 'seed' });

    const a = await login(ctx.db, { username: user.username, password: '4821', terminalId: 'till-1' });
    const b = await login(ctx.db, { username: user.username, password: '4821', terminalId: 'till-2' });
    if (!a.ok || !b.ok) throw new Error('unreachable');

    expect(a.token).not.toBe(b.token);
    expect((await resolveSession(ctx.db, a.token))?.terminalId).toBe('till-1');
    expect((await resolveSession(ctx.db, b.token))?.terminalId).toBe('till-2');
  });

  it('matches a username case-insensitively and ignores surrounding whitespace', async () => {
    ctx = createTestDb();
    await createUser(ctx.db, { name: 'Ayesha', username: 'ayesha', password: '4821', role: 'cashier' }, { actorId: null, terminalId: 'seed' });

    const result = await login(ctx.db, { username: '  AYESHA ', password: '4821', terminalId: 'till-1' });
    expect(result.ok).toBe(true);
  });

  it('gives the same answer for an unknown user as for a wrong password', async () => {
    ctx = createTestDb();
    await createUser(ctx.db, { name: 'Ayesha', username: 'ayesha', password: '4821', role: 'cashier' }, { actorId: null, terminalId: 'seed' });

    const unknownUser = await login(ctx.db, { username: 'nobody', password: '4821', terminalId: 'till-1' });
    const wrongPassword = await login(ctx.db, { username: 'ayesha', password: 'wrong-one', terminalId: 'till-1' });
    expect(unknownUser).toEqual(wrongPassword);
  });
});
