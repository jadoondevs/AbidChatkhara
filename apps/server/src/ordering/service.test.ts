import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCategory, createItem, createModifier, createModifierGroup, linkModifierGroup, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { eventBus } from '../platform/events/bus.js';
import {
  addLine,
  billOrder,
  createOrder,
  getOrder,
  listOrders,
  OrderStateError,
  reopenOrder,
  setDiscount,
  voidLine,
  voidOrder,
} from './service.js';

describe('ordering/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupMenu() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const catalogActor = { actorId: admin.id, terminalId: 'seed' };
    const server = await createUser(ctx.db, { name: 'Server', pin: '1111', role: 'server' }, catalogActor);

    const category = await createCategory(ctx.db, { name: 'Mains' }, catalogActor);
    // Plain item, no modifier groups linked — most tests here are about
    // order lifecycle, not modifier selection, and shouldn't have to
    // satisfy an unrelated "choose one" rule on every addLine call.
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, catalogActor);
    await setItemPrice(ctx.db, item.id, paisa(500_00), catalogActor);

    // A second item WITH a mandatory modifier group, for the tests that
    // are specifically about modifier selection.
    const itemWithModifiers = await createItem(ctx.db, { categoryId: category.id, name: 'Biryani' }, catalogActor);
    await setItemPrice(ctx.db, itemWithModifiers.id, paisa(500_00), catalogActor);
    const group = await createModifierGroup(ctx.db, { name: 'Spice level', minSelect: 1, maxSelect: 1 }, catalogActor);
    const mild = await createModifier(ctx.db, { groupId: group.id, name: 'Mild', priceDeltaMinor: paisa(0) }, catalogActor);
    const extraHot = await createModifier(ctx.db, { groupId: group.id, name: 'Extra hot', priceDeltaMinor: paisa(20_00) }, catalogActor);
    await linkModifierGroup(ctx.db, itemWithModifiers.id, group.id, catalogActor);

    const orderActor = { actorId: server.id, terminalId: 'till-1' };
    return { admin, server, item, itemWithModifiers, group, mild, extraHot, orderActor };
  }

  describe('createOrder', () => {
    it('opens a dine_in order given a waiter and table', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T4', waiterId: orderActor.actorId }, orderActor);
      expect(order).toMatchObject({ orderType: 'dine_in', tableLabel: 'T4', waiterId: orderActor.actorId, status: 'open' });
    });

    it('rejects a dine_in order with no waiter or table', async () => {
      const { orderActor } = await setupMenu();
      await expect(createOrder(ctx.db, { orderType: 'dine_in' }, orderActor)).rejects.toThrow(/require a waiter/);
      await expect(createOrder(ctx.db, { orderType: 'dine_in', waiterId: orderActor.actorId }, orderActor)).rejects.toThrow(
        /require a table label/,
      );
    });

    it('opens a takeaway order with no waiter or table required', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      expect(order).toMatchObject({ orderType: 'takeaway', tableLabel: null, waiterId: null, status: 'open' });
    });

    it('rejects an unknown waiter id', async () => {
      const { orderActor } = await setupMenu();
      await expect(createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T1', waiterId: 99999 }, orderActor)).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe('addLine', () => {
    it('snapshots the current catalog price and computes the line total', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 2 }, orderActor);

      expect(detail.lines[0]).toMatchObject({ itemId: item.id, qty: 2, unitPriceMinor: 500_00, grossMinor: 1_000_00, netSalesMinor: 1_000_00 });
      expect(detail.subtotalMinor).toBe(1_000_00);
    });

    it('includes modifiers in the line gross and validates the group selection', async () => {
      const { itemWithModifiers, extraHot, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [extraHot.id] }, orderActor);

      expect(detail.lines[0]?.grossMinor).toBe(520_00);
      expect(detail.lines[0]?.modifiers[0]).toMatchObject({ modifierId: extraHot.id, grossMinor: 20_00 });
    });

    it('rejects a selection that violates the modifier group min/max', async () => {
      const { itemWithModifiers, mild, extraHot, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      // Spice level requires exactly 1 selection.
      await expect(addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [] }, orderActor)).rejects.toThrow(
        /requires between 1 and 1/,
      );
      await expect(
        addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id, extraHot.id] }, orderActor),
      ).rejects.toThrow(/requires between 1 and 1/);
    });

    it('rejects a modifier not linked to the item', async () => {
      const { itemWithModifiers, orderActor } = await setupMenu();
      const catalogActor = { actorId: orderActor.actorId, terminalId: 'seed' };
      const otherGroup = await createModifierGroup(ctx.db, { name: 'Unrelated', minSelect: 0, maxSelect: 1 }, catalogActor);
      const unrelatedModifier = await createModifier(ctx.db, { groupId: otherGroup.id, name: 'x', priceDeltaMinor: paisa(0) }, catalogActor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await expect(
        addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [unrelatedModifier.id] }, orderActor),
      ).rejects.toThrow(/does not belong to a modifier group linked to item/);
    });

    it('rejects adding a line to a non-open order', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await billOrder(ctx.db, order.id, {}, orderActor);

      await expect(addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor)).rejects.toThrow(OrderStateError);
    });

    it('rejects an item with no price set', async () => {
      const { orderActor } = await setupMenu();
      const catalogActor = { actorId: orderActor.actorId, terminalId: 'seed' };
      const category = await createCategory(ctx.db, { name: 'New' }, catalogActor);
      const unpriced = await createItem(ctx.db, { categoryId: category.id, name: 'Unpriced' }, catalogActor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      await expect(addLine(ctx.db, order.id, { itemId: unpriced.id, qty: 1 }, orderActor)).rejects.toThrow(/no price set/);
    });

    it('recomputes discount proration across all lines when a new line is added', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor); // Rs 500
      await setDiscount(ctx.db, order.id, { discountMinor: paisa(50_00), reason: 'loyalty' }, orderActor); // 10%

      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor); // now two Rs-500 lines
      expect(detail.subtotalMinor).toBe(1_000_00);
      // 50 discount split across two equal Rs-500 lines: 25 each.
      expect(detail.lines[0]?.proratedDiscountMinor).toBe(25_00);
      expect(detail.lines[1]?.proratedDiscountMinor).toBe(25_00);
    });
  });

  describe('voidLine', () => {
    it('excludes a voided line from the order totals and requires a reason', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      const withSecondLine = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      const lineToVoid = withSecondLine.lines[0]!.id;

      const detail = await voidLine(ctx.db, order.id, lineToVoid, { reason: 'customer changed mind' }, orderActor);
      expect(detail.lines.find((l) => l.id === lineToVoid)?.voided).toBe(true);
      expect(detail.subtotalMinor).toBe(500_00); // only the remaining line counts
    });

    it('rejects voiding an already-voided line', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      const lineId = detail.lines[0]!.id;
      await voidLine(ctx.db, order.id, lineId, { reason: 'a' }, orderActor);
      await expect(voidLine(ctx.db, order.id, lineId, { reason: 'b' }, orderActor)).rejects.toThrow(/already voided/);
    });

    it('requires a non-empty reason', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await expect(voidLine(ctx.db, order.id, detail.lines[0]!.id, { reason: '  ' }, orderActor)).rejects.toThrow(/reason is required/);
    });
  });

  describe('setDiscount', () => {
    it('rejects a discount exceeding the subtotal', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor); // Rs 500
      await expect(setDiscount(ctx.db, order.id, { discountMinor: paisa(600_00), reason: 'x' }, orderActor)).rejects.toThrow(
        /exceeds subtotal/,
      );
    });

    it('requires a reason for a non-zero discount', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await expect(setDiscount(ctx.db, order.id, { discountMinor: paisa(50_00) }, orderActor)).rejects.toThrow(/reason is required/);
    });

    it('allows clearing a discount back to zero without a reason', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await setDiscount(ctx.db, order.id, { discountMinor: paisa(50_00), reason: 'x' }, orderActor);
      const cleared = await setDiscount(ctx.db, order.id, { discountMinor: paisa(0) }, orderActor);
      expect(cleared.orderDiscountMinor).toBe(0);
      expect(cleared.discountReason).toBeNull();
    });
  });

  describe('billOrder', () => {
    it('computes tax(0) + service charge + rounding into the total and transitions to billed', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T1', waiterId: orderActor.actorId }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor); // Rs 500 net sales

      const billed = await billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(25_00) }, orderActor);
      // pre-round = 500 + 0 (tax) + 25 (service charge) = 525, already a whole rupee.
      expect(billed).toMatchObject({ status: 'billed', taxMinor: 0, serviceChargeMinor: 25_00, roundingAdjustmentMinor: 0, totalMinor: 525_00 });
      expect(billed.billedAt).not.toBeNull();
    });

    it('rounds a non-whole-rupee total and records the adjustment', async () => {
      const { orderActor } = await setupMenu();
      const catalogActor = { actorId: orderActor.actorId, terminalId: 'seed' };
      const category = await createCategory(ctx.db, { name: 'Odd' }, catalogActor);
      const oddItem = await createItem(ctx.db, { categoryId: category.id, name: 'Odd price' }, catalogActor);
      await setItemPrice(ctx.db, oddItem.id, paisa(499_50), catalogActor); // Rs 499.50

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: oddItem.id, qty: 1, modifierIds: [] }, orderActor);
      const billed = await billOrder(ctx.db, order.id, {}, orderActor);

      expect(billed.roundingAdjustmentMinor).toBe(50); // rounds up to Rs 500
      expect(billed.totalMinor).toBe(500_00);
    });

    it('rejects service charge on an order with no waiter', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await expect(billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(10_00) }, orderActor)).rejects.toThrow(
        /service charge requires a waiter/,
      );
    });

    it('rejects billing an order with no lines', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await expect(billOrder(ctx.db, order.id, {}, orderActor)).rejects.toThrow(/no items to bill/);
    });

    it('may be reprinted without changing state — reading the order twice returns identical totals', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await billOrder(ctx.db, order.id, {}, orderActor);

      const first = await getOrder(ctx.db, order.id);
      const second = await getOrder(ctx.db, order.id);
      expect(first).toEqual(second);
    });
  });

  describe('reopenOrder', () => {
    it('returns a billed order to open and clears billed_at', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await billOrder(ctx.db, order.id, {}, orderActor);

      const reopened = await reopenOrder(ctx.db, order.id, orderActor);
      expect(reopened.status).toBe('open');
      expect(reopened.billedAt).toBeNull();

      // and lines can be added again now that it's open.
      const afterAdd = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      expect(afterAdd.lines).toHaveLength(2);
    });

    it('rejects reopening an order that is not billed', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await expect(reopenOrder(ctx.db, order.id, orderActor)).rejects.toThrow(/not billed/);
    });
  });

  describe('voidOrder', () => {
    it('voids an open order and emits OrderVoided', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      const events: unknown[] = [];
      eventBus.on('OrderVoided', (e) => events.push(e));
      const voided = await voidOrder(ctx.db, order.id, { reason: 'mistaken order' }, orderActor);

      expect(voided.status).toBe('voided');
      expect(events).toEqual([{ orderId: order.id, reason: 'mistaken order', voidedBy: orderActor.actorId, voidedAt: expect.any(String) }]);
    });

    it('rejects voiding an order that is already voided', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await voidOrder(ctx.db, order.id, { reason: 'a' }, orderActor);
      await expect(voidOrder(ctx.db, order.id, { reason: 'b' }, orderActor)).rejects.toThrow(/already voided/);
    });
  });

  describe('listOrders and no-current-order concurrency', () => {
    it('every order is independently addressable — working on one never blocks another', async () => {
      const { item, orderActor } = await setupMenu();
      const a = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const b = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      await addLine(ctx.db, a.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await addLine(ctx.db, b.id, { itemId: item.id, qty: 3, modifierIds: [] }, orderActor);

      const [orderA, orderB] = await Promise.all([getOrder(ctx.db, a.id), getOrder(ctx.db, b.id)]);
      expect(orderA?.subtotalMinor).toBe(500_00);
      expect(orderB?.subtotalMinor).toBe(1_500_00);
    });

    it('listOrders filters by status and orders oldest-first', async () => {
      const { item, orderActor } = await setupMenu();
      const open1 = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const open2 = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, open2.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await billOrder(ctx.db, open2.id, {}, orderActor);

      const openOrders = await listOrders(ctx.db, { status: ['open'] });
      expect(openOrders.map((o) => o.id)).toEqual([open1.id]);

      const billedOrders = await listOrders(ctx.db, { status: ['billed'] });
      expect(billedOrders.map((o) => o.id)).toEqual([open2.id]);
    });

    it('two concurrent attempts to bill the same order: exactly one succeeds, the other gets a clean state error', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);

      const results = await Promise.allSettled([billOrder(ctx.db, order.id, {}, orderActor), billOrder(ctx.db, order.id, {}, orderActor)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OrderStateError);
    });
  });
});
