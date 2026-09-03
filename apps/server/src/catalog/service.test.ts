import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import {
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  clearItemModifierPrice,
  getAvailability,
  getCurrentPrice,
  getItemModifierPrice,
  getPriceHistory,
  linkModifierGroup,
  listItemModifierPrices,
  listCategories,
  listItems,
  listMenu,
  listModifierGroups,
  listModifierGroupsForItem,
  listModifiers,
  removeItem,
  setAvailability,
  setItemModifierPrice,
  setItemPrice,
  unlinkModifierGroup,
  updateCategory,
  updateItem,
  updateModifierGroup,
} from './service.js';

describe('catalog/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupActor() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    return { actorId: admin.id, terminalId: 't1' };
  }

  describe('category', () => {
    it('creates and lists categories, ordered by sortOrder then name', async () => {
      const actor = await setupActor();
      await createCategory(ctx.db, { name: 'Beverages', sortOrder: 2 }, actor);
      await createCategory(ctx.db, { name: 'Starters', sortOrder: 1 }, actor);
      await createCategory(ctx.db, { name: 'Mains', sortOrder: 1 }, actor);

      const categories = await listCategories(ctx.db);
      expect(categories.map((c) => c.name)).toEqual(['Mains', 'Starters', 'Beverages']);
    });

    it('excludes inactive categories by default, includes them on request', async () => {
      const actor = await setupActor();
      const cat = await createCategory(ctx.db, { name: 'Seasonal' }, actor);
      await updateCategory(ctx.db, cat.id, { active: false }, actor);

      expect(await listCategories(ctx.db)).toEqual([]);
      expect((await listCategories(ctx.db, { includeInactive: true })).map((c) => c.name)).toEqual(['Seasonal']);
    });

    it('updateCategory throws for an unknown id', async () => {
      const actor = await setupActor();
      await expect(updateCategory(ctx.db, 999, { name: 'x' }, actor)).rejects.toThrow(/not found/);
    });
  });

  describe('item', () => {
    it('creates an item with a paired, available-by-default availability row', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Chicken Karahi' }, actor);

      expect(item).toMatchObject({ name: 'Chicken Karahi', categoryId: category.id, active: true });
      expect(await getAvailability(ctx.db, item.id)).toMatchObject({ itemId: item.id, available: true });
    });

    it('rejects creating an item under a nonexistent category', async () => {
      const actor = await setupActor();
      await expect(createItem(ctx.db, { categoryId: 999, name: 'Ghost Dish' }, actor)).rejects.toThrow(/category 999 not found/);
    });

    it('lists items scoped to a category and excludes inactive by default', async () => {
      const actor = await setupActor();
      const mains = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const drinks = await createCategory(ctx.db, { name: 'Drinks' }, actor);
      const biryani = await createItem(ctx.db, { categoryId: mains.id, name: 'Biryani' }, actor);
      await createItem(ctx.db, { categoryId: drinks.id, name: 'Cola' }, actor);
      await updateItem(ctx.db, biryani.id, { active: false }, actor);

      expect((await listItems(ctx.db, { categoryId: mains.id })).map((i) => i.name)).toEqual([]);
      expect((await listItems(ctx.db, { categoryId: drinks.id })).map((i) => i.name)).toEqual(['Cola']);
    });

    it('can move an item to a different category', async () => {
      const actor = await setupActor();
      const a = await createCategory(ctx.db, { name: 'A' }, actor);
      const b = await createCategory(ctx.db, { name: 'B' }, actor);
      const item = await createItem(ctx.db, { categoryId: a.id, name: 'Thing' }, actor);

      const moved = await updateItem(ctx.db, item.id, { categoryId: b.id }, actor);
      expect(moved.categoryId).toBe(b.id);
    });
  });

  describe('item price', () => {
    it('setting a price for the first time opens one row with no prior close', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);

      const price = await setItemPrice(ctx.db, item.id, paisa(85_000), actor);
      expect(price.priceMinor).toBe(85_000);
      expect(price.validTo).toBeNull();

      const history = await getPriceHistory(ctx.db, item.id);
      expect(history).toHaveLength(1);
    });

    it('a second price change closes the first row and opens a new one — never edits price_minor in place', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);

      const first = await setItemPrice(ctx.db, item.id, paisa(85_000), actor);
      const second = await setItemPrice(ctx.db, item.id, paisa(90_000), actor);

      const history = await getPriceHistory(ctx.db, item.id);
      expect(history).toHaveLength(2);
      const closedFirst = history.find((h) => h.id === first.id);
      expect(closedFirst?.priceMinor).toBe(85_000); // never mutated
      expect(closedFirst?.validTo).not.toBeNull();
      expect(second.validTo).toBeNull();
    });

    it('getCurrentPrice returns the price in effect at a given historical instant', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);

      const before = new Date();
      await new Promise((r) => setTimeout(r, 5));
      await setItemPrice(ctx.db, item.id, paisa(85_000), actor);
      await new Promise((r) => setTimeout(r, 5));
      const afterFirst = new Date();
      await new Promise((r) => setTimeout(r, 5));
      await setItemPrice(ctx.db, item.id, paisa(90_000), actor);

      expect(await getCurrentPrice(ctx.db, item.id, before)).toBeNull();
      expect(await getCurrentPrice(ctx.db, item.id, afterFirst)).toBe(85_000);
      expect(await getCurrentPrice(ctx.db, item.id)).toBe(90_000); // now
    });

    it('rejects setting a price on a nonexistent item', async () => {
      const actor = await setupActor();
      await expect(setItemPrice(ctx.db, 999, paisa(100), actor)).rejects.toThrow(/item 999 not found/);
    });
  });

  describe('taking an item off the menu', () => {
    it('deletes an item that was never sold, along with everything hanging off it', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Chiken Karahi' }, actor);
      await setItemPrice(ctx.db, item.id, paisa(1000_00), actor);
      await setAvailability(ctx.db, item.id, false, actor);
      const group = await createModifierGroup(ctx.db, { name: 'Half / Full', minSelect: 1, maxSelect: 1 }, actor);
      const full = await createModifier(ctx.db, { groupId: group.id, name: 'Full', priceDeltaMinor: paisa(500_00) }, actor);
      await linkModifierGroup(ctx.db, item.id, group.id, actor);
      await setItemModifierPrice(ctx.db, item.id, full.id, paisa(900_00), actor);

      // A typo should leave no trace.
      expect(await removeItem(ctx.db, item.id, actor)).toBe('deleted');
      expect((await listItems(ctx.db)).map((i) => i.id)).not.toContain(item.id);
      for (const table of ['item_price', 'item_availability', 'item_modifier_group', 'item_modifier_price'] as const) {
        const rows = await ctx.db.selectFrom(table).select('item_id').where('item_id', '=', item.id).execute();
        expect(rows, table).toEqual([]);
      }
    });

    it('leaves the audit trail behind even though the item is gone', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Typo' }, actor);
      await removeItem(ctx.db, item.id, actor);

      const audit = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'item.delete').execute();
      expect(audit).toHaveLength(1);
      expect(String(audit[0]?.before_json)).toContain('Typo');
    });

    it('rejects an item that does not exist', async () => {
      const actor = await setupActor();
      await expect(removeItem(ctx.db, 4242, actor)).rejects.toThrow(/item 4242 not found/);
    });
  });

  describe('per-item modifier prices', () => {
    /** One size group shared by two items whose Full is worth different
     * money — the case the whole table exists for. */
    async function twoKarahis() {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Karahi' }, actor);
      const size = await createModifierGroup(ctx.db, { name: 'Half / Full', minSelect: 1, maxSelect: 1 }, actor);
      const half = await createModifier(ctx.db, { groupId: size.id, name: 'Half', priceDeltaMinor: paisa(0) }, actor);
      const full = await createModifier(ctx.db, { groupId: size.id, name: 'Full', priceDeltaMinor: paisa(1000_00) }, actor);

      const chicken = await createItem(ctx.db, { categoryId: category.id, name: 'Chicken Karahi' }, actor);
      const shinwari = await createItem(ctx.db, { categoryId: category.id, name: 'Shinwari Karahi' }, actor);
      await linkModifierGroup(ctx.db, chicken.id, size.id, actor);
      await linkModifierGroup(ctx.db, shinwari.id, size.id, actor);
      return { actor, size, half, full, chicken, shinwari };
    }

    it("falls back to the modifier's own delta when an item has no override", async () => {
      const { chicken, full } = await twoKarahis();
      expect(await getItemModifierPrice(ctx.db, chicken.id, full.id)).toBeNull();
    });

    it('lets one shared group carry a different uplift per item', async () => {
      const { actor, chicken, shinwari, full } = await twoKarahis();
      await setItemModifierPrice(ctx.db, chicken.id, full.id, paisa(1000_00), actor);
      await setItemModifierPrice(ctx.db, shinwari.id, full.id, paisa(1800_00), actor);

      expect(await getItemModifierPrice(ctx.db, chicken.id, full.id)).toBe(1000_00);
      expect(await getItemModifierPrice(ctx.db, shinwari.id, full.id)).toBe(1800_00);
    });

    it('closes the open row rather than updating a price in place', async () => {
      const { actor, chicken, full } = await twoKarahis();
      await setItemModifierPrice(ctx.db, chicken.id, full.id, paisa(1000_00), actor);
      await setItemModifierPrice(ctx.db, chicken.id, full.id, paisa(1200_00), actor);

      const rows = await ctx.db.selectFrom('item_modifier_price').selectAll().where('item_id', '=', chicken.id).execute();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.valid_to === null)).toHaveLength(1);
      expect(await getItemModifierPrice(ctx.db, chicken.id, full.id)).toBe(1200_00);
    });

    it('clearing an override restores the modifier default', async () => {
      const { actor, chicken, full } = await twoKarahis();
      await setItemModifierPrice(ctx.db, chicken.id, full.id, paisa(1200_00), actor);
      await clearItemModifierPrice(ctx.db, chicken.id, full.id, actor);
      expect(await getItemModifierPrice(ctx.db, chicken.id, full.id)).toBeNull();
    });

    it('lists only the overrides currently in effect', async () => {
      const { actor, chicken, half, full } = await twoKarahis();
      await setItemModifierPrice(ctx.db, chicken.id, full.id, paisa(1000_00), actor);
      await setItemModifierPrice(ctx.db, chicken.id, half.id, paisa(0), actor);
      await clearItemModifierPrice(ctx.db, chicken.id, half.id, actor);

      expect(await listItemModifierPrices(ctx.db, chicken.id)).toEqual([{ modifierId: full.id, priceDeltaMinor: 1000_00 }]);
    });

    it('refuses an override for a modifier the item cannot be sold with', async () => {
      const { actor, chicken } = await twoKarahis();
      const other = await createModifierGroup(ctx.db, { name: 'Add-ons', minSelect: 0, maxSelect: 1 }, actor);
      const cheese = await createModifier(ctx.db, { groupId: other.id, name: 'Extra cheese', priceDeltaMinor: paisa(100_00) }, actor);

      // The group is not linked to this item, so the override could
      // never be read — a configuration mistake, not a price.
      await expect(setItemModifierPrice(ctx.db, chicken.id, cheese.id, paisa(50_00), actor)).rejects.toThrow(/not linked/);
    });
  });

  describe('modifier groups and modifiers', () => {
    it('creates a modifier group and rejects an invalid select range', async () => {
      const actor = await setupActor();
      const group = await createModifierGroup(ctx.db, { name: 'Spice level', minSelect: 1, maxSelect: 1 }, actor);
      expect(group.minSelect).toBe(1);

      await expect(createModifierGroup(ctx.db, { name: 'Bad', minSelect: 2, maxSelect: 1 }, actor)).rejects.toThrow(
        /maxSelect must be >= minSelect/,
      );
    });

    it('updateModifierGroup validates the resulting range even when only one bound changes', async () => {
      const actor = await setupActor();
      const group = await createModifierGroup(ctx.db, { name: 'Add-ons', minSelect: 0, maxSelect: 3 }, actor);
      await expect(updateModifierGroup(ctx.db, group.id, { maxSelect: -1 }, actor)).rejects.toThrow();
      const updated = await updateModifierGroup(ctx.db, group.id, { minSelect: 1 }, actor);
      expect(updated).toMatchObject({ minSelect: 1, maxSelect: 3 });
    });

    it('creates a modifier under a group, with a Paisa price delta', async () => {
      const actor = await setupActor();
      const group = await createModifierGroup(ctx.db, { name: 'Add-ons', minSelect: 0, maxSelect: 3 }, actor);
      const modifier = await createModifier(ctx.db, { groupId: group.id, name: 'Extra cheese', priceDeltaMinor: paisa(15_00) }, actor);
      expect(modifier.priceDeltaMinor).toBe(1500);

      expect((await listModifiers(ctx.db, { groupId: group.id })).map((m) => m.name)).toEqual(['Extra cheese']);
    });

    it('lists a group’s options in the order they were entered, not alphabetically', async () => {
      const actor = await setupActor();
      const group = await createModifierGroup(ctx.db, { name: 'Half / Full', minSelect: 1, maxSelect: 1 }, actor);
      await createModifier(ctx.db, { groupId: group.id, name: 'Half', priceDeltaMinor: paisa(0) }, actor);
      await createModifier(ctx.db, { groupId: group.id, name: 'Full', priceDeltaMinor: paisa(0) }, actor);

      // Alphabetically this is Full, Half — which would put the
      // dearer size first AND make it the till's pre-selected default.
      expect((await listModifiers(ctx.db, { groupId: group.id })).map((m) => m.name)).toEqual(['Half', 'Full']);
    });

    it('lists all modifier groups, ordered by name', async () => {
      const actor = await setupActor();
      await createModifierGroup(ctx.db, { name: 'Spice level', minSelect: 1, maxSelect: 1 }, actor);
      await createModifierGroup(ctx.db, { name: 'Add-ons', minSelect: 0, maxSelect: 3 }, actor);

      expect((await listModifierGroups(ctx.db)).map((g) => g.name)).toEqual(['Add-ons', 'Spice level']);
    });

    it('rejects a modifier under a nonexistent group', async () => {
      const actor = await setupActor();
      await expect(createModifier(ctx.db, { groupId: 999, name: 'x', priceDeltaMinor: paisa(0) }, actor)).rejects.toThrow(
        /modifier group 999 not found/,
      );
    });
  });

  describe('item <-> modifier group linking', () => {
    it('links and unlinks a modifier group to an item', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Burger' }, actor);
      const group = await createModifierGroup(ctx.db, { name: 'Protein', minSelect: 1, maxSelect: 1 }, actor);

      await linkModifierGroup(ctx.db, item.id, group.id, actor);
      expect((await listModifierGroupsForItem(ctx.db, item.id)).map((g) => g.id)).toEqual([group.id]);

      await unlinkModifierGroup(ctx.db, item.id, group.id, actor);
      expect(await listModifierGroupsForItem(ctx.db, item.id)).toEqual([]);
    });
  });

  describe('availability', () => {
    it('toggles availability and records before/after in the audit log', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);

      const updated = await setAvailability(ctx.db, item.id, false, actor);
      expect(updated.available).toBe(false);
      expect(updated.changedBy).toBe(actor.actorId);

      const audit = await ctx.db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'item.mark_unavailable')
        .executeTakeFirstOrThrow();
      expect(JSON.parse(audit.before_json ?? '{}')).toMatchObject({ available: true });
      expect(JSON.parse(audit.after_json ?? '{}')).toMatchObject({ available: false });
    });

    it('rejects toggling availability for an item with no availability row', async () => {
      const actor = await setupActor();
      // Directly insert an item bypassing createItem, so it has no paired
      // availability row — proves setAvailability fails loudly rather
      // than silently creating one out of band.
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const row = await ctx.db
        .insertInto('item')
        .values({ category_id: category.id, name: 'Orphan', active: 1 })
        .returningAll()
        .executeTakeFirstOrThrow();

      await expect(setAvailability(ctx.db, row.id, false, actor)).rejects.toThrow(/no availability row/);
    });
  });

  describe('listMenu', () => {
    it('combines item, current price, and availability into one view', async () => {
      const actor = await setupActor();
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const priced = await createItem(ctx.db, { categoryId: category.id, name: 'Priced & available' }, actor);
      await setItemPrice(ctx.db, priced.id, paisa(50_000), actor);

      await createItem(ctx.db, { categoryId: category.id, name: 'No price yet' }, actor);

      const unavailable = await createItem(ctx.db, { categoryId: category.id, name: '86d item' }, actor);
      await setItemPrice(ctx.db, unavailable.id, paisa(30_000), actor);
      await setAvailability(ctx.db, unavailable.id, false, actor);

      const menu = await listMenu(ctx.db, { categoryId: category.id });
      const byName = Object.fromEntries(menu.map((m) => [m.name, m]));

      expect(byName['Priced & available']).toMatchObject({ priceMinor: 50_000, available: true });
      expect(byName['No price yet']).toMatchObject({ priceMinor: null, available: true });
      expect(byName['86d item']).toMatchObject({ priceMinor: 30_000, available: false });
    });
  });
});
