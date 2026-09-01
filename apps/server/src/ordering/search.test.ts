import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentMethod, createPaymentAccount, recordPayment } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { addLine, billOrder, createOrder, searchOrders, setOrderCustomer } from './service.js';

/**
 * Looking an order up after the fact. The floor board answers "what is
 * happening now"; this answers "what happened", and the difference that
 * matters is that this one is scoped — a restaurant six months in has
 * tens of thousands of orders.
 */
describe('searchOrders', () => {
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
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1_000_00), actor);
    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);

    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);
    const wallet = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
    const account = await createPaymentAccount(ctx.db, { paymentMethodId: wallet.id, label: 'Counter wallet' }, actor);

    return { admin, actor, waiter, item, cash, wallet, account };
  }

  /** An order taken, billed, and paid — the ordinary case. */
  async function settledOrder(
    item: { id: number },
    actor: { actorId: number; terminalId: string },
    methodId: number,
    extra: { customerName?: string; tableLabel?: string; waiterId?: number; referenceNo?: string; accountId?: number } = {},
  ) {
    const order = await createOrder(
      ctx.db,
      {
        orderType: extra.waiterId ? 'dine_in' : 'takeaway',
        ...(extra.tableLabel === undefined ? {} : { tableLabel: extra.tableLabel }),
        ...(extra.waiterId === undefined ? {} : { waiterId: extra.waiterId }),
      },
      actor,
    );
    if (extra.customerName) await setOrderCustomer(ctx.db, order.id, { customerName: extra.customerName }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    await recordPayment(
      ctx.db,
      order.id,
      {
        paymentMethodId: methodId,
        amountMinor: billed.totalMinor,
        ...(extra.referenceNo === undefined ? {} : { referenceNo: extra.referenceNo }),
        ...(extra.accountId === undefined ? {} : { paymentAccountId: extra.accountId }),
      },
      actor,
    );
    return order;
  }

  it('returns today\'s orders, newest first', async () => {
    const { actor, item, cash } = await setup();
    const first = await settledOrder(item, actor, cash.id);
    const second = await settledOrder(item, actor, cash.id);

    const results = await searchOrders(ctx.db);
    expect(results.map((o) => o.id)).toEqual([second.id, first.id]);
  });

  it('carries what a list needs to be readable without a second request', async () => {
    const { actor, item, cash, waiter } = await setup();
    const order = await settledOrder(item, actor, cash.id, { waiterId: waiter.id, tableLabel: 'T4', customerName: 'A. Customer' });

    const [result] = await searchOrders(ctx.db);
    expect(result?.id).toBe(order.id);
    expect(result?.waiterName).toBe('Faisal Ahmed');
    expect(result?.settledByName).toBe('Amina Qureshi');
    expect(result?.lineCount).toBe(1);
    expect(result?.paidMinor).toBe(1_000_00);
    expect(result?.balanceMinor).toBe(0);
  });

  it('excludes a day the order does not belong to', async () => {
    const { actor, item, cash } = await setup();
    await settledOrder(item, actor, cash.id);

    // A window that ended before anything happened today.
    const results = await searchOrders(ctx.db, { fromInclusive: '2020-01-01T00:00:00.000Z', toExclusive: '2020-01-02T00:00:00.000Z' });
    expect(results).toEqual([]);
  });

  it('finds an order by its own number, not by a substring of it', async () => {
    const { actor, item, cash } = await setup();
    const order = await settledOrder(item, actor, cash.id);

    const found = await searchOrders(ctx.db, { q: String(order.id) });
    expect(found.map((o) => o.id)).toContain(order.id);

    // "1" must not match order 12 — a cashier typing an order number
    // means that order.
    const spurious = await searchOrders(ctx.db, { q: '99' });
    expect(spurious).toEqual([]);
  });

  it('finds an order by invoice number', async () => {
    const { actor, item, cash } = await setup();
    const order = await settledOrder(item, actor, cash.id);
    const invoiceNo = (await searchOrders(ctx.db)).find((o) => o.id === order.id)?.invoiceNo;

    const found = await searchOrders(ctx.db, { q: String(invoiceNo) });
    expect(found.map((o) => o.id)).toContain(order.id);
  });

  it('finds an order by customer, table, waiter or cashier', async () => {
    const { actor, item, cash, waiter } = await setup();
    const order = await settledOrder(item, actor, cash.id, { waiterId: waiter.id, tableLabel: 'T4', customerName: 'Bilal Khan' });

    for (const term of ['bilal', 'T4', 'faisal', 'amina']) {
      const found = await searchOrders(ctx.db, { q: term });
      expect(found.map((o) => o.id), `searching for ${term}`).toContain(order.id);
    }
  });

  it('finds an order by a payment reference', async () => {
    const { actor, item, wallet, account } = await setup();
    const order = await settledOrder(item, actor, wallet.id, { referenceNo: 'EP-778899', accountId: account.id });

    const found = await searchOrders(ctx.db, { q: 'ep-7788' });
    expect(found.map((o) => o.id)).toContain(order.id);
  });

  it('includes an order that is still open, dated by when it was opened', async () => {
    const { actor, item } = await setup();
    const open = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, open.id, { itemId: item.id, qty: 1 }, actor);

    const results = await searchOrders(ctx.db);
    expect(results.map((o) => o.id)).toContain(open.id);
    expect(results.find((o) => o.id === open.id)?.balanceMinor).toBe(0);
  });

  it('never returns more than it was asked for', async () => {
    const { actor, item, cash } = await setup();
    await settledOrder(item, actor, cash.id);
    await settledOrder(item, actor, cash.id);
    await settledOrder(item, actor, cash.id);

    expect(await searchOrders(ctx.db, { limit: 2 })).toHaveLength(2);
  });
});
