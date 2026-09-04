import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../identity/service.js';
import { addLine, createOrder } from '../ordering/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import {
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  deleteCategory,
  deleteModifier,
  linkModifierGroup,
  listCategories,
  listDisabledModifiersForItem,
  listMenu,
  listModifiers,
  setItemModifierEnabled,
  setItemPrice,
} from './service.js';

/**
 * Managing the menu itself: clearing away categories and options that are
 * no longer needed, and switching a shared option off for one dish. The
 * through-line is the same as removing an item — nothing that has been
 * sold is ever deleted, because that history is not ours to rewrite.
 */
describe('catalog/menu management', () => {
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
    const catalogActor = { actorId: admin.id, terminalId: 'seed' };
    const server = await createUser(ctx.db, { name: 'Server', username: 'server', password: '1111', role: 'server' }, catalogActor);
    const orderActor = { actorId: server.id, terminalId: 'till-1' };
    return { catalogActor, orderActor };
  }

  describe('deleteCategory', () => {
    it('deletes a category and its never-sold items outright', async () => {
      const { catalogActor } = await setup();
      const cat = await createCategory(ctx.db, { name: 'Test Junk' }, catalogActor);
      const item = await createItem(ctx.db, { categoryId: cat.id, name: 'Throwaway' }, catalogActor);
      await setItemPrice(ctx.db, item.id, paisa(100_00), catalogActor);

      expect(await deleteCategory(ctx.db, cat.id, catalogActor)).toBe('deleted');
      expect((await listCategories(ctx.db, { includeInactive: true })).some((c) => c.id === cat.id)).toBe(false);
      expect((await listMenu(ctx.db, { includeInactive: true })).some((i) => i.id === item.id)).toBe(false);
    });

    it('retires a category whose item has been sold, keeping it and its items', async () => {
      const { catalogActor, orderActor } = await setup();
      const cat = await createCategory(ctx.db, { name: 'Real Food' }, catalogActor);
      const item = await createItem(ctx.db, { categoryId: cat.id, name: 'Karahi' }, catalogActor);
      await setItemPrice(ctx.db, item.id, paisa(100_00), catalogActor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      expect(await deleteCategory(ctx.db, cat.id, catalogActor)).toBe('retired');
      // Off the till (inactive) but still present, with its item intact.
      expect((await listCategories(ctx.db)).some((c) => c.id === cat.id)).toBe(false);
      expect((await listCategories(ctx.db, { includeInactive: true })).find((c) => c.id === cat.id)?.active).toBe(false);
      expect((await listMenu(ctx.db, { includeInactive: true })).some((i) => i.id === item.id)).toBe(true);
    });
  });

  describe('deleteModifier', () => {
    it('deletes a never-sold option', async () => {
      const { catalogActor } = await setup();
      const group = await createModifierGroup(ctx.db, { name: 'Extras', minSelect: 0, maxSelect: 3 }, catalogActor);
      const cheese = await createModifier(ctx.db, { groupId: group.id, name: 'Extra cheese', priceDeltaMinor: paisa(100_00) }, catalogActor);

      await deleteModifier(ctx.db, cheese.id, catalogActor);
      expect((await listModifiers(ctx.db, { groupId: group.id })).some((m) => m.id === cheese.id)).toBe(false);
    });

    it('refuses to delete an option that has been sold', async () => {
      const { catalogActor, orderActor } = await setup();
      const cat = await createCategory(ctx.db, { name: 'Mains' }, catalogActor);
      const item = await createItem(ctx.db, { categoryId: cat.id, name: 'Pasta' }, catalogActor);
      await setItemPrice(ctx.db, item.id, paisa(200_00), catalogActor);
      const group = await createModifierGroup(ctx.db, { name: 'Extras', minSelect: 0, maxSelect: 3 }, catalogActor);
      const cheese = await createModifier(ctx.db, { groupId: group.id, name: 'Extra cheese', priceDeltaMinor: paisa(100_00) }, catalogActor);
      await linkModifierGroup(ctx.db, item.id, group.id, catalogActor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [cheese.id] }, orderActor);

      await expect(deleteModifier(ctx.db, cheese.id, catalogActor)).rejects.toThrow(/has been sold/);
      // Still there, untouched.
      expect((await listModifiers(ctx.db, { groupId: group.id })).some((m) => m.id === cheese.id)).toBe(true);
    });
  });

  describe('disabling one option on one item', () => {
    it('hides the option from the item and refuses it at the till, until re-enabled', async () => {
      const { catalogActor, orderActor } = await setup();
      const cat = await createCategory(ctx.db, { name: 'Karahi' }, catalogActor);
      const item = await createItem(ctx.db, { categoryId: cat.id, name: 'Chicken Karahi' }, catalogActor);
      await setItemPrice(ctx.db, item.id, paisa(1_300_00), catalogActor);
      // A shared size group with two options; the dish is only sold Full.
      const size = await createModifierGroup(ctx.db, { name: 'Half / Full', minSelect: 1, maxSelect: 1, pricingMode: 'variant' }, catalogActor);
      const half = await createModifier(ctx.db, { groupId: size.id, name: 'Half', priceDeltaMinor: paisa(0) }, catalogActor);
      const full = await createModifier(ctx.db, { groupId: size.id, name: 'Full', priceDeltaMinor: paisa(700_00) }, catalogActor);
      await linkModifierGroup(ctx.db, item.id, size.id, catalogActor);

      await setItemModifierEnabled(ctx.db, item.id, half.id, false, catalogActor);
      expect(await listDisabledModifiersForItem(ctx.db, item.id)).toEqual([half.id]);

      // The till refuses the disabled option...
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await expect(addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [half.id] }, orderActor)).rejects.toThrow(
        /not offered on this item/,
      );
      // ...but still sells the option that is offered.
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [full.id] }, orderActor);

      // Re-enable, and Half sells again.
      await setItemModifierEnabled(ctx.db, item.id, half.id, true, catalogActor);
      expect(await listDisabledModifiersForItem(ctx.db, item.id)).toEqual([]);
      const order2 = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order2.id, { itemId: item.id, qty: 1, modifierIds: [half.id] }, orderActor);
    });

    it('refuses to disable an option whose group the item does not offer', async () => {
      const { catalogActor } = await setup();
      const cat = await createCategory(ctx.db, { name: 'Mains' }, catalogActor);
      const item = await createItem(ctx.db, { categoryId: cat.id, name: 'Plain' }, catalogActor);
      const group = await createModifierGroup(ctx.db, { name: 'Extras', minSelect: 0, maxSelect: 3 }, catalogActor);
      const cheese = await createModifier(ctx.db, { groupId: group.id, name: 'Extra cheese', priceDeltaMinor: paisa(100_00) }, catalogActor);
      // Group is NOT linked to the item.
      await expect(setItemModifierEnabled(ctx.db, item.id, cheese.id, false, catalogActor)).rejects.toThrow(/not linked/);
    });
  });

  it('listMenu reports each item’s modifier group ids', async () => {
    const { catalogActor } = await setup();
    const cat = await createCategory(ctx.db, { name: 'Karahi' }, catalogActor);
    const item = await createItem(ctx.db, { categoryId: cat.id, name: 'Chicken Karahi' }, catalogActor);
    await setItemPrice(ctx.db, item.id, paisa(1_300_00), catalogActor);
    const size = await createModifierGroup(ctx.db, { name: 'Half / Full', minSelect: 1, maxSelect: 1, pricingMode: 'variant' }, catalogActor);
    await linkModifierGroup(ctx.db, item.id, size.id, catalogActor);

    const menuItem = (await listMenu(ctx.db)).find((i) => i.id === item.id);
    expect(menuItem?.modifierGroupIds).toEqual([size.id]);
  });
});
