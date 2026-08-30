import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentMethod, recordPayment, refundOrder } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { eventBus } from '../platform/events/bus.js';
import { closeShift, getBlockingOrders, getOpenShift, getZReport, openShift, ShiftCloseBlockedError, ShiftStateError } from './service.js';

describe('shifts/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', pin: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1000_00), actor);

    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);
    const easypaisa = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);

    return { admin, actor, item, partner, cash, easypaisa };
  }

  describe('openShift', () => {
    it('opens a shift with an opening float', async () => {
      const { actor } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(5_000_00) }, actor);
      expect(shift).toMatchObject({ openingCashMinor: 5_000_00, closedAt: null, countedCashMinor: null });
      expect(await getOpenShift(ctx.db)).toMatchObject({ id: shift.id });
    });

    it('refuses to open a second shift while one is already open', async () => {
      const { actor } = await setupBase();
      await openShift(ctx.db, { openingCashMinor: paisa(5_000_00) }, actor);
      await expect(openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor)).rejects.toThrow(ShiftStateError);
    });
  });

  describe('an order created while a shift is open gets tagged with it', () => {
    it('createOrder sets shift_id from the currently open shift', async () => {
      const { actor } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      expect(order.shiftId).toBe(shift.id);
    });

    it('an order created before any shift ever opened carries shift_id: null', async () => {
      const { actor } = await setupBase();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      expect(order.shiftId).toBeNull();
    });
  });

  describe('closeShift', () => {
    it('refuses to close while an order tagged with this shift is still open or awaiting payment, listing which ones', async () => {
      const { actor, item } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);
      const openOrder = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, openOrder.id, { itemId: item.id, qty: 1 }, actor);

      const billedOnly = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, billedOnly.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, billedOnly.id, {}, actor);

      await expect(closeShift(ctx.db, shift.id, { countedCashMinor: paisa(0) }, actor)).rejects.toThrow(ShiftCloseBlockedError);
      const blocking = await getBlockingOrders(ctx.db, shift.id);
      expect(blocking.map((o) => o.id).sort()).toEqual([openOrder.id, billedOnly.id].sort());
    });

    it('computes expected cash as opening float + cash payments, excluding wallet payments', async () => {
      const { actor, item, cash, easypaisa } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(2_000_00) }, actor);

      const cashOrder = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, cashOrder.id, { itemId: item.id, qty: 1 }, actor);
      const billedCash = await billOrder(ctx.db, cashOrder.id, {}, actor);
      await recordPayment(ctx.db, cashOrder.id, { paymentMethodId: cash.id, amountMinor: billedCash.totalMinor }, actor);

      const walletOrder = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, walletOrder.id, { itemId: item.id, qty: 1 }, actor);
      const billedWallet = await billOrder(ctx.db, walletOrder.id, {}, actor);
      await recordPayment(ctx.db, walletOrder.id, { paymentMethodId: easypaisa.id, amountMinor: billedWallet.totalMinor, referenceNo: 'TXN1' }, actor);

      // Opening float 2000 + cash payment 1000 = 3000; the wallet payment never counts.
      const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(3_000_00) }, actor);
      expect(closed.expectedCashMinor).toBe(3_000_00);
      expect(closed.varianceMinor).toBe(0);
      expect(closed.countedCashMinor).toBe(3_000_00);
    });

    it('a cash refund reduces expected cash the same way the original payment increased it', async () => {
      const { actor, item, cash } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);
      await refundOrder(ctx.db, order.id, { reason: 'complaint' }, actor);

      const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(0) }, actor);
      expect(closed.expectedCashMinor).toBe(0); // payment + refund net to zero
    });

    it('records a nonzero variance when the counted amount does not match', async () => {
      const { actor } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(950_00) }, actor);
      expect(closed.expectedCashMinor).toBe(1_000_00);
      expect(closed.varianceMinor).toBe(-50_00);
    });

    it('emits ShiftClosed and refuses to close an already-closed shift', async () => {
      const { actor } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const events: unknown[] = [];
      eventBus.on('ShiftClosed', (e) => events.push(e));
      await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(0) }, actor);
      expect(events).toHaveLength(1);

      await expect(closeShift(ctx.db, shift.id, { countedCashMinor: paisa(0) }, actor)).rejects.toThrow(ShiftStateError);
    });

    it('a fresh shift can be opened once the previous one is closed', async () => {
      const { actor } = await setupBase();
      const first = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);
      await closeShift(ctx.db, first.id, { countedCashMinor: paisa(0) }, actor);
      const second = await openShift(ctx.db, { openingCashMinor: paisa(500_00) }, actor);
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('getZReport', () => {
    it('splits customer sales from consumption, and totals tax/rounding/service-charge/payment-method figures', async () => {
      const { actor, item, cash } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      // A dine_in customer order, with a waiter and a service charge, paid in cash.
      const waiter = await createUser(ctx.db, { name: 'Bilal', pin: '1111', role: 'server' }, actor);
      const customerOrder = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T1', waiterId: waiter.id }, actor);
      await addLine(ctx.db, customerOrder.id, { itemId: item.id, qty: 1 }, actor);
      const billedCustomer = await billOrder(ctx.db, customerOrder.id, { serviceChargeMinor: paisa(50_00) }, actor);
      await recordPayment(ctx.db, customerOrder.id, { paymentMethodId: cash.id, amountMinor: billedCustomer.totalMinor }, actor);

      const report = await getZReport(ctx.db, shift.id);
      expect(report.customerSalesMinor).toBe(1000_00);
      expect(report.consumptionMinor).toBe(0);
      expect(report.combinedSalesMinor).toBe(1000_00);
      expect(report.serviceChargeCollectedMinor).toBe(50_00);
      expect(report.taxCollectedMinor).toBe(0);
      expect(report.paymentMethodBreakdown).toMatchObject([{ paymentMethodName: 'Cash', totalMinor: 1050_00 }]);
    });
  });
});
