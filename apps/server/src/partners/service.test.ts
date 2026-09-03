import { paisa, sum } from '@pos/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCategory, createItem, removeItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import {
  allocateOrder,
  checkOwnershipIntegrity,
  createPartner,
  getActiveItemOwnership,
  getPartnerRecord,
  listItemsWithoutOwnership,
  listPartners,
  renamePartner,
  reverseLineAllocations,
  reverseOrderAllocations,
  scheduleOwnershipIntegrityCheck,
  setItemOwnership,
  setOwnershipForCategories,
  setPartnerActive,
} from './service.js';

describe('partners/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'seed' };

    const alice = await createPartner(ctx.db, 'Alice', actor);
    const bob = await createPartner(ctx.db, 'Bob', actor);

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1000_00), actor);

    return { admin, actor, alice, bob, category, item };
  }

  /** Opens an order, adds one line of `item` at `qty`, applies an
   * optional discount, and bills it — leaving it ready to allocate. */
  async function billedOrder(item: { id: number }, actor: { actorId: number; terminalId: string }, opts: { qty?: number; discountMinor?: number } = {}) {
    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: opts.qty ?? 1 }, actor);
    if (opts.discountMinor) {
      const { setDiscount } = await import('../ordering/service.js');
      await setDiscount(ctx.db, order.id, { discountMinor: paisa(opts.discountMinor), reason: 'test' }, actor);
    }
    return billOrder(ctx.db, order.id, {}, actor);
  }

  describe('partner CRUD', () => {
    it('creates, lists (active by default), and deactivates a partner', async () => {
      const { actor } = await setupBase();
      const carol = await createPartner(ctx.db, 'Carol', actor);
      expect((await listPartners(ctx.db)).map((p) => p.name)).toEqual(expect.arrayContaining(['Alice', 'Bob', 'Carol']));

      const deactivated = await setPartnerActive(ctx.db, carol.id, false, actor);
      expect(deactivated.active).toBe(false);
      expect(deactivated.leftAt).not.toBeNull();
      expect((await listPartners(ctx.db)).map((p) => p.name)).not.toContain('Carol');
    });
  });

  describe('partner management', () => {
    it('renames a partner without touching anything they were allocated', async () => {
      const { actor, item, alice } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);
      await allocateOrder(ctx.db, billed.id, new Date(), actor);

      const before = await getPartnerRecord(ctx.db, alice.id);
      const renamed = await renamePartner(ctx.db, alice.id, 'Alice Khan', actor);
      expect(renamed.name).toBe('Alice Khan');

      const after = await getPartnerRecord(ctx.db, alice.id);
      expect(after?.totalAllocatedMinor).toBe(before?.totalAllocatedMinor);
      expect(after?.recentAllocations).toEqual(before?.recentAllocations);
    });

    it('rejects a blank name', async () => {
      const { actor, alice } = await setupBase();
      await expect(renamePartner(ctx.db, alice.id, '   ', actor)).rejects.toThrow();
    });

    it('brings a partner back after they were marked as left', async () => {
      const { actor, alice } = await setupBase();
      await setPartnerActive(ctx.db, alice.id, false, actor);
      const back = await setPartnerActive(ctx.db, alice.id, true, actor);
      expect(back.active).toBe(true);
      expect(back.leftAt).toBeNull();
      expect((await listPartners(ctx.db)).map((p) => p.name)).toContain('Alice');
    });

    it('keeps crediting a partner who has left until their items are reassigned', async () => {
      const { actor, item, alice } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      await setPartnerActive(ctx.db, alice.id, false, actor);

      // Deactivating records a departure; it does not reassign what
      // they own, which is exactly why the UI says so before doing it.
      const billed = await billedOrder(item, actor);
      await allocateOrder(ctx.db, billed.id, new Date(), actor);
      const record = await getPartnerRecord(ctx.db, alice.id);
      expect(record?.totalAllocatedMinor).toBe(1000_00);
      expect(record?.ownedItems).toHaveLength(1);
    });
  });

  describe('getPartnerRecord', () => {
    it('returns null for a partner who does not exist', async () => {
      await setupBase();
      expect(await getPartnerRecord(ctx.db, 9_999)).toBeNull();
    });

    it('reports what they own today and what they have been credited', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 6_000 }, { partnerId: bob.id, shareBp: 4_000 }], actor);
      const billed = await billedOrder(item, actor);
      await allocateOrder(ctx.db, billed.id, new Date(), actor);

      const record = await getPartnerRecord(ctx.db, alice.id);
      expect(record?.ownedItems).toEqual([{ itemId: item.id, itemName: 'Karahi', shareBp: 6_000 }]);
      expect(record?.totalAllocatedMinor).toBe(600_00);
      expect(record?.recentAllocations[0]).toMatchObject({
        orderId: billed.id,
        itemName: 'Karahi',
        qty: 1,
        shareBpSnapshot: 6_000,
        amountMinor: 600_00,
        isReversal: false,
      });
    });

    it('shows an allocation at the share it was written at, not today’s', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);
      await allocateOrder(ctx.db, billed.id, new Date(), actor);

      // The split changes afterwards. The sale that already happened
      // was Alice's in full, and stays that way.
      await setItemOwnership(ctx.db, item.id, [{ partnerId: bob.id, shareBp: 10_000 }], actor);

      const record = await getPartnerRecord(ctx.db, alice.id);
      expect(record?.recentAllocations[0]?.shareBpSnapshot).toBe(10_000);
      expect(record?.totalAllocatedMinor).toBe(1000_00);
      expect(record?.ownedItems).toHaveLength(0);
    });

    it('shows a reversal as a reversal rather than netting it away', async () => {
      const { actor, item, alice } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);
      await allocateOrder(ctx.db, billed.id, new Date(), actor);
      await reverseOrderAllocations(ctx.db, billed.id, actor);

      const record = await getPartnerRecord(ctx.db, alice.id);
      // A partner asking why a figure moved is owed the entry that
      // moved it, so both rows are there and the total nets to zero.
      expect(record?.recentAllocations).toHaveLength(2);
      expect(record?.recentAllocations.filter((a) => a.isReversal)).toHaveLength(1);
      expect(record?.totalAllocatedMinor).toBe(0);
    });

    it('names the item as it was sold, after the menu is renamed', async () => {
      const { actor, item, alice } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);
      await allocateOrder(ctx.db, billed.id, new Date(), actor);

      const { renameItem } = await import('../catalog/service.js');
      await renameItem(ctx.db, item.id, 'Chicken Karahi (full)', actor);

      const record = await getPartnerRecord(ctx.db, alice.id);
      expect(record?.recentAllocations[0]?.itemName).toBe('Karahi');
      // What they own TODAY is a live question, so that one moves.
      expect(record?.ownedItems[0]?.itemName).toBe('Chicken Karahi (full)');
    });
  });

  describe('setItemOwnership', () => {
    it('rejects a split that does not sum to 10000', async () => {
      const { actor, item, alice } = await setupBase();
      await expect(setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 5000 }], actor)).rejects.toThrow(/10000/);
    });

    it('rejects the same partner listed twice', async () => {
      const { actor, item, alice } = await setupBase();
      await expect(
        setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 5000 }, { partnerId: alice.id, shareBp: 5000 }], actor),
      ).rejects.toThrow(/more than once/);
    });

    it('replacing a split closes the old rows rather than editing them, and getActiveItemOwnership tracks history', async () => {
      const { actor, item, alice, bob } = await setupBase();
      const t0 = new Date();
      await new Promise((r) => setTimeout(r, 5));
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      await new Promise((r) => setTimeout(r, 5));
      const t1 = new Date();
      await new Promise((r) => setTimeout(r, 5));
      await setItemOwnership(
        ctx.db,
        item.id,
        [
          { partnerId: alice.id, shareBp: 5000 },
          { partnerId: bob.id, shareBp: 5000 },
        ],
        actor,
      );

      expect(await getActiveItemOwnership(ctx.db, item.id, t0)).toEqual([]);
      expect(await getActiveItemOwnership(ctx.db, item.id, t1)).toEqual([{ partnerId: alice.id, shareBp: 10_000 }]);
      expect(await getActiveItemOwnership(ctx.db, item.id)).toEqual([
        { partnerId: alice.id, shareBp: 5000 },
        { partnerId: bob.id, shareBp: 5000 },
      ]);
    });
  });

  describe('allocateOrder', () => {
    it('a single-owner item allocates 100% with zero remainder', async () => {
      const { actor, item, alice } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);

      const allocations = await allocateOrder(ctx.db, billed.id, new Date(), actor);
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).toMatchObject({ partnerId: alice.id, amountMinor: billed.netSalesMinor });
    });

    it('sum of all allocations equals the order net sales exactly', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(
        ctx.db,
        item.id,
        [
          { partnerId: alice.id, shareBp: 3334 },
          { partnerId: bob.id, shareBp: 6666 },
        ],
        actor,
      );
      const billed = await billedOrder(item, actor, { qty: 3 });

      const allocations = await allocateOrder(ctx.db, billed.id, new Date(), actor);
      expect(sum(allocations.map((a) => a.amountMinor))).toBe(billed.netSalesMinor);
    });

    it('a 10% order discount reduces each owner\'s allocation by exactly 10%', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(
        ctx.db,
        item.id,
        [
          { partnerId: alice.id, shareBp: 5000 },
          { partnerId: bob.id, shareBp: 5000 },
        ],
        actor,
      );

      const withoutDiscount = await (async () => {
        const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
        await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
        return billOrder(ctx.db, order.id, {}, actor);
      })();
      const baselineAllocations = await allocateOrder(ctx.db, withoutDiscount.id, new Date(), actor);

      const discounted = await billedOrder(item, actor, { discountMinor: 100_00 }); // 10% of Rs 1000
      const discountedAllocations = await allocateOrder(ctx.db, discounted.id, new Date(), actor);

      // Rs 1000 net sales, split 50/50: Rs 500 each before the discount.
      // A 10% discount on an evenly-divisible basket takes exactly 10%
      // off each owner's share with no remainder to worry about: Rs 450
      // each — asserted as concrete numbers, not derived via arithmetic
      // on the Paisa values themselves (only platform/money may do that).
      for (const partnerId of [alice.id, bob.id]) {
        const baseline = baselineAllocations.find((a) => a.partnerId === partnerId)!.amountMinor;
        const discountedAmount = discountedAllocations.find((a) => a.partnerId === partnerId)!.amountMinor;
        expect(baseline).toBe(500_00);
        expect(discountedAmount).toBe(450_00);
      }
    });

    it('rounding adjustment never appears in any partner\'s allocation total', async () => {
      const { actor, alice } = await setupBase();
      const catalogActor = actor;
      const category = await createCategory(ctx.db, { name: 'Odd' }, catalogActor);
      const oddItem = await createItem(ctx.db, { categoryId: category.id, name: 'Odd price' }, catalogActor);
      await setItemPrice(ctx.db, oddItem.id, paisa(99_50), catalogActor); // forces a rounding adjustment
      await setItemOwnership(ctx.db, oddItem.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);

      const billed = await billedOrder(oddItem, actor);
      expect(billed.roundingAdjustmentMinor).not.toBe(0); // sanity: this order actually has a rounding adjustment

      const allocations = await allocateOrder(ctx.db, billed.id, new Date(), actor);
      const totalAllocated = sum(allocations.map((a) => a.amountMinor));
      expect(totalAllocated).toBe(billed.netSalesMinor); // never billed.totalMinor, which includes rounding
      expect(totalAllocated).not.toBe(billed.totalMinor);
    });

    it('enabling tax does not change any partner\'s allocation for the same basket', async () => {
      // No tax module exists yet — simulate "a tax rule is active" by
      // writing tax_minor directly onto a second, otherwise-identical
      // order, the way the tax milestone's pipeline eventually will.
      const { actor, item, alice } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);

      const withoutTax = await billedOrder(item, actor);
      const withoutTaxAllocations = await allocateOrder(ctx.db, withoutTax.id, new Date(), actor);

      const withTax = await billedOrder(item, actor);
      await ctx.db.updateTable('order').set({ tax_minor: paisa(50_00) }).where('id', '=', withTax.id).execute();
      const withTaxAllocations = await allocateOrder(ctx.db, withTax.id, new Date(), actor);

      expect(withTaxAllocations.map((a) => a.amountMinor)).toEqual(withoutTaxAllocations.map((a) => a.amountMinor));
    });

    it('changing ownership after allocation does not alter the already-recorded allocation', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);
      const originalAllocations = await allocateOrder(ctx.db, billed.id, new Date(), actor);

      // Ownership changes completely after the fact.
      await setItemOwnership(ctx.db, item.id, [{ partnerId: bob.id, shareBp: 10_000 }], actor);

      const reloaded = await ctx.db.selectFrom('line_allocation').selectAll().where('order_line_id', '=', originalAllocations[0]!.orderLineId).execute();
      expect(reloaded.map((r) => r.partner_id)).toEqual([alice.id]); // still Alice, not Bob
    });
  });

  describe('reversal', () => {
    it('a refund reverses using the original snapshotted shares even after ownership has since changed', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);
      const [original] = await allocateOrder(ctx.db, billed.id, new Date(), actor);

      await setItemOwnership(ctx.db, item.id, [{ partnerId: bob.id, shareBp: 10_000 }], actor);

      const reversals = await reverseLineAllocations(ctx.db, original!.orderLineId, actor);
      expect(reversals).toHaveLength(1);
      expect(reversals[0]).toMatchObject({
        partnerId: alice.id, // the ORIGINAL owner, not the new one
        shareBpSnapshot: 10_000,
        amountMinor: -original!.amountMinor,
        reversesAllocationId: original!.id,
      });
    });

    it('reverseOrderAllocations reverses every line, and reversals net to zero', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(
        ctx.db,
        item.id,
        [
          { partnerId: alice.id, shareBp: 3000 },
          { partnerId: bob.id, shareBp: 7000 },
        ],
        actor,
      );
      const billed = await billedOrder(item, actor, { qty: 2 });
      const originals = await allocateOrder(ctx.db, billed.id, new Date(), actor);
      const reversals = await reverseOrderAllocations(ctx.db, billed.id, actor);

      expect(reversals).toHaveLength(originals.length);
      expect(sum([...originals, ...reversals].map((a) => a.amountMinor))).toBe(0);
    });

    it('reversing the same line twice does not double-reverse', async () => {
      const { actor, item, alice } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      const billed = await billedOrder(item, actor);
      const [original] = await allocateOrder(ctx.db, billed.id, new Date(), actor);

      const first = await reverseLineAllocations(ctx.db, original!.orderLineId, actor);
      const second = await reverseLineAllocations(ctx.db, original!.orderLineId, actor);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });
  });

  describe('checkOwnershipIntegrity', () => {
    it('reports no violations for a correctly-configured item', async () => {
      const { actor, item, alice, bob } = await setupBase();
      await setItemOwnership(
        ctx.db,
        item.id,
        [
          { partnerId: alice.id, shareBp: 4000 },
          { partnerId: bob.id, shareBp: 6000 },
        ],
        actor,
      );
      expect(await checkOwnershipIntegrity(ctx.db)).toEqual([]);
    });

    it('does not flag an item with no ownership configured at all', async () => {
      const { item } = await setupBase();
      const violations = await checkOwnershipIntegrity(ctx.db);
      expect(violations.find((v) => v.kind === 'item' && v.id === item.id)).toBeUndefined();
    });

    it('flags an item whose active shares sum to something other than 10000 or 0', async () => {
      const { item, alice } = await setupBase();
      // Bypass the service layer's write-time guard entirely, simulating
      // a bad state the guard is supposed to have prevented.
      await ctx.db
        .insertInto('item_ownership')
        .values({ item_id: item.id, partner_id: alice.id, share_bp: 4000, valid_from: new Date().toISOString(), valid_to: null })
        .execute();

      const violations = await checkOwnershipIntegrity(ctx.db);
      expect(violations).toContainEqual({ kind: 'item', id: item.id, totalShareBp: 4000 });
    });
  });

  describe('setOwnershipForCategories', () => {
    it('applies one split to every active item in the chosen categories', async () => {
      const { actor, alice, bob, category, item } = await setupBase();
      const second = await createItem(ctx.db, { categoryId: category.id, name: 'Biryani' }, actor);
      const otherCategory = await createCategory(ctx.db, { name: 'Drinks' }, actor);
      const untouched = await createItem(ctx.db, { categoryId: otherCategory.id, name: 'Tea' }, actor);

      const { itemIds } = await setOwnershipForCategories(
        ctx.db,
        [category.id],
        [
          { partnerId: alice.id, shareBp: 8000 },
          { partnerId: bob.id, shareBp: 2000 },
        ],
        actor,
      );

      expect(itemIds).toEqual([item.id, second.id]);
      for (const id of itemIds) {
        expect(await getActiveItemOwnership(ctx.db, id)).toEqual([
          { partnerId: alice.id, shareBp: 8000 },
          { partnerId: bob.id, shareBp: 2000 },
        ]);
      }
      // A category nobody picked is left exactly as it was.
      expect(await getActiveItemOwnership(ctx.db, untouched.id)).toEqual([]);
    });

    it('closes the previous split rather than overwriting it, and audits each item', async () => {
      const { actor, alice, bob, category, item } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);

      await setOwnershipForCategories(
        ctx.db,
        [category.id],
        [
          { partnerId: alice.id, shareBp: 5000 },
          { partnerId: bob.id, shareBp: 5000 },
        ],
        actor,
      );

      const rows = await ctx.db.selectFrom('item_ownership').selectAll().where('item_id', '=', item.id).orderBy('id', 'asc').execute();
      expect(rows).toHaveLength(3);
      expect(rows[0]!.valid_to).not.toBeNull(); // the 100% row was closed, not edited
      expect(rows.slice(1).every((r) => r.valid_to === null)).toBe(true);

      // A bulk change is still a change to this item's money, and the
      // log should say so item by item.
      const audits = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'item.set_ownership').where('entity_id', '=', String(item.id)).execute();
      expect(audits).toHaveLength(2);
    });

    it('skips retired items, refuses an unbalanced split, and refuses an unknown category', async () => {
      const { actor, alice, bob, category, item } = await setupBase();
      const retired = await createItem(ctx.db, { categoryId: category.id, name: 'Old dish' }, actor);
      expect(await removeItem(ctx.db, retired.id, actor)).toBe('deleted');
      const stillThere = await createItem(ctx.db, { categoryId: category.id, name: 'Kept' }, actor);
      await ctx.db.updateTable('item').set({ active: 0 }).where('id', '=', stillThere.id).execute();

      const balanced = [
        { partnerId: alice.id, shareBp: 8000 },
        { partnerId: bob.id, shareBp: 2000 },
      ];
      const { itemIds } = await setOwnershipForCategories(ctx.db, [category.id], balanced, actor);
      expect(itemIds).toEqual([item.id]); // the deactivated item is not touched

      await expect(setOwnershipForCategories(ctx.db, [category.id], [{ partnerId: alice.id, shareBp: 9000 }], actor)).rejects.toThrow(
        /sum to exactly 10000/,
      );
      await expect(setOwnershipForCategories(ctx.db, [category.id + 999], balanced, actor)).rejects.toThrow(/not found/);
      await expect(setOwnershipForCategories(ctx.db, [], balanced, actor)).rejects.toThrow(/at least one category/);
    });

    it('leaves nothing half-written when one item in the batch fails', async () => {
      const { actor, alice, category, item } = await setupBase();
      const second = await createItem(ctx.db, { categoryId: category.id, name: 'Biryani' }, actor);

      // A partner id that does not exist trips the foreign key on the
      // SECOND item, after the first has already been written.
      await expect(
        setOwnershipForCategories(
          ctx.db,
          [category.id],
          [
            { partnerId: alice.id, shareBp: 5000 },
            { partnerId: 9999, shareBp: 5000 },
          ],
          actor,
        ),
      ).rejects.toThrow();

      expect(await getActiveItemOwnership(ctx.db, item.id)).toEqual([]);
      expect(await getActiveItemOwnership(ctx.db, second.id)).toEqual([]);
    });
  });

  describe('listItemsWithoutOwnership', () => {
    it('lists active items nobody owns, and drops them once a split is set', async () => {
      const { actor, alice, category, item } = await setupBase();
      const second = await createItem(ctx.db, { categoryId: category.id, name: 'Biryani' }, actor);

      expect(await listItemsWithoutOwnership(ctx.db)).toEqual([item.id, second.id]);

      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      expect(await listItemsWithoutOwnership(ctx.db)).toEqual([second.id]);

      // Retired items can't be sold, so they are not waiting on anything.
      await ctx.db.updateTable('item').set({ active: 0 }).where('id', '=', second.id).execute();
      expect(await listItemsWithoutOwnership(ctx.db)).toEqual([]);
    });

    it('reports an item whose only ownership rows have been closed', async () => {
      const { actor, alice, item } = await setupBase();
      await setItemOwnership(ctx.db, item.id, [{ partnerId: alice.id, shareBp: 10_000 }], actor);
      await ctx.db.updateTable('item_ownership').set({ valid_to: new Date().toISOString() }).where('item_id', '=', item.id).execute();
      expect(await listItemsWithoutOwnership(ctx.db)).toContain(item.id);
    });
  });

  describe('scheduleOwnershipIntegrityCheck', () => {
    it('runs the check on the given interval and logs when it finds a violation', async () => {
      vi.useFakeTimers();
      try {
        const { item, alice } = await setupBase();
        await ctx.db
          .insertInto('item_ownership')
          .values({ item_id: item.id, partner_id: alice.id, share_bp: 4000, valid_from: new Date().toISOString(), valid_to: null })
          .execute();

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const cancel = scheduleOwnershipIntegrityCheck(ctx.db, 1000);

        await vi.advanceTimersByTimeAsync(1000);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('violation'), expect.arrayContaining([expect.objectContaining({ id: item.id })]));

        cancel();
        errorSpy.mockClear();
        await vi.advanceTimersByTimeAsync(5000);
        expect(errorSpy).not.toHaveBeenCalled(); // cancelled — no further runs

        errorSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
