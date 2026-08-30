import { paisa, sum } from '@pos/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import {
  allocateOrder,
  checkOwnershipIntegrity,
  createPartner,
  getActiveItemOwnership,
  listPartners,
  reverseLineAllocations,
  reverseOrderAllocations,
  scheduleOwnershipIntegrityCheck,
  setItemOwnership,
  setPartnerActive,
} from './service.js';

describe('partners/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
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
