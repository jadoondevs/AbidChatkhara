import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../identity/service.js';
import { createPartner } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { openShift } from '../shifts/service.js';
import {
  createPurchase,
  createPurchaseCategory,
  createPurchaseSource,
  deletePurchaseCategory,
  deletePurchaseSource,
  listPurchaseCategories,
  listPurchaseSources,
  listPurchases,
  purchaseReport,
  renamePurchaseCategory,
  renamePurchaseSource,
  setPurchaseCategoryActive,
  setPurchaseSourceCashDrawer,
  voidPurchase,
} from './service.js';

/**
 * The daily purchase ledger: a pure record of what the restaurant bought,
 * for how much, for which partner, under which (owner-configured)
 * category — scoped by shift exactly like an order, and never netted
 * against sales.
 */
describe('purchases', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };
    const azhar = await createPartner(ctx.db, 'Azhar', actor);
    const restaurant = await createPartner(ctx.db, 'Restaurant', actor);
    const meat = await createPurchaseCategory(ctx.db, { name: 'Meat' }, actor);
    const gas = await createPurchaseCategory(ctx.db, { name: 'Gas' }, actor);
    return { admin, actor, azhar, restaurant, meat, gas };
  }

  describe('purchase categories', () => {
    it('creates, lists active-only, renames and retires', async () => {
      const { actor, meat, gas } = await setup();
      expect((await listPurchaseCategories(ctx.db)).map((c) => c.name)).toEqual(['Meat', 'Gas']);

      const renamed = await renamePurchaseCategory(ctx.db, meat.id, 'Chicken', actor);
      expect(renamed.name).toBe('Chicken');

      await setPurchaseCategoryActive(ctx.db, gas.id, false, actor);
      expect((await listPurchaseCategories(ctx.db)).map((c) => c.name)).toEqual(['Chicken']);
      expect((await listPurchaseCategories(ctx.db, { includeInactive: true })).map((c) => c.name)).toEqual(['Chicken', 'Gas']);
    });

    it('deletes an unused category outright but retires one already used', async () => {
      const { actor, azhar, meat, gas } = await setup();
      // Gas is never used → deleted.
      expect(await deletePurchaseCategory(ctx.db, gas.id, actor)).toBe('deleted');
      expect((await listPurchaseCategories(ctx.db, { includeInactive: true })).some((c) => c.id === gas.id)).toBe(false);

      // Meat has a purchase against it → retired, not deleted.
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(500_00), description: 'Beef 5kg' }, actor);
      expect(await deletePurchaseCategory(ctx.db, meat.id, actor)).toBe('retired');
      const stillThere = (await listPurchaseCategories(ctx.db, { includeInactive: true })).find((c) => c.id === meat.id);
      expect(stillThere).toMatchObject({ id: meat.id, active: false });
    });
  });

  describe('recording a purchase', () => {
    it('records what was bought, for which partner and category, and ties it to the open shift', async () => {
      const { actor, azhar, meat } = await setup();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const purchase = await createPurchase(
        ctx.db,
        { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(1200_00), description: 'Mutton 6kg', note: 'Rate up today' },
        actor,
      );

      expect(purchase).toMatchObject({
        partnerName: 'Azhar',
        categoryName: 'Meat',
        description: 'Mutton 6kg',
        amountMinor: 1200_00,
        note: 'Rate up today',
        shiftId: shift.id,
        voided: false,
      });
      expect(purchase.createdByName).toBe('Admin');
    });

    it('still records a purchase when no shift is open — tagged to the date, shift_id null', async () => {
      const { actor, azhar, meat } = await setup();
      const purchase = await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(300_00) }, actor);
      expect(purchase.shiftId).toBeNull();
      expect(purchase.description).toBeNull();
    });

    it('refuses a zero or negative amount, an inactive partner, and an inactive category', async () => {
      const { actor, azhar, meat, gas } = await setup();
      await expect(createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(0) }, actor)).rejects.toThrow(/greater than zero/);

      await setPurchaseCategoryActive(ctx.db, gas.id, false, actor);
      await expect(createPurchase(ctx.db, { partnerId: azhar.id, categoryId: gas.id, amountMinor: paisa(100_00) }, actor)).rejects.toThrow(/no longer active/);
    });
  });

  describe('voiding a purchase', () => {
    it('voids with a reason, drops it from the live list and totals, and refuses a second void', async () => {
      const { actor, azhar, meat } = await setup();
      const a = await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(500_00) }, actor);
      const b = await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(300_00) }, actor);

      const voided = await voidPurchase(ctx.db, a.id, { reason: 'entered twice' }, actor);
      expect(voided).toMatchObject({ voided: true, voidReason: 'entered twice', voidedByName: 'Admin' });

      // Live list and totals now reflect only b.
      const live = await listPurchases(ctx.db);
      expect(live.map((p) => p.id)).toEqual([b.id]);
      const report = await purchaseReport(ctx.db, {});
      expect(report.totalMinor).toBe(300_00);
      expect(report.count).toBe(1);

      // Explicitly asking for voided rows shows it again.
      expect((await listPurchases(ctx.db, { includeVoided: true })).map((p) => p.id).sort((x, y) => x - y)).toEqual([a.id, b.id].sort((x, y) => x - y));

      await expect(voidPurchase(ctx.db, a.id, { reason: 'again' }, actor)).rejects.toThrow(/already voided/);
    });
  });

  describe('listing and scoping', () => {
    it('scopes to one shift by shiftId, winning over the date range', async () => {
      const { actor, azhar, meat } = await setup();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(400_00) }, actor);

      const past = { fromInclusive: '2000-01-01T00:00:00.000Z', toExclusive: '2000-01-02T00:00:00.000Z' };
      const inShift = await listPurchases(ctx.db, { shiftId: shift.id, ...past });
      expect(inShift).toHaveLength(1);
      expect(await listPurchases(ctx.db, { shiftId: shift.id + 999 })).toEqual([]);
    });

    it('filters by partner and by category', async () => {
      const { actor, azhar, restaurant, meat, gas } = await setup();
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(500_00) }, actor);
      await createPurchase(ctx.db, { partnerId: restaurant.id, categoryId: gas.id, amountMinor: paisa(200_00) }, actor);

      expect((await listPurchases(ctx.db, { partnerId: azhar.id })).map((p) => p.amountMinor)).toEqual([500_00]);
      expect((await listPurchases(ctx.db, { categoryId: gas.id })).map((p) => p.amountMinor)).toEqual([200_00]);
    });
  });

  describe('purchase report', () => {
    it('totals the spend and splits it by category and by partner, biggest first', async () => {
      const { actor, azhar, restaurant, meat, gas } = await setup();
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(1000_00) }, actor);
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(500_00) }, actor);
      await createPurchase(ctx.db, { partnerId: restaurant.id, categoryId: gas.id, amountMinor: paisa(300_00) }, actor);

      const report = await purchaseReport(ctx.db, {});
      expect(report.totalMinor).toBe(1800_00);
      expect(report.count).toBe(3);

      expect(report.byCategory).toEqual([
        { id: meat.id, name: 'Meat', count: 2, totalMinor: 1500_00 },
        { id: gas.id, name: 'Gas', count: 1, totalMinor: 300_00 },
      ]);
      expect(report.byPartner).toEqual([
        { id: azhar.id, name: 'Azhar', count: 2, totalMinor: 1500_00 },
        { id: restaurant.id, name: 'Restaurant', count: 1, totalMinor: 300_00 },
      ]);
    });
  });

  describe('payment sources', () => {
    it('creates, lists active-only, renames, deletes unused but retires used', async () => {
      const { actor, azhar, meat } = await setup();
      const drawer = await createPurchaseSource(ctx.db, { name: 'Cash drawer' }, actor);
      const irfan = await createPurchaseSource(ctx.db, { name: 'Irfan' }, actor);
      expect((await listPurchaseSources(ctx.db)).map((s) => s.name)).toEqual(['Cash drawer', 'Irfan']);

      await renamePurchaseSource(ctx.db, irfan.id, 'Irfan Khan', actor);
      expect((await listPurchaseSources(ctx.db)).map((s) => s.name)).toEqual(['Cash drawer', 'Irfan Khan']);

      // Irfan is unused → deleted outright.
      expect(await deletePurchaseSource(ctx.db, irfan.id, actor)).toBe('deleted');

      // Cash drawer funded a purchase → retired, not deleted.
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(100_00), sourceId: drawer.id }, actor);
      expect(await deletePurchaseSource(ctx.db, drawer.id, actor)).toBe('retired');
      expect((await listPurchaseSources(ctx.db, { includeInactive: true })).find((s) => s.id === drawer.id)).toMatchObject({ active: false });
    });

    it('records a purchase against its source, and the report splits spend by source — sourceless under "—"', async () => {
      const { actor, azhar, meat } = await setup();
      const drawer = await createPurchaseSource(ctx.db, { name: 'Cash drawer' }, actor);
      const irfan = await createPurchaseSource(ctx.db, { name: 'Irfan' }, actor);

      const fromDrawer = await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(1000_00), sourceId: drawer.id }, actor);
      expect(fromDrawer).toMatchObject({ sourceId: drawer.id, sourceName: 'Cash drawer' });
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(400_00), sourceId: irfan.id }, actor);
      // No source given — allowed, and reported under "—".
      const none = await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(100_00) }, actor);
      expect(none).toMatchObject({ sourceId: null, sourceName: null });

      const report = await purchaseReport(ctx.db, {});
      expect(report.bySource).toEqual([
        { id: drawer.id, name: 'Cash drawer', count: 1, totalMinor: 1000_00 },
        { id: irfan.id, name: 'Irfan', count: 1, totalMinor: 400_00 },
        { id: 0, name: '—', count: 1, totalMinor: 100_00 },
      ]);
    });

    it('flags one source as the cash drawer (single-drawer) and totals only its purchases', async () => {
      const { actor, azhar, meat } = await setup();
      const drawer = await createPurchaseSource(ctx.db, { name: 'Cash drawer' }, actor);
      const irfan = await createPurchaseSource(ctx.db, { name: 'Irfan' }, actor);

      expect((await setPurchaseSourceCashDrawer(ctx.db, drawer.id, true, actor)).isCashDrawer).toBe(true);

      // Flagging another clears the first — at most one drawer.
      await setPurchaseSourceCashDrawer(ctx.db, irfan.id, true, actor);
      let list = await listPurchaseSources(ctx.db);
      expect(list.find((s) => s.id === drawer.id)?.isCashDrawer).toBe(false);
      expect(list.find((s) => s.id === irfan.id)?.isCashDrawer).toBe(true);

      // Put it back on the real drawer; only drawer purchases count.
      await setPurchaseSourceCashDrawer(ctx.db, drawer.id, true, actor);
      list = await listPurchaseSources(ctx.db);
      expect(list.find((s) => s.id === irfan.id)?.isCashDrawer).toBe(false);

      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(1000_00), sourceId: drawer.id }, actor);
      await createPurchase(ctx.db, { partnerId: azhar.id, categoryId: meat.id, amountMinor: paisa(400_00), sourceId: irfan.id }, actor);

      const report = await purchaseReport(ctx.db, {});
      expect(report.drawerTotalMinor).toBe(1000_00);
    });
  });
});
