import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentAccount, createPaymentMethod, recordPayment, refundOrder } from '../billing/service.js';
import {
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  linkModifierGroup,
  renameItem,
  setItemPrice,
} from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { defaultsFor } from '../settings/schema.js';
import { saveSetting } from '../settings/service.js';
import { getOrderHistory } from './history.js';
import { addLine, billOrder, createOrder } from './service.js';

/**
 * A historical order is a record of what happened, not a live query.
 * These tests change the restaurant AFTER the sale and assert the sale
 * did not move.
 */
describe('order history', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Amina Qureshi', username: 'amina', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };
    const waiter = await createUser(ctx.db, { name: 'Faisal Ahmed', username: 'faisal', password: '4444', role: 'server' }, actor);

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Chicken Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1_850_00), actor);

    const spice = await createModifierGroup(ctx.db, { name: 'Spice level', minSelect: 1, maxSelect: 1 }, actor);
    const medium = await createModifier(ctx.db, { groupId: spice.id, name: 'Medium', priceDeltaMinor: paisa(0) }, actor);
    await linkModifierGroup(ctx.db, item.id, spice.id, actor);

    const partner = await createPartner(ctx.db, 'Alia Holdings', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);

    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);
    const easypaisa = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
    const account = await createPaymentAccount(
      ctx.db,
      { paymentMethodId: easypaisa.id, label: 'Main Easypaisa', accountNumber: '0300-1234567' },
      actor,
    );

    await saveSetting(ctx.db, 'serviceCharge', { ...defaultsFor('serviceCharge'), enabled: true, rateBp: 500 }, actor);

    return { admin, actor, waiter, item, medium, partner, cash, easypaisa, account };
  }

  /** A dine-in order, billed and paid in cash with change. */
  async function settledCashOrder(s: Awaited<ReturnType<typeof setup>>) {
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T4', waiterId: s.waiter.id }, s.actor);
    await addLine(ctx.db, order.id, { itemId: s.item.id, qty: 2, modifierIds: [s.medium.id] }, s.actor);
    const billed = await billOrder(ctx.db, order.id, {}, s.actor);
    const paid = await recordPayment(
      ctx.db,
      order.id,
      { paymentMethodId: s.cash.id, amountMinor: paisa(billed.totalMinor + 250_00) },
      s.actor,
    );
    return { order, billed, paid };
  }

  it('returns null for an order that does not exist', async () => {
    await setup();
    expect(await getOrderHistory(ctx.db, 9999)).toBeNull();
  });

  it('carries the whole order: who, what, when and how much', async () => {
    const s = await setup();
    const { order, billed } = await settledCashOrder(s);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history).not.toBeNull();
    if (!history) throw new Error('unreachable');

    expect(history.order.id).toBe(order.id);
    expect(history.order.invoiceNo).toBe(1);
    expect(history.order.orderType).toBe('dine_in');
    expect(history.order.tableLabel).toBe('T4');
    expect(history.order.status).toBe('closed');
    expect(history.waiterName).toBe('Faisal Ahmed');
    expect(history.openedByName).toBe('Amina Qureshi');
    expect(history.closedByName).toBe('Amina Qureshi');
    expect(history.order.openedAt).toBeTruthy();
    expect(history.order.billedAt).toBeTruthy();
    expect(history.order.closedAt).toBeTruthy();
    expect(history.order.totalMinor).toBe(billed.totalMinor);
  });

  it('itemises every line with its quantity, unit price, modifiers and line total', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    const history = await getOrderHistory(ctx.db, order.id);
    const line = history?.order.lines[0];
    expect(line?.itemName).toBe('Chicken Karahi');
    expect(line?.qty).toBe(2);
    expect(line?.unitPriceMinor).toBe(1_850_00);
    expect(line?.grossMinor).toBe(3_700_00);
    expect(line?.modifiers.map((m) => m.modifierName)).toEqual(['Medium']);
  });

  it('carries every financial figure, including the service charge and its rate', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.order.subtotalMinor).toBe(3_700_00);
    expect(history?.order.orderDiscountMinor).toBe(0);
    expect(history?.order.netSalesMinor).toBe(3_700_00);
    expect(history?.order.serviceChargeMinor).toBe(185_00); // 5%
    expect(history?.order.serviceChargeRateBp).toBe(500);
    expect(history?.order.taxMinor).toBe(0);
    expect(history?.order.totalMinor).toBe(3_885_00);
    expect(history?.paidMinor).toBe(3_885_00);
    expect(history?.balanceMinor).toBe(0);
  });

  it('records the cash tendered and the change given back', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    const history = await getOrderHistory(ctx.db, order.id);
    const payment = history?.payments[0];
    expect(payment?.methodName).toBe('Cash');
    expect(payment?.amountMinor).toBe(3_885_00);
    expect(payment?.tenderedMinor).toBe(4_135_00);
    expect(payment?.changeMinor).toBe(250_00);
    expect(history?.changeGivenMinor).toBe(250_00);
    expect(payment?.receivedByName).toBe('Amina Qureshi');
  });

  it('names the account and reference a non-cash payment landed in', async () => {
    const s = await setup();
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T2', waiterId: s.waiter.id }, s.actor);
    await addLine(ctx.db, order.id, { itemId: s.item.id, qty: 1, modifierIds: [s.medium.id] }, s.actor);
    const billed = await billOrder(ctx.db, order.id, {}, s.actor);
    await recordPayment(
      ctx.db,
      order.id,
      { paymentMethodId: s.easypaisa.id, amountMinor: billed.totalMinor, referenceNo: 'EP123456' },
      s.actor,
    );

    const history = await getOrderHistory(ctx.db, order.id);
    const payment = history?.payments[0];
    expect(payment?.methodName).toBe('Easypaisa');
    expect(payment?.accountLabel).toBe('Main Easypaisa');
    expect(payment?.accountNumber).toBe('0300-1234567');
    expect(payment?.referenceNo).toBe('EP123456');
  });

  it('shows a split payment as the two payments it was', async () => {
    const s = await setup();
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T3', waiterId: s.waiter.id }, s.actor);
    await addLine(ctx.db, order.id, { itemId: s.item.id, qty: 1, modifierIds: [s.medium.id] }, s.actor);
    const billed = await billOrder(ctx.db, order.id, {}, s.actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: s.cash.id, amountMinor: paisa(1_000_00) }, s.actor);
    await recordPayment(
      ctx.db,
      order.id,
      { paymentMethodId: s.easypaisa.id, amountMinor: paisa(billed.totalMinor - 1_000_00) },
      s.actor,
    );

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.payments).toHaveLength(2);
    expect(history?.payments.map((p) => p.methodName)).toEqual(['Cash', 'Easypaisa']);
    expect(history?.paidMinor).toBe(billed.totalMinor);
    expect(history?.balanceMinor).toBe(0);
  });

  it('shows an outstanding balance on a part-paid order', async () => {
    const s = await setup();
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T5', waiterId: s.waiter.id }, s.actor);
    await addLine(ctx.db, order.id, { itemId: s.item.id, qty: 1, modifierIds: [s.medium.id] }, s.actor);
    const billed = await billOrder(ctx.db, order.id, {}, s.actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: s.cash.id, amountMinor: paisa(500_00) }, s.actor);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.paidMinor).toBe(500_00);
    expect(history?.balanceMinor).toBe(billed.totalMinor - 500_00);
    expect(history?.order.status).toBe('billed');
  });

  it('shows a refund as its own negative payment, netting the total paid', async () => {
    const s = await setup();
    const { order, billed } = await settledCashOrder(s);
    await refundOrder(ctx.db, order.id, { reason: 'never delivered' }, s.actor);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.payments).toHaveLength(2);
    const refund = history?.payments.find((p) => p.isRefund);
    expect(refund).toBeDefined();
    expect(refund?.amountMinor).toBeLessThan(0);
    expect(history?.paidMinor).toBe(billed.totalMinor - 3_700_00);
  });

  it('credits each partner at the share that was in force when it closed', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.partnerAllocations).toHaveLength(1);
    expect(history?.partnerAllocations[0]).toMatchObject({
      partnerName: 'Alia Holdings',
      shareBpSnapshot: 10_000,
      amountMinor: 3_700_00,
    });
  });

  // ---- the snapshot guarantees ----

  it('keeps the item NAME the order was sold under after the menu is renamed', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    await renameItem(ctx.db, s.item.id, 'Chicken Karahi (full)', s.actor);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.order.lines[0]?.itemName).toBe('Chicken Karahi');
  });

  it('keeps the item PRICE the order was sold at after the price changes', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    await setItemPrice(ctx.db, s.item.id, paisa(2_500_00), s.actor);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.order.lines[0]?.unitPriceMinor).toBe(1_850_00);
    expect(history?.order.totalMinor).toBe(3_885_00);
  });

  it('keeps the service charge that applied after the rate changes', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    await saveSetting(ctx.db, 'serviceCharge', { ...defaultsFor('serviceCharge'), enabled: true, rateBp: 1_000 }, s.actor);

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.order.serviceChargeRateBp).toBe(500);
    expect(history?.order.serviceChargeMinor).toBe(185_00);
  });

  it('shows the account as it WAS when the money arrived, after it is renamed and deactivated', async () => {
    const s = await setup();
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T6', waiterId: s.waiter.id }, s.actor);
    await addLine(ctx.db, order.id, { itemId: s.item.id, qty: 1, modifierIds: [s.medium.id] }, s.actor);
    const billed = await billOrder(ctx.db, order.id, {}, s.actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: s.easypaisa.id, amountMinor: billed.totalMinor }, s.actor);

    await ctx.db
      .updateTable('payment_account')
      .set({ label: 'Old wallet (closed)', active: 0 })
      .where('id', '=', s.account.id)
      .execute();

    // The identity is intact AND the label is the one that was on the
    // account when this payment was taken. A customer disputing a
    // transfer is asking about the account it went to that day, and an
    // admin correcting a spelling must not rewrite the answer
    // (migration 0019).
    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.payments[0]?.accountId).toBe(s.account.id);
    expect(history?.payments[0]?.accountLabel).toBe('Main Easypaisa');
  });

  it('keeps a partner allocation after the ownership split is changed', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    const second = await createPartner(ctx.db, 'Bilal Foods', s.actor);
    await setItemOwnership(
      ctx.db,
      s.item.id,
      [
        { partnerId: s.partner.id, shareBp: 5_000 },
        { partnerId: second.id, shareBp: 5_000 },
      ],
      s.actor,
    );

    const history = await getOrderHistory(ctx.db, order.id);
    expect(history?.partnerAllocations).toHaveLength(1);
    expect(history?.partnerAllocations[0]?.shareBpSnapshot).toBe(10_000);
  });

  it('reading an order changes nothing about it', async () => {
    const s = await setup();
    const { order } = await settledCashOrder(s);

    const before = await ctx.db.selectFrom('order').selectAll().where('id', '=', order.id).executeTakeFirstOrThrow();
    await getOrderHistory(ctx.db, order.id);
    await getOrderHistory(ctx.db, order.id);
    const after = await ctx.db.selectFrom('order').selectAll().where('id', '=', order.id).executeTakeFirstOrThrow();

    expect(after).toEqual(before);
  });

  it('names the beneficiary of a staff meal', async () => {
    const s = await setup();
    const person = await ctx.db
      .insertInto('person')
      .values({ name: 'Rashid (kitchen)', kind: 'staff', active: 1, meal_policy: 'free', meal_discount_bp: 0 })
      .returningAll()
      .executeTakeFirstOrThrow();

    const meal = await createOrder(
      ctx.db,
      { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id },
      s.actor,
    );
    await addLine(ctx.db, meal.id, { itemId: s.item.id, qty: 1, modifierIds: [s.medium.id] }, s.actor);

    const history = await getOrderHistory(ctx.db, meal.id);
    expect(history?.beneficiaryName).toBe('Rashid (kitchen)');
  });
});
