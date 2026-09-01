import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCategory, createItem, createModifier, createModifierGroup, linkModifierGroup, setItemPrice } from '../catalog/service.js';
import { createPaymentMethod, recordPayment } from '../billing/service.js';
import { createPerson } from '../consumption/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createUser } from '../identity/service.js';
import { createTestDb, enableServiceCharge } from '../platform/db/test-helpers.js';
import { eventBus } from '../platform/events/bus.js';
import {
  addLine,
  billOrder,
  createOrder,
  getFloorBoard,
  getOrder,
  listOrders,
  MAX_LINE_QTY,
  OrderStateError,
  previewBillTotals,
  removeLine,
  reopenOrder,
  setDiscount,
  setLineNote,
  setLineQty,
  setOrderCustomer,
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
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const catalogActor = { actorId: admin.id, terminalId: 'seed' };
    const server = await createUser(ctx.db, { name: 'Server', username: 'server', password: '1111', role: 'server' }, catalogActor);

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
    // Several tests here bill with a hand-entered service charge,
    // which a disabled charge refuses (see computeServiceCharge).
    await enableServiceCharge(ctx.db, catalogActor);
    return { admin, server, item, itemWithModifiers, group, mild, extraHot, orderActor };
  }

  describe('createOrder', () => {
    it('opens a dine_in order given a waiter and table', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T4', waiterId: orderActor.actorId }, orderActor);
      expect(order).toMatchObject({ orderType: 'dine_in', tableLabel: 'T4', waiterId: orderActor.actorId, status: 'open' });
    });

    it('rejects a dine_in order with no waiter', async () => {
      const { orderActor } = await setupMenu();
      await expect(createOrder(ctx.db, { orderType: 'dine_in' }, orderActor)).rejects.toThrow(/require a waiter/);
    });

    it('opens a dine_in order with no table label — a counter sale is still dine_in', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', waiterId: orderActor.actorId }, orderActor);
      expect(order).toMatchObject({ orderType: 'dine_in', tableLabel: null, status: 'open' });
    });

    it('treats a blank table label as no table rather than storing whitespace', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: '   ', waiterId: orderActor.actorId }, orderActor);
      expect(order.tableLabel).toBeNull();
    });

    it('trims a table label it does keep', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: '  T4 ', waiterId: orderActor.actorId }, orderActor);
      expect(order.tableLabel).toBe('T4');
    });

    it('opens takeaway and delivery orders with no table', async () => {
      const { orderActor } = await setupMenu();
      const takeaway = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const delivery = await createOrder(ctx.db, { orderType: 'delivery' }, orderActor);
      expect(takeaway.tableLabel).toBeNull();
      expect(delivery.tableLabel).toBeNull();
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

  describe('createOrder — staff and owner meals', () => {
    async function setupPeople(orderActor: { actorId: number; terminalId: string }) {
      const staffPerson = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'free' }, orderActor);
      const partnerPerson = await createPerson(ctx.db, { name: 'Alice', kind: 'partner', mealPolicy: 'discounted', mealDiscountBp: 5_000 }, orderActor);
      const inactivePerson = await createPerson(ctx.db, { name: 'Left', kind: 'staff', mealPolicy: 'free' }, orderActor);
      await ctx.db.updateTable('person').set({ active: 0 }).where('id', '=', inactivePerson.id).execute();
      return { staffPerson, partnerPerson, inactivePerson };
    }

    it('opens a staff_meal order for a staff-kind person', async () => {
      const { orderActor } = await setupMenu();
      const { staffPerson } = await setupPeople(orderActor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: staffPerson.id }, orderActor);
      expect(order).toMatchObject({ channel: 'staff_meal', beneficiaryPersonId: staffPerson.id });
    });

    it('opens an owner_meal order for a partner-kind person', async () => {
      const { orderActor } = await setupMenu();
      const { partnerPerson } = await setupPeople(orderActor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'owner_meal', beneficiaryPersonId: partnerPerson.id }, orderActor);
      expect(order).toMatchObject({ channel: 'owner_meal', beneficiaryPersonId: partnerPerson.id });
    });

    it('rejects a staff_meal/owner_meal order with no beneficiary person', async () => {
      const { orderActor } = await setupMenu();
      await expect(createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal' }, orderActor)).rejects.toThrow(/require a beneficiary person/);
    });

    it('rejects a staff_meal order given a partner-kind person, and vice versa', async () => {
      const { orderActor } = await setupMenu();
      const { staffPerson, partnerPerson } = await setupPeople(orderActor);
      await expect(
        createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: partnerPerson.id }, orderActor),
      ).rejects.toThrow(/kind 'staff'/);
      await expect(
        createOrder(ctx.db, { orderType: 'takeaway', channel: 'owner_meal', beneficiaryPersonId: staffPerson.id }, orderActor),
      ).rejects.toThrow(/kind 'partner'/);
    });

    it('rejects an inactive beneficiary person', async () => {
      const { orderActor } = await setupMenu();
      const { inactivePerson } = await setupPeople(orderActor);
      await expect(
        createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: inactivePerson.id }, orderActor),
      ).rejects.toThrow(/not active/);
    });

    it('rejects a beneficiaryPersonId on a plain customer order', async () => {
      const { orderActor } = await setupMenu();
      const { staffPerson } = await setupPeople(orderActor);
      await expect(createOrder(ctx.db, { orderType: 'takeaway', beneficiaryPersonId: staffPerson.id }, orderActor)).rejects.toThrow(
        /only valid for staff_meal\/owner_meal/,
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
      const { item, itemWithModifiers, mild, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor); // Rs 500
      await setDiscount(ctx.db, order.id, { discountMinor: paisa(50_00), reason: 'loyalty' }, orderActor); // 10%

      // A DIFFERENT item, so this is genuinely a second line rather than
      // a repeat tap merging into the first (see addLine).
      const detail = await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id] }, orderActor);
      expect(detail.subtotalMinor).toBe(1_000_00);
      // 50 discount split across two equal Rs-500 lines: 25 each.
      expect(detail.lines[0]?.proratedDiscountMinor).toBe(25_00);
      expect(detail.lines[1]?.proratedDiscountMinor).toBe(25_00);
    });
  });

  describe('voidLine', () => {
    it('excludes a voided line from the order totals and requires a reason', async () => {
      const { item, itemWithModifiers, mild, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      const withSecondLine = await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id] }, orderActor);
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
      await expect(voidLine(ctx.db, order.id, lineId, { reason: 'b' }, orderActor)).rejects.toThrow(/already off this order/);
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

    it('rejects a non-zero discount on a staff/owner meal order — always full menu price', async () => {
      const { item, orderActor } = await setupMenu();
      const staffPerson = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'free' }, orderActor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: staffPerson.id }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [] }, orderActor);
      await expect(setDiscount(ctx.db, order.id, { discountMinor: paisa(50_00), reason: 'x' }, orderActor)).rejects.toThrow(
        /full menu price/,
      );
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

  // -------------------------------------------------------------------
  // Item selection: tap-to-add, quantity, removal
  // -------------------------------------------------------------------

  describe('tapping an item repeatedly', () => {
    it('increments the existing line rather than stacking identical rows', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      expect(detail.lines).toHaveLength(1);
      expect(detail.lines[0]?.qty).toBe(3);
      expect(detail.subtotalMinor).toBe(1_500_00);
    });

    it('merges only when the modifiers match exactly', async () => {
      const { itemWithModifiers, mild, extraHot, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id] }, orderActor);
      const twoKinds = await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [extraHot.id] }, orderActor);
      expect(twoKinds.lines).toHaveLength(2);

      const backToMild = await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id] }, orderActor);
      expect(backToMild.lines).toHaveLength(2);
      expect(backToMild.lines.find((l) => l.modifiers[0]?.modifierId === mild.id)?.qty).toBe(2);
    });

    it('starts a new line instead of merging once the order has been billed', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      await billOrder(ctx.db, order.id, {}, orderActor);
      await reopenOrder(ctx.db, order.id, orderActor);

      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      expect(detail.lines).toHaveLength(2);
    });

    it('refuses a quantity beyond the typo guard', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await expect(addLine(ctx.db, order.id, { itemId: item.id, qty: MAX_LINE_QTY + 1 }, orderActor)).rejects.toThrow(/implausible/);
    });
  });

  describe('setLineQty', () => {
    it('sets a typed quantity outright and recomputes the totals', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      const lineId = added.lines[0]!.id;

      const detail = await setLineQty(ctx.db, order.id, lineId, { qty: 5 }, orderActor);
      expect(detail.lines[0]?.qty).toBe(5);
      expect(detail.subtotalMinor).toBe(2_500_00);
      expect(detail.netSalesMinor).toBe(2_500_00);
    });

    it('can lower a quantity as well as raise it', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 4 }, orderActor);

      const detail = await setLineQty(ctx.db, order.id, added.lines[0]!.id, { qty: 2 }, orderActor);
      expect(detail.subtotalMinor).toBe(1_000_00);
    });

    it('refuses zero, negative, fractional and implausible quantities', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      const lineId = added.lines[0]!.id;

      await expect(setLineQty(ctx.db, order.id, lineId, { qty: 0 }, orderActor)).rejects.toThrow(/positive integer/);
      await expect(setLineQty(ctx.db, order.id, lineId, { qty: -1 }, orderActor)).rejects.toThrow(/positive integer/);
      await expect(setLineQty(ctx.db, order.id, lineId, { qty: 1.5 }, orderActor)).rejects.toThrow(/positive integer/);
      await expect(setLineQty(ctx.db, order.id, lineId, { qty: MAX_LINE_QTY + 1 }, orderActor)).rejects.toThrow(/implausible/);
    });

    it('refuses to change the quantity of a line that is off the bill', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      const lineId = added.lines[0]!.id;
      await removeLine(ctx.db, order.id, lineId, orderActor);

      await expect(setLineQty(ctx.db, order.id, lineId, { qty: 2 }, orderActor)).rejects.toThrow(/off this order/);
    });
  });

  describe('removeLine — a correction, not a void', () => {
    it('takes a mis-tapped line off an un-billed order with no reason and no manager', async () => {
      const { item, itemWithModifiers, mild, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id] }, orderActor);

      const detail = await removeLine(ctx.db, order.id, added.lines[0]!.id, orderActor);
      const removed = detail.lines.find((l) => l.id === added.lines[0]!.id);
      expect(removed?.voided).toBe(true);
      expect(removed?.voidKind).toBe('correction');
      expect(removed?.voidReason).toBeNull();
      // A correction is nobody's approval — recording one would be a lie.
      expect(removed?.voidApprovedBy).toBeNull();
      expect(detail.subtotalMinor).toBe(500_00);
    });

    it('keeps the row rather than deleting it, so the bill stays reconstructable', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 2 }, orderActor);
      await removeLine(ctx.db, order.id, added.lines[0]!.id, orderActor);

      const rows = await ctx.db.selectFrom('order_line').selectAll().where('order_id', '=', order.id).execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.qty).toBe(2);
    });

    it('records the correction in the audit log, distinctly from a void', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      await removeLine(ctx.db, order.id, added.lines[0]!.id, orderActor);

      const entries = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'order.remove_line').execute();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor_id).toBe(orderActor.actorId);
    });

    it('refuses once the order has been billed — that is a void, and needs a manager', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      await billOrder(ctx.db, order.id, {}, orderActor);
      await reopenOrder(ctx.db, order.id, orderActor);

      await expect(removeLine(ctx.db, order.id, added.lines[0]!.id, orderActor)).rejects.toThrow(/needs a manager and a reason/);
    });

    it('marks a manager-approved removal as a void, with its reason and approver', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      const detail = await voidLine(ctx.db, order.id, added.lines[0]!.id, { reason: 'customer changed mind' }, orderActor);
      const line = detail.lines[0];
      expect(line?.voidKind).toBe('void');
      expect(line?.voidReason).toBe('customer changed mind');
      expect(line?.voidApprovedBy).toBe(orderActor.actorId);
    });
  });

  // -------------------------------------------------------------------
  // Modifier selection (the "Chicken Karahi spice level" flow)
  // -------------------------------------------------------------------

  describe('required modifier groups', () => {
    it('adds an item whose mandatory group is satisfied', async () => {
      const { itemWithModifiers, mild, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      const detail = await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id] }, orderActor);
      expect(detail.lines[0]?.modifiers.map((m) => m.modifierId)).toEqual([mild.id]);
    });

    it('names the group, and the numbers, when a mandatory selection is missing', async () => {
      const { itemWithModifiers, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      // The message is what a cashier sees on screen, so it has to say
      // which group and how many — not just "invalid".
      await expect(addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [] }, orderActor)).rejects.toThrow(
        /"Spice level" requires between 1 and 1 selection\(s\); got 0/,
      );
    });

    it('rejects two selections from a choose-exactly-one group', async () => {
      const { itemWithModifiers, mild, extraHot, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      await expect(
        addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [mild.id, extraHot.id] }, orderActor),
      ).rejects.toThrow(/requires between 1 and 1 selection\(s\); got 2/);
    });

    it('rejects a modifier that belongs to no group linked to this item', async () => {
      const { item, mild, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      await expect(addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [mild.id] }, orderActor)).rejects.toThrow(
        /does not belong to a modifier group linked to item/,
      );
    });

    it('adds an item with no modifier groups at all without any selection', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      expect(detail.lines[0]?.modifiers).toEqual([]);
    });

    it('carries a priced modifier into the line total', async () => {
      const { itemWithModifiers, extraHot, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      const detail = await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 2, modifierIds: [extraHot.id] }, orderActor);
      // (500 item + 20 modifier) x 2
      expect(detail.lines[0]?.grossMinor).toBe(1_040_00);
    });
  });

  // -------------------------------------------------------------------
  // Floor board
  // -------------------------------------------------------------------

  describe('getFloorBoard', () => {
    async function payableOrder(item: { id: number }, actor: { actorId: number; terminalId: string }) {
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      return billOrder(ctx.db, order.id, {}, actor);
    }

    it('puts a newly created order in `open` and nowhere else', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);

      const board = await getFloorBoard(ctx.db);
      expect(board.open.map((o) => o.id)).toEqual([order.id]);
      expect(board.awaitingPayment).toEqual([]);
      expect(board.completed).toEqual([]);
    });

    it('moves a billed order out of `open` and into `awaitingPayment`', async () => {
      const { item, orderActor } = await setupMenu();
      const billed = await payableOrder(item, orderActor);

      const board = await getFloorBoard(ctx.db);
      expect(board.open).toEqual([]);
      expect(board.awaitingPayment.map((o) => o.id)).toEqual([billed.id]);
      expect(board.awaitingPayment[0]?.paidMinor).toBe(0);
      expect(board.awaitingPayment[0]?.balanceMinor).toBe(billed.totalMinor);
    });

    it('keeps a PARTLY paid order in `awaitingPayment`, showing what is left', async () => {
      const { item, orderActor } = await setupMenu();
      const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, orderActor);
      const billed = await payableOrder(item, orderActor);
      await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: paisa(100_00) }, orderActor);

      const board = await getFloorBoard(ctx.db);
      expect(board.awaitingPayment.map((o) => o.id)).toEqual([billed.id]);
      expect(board.awaitingPayment[0]?.paidMinor).toBe(100_00);
      expect(board.awaitingPayment[0]?.balanceMinor).toBe(billed.totalMinor - 100_00);
      expect(board.completed).toEqual([]);
    });

    it('moves a FULLY paid order out of both live lists and into `completed`', async () => {
      const { item, orderActor } = await setupMenu();
      const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, orderActor);
      const partner = await createPartner(ctx.db, 'Alice', orderActor);
      await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], orderActor);
      const billed = await payableOrder(item, orderActor);
      await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, orderActor);

      const board = await getFloorBoard(ctx.db);
      expect(board.open).toEqual([]);
      // This is the whole point: a settled bill must never still be
      // sitting in a list of things that need paying.
      expect(board.awaitingPayment).toEqual([]);
      expect(board.completed.map((o) => o.id)).toEqual([billed.id]);
      expect(board.completed[0]?.balanceMinor).toBe(0);
    });

    it('shows a voided order in none of the three lists', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      await voidOrder(ctx.db, order.id, { reason: 'customer left' }, orderActor);

      const board = await getFloorBoard(ctx.db);
      expect([...board.open, ...board.awaitingPayment, ...board.completed]).toEqual([]);
    });

    it('returns a reopened order to `open`', async () => {
      const { item, orderActor } = await setupMenu();
      const billed = await payableOrder(item, orderActor);
      await reopenOrder(ctx.db, billed.id, orderActor);

      const board = await getFloorBoard(ctx.db);
      expect(board.open.map((o) => o.id)).toEqual([billed.id]);
      expect(board.awaitingPayment).toEqual([]);
    });

    it('caps the completed list so the board stays a board, not a sales report', async () => {
      const { item, orderActor } = await setupMenu();
      const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, orderActor);
      const partner = await createPartner(ctx.db, 'Alice', orderActor);
      await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], orderActor);

      for (let i = 0; i < 3; i += 1) {
        const billed = await payableOrder(item, orderActor);
        await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, orderActor);
      }

      const board = await getFloorBoard(ctx.db, { completedLimit: 2 });
      expect(board.completed).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------
  // Bill preview
  // -------------------------------------------------------------------

  describe('previewBillTotals', () => {
    it('predicts exactly the total that billing then persists, rounding included', async () => {
      const { item, itemWithModifiers, extraHot, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      // 520.00 x 1 alongside 500.00 gives a total that is not a whole
      // number of rupees once a 33-paisa-ish service charge is added.
      await addLine(ctx.db, order.id, { itemId: itemWithModifiers.id, qty: 1, modifierIds: [extraHot.id] }, orderActor);

      const preview = await previewBillTotals(ctx.db, order.id, paisa(0));
      const billed = await billOrder(ctx.db, order.id, {}, orderActor);

      expect(preview.totalMinor).toBe(billed.totalMinor);
      expect(preview.taxMinor).toBe(billed.taxMinor);
      expect(preview.roundingAdjustmentMinor).toBe(billed.roundingAdjustmentMinor);
      expect(preview.netSalesMinor).toBe(billed.netSalesMinor);
    });

    it('includes a service charge in the predicted total', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', waiterId: orderActor.actorId }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      const preview = await previewBillTotals(ctx.db, order.id, paisa(100_00));
      expect(preview.serviceChargeMinor).toBe(100_00);
      expect(preview.totalMinor).toBe(600_00);

      const billed = await billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(100_00) }, orderActor);
      expect(billed.totalMinor).toBe(preview.totalMinor);
    });

    it('shows a non-zero rounding adjustment before anything is printed', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'dine_in', waiterId: orderActor.actorId }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      // Rs 500.00 + Rs 10.40 service charge = Rs 510.40, which rounds.
      const preview = await previewBillTotals(ctx.db, order.id, paisa(10_40));
      expect(preview.roundingAdjustmentMinor).not.toBe(0);
      expect(preview.totalMinor % 100).toBe(0);
    });

    it('refuses a service charge on an order with no waiter, the same as billing does', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      await expect(previewBillTotals(ctx.db, order.id, paisa(50_00))).rejects.toThrow(/requires a waiter/);
    });

    it('changes nothing: the order is still open afterwards', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      await previewBillTotals(ctx.db, order.id, paisa(0));
      const after = await getOrder(ctx.db, order.id);
      expect(after?.status).toBe('open');
      expect(after?.billedAt).toBeNull();
      expect(after?.totalMinor).toBe(0);
    });
  });

  /**
   * Who the order was for and what the kitchen was told (migration
   * 0018). Neither touches a money field; both are part of the record
   * of what happened, so both stop being editable when the order does.
   */
  describe('customer details and line notes', () => {
    it('records the customer at order creation', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(
        ctx.db,
        { orderType: 'delivery', customerName: 'A. Customer', customerPhone: '0300-0000000' },
        orderActor,
      );
      expect(order.customerName).toBe('A. Customer');
      expect(order.customerPhone).toBe('0300-0000000');
    });

    it('leaves the customer null when none was given', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      expect(order.customerName).toBeNull();
      expect(order.customerPhone).toBeNull();
    });

    it('adds the customer to an order already taken, one field at a time', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'delivery' }, orderActor);

      const named = await setOrderCustomer(ctx.db, order.id, { customerName: 'A. Customer' }, orderActor);
      expect(named.customerName).toBe('A. Customer');

      // Sending only the phone must not wipe the name.
      const phoned = await setOrderCustomer(ctx.db, order.id, { customerPhone: '0300-0000000' }, orderActor);
      expect(phoned.customerName).toBe('A. Customer');
      expect(phoned.customerPhone).toBe('0300-0000000');
    });

    it('clears a field given an empty string', async () => {
      const { orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'delivery', customerName: 'Wrong Person' }, orderActor);
      const cleared = await setOrderCustomer(ctx.db, order.id, { customerName: '' }, orderActor);
      expect(cleared.customerName).toBeNull();
    });

    it('refuses to change the customer once the order is settled', async () => {
      const { item, orderActor } = await setupMenu();
      const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, orderActor);
      // Closing an order allocates it, and allocation needs an owner.
      const partner = await createPartner(ctx.db, 'Alice', orderActor);
      await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], orderActor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway', customerName: 'A. Customer' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);
      const billed = await billOrder(ctx.db, order.id, {}, orderActor);
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, orderActor);

      await expect(setOrderCustomer(ctx.db, order.id, { customerName: 'Someone Else' }, orderActor)).rejects.toThrow(OrderStateError);
    });

    it('keeps a line note on the line it was written for', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, note: 'no onions' }, orderActor);
      expect(detail.lines[0]?.note).toBe('no onions');
    });

    it('never merges two lines that were ordered differently', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, note: 'no onions' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, orderActor);

      // Merging these would send one instruction to the kitchen and
      // silently drop the other.
      expect(detail.lines).toHaveLength(2);
      expect(detail.lines.map((line) => line.note)).toEqual(['no onions', null]);
    });

    it('merges two lines with the same note', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, note: 'no onions' }, orderActor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, note: 'no onions' }, orderActor);
      expect(detail.lines).toHaveLength(1);
      expect(detail.lines[0]?.qty).toBe(2);
    });

    it('changes a note on an open order and clears it with an empty string', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, note: 'no onions' }, orderActor);
      const lineId = added.lines[0]!.id;

      const changed = await setLineNote(ctx.db, order.id, lineId, { note: 'extra spicy' }, orderActor);
      expect(changed.lines[0]?.note).toBe('extra spicy');

      const cleared = await setLineNote(ctx.db, order.id, lineId, { note: '  ' }, orderActor);
      expect(cleared.lines[0]?.note).toBeNull();
    });

    it('refuses to rewrite a note once the bill is printed', async () => {
      const { item, orderActor } = await setupMenu();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, note: 'no onions' }, orderActor);
      await billOrder(ctx.db, order.id, {}, orderActor);

      await expect(setLineNote(ctx.db, order.id, added.lines[0]!.id, { note: 'onions after all' }, orderActor)).rejects.toThrow(OrderStateError);
    });
  });
});
