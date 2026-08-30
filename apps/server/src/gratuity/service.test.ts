import { paisa, sum } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentMethod, recordPayment, refundOrder } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { recordServiceChargeEntry, reverseServiceChargeEntries, waiterPayoutTotals } from './service.js';

describe('gratuity/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };
    const waiter = await createUser(ctx.db, { name: 'Bilal', pin: '1111', role: 'server' }, actor);

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1000_00), actor);
    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);

    return { admin, actor, waiter, item, partner, cash };
  }

  /** Opens a dine_in order with the given waiter, bills it with a
   * service charge, and closes it via a full cash payment. */
  async function closedOrderWithServiceCharge(
    item: { id: number },
    waiterId: number,
    cashId: number,
    actor: { actorId: number; terminalId: string },
    serviceChargeMinor = paisa(50_00),
  ) {
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T1', waiterId }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, { serviceChargeMinor }, actor);
    const { order: closed } = await recordPayment(ctx.db, order.id, { paymentMethodId: cashId, amountMinor: billed.totalMinor }, actor);
    return closed;
  }

  describe('recordServiceChargeEntryInTransaction / recordServiceChargeEntry', () => {
    it('is a no-op when the order has no service charge', async () => {
      const { actor, item, waiter } = await setupBase();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T1', waiterId: waiter.id }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, order.id, {}, actor); // no service charge

      const result = await recordServiceChargeEntry(ctx.db, order.id, actor);
      expect(result).toBeNull();
      expect(await ctx.db.selectFrom('service_charge_entry').selectAll().execute()).toEqual([]);
    });

    it('throws if a non-zero service charge exists with no waiter (defensive — should be unreachable via billOrder)', async () => {
      const { actor, item } = await setupBase();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, order.id, {}, actor);
      // Bypass ordering's own guard to simulate a corrupted state.
      await ctx.db.updateTable('order').set({ service_charge_minor: paisa(50_00) }).where('id', '=', order.id).execute();

      await expect(recordServiceChargeEntry(ctx.db, order.id, actor)).rejects.toThrow(/no waiter/);
    });
  });

  describe('closing an order (via billing) records the service charge entry', () => {
    it('attributes the entry directly to the order\'s waiter, no pooling', async () => {
      const { actor, item, waiter, cash } = await setupBase();
      const closed = await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(50_00));

      const entries = await ctx.db.selectFrom('service_charge_entry').selectAll().where('order_id', '=', closed.id).execute();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ waiter_id: waiter.id, amount_minor: 50_00 });
    });

    it('is excluded from net sales and the partner allocation base — never appears in line_allocation', async () => {
      const { actor, item, waiter, partner, cash } = await setupBase();
      const closed = await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(50_00));

      expect(closed.netSalesMinor).toBe(1000_00); // service charge not included
      expect(closed.totalMinor).toBe(1050_00); // but it IS included in the total (spec)

      const allocations = await ctx.db.selectFrom('line_allocation').selectAll().execute();
      expect(sum(allocations.map((a) => a.amount_minor))).toBe(1000_00); // exactly net sales, not total
      expect(allocations.every((a) => a.partner_id === partner.id)).toBe(true); // no partner gets a slice of it
    });
  });

  describe('reverseServiceChargeEntries', () => {
    it('a full-order refund reverses the entry', async () => {
      const { actor, item, waiter, cash } = await setupBase();
      const closed = await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(50_00));

      await refundOrder(ctx.db, closed.id, { reason: 'complaint' }, actor);

      const entries = await ctx.db.selectFrom('service_charge_entry').selectAll().where('order_id', '=', closed.id).execute();
      expect(entries).toHaveLength(2); // original + reversal
      expect(sum(entries.map((e) => e.amount_minor))).toBe(0);
    });

    it('is safe to call more than once — does not double-reverse', async () => {
      const { actor, item, waiter, cash } = await setupBase();
      const closed = await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(50_00));

      const first = await reverseServiceChargeEntries(ctx.db, closed.id, actor);
      const second = await reverseServiceChargeEntries(ctx.db, closed.id, actor);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('a partial, single-line refund does NOT reverse the service charge', async () => {
      const { actor, item, waiter, cash } = await setupBase();
      const closed = await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(50_00));
      const [line] = await ctx.db.selectFrom('order_line').selectAll().where('order_id', '=', closed.id).execute();

      await refundOrder(ctx.db, closed.id, { reason: 'wrong item', orderLineId: line!.id }, actor);

      const entries = await ctx.db.selectFrom('service_charge_entry').selectAll().where('order_id', '=', closed.id).execute();
      expect(entries).toHaveLength(1); // untouched — the waiter is still owed it
    });
  });

  describe('waiterPayoutTotals', () => {
    it('sums each waiter\'s entries, net of any reversal', async () => {
      const { actor, item, waiter, cash } = await setupBase();
      const otherWaiter = await createUser(ctx.db, { name: 'Ahmed', pin: '2222', role: 'server' }, actor);

      await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(50_00));
      await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(30_00));
      const otherClosed = await closedOrderWithServiceCharge(item, otherWaiter.id, cash.id, actor, paisa(20_00));
      await refundOrder(ctx.db, otherClosed.id, { reason: 'x' }, actor); // fully reversed

      const payout = await waiterPayoutTotals(ctx.db);
      expect(payout).toEqual([{ waiterId: waiter.id, waiterName: 'Bilal', totalMinor: 80_00 }]); // Ahmed nets to zero, excluded
    });

    it('filters by a date range', async () => {
      const { actor, item, waiter, cash } = await setupBase();
      await closedOrderWithServiceCharge(item, waiter.id, cash.id, actor, paisa(50_00));

      const future = new Date(Date.now() + 60_000).toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();
      expect(await waiterPayoutTotals(ctx.db, { fromInclusive: future })).toEqual([]);
      expect(await waiterPayoutTotals(ctx.db, { fromInclusive: past })).toHaveLength(1);
    });
  });
});
