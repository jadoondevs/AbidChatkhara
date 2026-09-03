import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCategory, createItem, createModifier, createModifierGroup, linkModifierGroup, setItemModifierPrice, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { saveSetting } from '../settings/service.js';
import { buildAgentBillPayload, buildAgentReceiptPayload, maskAccountNumber } from './agent-ticket.js';
import { createPaymentAccount, createPaymentMethod, recordPayment, updatePaymentMethod } from './service.js';

describe('billing/agent-ticket', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };
    const waiter = await createUser(ctx.db, { name: 'Saif', username: 'saif', password: '1111', role: 'server' }, actor);

    await saveSetting(ctx.db, 'restaurant', { name: 'Abid Chatkhara', addressLine1: '00 Example Road', addressLine2: 'Nowhere', phone: '000-0000000' }, actor);

    const category = await createCategory(ctx.db, { name: 'Karahi' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Chicken Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1100_00), actor);

    const partner = await createPartner(ctx.db, 'Owner', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);

    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);
    const bank = await createPaymentMethod(ctx.db, { code: 'bank', displayName: 'Bank transfer', kind: 'bank_transfer' }, actor);
    // A full account number, marked to print — exactly the thing that
    // must never leave the server un-masked.
    await createPaymentAccount(
      ctx.db,
      { paymentMethodId: bank.id, label: 'HBL main', accountTitle: 'abid', accountNumber: '1234567890', bankName: 'HBL', printOnReceipt: true },
      actor,
    );

    return { admin, actor, waiter, category, item, cash, bank };
  }

  describe('maskAccountNumber', () => {
    it('keeps only the last four digits', () => {
      expect(maskAccountNumber('1234567890')).toBe('****7890');
      expect(maskAccountNumber('0300-1234567')).toBe('****4567');
    });
    it('drops anything four digits or shorter, and handles nothing', () => {
      expect(maskAccountNumber('7890')).toBe('****');
      expect(maskAccountNumber('')).toBe('');
      expect(maskAccountNumber(null)).toBe('');
    });
  });

  it('builds a bill payload with rupee amounts, the size on the line, and a MASKED account number', async () => {
    const { actor, item, waiter } = await setup();

    // A sized line: base 1100, Full +1000 => a line total of 2100.
    const size = await createModifierGroup(ctx.db, { name: 'Size', minSelect: 1, maxSelect: 1 }, actor);
    const full = await createModifier(ctx.db, { groupId: size.id, name: 'Full', priceDeltaMinor: paisa(0) }, actor);
    await linkModifierGroup(ctx.db, item.id, size.id, actor);
    await setItemModifierPrice(ctx.db, item.id, full.id, paisa(1000_00), actor);

    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T7', waiterId: waiter.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [full.id] }, actor);
    await billOrder(ctx.db, order.id, {}, actor);

    const payload = await buildAgentBillPayload(ctx.db, order.id);

    expect(payload.kind).toBe('bill');
    expect(payload.restaurant).toEqual({ name: 'Abid Chatkhara', address: '00 Example Road, Nowhere', phone: '000-0000000' });
    expect(payload.orderNumber).toBe(order.id);
    expect(payload.orderType).toBe('dine_in');
    expect(payload.waiter).toBe('Saif');
    // Rupees, not paisa; the size folded into the name; line total not unit.
    expect(payload.items).toEqual([{ quantity: 1, name: 'Chicken Karahi (Full)', amount: 2100 }]);
    expect(payload.subtotal).toBe(2100);
    expect(payload.total).toBe(2100);
    // The number never leaves un-masked.
    expect(payload.paymentOptions).toEqual([{ bank: 'HBL', accountName: 'abid', accountNumber: '****7890' }]);
    const asString = JSON.stringify(payload);
    expect(asString).not.toContain('1234567890');
  });

  it('omits payment options when the restaurant hides them', async () => {
    const { actor, item, waiter } = await setup();
    await saveSetting(ctx.db, 'receipt', { showPaymentAccounts: false }, actor);

    const order = await createOrder(ctx.db, { orderType: 'takeaway', waiterId: waiter.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 2 }, actor);
    await billOrder(ctx.db, order.id, {}, actor);

    const payload = await buildAgentBillPayload(ctx.db, order.id);
    expect(payload.paymentOptions).toEqual([]);
    expect(payload.items).toEqual([{ quantity: 2, name: 'Chicken Karahi', amount: 2200 }]);
  });

  it('builds a receipt payload with the invoice, method and amount paid, and no payment options', async () => {
    const { actor, item, cash, waiter } = await setup();
    const order = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T7', waiterId: waiter.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    const payload = await buildAgentReceiptPayload(ctx.db, order.id);
    expect(payload.kind).toBe('receipt');
    expect(payload.invoiceNumber).toBeGreaterThan(0);
    expect(payload.paymentMethod).toBe('Cash');
    expect(payload.amountPaid).toBe(1100);
    expect(payload.total).toBe(1100);
    expect(payload).not.toHaveProperty('paymentOptions');
  });

  it('names the method as it was at sale time, even after the method is renamed', async () => {
    const { actor, item, cash, waiter } = await setup();
    const order = await createOrder(ctx.db, { orderType: 'takeaway', waiterId: waiter.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    await updatePaymentMethod(ctx.db, cash.id, { displayName: 'Cash on hand' }, actor);

    const payload = await buildAgentReceiptPayload(ctx.db, order.id);
    expect(payload.paymentMethod).toBe('Cash'); // the snapshot, not the new name
  });
});
