import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { defaultsFor } from './schema.js';
import { getAllSettings, getSetting, resolvePrinterTarget, saveSetting } from './service.js';

describe('settings/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(
      ctx.db,
      { name: 'Admin', username: 'admin', password: '9999', role: 'admin' },
      { actorId: null, terminalId: 'seed' },
    );
    return { actor: { actorId: admin.id, terminalId: 'till-1' } };
  }

  it('returns defaults for a group that has never been saved', async () => {
    await setup();
    expect(await getSetting(ctx.db, 'restaurant')).toEqual(defaultsFor('restaurant'));
    expect(await getSetting(ctx.db, 'receipt')).toEqual(defaultsFor('receipt'));
  });

  it('ships with no restaurant identity of its own', async () => {
    await setup();
    const restaurant = await getSetting(ctx.db, 'restaurant');
    expect(restaurant.name).toBe('');
    expect(restaurant.addressLine1).toBe('');
    expect(restaurant.phone).toBe('');
  });

  it('round-trips a saved group', async () => {
    const { actor } = await setup();
    const saved = await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: 'Demo Karahi House', phone: '000-0000000' }, actor);
    expect(saved.name).toBe('Demo Karahi House');
    expect(await getSetting(ctx.db, 'restaurant')).toEqual(saved);
  });

  it('overwrites rather than accumulating rows on a second save', async () => {
    const { actor } = await setup();
    await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: 'First' }, actor);
    await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: 'Second' }, actor);

    const rows = await ctx.db.selectFrom('app_setting').selectAll().where('key', '=', 'restaurant').execute();
    expect(rows).toHaveLength(1);
    expect((await getSetting(ctx.db, 'restaurant')).name).toBe('Second');
  });

  it('fills in missing fields from the defaults, so adding a setting does not invalidate a saved one', async () => {
    const { actor } = await setup();
    await saveSetting(ctx.db, 'receipt', defaultsFor('receipt'), actor);
    // Simulate an older saved document that predates several fields.
    await ctx.db
      .updateTable('app_setting')
      .set({ value_json: JSON.stringify({ footerMessage: 'Shukriya' }) })
      .where('key', '=', 'receipt')
      .execute();

    const receipt = await getSetting(ctx.db, 'receipt');
    expect(receipt.footerMessage).toBe('Shukriya');
    expect(receipt.showAddress).toBe(defaultsFor('receipt').showAddress);
    expect(receipt.feedLines).toBe(defaultsFor('receipt').feedLines);
  });

  it('falls back to defaults rather than throwing when the stored value is corrupt', async () => {
    const { actor } = await setup();
    await saveSetting(ctx.db, 'receipt', defaultsFor('receipt'), actor);
    await ctx.db.updateTable('app_setting').set({ value_json: 'not json at all' }).where('key', '=', 'receipt').execute();

    // A settings read is on the path of every print — it must never be
    // the thing that fails one.
    expect(await getSetting(ctx.db, 'receipt')).toEqual(defaultsFor('receipt'));
  });

  it('falls back to defaults when a stored field has the wrong type', async () => {
    const { actor } = await setup();
    await saveSetting(ctx.db, 'printer', defaultsFor('printer'), actor);
    await ctx.db.updateTable('app_setting').set({ value_json: JSON.stringify({ port: 'nine thousand' }) }).where('key', '=', 'printer').execute();

    expect(await getSetting(ctx.db, 'printer')).toEqual(defaultsFor('printer'));
  });

  it('rejects a value that fails its schema at the boundary', async () => {
    const { actor } = await setup();
    await expect(saveSetting(ctx.db, 'printer', { host: 'printer.local', port: 70_000, enabled: true }, actor)).rejects.toThrow();
    await expect(saveSetting(ctx.db, 'restaurant', { name: 'x'.repeat(200) }, actor)).rejects.toThrow();
  });

  it('audits every save with the previous value', async () => {
    const { actor } = await setup();
    await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: 'First' }, actor);
    await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: 'Second' }, actor);

    const entries = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'setting.save').orderBy('id', 'asc').execute();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.actor_id).toBe(actor.actorId);
    expect(JSON.parse(entries[1]?.before_json as string)).toMatchObject({ name: 'First' });
    expect(JSON.parse(entries[1]?.after_json as string)).toMatchObject({ name: 'Second' });
  });

  it('reads every group at once', async () => {
    const { actor } = await setup();
    await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: 'Demo Karahi House' }, actor);
    const all = await getAllSettings(ctx.db);
    expect(all.restaurant.name).toBe('Demo Karahi House');
    expect(all.receipt).toEqual(defaultsFor('receipt'));
    expect(all.printer).toEqual(defaultsFor('printer'));
  });
});

describe('resolvePrinterTarget', () => {
  const env = { host: '10.0.0.9', port: 9100 };
  /** Density plays no part in resolving WHERE to print. */
  const printer = (over: { host: string; port?: number; enabled?: boolean }) => ({
    port: 9100,
    enabled: true,
    densityLevel: 5,
    ...over,
  });

  it('prefers a printer configured in Settings over the environment', () => {
    expect(resolvePrinterTarget(printer({ host: '10.0.0.50', enabled: true }), env)).toEqual({ host: '10.0.0.50', port: 9100 });
  });

  it('falls back to the environment when Settings names no host', () => {
    expect(resolvePrinterTarget(printer({ host: '', enabled: true }), env)).toEqual(env);
    expect(resolvePrinterTarget(printer({ host: '   ', enabled: true }), env)).toEqual(env);
  });

  it('returns nothing when neither is configured', () => {
    expect(resolvePrinterTarget(printer({ host: '', enabled: true }), null)).toBeNull();
  });

  it('disables printing outright when told to, whatever the environment says', () => {
    expect(resolvePrinterTarget(printer({ host: '10.0.0.50', enabled: false }), env)).toBeNull();
    expect(resolvePrinterTarget(printer({ host: '', enabled: false }), env)).toBeNull();
  });

  it('honours a non-default port from Settings', () => {
    expect(resolvePrinterTarget(printer({ host: '10.0.0.50', port: 9101 }), env)).toEqual({ host: '10.0.0.50', port: 9101 });
  });
});
