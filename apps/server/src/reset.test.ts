import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { recordPayment, createPaymentMethod } from './billing/service.js';
import {
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  linkModifierGroup,
  setItemModifierPrice,
  setItemPrice,
} from './catalog/service.js';
import { createUser } from './identity/service.js';
import { addLine, billOrder, createOrder } from './ordering/service.js';
import { createPartner, setItemOwnership } from './partners/service.js';
import { createTestDb } from './platform/db/test-helpers.js';
import { countTransactional, resetTransactionalData } from './reset.js';
import { openShift } from './shifts/service.js';

/**
 * The pre-go-live reset: wipe the test trading record and nothing else.
 * The through-line of every assertion is the same — the sales are gone,
 * the setup is untouched.
 */
describe('reset transactional data', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  const count = (table: string): number => (ctx.sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;

  async function setupWithTrading() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };

    // --- setup that must SURVIVE the reset ---
    const category = await createCategory(ctx.db, { name: 'Karahi' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Chicken Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1_300_00), actor);
    const group = await createModifierGroup(ctx.db, { name: 'Half / Full', minSelect: 1, maxSelect: 1, pricingMode: 'variant' }, actor);
    const full = await createModifier(ctx.db, { groupId: group.id, name: 'Full', priceDeltaMinor: paisa(0) }, actor);
    await linkModifierGroup(ctx.db, item.id, group.id, actor);
    await setItemModifierPrice(ctx.db, item.id, full.id, paisa(700_00), actor);
    const partner = await createPartner(ctx.db, 'Owner One', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);

    // --- trading that must be CLEARED ---
    await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [full.id] }, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

    return { actor, item };
  }

  it('clears the whole trading record and leaves the setup intact', async () => {
    const { actor } = await setupWithTrading();

    // Sanity: there is trading to clear, and setup to keep.
    expect(count('order')).toBeGreaterThan(0);
    expect(count('payment')).toBeGreaterThan(0);
    expect(count('shift')).toBeGreaterThan(0);
    expect(count('order_line')).toBeGreaterThan(0);
    expect(count('order_line_modifier')).toBeGreaterThan(0);
    expect(count('line_allocation')).toBeGreaterThan(0);
    expect(count('audit_log')).toBeGreaterThan(0);

    const setupBefore = {
      category: count('category'),
      item: count('item'),
      item_price: count('item_price'),
      modifier: count('modifier'),
      modifier_group: count('modifier_group'),
      item_modifier_group: count('item_modifier_group'),
      item_modifier_price: count('item_modifier_price'),
      item_ownership: count('item_ownership'),
      partner: count('partner'),
      user: count('user'),
      payment_method: count('payment_method'),
      app_setting: count('app_setting'),
    };

    const cleared = resetTransactionalData(ctx.sqlite);
    expect(cleared.orders).toBeGreaterThan(0);
    expect(cleared.payments).toBeGreaterThan(0);
    expect(cleared.shifts).toBeGreaterThan(0);

    // Every transactional table is empty.
    for (const table of [
      'order',
      'order_line',
      'order_line_modifier',
      'line_allocation',
      'payment',
      'service_charge_entry',
      'consumption_record',
      'shift',
      'audit_log',
      'sync_queue_entry',
    ]) {
      expect(count(table), `${table} should be empty`).toBe(0);
    }

    // Every setup table is exactly as it was.
    expect({
      category: count('category'),
      item: count('item'),
      item_price: count('item_price'),
      modifier: count('modifier'),
      modifier_group: count('modifier_group'),
      item_modifier_group: count('item_modifier_group'),
      item_modifier_price: count('item_modifier_price'),
      item_ownership: count('item_ownership'),
      partner: count('partner'),
      user: count('user'),
      payment_method: count('payment_method'),
      app_setting: count('app_setting'),
    }).toEqual(setupBefore);

    // Invoices restart at 1, and no foreign keys dangle.
    expect((ctx.sqlite.prepare('SELECT next_value AS n FROM invoice_counter WHERE id = 1').get() as { n: number } | undefined)?.n).toBe(1);
    expect(ctx.sqlite.pragma('foreign_key_check')).toEqual([]);

    // The next real order is #1 — numbering restarts, not continues.
    const fresh = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    expect(fresh.id).toBe(1);
  });

  it('reports zero to clear on a fresh database', () => {
    ctx = createTestDb();
    expect(countTransactional(ctx.sqlite)).toEqual({ orders: 0, payments: 0, shifts: 0 });
  });
});
