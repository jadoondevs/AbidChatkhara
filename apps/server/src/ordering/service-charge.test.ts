import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBillTicketData, buildReceiptTicketData } from '../billing/printing.js';
import { recordPayment, createPaymentMethod } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { defaultsFor } from '../settings/schema.js';
import { saveSetting } from '../settings/service.js';
import { addLine, billOrder, createOrder, getOrder, previewBillTotals } from './service.js';

/**
 * The service charge is configured once and applied by one function.
 * These tests are about that rule holding — including the part that
 * matters months later: a historical order keeps the charge that
 * actually applied to it, not the one configured today.
 */
describe('service charge — configured, authoritative, and snapshotted', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1_000_00), actor);
    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);

    return { admin, actor, item, cash };
  }

  async function configure(actor: { actorId: number; terminalId: string }, patch: Record<string, unknown>) {
    await saveSetting(ctx.db, 'serviceCharge', { ...defaultsFor('serviceCharge'), ...patch }, actor);
  }

  /** A dine-in order with a waiter — the case a service charge applies to. */
  async function dineInOrder(item: { id: number }, actor: { actorId: number; terminalId: string }) {
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T1', waiterId: actor.actorId }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    return order;
  }

  it('ships disabled — an unconfigured restaurant never adds a service charge', async () => {
    const { actor, item } = await setup();
    const order = await dineInOrder(item, actor);

    const billed = await billOrder(ctx.db, order.id, {}, actor);
    expect(billed.serviceChargeMinor).toBe(0);
    expect(billed.serviceChargeRateBp).toBeNull();
    expect(billed.totalMinor).toBe(1_000_00);
  });

  it('applies the configured rate to net sales', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 }); // 5%
    const order = await dineInOrder(item, actor);

    const billed = await billOrder(ctx.db, order.id, {}, actor);
    expect(billed.serviceChargeMinor).toBe(50_00);
    expect(billed.serviceChargeRateBp).toBe(500);
    expect(billed.totalMinor).toBe(1_050_00);
  });

  it('is zero when disabled, whatever rate is left configured', async () => {
    const { actor, item } = await setup();
    // A restaurant that switches the charge off should not have to zero
    // the rate as well — "disabled" has to mean zero on its own.
    await configure(actor, { enabled: false, rateBp: 1_000 });
    const order = await dineInOrder(item, actor);

    const billed = await billOrder(ctx.db, order.id, {}, actor);
    expect(billed.serviceChargeMinor).toBe(0);
  });

  it('predicts in the bill preview exactly what billing then charges', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 750 });
    const order = await dineInOrder(item, actor);

    const preview = await previewBillTotals(ctx.db, order.id);
    const billed = await billOrder(ctx.db, order.id, {}, actor);

    expect(preview.serviceChargeMinor).toBe(billed.serviceChargeMinor);
    expect(preview.serviceChargeRateBp).toBe(billed.serviceChargeRateBp);
    expect(preview.totalMinor).toBe(billed.totalMinor);
    expect(preview.serviceChargeMinor).toBe(75_00);
  });

  it('carries the configured display name through the preview', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500, displayName: 'Service & tips' });
    const order = await dineInOrder(item, actor);

    expect((await previewBillTotals(ctx.db, order.id)).serviceChargeName).toBe('Service & tips');
  });

  it('applies to dine-in only by default — a takeaway carries its own food', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500, dineInOnly: true });

    const takeaway = await createOrder(ctx.db, { orderType: 'takeaway', waiterId: actor.actorId }, actor);
    await addLine(ctx.db, takeaway.id, { itemId: item.id, qty: 1 }, actor);

    expect((await billOrder(ctx.db, takeaway.id, {}, actor)).serviceChargeMinor).toBe(0);
  });

  it('applies to every order type when the restaurant says so', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500, dineInOnly: false });

    const takeaway = await createOrder(ctx.db, { orderType: 'takeaway', waiterId: actor.actorId }, actor);
    await addLine(ctx.db, takeaway.id, { itemId: item.id, qty: 1 }, actor);

    expect((await billOrder(ctx.db, takeaway.id, {}, actor)).serviceChargeMinor).toBe(50_00);
  });

  it('never charges an order with no waiter — there is nobody to attribute it to', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500, dineInOnly: false });

    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);

    expect((await billOrder(ctx.db, order.id, {}, actor)).serviceChargeMinor).toBe(0);
  });

  it('never charges a staff or owner meal', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500, dineInOnly: false });
    const person = await ctx.db
      .insertInto('person')
      .values({ name: 'Rashid', kind: 'staff', active: 1, meal_policy: 'free', meal_discount_bp: 0 })
      .returningAll()
      .executeTakeFirstOrThrow();

    const meal = await createOrder(
      ctx.db,
      { orderType: 'dine_in', channel: 'staff_meal', beneficiaryPersonId: person.id, waiterId: actor.actorId },
      actor,
    );
    await addLine(ctx.db, meal.id, { itemId: item.id, qty: 1 }, actor);

    expect((await billOrder(ctx.db, meal.id, {}, actor)).serviceChargeMinor).toBe(0);
  });

  it('lets a cashier override the amount, and records that no rate produced it', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 });
    const order = await dineInOrder(item, actor);

    // Waiving service on a complaint is ordinary practice; claiming a
    // rate produced the waived amount would be a lie on the receipt.
    const billed = await billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(0) }, actor);
    expect(billed.serviceChargeMinor).toBe(0);
    expect(billed.serviceChargeRateBp).toBeNull();
  });

  it('refuses an override while the charge is switched off, rather than silently dropping it', async () => {
    const { actor, item } = await setup();
    const order = await dineInOrder(item, actor);

    await expect(billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(100_00) }, actor)).rejects.toThrow(
      /switched off for this restaurant/,
    );
  });

  it('refuses an override on an order with no waiter', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 });
    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);

    await expect(billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(50_00) }, actor)).rejects.toThrow(/requires a waiter/);
  });

  it('refuses a negative override', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 });
    const order = await dineInOrder(item, actor);

    await expect(billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(-1) }, actor)).rejects.toThrow(/cannot be negative/);
  });

  // ---- the point of storing the rate at all ----

  it('KEEPS the rate an old order was billed at when the setting later changes', async () => {
    const { actor, item, cash } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 }); // 5% today

    const order = await dineInOrder(item, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    // The restaurant raises it to 10% next month.
    await configure(actor, { enabled: true, rateBp: 1_000 });

    const historical = await getOrder(ctx.db, order.id);
    expect(historical?.serviceChargeRateBp).toBe(500);
    expect(historical?.serviceChargeMinor).toBe(50_00);
    expect(historical?.totalMinor).toBe(1_050_00);
  });

  it('keeps an old order intact when the charge is switched off entirely', async () => {
    const { actor, item, cash } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 });

    const order = await dineInOrder(item, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    await configure(actor, { enabled: false });

    const historical = await getOrder(ctx.db, order.id);
    expect(historical?.serviceChargeMinor).toBe(50_00);
    expect(historical?.serviceChargeRateBp).toBe(500);
  });

  it('charges each order at the rate in force when IT was billed', async () => {
    const { actor, item } = await setup();

    await configure(actor, { enabled: true, rateBp: 500 });
    const first = await dineInOrder(item, actor);
    const firstBilled = await billOrder(ctx.db, first.id, {}, actor);

    await configure(actor, { enabled: true, rateBp: 1_000 });
    const second = await dineInOrder(item, actor);
    const secondBilled = await billOrder(ctx.db, second.id, {}, actor);

    expect(firstBilled.serviceChargeRateBp).toBe(500);
    expect(firstBilled.serviceChargeMinor).toBe(50_00);
    expect(secondBilled.serviceChargeRateBp).toBe(1_000);
    expect(secondBilled.serviceChargeMinor).toBe(100_00);
  });

  it('rounds the charge with the money module, to the paisa', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 333 }); // 3.33%
    const order = await dineInOrder(item, actor);

    // 3.33% of Rs 1,000.00 is Rs 33.30 exactly — no float drift.
    expect((await billOrder(ctx.db, order.id, {}, actor)).serviceChargeMinor).toBe(33_30);
  });

  it('rejects an implausible rate at the settings boundary', async () => {
    const { actor } = await setup();
    await expect(configure(actor, { enabled: true, rateBp: 9_000 })).rejects.toThrow();
    await expect(configure(actor, { enabled: true, rateBp: -1 })).rejects.toThrow();
  });

  it('prints the configured wording, with the rate that produced the charge', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 550, displayName: 'Service fee' });

    const order = await dineInOrder(item, actor);
    await billOrder(ctx.db, order.id, {}, actor);

    const ticket = await buildBillTicketData(ctx.db, order.id);
    expect(ticket.serviceChargeLabel).toBe('Service fee (5.5%)');
    expect(ticket.serviceChargeMinor).toBe(55_00);
  });

  it('names no rate on a ticket when a cashier overrode the amount', async () => {
    const { actor, item } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 });

    const order = await dineInOrder(item, actor);
    await billOrder(ctx.db, order.id, { serviceChargeMinor: paisa(20_00) }, actor);

    // A percentage on the customer's bill has to be one the amount
    // actually came from — this one did not.
    const ticket = await buildBillTicketData(ctx.db, order.id);
    expect(ticket.serviceChargeLabel).toBe('Service charge');
    expect(ticket.serviceChargeMinor).toBe(20_00);
  });

  it('reprints an old receipt at the old rate, however the setting has moved since', async () => {
    const { actor, item, cash } = await setup();
    await configure(actor, { enabled: true, rateBp: 500 });

    const order = await dineInOrder(item, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    await configure(actor, { enabled: true, rateBp: 1_000, displayName: 'Service fee' });

    // The wording is the restaurant's current one — a rename should show
    // on reprints — but the percentage is the order's own.
    const receipt = await buildReceiptTicketData(ctx.db, order.id);
    expect(receipt.serviceChargeLabel).toBe('Service fee (5%)');
    expect(receipt.serviceChargeMinor).toBe(50_00);
    expect(receipt.totalMinor).toBe(1_050_00);
  });
});
