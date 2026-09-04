import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentAccount, createPaymentMethod, recordPayment, refundOrder, settleConsumption } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createPerson } from '../consumption/service.js';
import { addLine, billOrder, createOrder, deleteEmptyOrder, removeLine, setDiscount, voidLine, voidOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb, enableServiceCharge } from '../platform/db/test-helpers.js';
import { eventBus } from '../platform/events/bus.js';
import { closeShift, getBlockingOrders, getOpenShift, getZReport, openShift, ShiftCloseBlockedError, ShiftStateError } from './service.js';

describe('shifts/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };
    await enableServiceCharge(ctx.db, actor);

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1000_00), actor);

    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);
    const easypaisa = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
    // A wallet payment now needs an account to land in, so every shift
    // fixture that takes one configures the account it lands in.
    await createPaymentAccount(ctx.db, { paymentMethodId: easypaisa.id, label: 'Counter wallet' }, actor);

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

    it('counts only the cash that stayed in the drawer when change was given', async () => {
      const { actor, item, cash } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);

      // Customer hands over Rs 500 more than the bill and takes the
      // change away with them: the drawer is up by the bill, not by the
      // note.
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: paisa(billed.totalMinor + 500_00) }, actor);

      const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: billed.totalMinor }, actor);
      expect(closed.expectedCashMinor).toBe(billed.totalMinor);
      expect(closed.varianceMinor).toBe(0);
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
      const waiter = await createUser(ctx.db, { name: 'Bilal', username: 'bilal', password: '1111', role: 'server' }, actor);
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

  describe('getZReport — the operator-facing figures', () => {
    it('predicts expected cash before the shift is closed, and agrees with the close afterwards', async () => {
      const { actor, item, cash } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(2_000_00) }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

      const before = await getZReport(ctx.db, shift.id);
      expect(before.openingFloatMinor).toBe(2_000_00);
      expect(before.cashPaymentsMinor).toBe(billed.totalMinor);
      expect(before.expectedCashMinor).toBe(2_000_00 + billed.totalMinor);
      expect(before.countedCashMinor).toBeNull();
      expect(before.varianceMinor).toBeNull();

      const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(2_000_00 + billed.totalMinor) }, actor);
      const after = await getZReport(ctx.db, shift.id);
      expect(after.expectedCashMinor).toBe(closed.expectedCashMinor);
      expect(after.countedCashMinor).toBe(closed.countedCashMinor);
      expect(after.varianceMinor).toBe(0);
    });

    it('reports cash tendered and change alongside what actually stayed in the drawer', async () => {
      const { actor, item, cash } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: paisa(billed.totalMinor + 500_00) }, actor);

      const report = await getZReport(ctx.db, shift.id);
      expect(report.cashTenderedMinor).toBe(billed.totalMinor + 500_00);
      expect(report.changeGivenMinor).toBe(500_00);
      // What the drawer is actually up by, and what the close will expect.
      expect(report.cashPaymentsMinor).toBe(billed.totalMinor);
      expect(report.expectedCashMinor).toBe(billed.totalMinor);
    });

    it('separates cash from non-cash takings', async () => {
      const { actor, item, cash, easypaisa } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const cashOrder = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, cashOrder.id, { itemId: item.id, qty: 1 }, actor);
      const billedCash = await billOrder(ctx.db, cashOrder.id, {}, actor);
      await recordPayment(ctx.db, cashOrder.id, { paymentMethodId: cash.id, amountMinor: billedCash.totalMinor }, actor);

      const walletOrder = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, walletOrder.id, { itemId: item.id, qty: 1 }, actor);
      const billedWallet = await billOrder(ctx.db, walletOrder.id, {}, actor);
      await recordPayment(ctx.db, walletOrder.id, { paymentMethodId: easypaisa.id, amountMinor: billedWallet.totalMinor }, actor);

      const report = await getZReport(ctx.db, shift.id);
      expect(report.cashPaymentsMinor).toBe(billedCash.totalMinor);
      expect(report.nonCashPaymentsMinor).toBe(billedWallet.totalMinor);
      expect(report.expectedCashMinor).toBe(billedCash.totalMinor);
    });

    it('reports discounts given', async () => {
      const { actor, item, cash } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await setDiscount(ctx.db, order.id, { discountMinor: paisa(100_00), reason: 'loyalty' }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

      const report = await getZReport(ctx.db, shift.id);
      expect(report.discountsGivenMinor).toBe(100_00);
      expect(report.customerSalesMinor).toBe(900_00);
    });

    it('reports voided sales, and excludes a voided order from the sales figures', async () => {
      const { actor, item } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await voidOrder(ctx.db, order.id, { reason: 'customer left' }, actor);

      const report = await getZReport(ctx.db, shift.id);
      expect(report.voidedSalesMinor).toBe(1000_00);
      expect(report.customerSalesMinor).toBe(0);
    });

    it('counts a voided LINE as voided sales, but not a pre-bill correction', async () => {
      const { actor, item } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await removeLine(ctx.db, order.id, added.lines[0]!.id, actor);

      // A mis-tap on a bill nobody has seen is a keystroke, not a
      // removed sale — it must not show up as one on the Z-report.
      expect((await getZReport(ctx.db, shift.id)).voidedSalesMinor).toBe(0);

      const second = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const liveLine = second.lines.find((l) => !l.voided)!;
      await voidLine(ctx.db, order.id, liveLine.id, { reason: 'sent back' }, actor);

      expect((await getZReport(ctx.db, shift.id)).voidedSalesMinor).toBe(1000_00);
    });

    it('shows what the house absorbed on a free staff meal', async () => {
      const { actor, item } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);
      const person = await createPerson(ctx.db, { name: 'Rashid', kind: 'staff', mealPolicy: 'free' }, actor);

      const meal = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, meal.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, meal.id, {}, actor);
      await settleConsumption(ctx.db, meal.id, { settlementType: 'house_expense' }, actor);

      const report = await getZReport(ctx.db, shift.id);
      expect(report.consumptionMinor).toBe(1000_00);
      expect(report.consumptionUnchargedMinor).toBe(1000_00);
      // A free meal takes no money, so the drawer is unaffected.
      expect(report.expectedCashMinor).toBe(0);
    });
  });

  /**
   * The close blocker and the empty-order delete have to agree. A
   * manager standing at a till at 1am is told they cannot close because
   * of table 19; deleting table 19 has to actually end that, without a
   * reload and without the two answers coming from different places.
   */
  describe('blockers clear when an empty order is deleted', () => {
    it('lists an empty open order as a blocker, and says it has no lines', async () => {
      const { actor } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      const empty = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);

      const blockers = await getBlockingOrders(ctx.db, shift.id);
      expect(blockers.map((b) => b.id)).toEqual([empty.id]);
      expect(blockers[0]?.lineCount).toBe(0);
    });

    it('stops listing it once it is deleted, and the shift then closes', async () => {
      const { actor } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      const empty = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);

      await expect(closeShift(ctx.db, shift.id, { countedCashMinor: paisa(1_000_00) }, actor)).rejects.toThrow(ShiftCloseBlockedError);

      await deleteEmptyOrder(ctx.db, empty.id, actor);

      expect(await getBlockingOrders(ctx.db, shift.id)).toEqual([]);
      const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(1_000_00) }, actor);
      expect(closed.closedAt).not.toBeNull();
    });

    it('an order emptied by removing a mis-tapped line reads as clearable and unblocks the close', async () => {
      const { actor, item } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      const detail = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await removeLine(ctx.db, order.id, detail.lines[0]!.id, actor);

      // It still has a (voided) line, so lineCount is 1 — but nothing
      // live, so the till can offer to delete it rather than saying
      // "finish or void it".
      const blockers = await getBlockingOrders(ctx.db, shift.id);
      expect(blockers[0]?.lineCount).toBe(1);
      expect(blockers[0]?.liveLineCount).toBe(0);
      expect(blockers[0]?.firstBilledAt).toBeNull();

      await deleteEmptyOrder(ctx.db, order.id, actor);
      expect(await getBlockingOrders(ctx.db, shift.id)).toEqual([]);
      const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(1_000_00) }, actor);
      expect(closed.closedAt).not.toBeNull();
    });

    it('keeps blocking while an order with items is still open', async () => {
      const { actor, item } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      const empty = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      const real = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, real.id, { itemId: item.id, qty: 1 }, actor);

      await deleteEmptyOrder(ctx.db, empty.id, actor);

      const blockers = await getBlockingOrders(ctx.db, shift.id);
      expect(blockers.map((b) => b.id)).toEqual([real.id]);
      expect(blockers[0]?.lineCount).toBe(1);
      // And the one that is a real order cannot be deleted away.
      await expect(deleteEmptyOrder(ctx.db, real.id, actor)).rejects.toThrow();
      await expect(closeShift(ctx.db, shift.id, { countedCashMinor: paisa(1_000_00) }, actor)).rejects.toThrow(ShiftCloseBlockedError);
    });

    it('lists an awaiting-payment order as a blocker that cannot be deleted', async () => {
      const { actor, item } = await setupBase();
      const shift = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, order.id, {}, actor);

      const blockers = await getBlockingOrders(ctx.db, shift.id);
      expect(blockers[0]).toMatchObject({ id: order.id, status: 'billed' });
      await expect(deleteEmptyOrder(ctx.db, order.id, actor)).rejects.toThrow(/never billed/);
    });

    it("does not count another shift's orders", async () => {
      const { actor } = await setupBase();
      const first = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      const stray = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await deleteEmptyOrder(ctx.db, stray.id, actor);
      await closeShift(ctx.db, first.id, { countedCashMinor: paisa(1_000_00) }, actor);

      const second = await openShift(ctx.db, { openingCashMinor: paisa(1_000_00) }, actor);
      await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      expect(await getBlockingOrders(ctx.db, first.id)).toEqual([]);
      expect(await getBlockingOrders(ctx.db, second.id)).toHaveLength(1);
    });
  });
});
