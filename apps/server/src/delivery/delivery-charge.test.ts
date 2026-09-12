import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentMethod, recordPayment, refundOrder } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder, OrderStateError } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { getShiftReport, getZReport, openShift } from '../shifts/service.js';
import { createRider } from '../riders/service.js';
import { riderPayoutTotals } from './service.js';

/**
 * Delivery charge owed to the rider — the delivery twin of the service
 * charge owed to the waiter. These assert the whole life of one: it rides
 * on the bill total, it is NOT revenue, it becomes a rider payout at
 * close, a refund reverses it, and it needs a rider to be owed to.
 */
describe('delivery/delivery-charge', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };

    const category = await createCategory(ctx.db, { name: 'Pizza' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Cheese Pizza' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(500_00), actor);
    // Every sold item must be owned, so an order can close.
    const partner = await createPartner(ctx.db, 'Restaurant', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);

    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);
    const rider = await createRider(ctx.db, 'Ali', actor);

    return { admin, actor, item, cash, rider };
  }

  it('adds the delivery charge to the bill total and stores it, but keeps it out of net sales', async () => {
    const { actor, item, rider } = await setup();
    await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

    const order = await createOrder(ctx.db, { orderType: 'delivery', riderId: rider.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, { deliveryChargeMinor: paisa(100_00) }, actor);

    // Net sales is the food only (Rs 500); the total is food + delivery (Rs 600).
    expect(billed.netSalesMinor).toBe(500_00);
    expect(billed.deliveryChargeMinor).toBe(100_00);
    expect(billed.totalMinor).toBe(600_00);
  });

  it('becomes a rider payout at close, and reverses on a full refund', async () => {
    const { actor, item, cash, rider } = await setup();
    await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

    const order = await createOrder(ctx.db, { orderType: 'delivery', riderId: rider.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, { deliveryChargeMinor: paisa(100_00) }, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    expect(await riderPayoutTotals(ctx.db)).toEqual([{ riderId: rider.id, riderName: 'Ali', totalMinor: 100_00 }]);

    // A full refund reverses the delivery charge, so the rider is owed nothing net.
    await refundOrder(ctx.db, order.id, { reason: 'sent back' }, actor);
    expect(await riderPayoutTotals(ctx.db)).toEqual([]);
  });

  it('shows in the Z-report and shift report as held-for-riders, never revenue', async () => {
    const { actor, item, cash, rider } = await setup();
    const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

    const order = await createOrder(ctx.db, { orderType: 'delivery', riderId: rider.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, { deliveryChargeMinor: paisa(100_00) }, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    const z = await getZReport(ctx.db, shift.id);
    expect(z.deliveryChargeCollectedMinor).toBe(100_00);
    // Revenue is the food only; delivery charge is separate.
    expect(z.customerSalesMinor).toBe(500_00);

    const report = await getShiftReport(ctx.db, shift.id);
    expect(report.itemSalesTotalMinor).toBe(500_00); // delivery charge is not item sales
    expect(report.totalCollectedMinor).toBe(600_00); // but it IS collected
    expect(report.riderPayout).toEqual([{ riderId: rider.id, riderName: 'Ali', totalMinor: 100_00 }]);
    expect(report.riderPayoutTotalMinor).toBe(100_00);
  });

  it('refuses a delivery charge with no rider to owe it to', async () => {
    const { actor, item } = await setup();
    await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

    const order = await createOrder(ctx.db, { orderType: 'delivery' }, actor); // no rider
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    await expect(billOrder(ctx.db, order.id, { deliveryChargeMinor: paisa(100_00) }, actor)).rejects.toThrow(OrderStateError);
  });

  it('refuses a delivery charge on a non-delivery order', async () => {
    const { actor, item } = await setup();
    await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    await expect(billOrder(ctx.db, order.id, { deliveryChargeMinor: paisa(100_00) }, actor)).rejects.toThrow(OrderStateError);
  });
});
