import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../platform/db/test-helpers.js';
import { importMenu, parseMenuFile, planMenuImport, readMenuFile, type MenuFile } from './menu-import.js';
import { getCurrentPrice, getItemModifierPrice, listMenu, listModifierGroupsForItem } from './service.js';

const actor = { actorId: null, terminalId: 'menu-import' };

const SMALL: MenuFile = parseMenuFile({
  modifierGroups: [{ name: 'Half / Full', minSelect: 1, maxSelect: 1, options: ['Half', 'Full'] }],
  categories: [
    {
      name: 'Karahi',
      items: [
        { name: 'Chicken Karahi', price: 1100, sizes: { group: 'Half / Full', prices: { Half: 1100, Full: 2100 } } },
        { name: 'Chicken Karahi Makhni', price: 1300, sizes: { group: 'Half / Full', prices: { Half: 1300, Full: 2400 } } },
        { name: 'Chicken Karahi Makhni', price: 1300, sizes: { group: 'Half / Full', prices: { Half: 1300, Full: 2500 } } },
      ],
    },
    { name: 'Tea', items: [{ name: 'Green Tea', price: 80 }] },
  ],
});

describe('catalog/menu-import', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  describe('the file itself', () => {
    it('refuses a size that names an option the group does not have', () => {
      expect(() =>
        parseMenuFile({
          modifierGroups: [{ name: 'Half / Full', minSelect: 1, maxSelect: 1, options: ['Half', 'Full'] }],
          categories: [{ name: 'Karahi', items: [{ name: 'X', price: 100, sizes: { group: 'Half / Full', prices: { Half: 100, Jumbo: 200 } } }] }],
        }),
      ).toThrow(/"Jumbo", which is not an option/);
    });

    it('refuses a size that leaves an option unpriced', () => {
      expect(() =>
        parseMenuFile({
          modifierGroups: [{ name: 'Half / Full', minSelect: 1, maxSelect: 1, options: ['Half', 'Full'] }],
          categories: [{ name: 'Karahi', items: [{ name: 'X', price: 100, sizes: { group: 'Half / Full', prices: { Half: 100 } } }] }],
        }),
      ).toThrow(/does not price "Full"/);
    });

    it('refuses an item whose base size disagrees with its own price', () => {
      expect(() =>
        parseMenuFile({
          modifierGroups: [{ name: 'Half / Full', minSelect: 1, maxSelect: 1, options: ['Half', 'Full'] }],
          categories: [{ name: 'Karahi', items: [{ name: 'X', price: 100, sizes: { group: 'Half / Full', prices: { Half: 150, Full: 200 } } }] }],
        }),
      ).toThrow(/priced 100 but its "Half" size is 150/);
    });

    it('refuses a size group the file never defines', () => {
      expect(() =>
        parseMenuFile({
          modifierGroups: [],
          categories: [{ name: 'Karahi', items: [{ name: 'X', price: 100, sizes: { group: 'Half / Full', prices: { Half: 100 } } }] }],
        }),
      ).toThrow(/which the file does not define/);
    });
  });

  it('loads categories, items, prices, size groups and per-item size prices', async () => {
    ctx = createTestDb();
    await importMenu(ctx.db, SMALL, actor);

    const menu = await listMenu(ctx.db);
    expect(menu).toHaveLength(4);

    const karahi = menu.filter((item) => item.name === 'Chicken Karahi');
    expect(karahi).toHaveLength(1);
    expect(await getCurrentPrice(ctx.db, karahi[0]!.id)).toBe(paisa(1100_00));

    // The size group is attached, and each option is priced ON THIS ITEM
    // — the whole reason item_modifier_price exists (migration 0020).
    const groups = await listModifierGroupsForItem(ctx.db, karahi[0]!.id);
    expect(groups.map((group) => group.name)).toEqual(['Half / Full']);
    const options = await ctx.db.selectFrom('modifier').select(['id', 'name']).where('group_id', '=', groups[0]!.id).execute();
    const half = options.find((option) => option.name === 'Half');
    const full = options.find((option) => option.name === 'Full');
    expect(await getItemModifierPrice(ctx.db, karahi[0]!.id, half!.id)).toBe(paisa(0));
    expect(await getItemModifierPrice(ctx.db, karahi[0]!.id, full!.id)).toBe(paisa(1000_00));
  });

  it('keeps a repeated menu line as two items, each with its own size prices', async () => {
    ctx = createTestDb();
    await importMenu(ctx.db, SMALL, actor);

    const menu = await listMenu(ctx.db);
    const repeated = menu.filter((item) => item.name === 'Chicken Karahi Makhni');
    expect(repeated).toHaveLength(2);

    const group = (await listModifierGroupsForItem(ctx.db, repeated[0]!.id))[0]!;
    const full = (await ctx.db.selectFrom('modifier').select(['id', 'name']).where('group_id', '=', group.id).execute()).find((o) => o.name === 'Full')!;
    const deltas = await Promise.all(repeated.map((item) => getItemModifierPrice(ctx.db, item.id, full.id)));
    // The printed menu lists it twice at different full prices; the
    // restaurant asked for that kept exactly as it is.
    expect(deltas.sort()).toEqual([paisa(1100_00), paisa(1200_00)]);
  });

  it('is idempotent — a second run changes nothing', async () => {
    ctx = createTestDb();
    const first = await importMenu(ctx.db, SMALL, actor);
    expect(first.applied).toBeGreaterThan(0);

    const second = await importMenu(ctx.db, SMALL, actor);
    expect(second.actions).toEqual([]);
    expect(second.unchangedItems).toBe(4);
    expect(await listMenu(ctx.db)).toHaveLength(4);
  });

  it('re-prices by writing a new effective-dated row, leaving the old price in history', async () => {
    ctx = createTestDb();
    await importMenu(ctx.db, SMALL, actor);
    const tea = (await listMenu(ctx.db)).find((item) => item.name === 'Green Tea')!;

    const dearer: MenuFile = {
      ...SMALL,
      categories: SMALL.categories.map((category) =>
        category.name === 'Tea' ? { ...category, items: [{ name: 'Green Tea', price: 120 }] } : category,
      ),
    };

    const plan = await planMenuImport(ctx.db, dearer);
    expect(plan.actions).toEqual([{ kind: 'set-price', at: { category: 'Tea', name: 'Green Tea', occurrence: 0 }, fromMinor: paisa(80_00), toMinor: paisa(120_00) }]);

    await importMenu(ctx.db, dearer, actor);
    expect(await getCurrentPrice(ctx.db, tea.id)).toBe(paisa(120_00));

    const rows = await ctx.db.selectFrom('item_price').selectAll().where('item_id', '=', tea.id).orderBy('id', 'asc').execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.price_minor).toBe(paisa(80_00));
    expect(rows[0]!.valid_to).not.toBeNull(); // closed, not edited
    expect(rows[1]!.valid_to).toBeNull();
  });

  it('plans without writing anything', async () => {
    ctx = createTestDb();
    const plan = await planMenuImport(ctx.db, SMALL);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(await listMenu(ctx.db)).toEqual([]);
  });

  it('leaves every imported item owned by nobody, so ownership stays a decision made in the app', async () => {
    ctx = createTestDb();
    await importMenu(ctx.db, SMALL, actor);
    expect(await ctx.db.selectFrom('item_ownership').selectAll().execute()).toEqual([]);
  });

  it('loads the restaurant menu that ships with the repo', async () => {
    ctx = createTestDb();
    const file = readMenuFile(new URL('../../menu/abid-chatkhara.json', import.meta.url).pathname);
    expect(file.categories).toHaveLength(11);
    expect(file.categories.reduce((total, category) => total + category.items.length, 0)).toBe(54);

    await importMenu(ctx.db, file, actor);
    const menu = await listMenu(ctx.db);
    expect(menu).toHaveLength(54);
    // Every item is priced: an unpriced item cannot be added to an order.
    expect(menu.filter((item) => item.priceMinor === null)).toEqual([]);

    const sized = await ctx.db.selectFrom('item_modifier_group').select('item_id').distinct().execute();
    expect(sized).toHaveLength(16);

    expect((await importMenu(ctx.db, file, actor)).actions).toEqual([]);
  });
});
