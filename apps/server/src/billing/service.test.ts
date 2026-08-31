import { paisa, sum } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createPerson } from '../consumption/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder, getOrder, OrderStateError } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { eventBus } from '../platform/events/bus.js';
import {
  createPaymentAccount,
  createPaymentMethod,
  listPaymentAccounts,
  listPaymentMethods,
  recordPayment,
  refundOrder,
  settleConsumption,
  updatePaymentAccount,
  updatePaymentMethod,
} from './service.js';

describe('billing/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
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

  async function billedOrder(item: { id: number }, actor: { actorId: number; terminalId: string }) {
    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    return billOrder(ctx.db, order.id, {}, actor);
  }

  describe('payment methods', () => {
    it('creates, lists (active by default), and updates a payment method', async () => {
      const { actor } = await setupBase();
      const bank = await createPaymentMethod(
        ctx.db,
        { code: 'bank', displayName: 'Bank transfer', kind: 'bank_transfer', printOnBill: true, accountTitle: 'Restaurant Ltd', accountNumber: '123', bankName: 'HBL' },
        actor,
      );
      expect(bank).toMatchObject({ kind: 'bank_transfer', printOnBill: true, accountTitle: 'Restaurant Ltd' });

      expect((await listPaymentMethods(ctx.db)).map((m) => m.code)).toEqual(expect.arrayContaining(['cash', 'easypaisa', 'bank']));

      const updated = await updatePaymentMethod(ctx.db, bank.id, { active: false }, actor);
      expect(updated.active).toBe(false);
      expect((await listPaymentMethods(ctx.db)).map((m) => m.code)).not.toContain('bank');
    });

    it('card is supported by the schema but never seeded here', async () => {
      const { actor } = await setupBase();
      const card = await createPaymentMethod(ctx.db, { code: 'card', displayName: 'Card', kind: 'card' }, actor);
      expect(card.kind).toBe('card');
    });
  });

  describe('recordPayment — single payment closes the order', () => {
    it('closes the order, allocates an invoice number, writes partner allocations, emits OrderClosed', async () => {
      const { actor, item, partner, cash } = await setupBase();
      const billed = await billedOrder(item, actor);

      const events: unknown[] = [];
      eventBus.on('OrderClosed', (e) => events.push(e));

      const result = await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

      expect(result.orderClosed).toBe(true);
      expect(result.invoiceNo).toBe(1);
      expect(result.order.status).toBe('closed');
      expect(result.order.invoiceNo).toBe(1);
      expect(events).toHaveLength(1);

      const allocations = await ctx.db.selectFrom('line_allocation').selectAll().execute();
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).toMatchObject({ partner_id: partner.id, amount_minor: billed.netSalesMinor });
    });

    it('computes change for a cash overpayment without persisting the tendered amount', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);

      const result = await recordPayment(
        ctx.db,
        billed.id,
        { paymentMethodId: cash.id, amountMinor: billed.totalMinor, tenderedMinor: paisa(billed.totalMinor + 200_00) },
        actor,
      );
      expect(result.changeMinor).toBe(200_00);
      expect(result.payment.amountMinor).toBe(billed.totalMinor); // only the applied amount is stored
    });

    it('takes a wallet payment with no reference number — a reference is optional', async () => {
      const { actor, item, easypaisa } = await setupBase();
      const billed = await billedOrder(item, actor);

      const result = await recordPayment(ctx.db, billed.id, { paymentMethodId: easypaisa.id, amountMinor: billed.totalMinor }, actor);
      expect(result.orderClosed).toBe(true);
      expect(result.payment.referenceNo).toBeNull();
    });

    it('keeps a reference number when one is given, and treats a blank one as none', async () => {
      const { actor, item, easypaisa } = await setupBase();

      const withRef = await billedOrder(item, actor);
      const kept = await recordPayment(
        ctx.db,
        withRef.id,
        { paymentMethodId: easypaisa.id, amountMinor: withRef.totalMinor, referenceNo: '  TX-1234 ' },
        actor,
      );
      expect(kept.payment.referenceNo).toBe('TX-1234');

      const blankRef = await billedOrder(item, actor);
      const blank = await recordPayment(
        ctx.db,
        blankRef.id,
        { paymentMethodId: easypaisa.id, amountMinor: blankRef.totalMinor, referenceNo: '   ' },
        actor,
      );
      expect(blank.payment.referenceNo).toBeNull();
    });

    it('rejects a NON-CASH payment that would exceed the remaining balance', async () => {
      const { actor, item, easypaisa } = await setupBase();
      const billed = await billedOrder(item, actor);
      await expect(
        recordPayment(ctx.db, billed.id, { paymentMethodId: easypaisa.id, amountMinor: paisa(billed.totalMinor + 1) }, actor),
      ).rejects.toThrow(/exceeds the remaining balance/);
    });

    // ---- cash change (the Rs 2,000 note for an Rs 1,800 bill) ----

    it('applies only the balance and returns the rest as change when cash exceeds the bill', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);
      const overBy = paisa(200_00);

      const result = await recordPayment(
        ctx.db,
        billed.id,
        { paymentMethodId: cash.id, amountMinor: paisa(billed.totalMinor + overBy) },
        actor,
      );

      expect(result.appliedMinor).toBe(billed.totalMinor);
      expect(result.changeMinor).toBe(overBy);
      expect(result.orderClosed).toBe(true);
      // The stored payment — what sales, allocations and expected cash
      // are all computed from — is the applied amount, never the tender.
      expect(result.payment.amountMinor).toBe(billed.totalMinor);
      expect(result.payment.tenderedMinor).toBe(paisa(billed.totalMinor + overBy));
      expect(result.payment.changeMinor).toBe(overBy);
    });

    it('gives zero change on an exact cash payment', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);

      const result = await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);
      expect(result.changeMinor).toBe(0);
      expect(result.appliedMinor).toBe(billed.totalMinor);
      expect(result.orderClosed).toBe(true);
    });

    it('computes change from an explicitly-tendered note as well as from an over-keyed amount', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);

      const result = await recordPayment(
        ctx.db,
        billed.id,
        { paymentMethodId: cash.id, amountMinor: billed.totalMinor, tenderedMinor: paisa(billed.totalMinor + 500_00) },
        actor,
      );
      expect(result.appliedMinor).toBe(billed.totalMinor);
      expect(result.changeMinor).toBe(500_00);
    });

    it('rejects a tender smaller than the amount being applied', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);
      await expect(
        recordPayment(
          ctx.db,
          billed.id,
          { paymentMethodId: cash.id, amountMinor: billed.totalMinor, tenderedMinor: paisa(billed.totalMinor - 100) },
          actor,
        ),
      ).rejects.toThrow(/less than/);
    });

    it('leaves an order awaiting payment after a partial cash payment, with no change', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);
      const part = paisa(100_00);

      const result = await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: part }, actor);
      expect(result.orderClosed).toBe(false);
      expect(result.appliedMinor).toBe(part);
      expect(result.changeMinor).toBe(0);
      expect(result.order.status).toBe('billed');
    });

    it('gives change only on the final payment of a split, against the remaining balance', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);
      const first = paisa(100_00);

      await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: first }, actor);
      // Second tender covers the rest with Rs 50 to spare.
      const remaining = paisa(billed.totalMinor - first);
      const result = await recordPayment(
        ctx.db,
        billed.id,
        { paymentMethodId: cash.id, amountMinor: paisa(remaining + 50_00) },
        actor,
      );

      expect(result.appliedMinor).toBe(remaining);
      expect(result.changeMinor).toBe(50_00);
      expect(result.orderClosed).toBe(true);
    });

    it('rejects paying an order that is still open (not yet billed)', async () => {
      const { actor, item, cash } = await setupBase();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await expect(recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: paisa(1000_00) }, actor)).rejects.toThrow(
        OrderStateError,
      );
    });
  });

  describe('recordPayment — split payments', () => {
    it('stays billed until payments sum to the total, then closes on the payment that completes it', async () => {
      const { actor, item, cash, easypaisa } = await setupBase();
      const billed = await billedOrder(item, actor); // Rs 1000

      const first = await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: paisa(400_00) }, actor);
      expect(first.orderClosed).toBe(false);
      expect(first.order.status).toBe('billed');

      const second = await recordPayment(
        ctx.db,
        billed.id,
        { paymentMethodId: easypaisa.id, amountMinor: paisa(600_00), referenceNo: 'TXN1' },
        actor,
      );
      expect(second.orderClosed).toBe(true);
      expect(second.order.status).toBe('closed');

      const payments = await ctx.db.selectFrom('payment').selectAll().where('order_id', '=', billed.id).execute();
      expect(payments).toHaveLength(2);
      expect(sum(payments.map((p) => p.amount_minor))).toBe(billed.totalMinor);
    });
  });

  describe('the double-close test (spec, definition of done)', () => {
    it('two terminals attempt to settle the same billed order simultaneously: exactly one succeeds, no duplicate invoice number, no duplicate allocation rows', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);

      const results = await Promise.allSettled([
        recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor),
        recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof recordPayment>>>[];
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OrderStateError);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already settled/);

      const finalOrder = await getOrder(ctx.db, billed.id);
      expect(finalOrder?.status).toBe('closed');

      const allocations = await ctx.db.selectFrom('line_allocation').selectAll().where('order_line_id', 'in', finalOrder!.lines.map((l) => l.id)).execute();
      expect(allocations).toHaveLength(1); // not duplicated

      const invoiceNumbers = await ctx.db.selectFrom('order').select('invoice_no').where('invoice_no', 'is not', null).execute();
      expect(new Set(invoiceNumbers.map((r) => r.invoice_no)).size).toBe(invoiceNumbers.length); // all unique
    });
  });

  describe('concurrency: settling out of print order (spec, definition of done)', () => {
    it('bills three tables, settles them in a different order than printed, plus a fourth billed in between: invoice numbers are sequential in settlement order, with no gaps, and no order affects another', async () => {
      const { actor, item, cash } = await setupBase();

      // Print (bill) tables A, B, C in that order.
      const a = await billedOrder(item, actor);
      const b = await billedOrder(item, actor);
      const c = await billedOrder(item, actor);

      // Settle C first, then A, with D billed and settled in between.
      const settledC = await recordPayment(ctx.db, c.id, { paymentMethodId: cash.id, amountMinor: c.totalMinor }, actor);
      expect(settledC.invoiceNo).toBe(1);

      const d = await billedOrder(item, actor); // billed after A/B/C were already billed
      const settledD = await recordPayment(ctx.db, d.id, { paymentMethodId: cash.id, amountMinor: d.totalMinor }, actor);
      expect(settledD.invoiceNo).toBe(2);

      const settledA = await recordPayment(ctx.db, a.id, { paymentMethodId: cash.id, amountMinor: a.totalMinor }, actor);
      expect(settledA.invoiceNo).toBe(3);

      const settledB = await recordPayment(ctx.db, b.id, { paymentMethodId: cash.id, amountMinor: b.totalMinor }, actor);
      expect(settledB.invoiceNo).toBe(4);

      // No gaps, no duplicates, and each order's own total is unaffected by the others.
      const invoiceNumbers = [settledC.invoiceNo, settledD.invoiceNo, settledA.invoiceNo, settledB.invoiceNo];
      expect(invoiceNumbers).toEqual([1, 2, 3, 4]);
      for (const settled of [a, b, c, d]) {
        expect(settled.totalMinor).toBe(1000_00);
      }
    });
  });

  describe('settleConsumption', () => {
    async function billedMealOrder(item: { id: number }, person: { id: number }, actor: { actorId: number; terminalId: string }) {
      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      return billOrder(ctx.db, order.id, {}, actor);
    }

    it('closes a payroll_deduction staff meal with no payment, but still allocates the full menu value to the owning partner', async () => {
      const { actor, item, partner } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'payroll_deduction' }, actor);
      const billed = await billedMealOrder(item, person, actor);

      const result = await settleConsumption(ctx.db, billed.id, {}, actor);
      expect(result.payment).toBeNull();
      expect(result.order.status).toBe('closed');
      expect(result.consumptionRecord).toMatchObject({ chargedMinor: 0, settlementMinor: 1000_00, settlementType: 'payroll_deduction' });

      const allocations = await ctx.db.selectFrom('line_allocation').selectAll().where('partner_id', '=', partner.id).execute();
      expect(sum(allocations.map((a) => a.amount_minor))).toBe(1000_00); // the partner is credited in full, discount notwithstanding
    });

    it('requires a payment method when the meal leaves a charge, and records it for exactly the charged amount', async () => {
      const { actor, item, cash } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'discounted', mealDiscountBp: 4_000 }, actor);
      const billed = await billedMealOrder(item, person, actor);

      await expect(settleConsumption(ctx.db, billed.id, {}, actor)).rejects.toThrow(/payment method is required/);

      const result = await settleConsumption(ctx.db, billed.id, { paymentMethodId: cash.id, settlementType: 'house_expense' }, actor);
      expect(result.payment).toMatchObject({ amountMinor: 600_00, paymentMethodId: cash.id }); // 60% of 1000
      expect(result.consumptionRecord).toMatchObject({ chargedMinor: 600_00, settlementMinor: 400_00, settlementType: 'house_expense' });
    });

    it('a full_price meal is fully collected and needs no settlement type', async () => {
      const { actor, item, cash } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Alice', kind: 'partner', mealPolicy: 'full_price' }, actor);
      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'owner_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);

      const result = await settleConsumption(ctx.db, billed.id, { paymentMethodId: cash.id }, actor);
      expect(result.payment).toMatchObject({ amountMinor: 1000_00 });
      expect(result.consumptionRecord).toMatchObject({ chargedMinor: 1000_00, settlementMinor: 0, settlementType: null });
    });

    it('rejects settleConsumption on a plain customer order, and recordPayment on a staff/owner meal order', async () => {
      const { actor, item, cash } = await setupBase();
      const customerBilled = await billedOrder(item, actor);
      await expect(settleConsumption(ctx.db, customerBilled.id, {}, actor)).rejects.toThrow(OrderStateError);

      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'free' }, actor);
      const mealBilled = await billedMealOrder(item, person, actor);
      await expect(recordPayment(ctx.db, mealBilled.id, { paymentMethodId: cash.id, amountMinor: mealBilled.totalMinor }, actor)).rejects.toThrow(
        OrderStateError,
      );
    });

    it('cannot be settled twice', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'payroll_deduction' }, actor);
      const billed = await billedMealOrder(item, person, actor);

      await settleConsumption(ctx.db, billed.id, {}, actor);
      await expect(settleConsumption(ctx.db, billed.id, {}, actor)).rejects.toThrow(/already settled/);
    });
  });

  describe('refunds', () => {
    it('reverses the allocation and records a negative payment, referencing the original', async () => {
      const { actor, item, partner, cash } = await setupBase();
      const billed = await billedOrder(item, actor);
      const { order: closedOrder } = await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

      const events: unknown[] = [];
      eventBus.on('RefundIssued', (e) => events.push(e));

      const refund = await refundOrder(ctx.db, closedOrder.id, { reason: 'customer complaint' }, actor);
      expect(refund.amountMinor).toBe(billed.netSalesMinor);
      expect(refund.allocationsReversed).toBe(1);
      expect(events).toHaveLength(1);

      const allocations = await ctx.db.selectFrom('line_allocation').selectAll().execute();
      expect(allocations).toHaveLength(2); // original + reversal
      expect(sum(allocations.map((a) => a.amount_minor))).toBe(0);
      expect(allocations.find((a) => a.reverses_allocation_id !== null)).toMatchObject({ partner_id: partner.id });

      const payments = await ctx.db.selectFrom('payment').selectAll().where('order_id', '=', closedOrder.id).execute();
      expect(payments).toHaveLength(2);
      const original = payments.find((p) => p.amount_minor > 0)!;
      const refundPayment = payments.find((p) => p.amount_minor < 0)!;
      expect(original.reversed_by_payment_id).toBe(refundPayment.id);
      expect(refundPayment.amount_minor).toBe(-original.amount_minor);
    });

    it('rejects refunding an order that has not been closed', async () => {
      const { actor, item } = await setupBase();
      const billed = await billedOrder(item, actor);
      await expect(refundOrder(ctx.db, billed.id, { reason: 'x' }, actor)).rejects.toThrow(OrderStateError);
    });

    it('rejects refunding the same order twice', async () => {
      const { actor, item, cash } = await setupBase();
      const billed = await billedOrder(item, actor);
      const { order: closedOrder } = await recordPayment(ctx.db, billed.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);
      await refundOrder(ctx.db, closedOrder.id, { reason: 'a' }, actor);
      await expect(refundOrder(ctx.db, closedOrder.id, { reason: 'b' }, actor)).rejects.toThrow(/nothing to refund/);
    });
  });

  describe('payment accounts', () => {
    it('records which configured account received a non-cash payment', async () => {
      const { actor, item, easypaisa } = await setupBase();
      const account = await createPaymentAccount(
        ctx.db,
        { paymentMethodId: easypaisa.id, label: 'Counter wallet', accountNumber: '0000-0000000' },
        actor,
      );
      const billed = await billedOrder(item, actor);

      const result = await recordPayment(
        ctx.db,
        billed.id,
        { paymentMethodId: easypaisa.id, amountMinor: billed.totalMinor, paymentAccountId: account.id },
        actor,
      );
      expect(result.payment.paymentAccountId).toBe(account.id);
    });

    it('refuses an account that belongs to a different payment method', async () => {
      const { actor, item, cash, easypaisa } = await setupBase();
      const account = await createPaymentAccount(ctx.db, { paymentMethodId: easypaisa.id, label: 'Counter wallet' }, actor);
      const billed = await billedOrder(item, actor);

      await expect(
        recordPayment(
          ctx.db,
          billed.id,
          { paymentMethodId: cash.id, amountMinor: billed.totalMinor, paymentAccountId: account.id },
          actor,
        ),
      ).rejects.toThrow(/does not belong to the payment method/);
    });

    it('refuses a deactivated account', async () => {
      const { actor, item, easypaisa } = await setupBase();
      const account = await createPaymentAccount(ctx.db, { paymentMethodId: easypaisa.id, label: 'Old wallet' }, actor);
      await updatePaymentAccount(ctx.db, account.id, { active: false }, actor);
      const billed = await billedOrder(item, actor);

      await expect(
        recordPayment(
          ctx.db,
          billed.id,
          { paymentMethodId: easypaisa.id, amountMinor: billed.totalMinor, paymentAccountId: account.id },
          actor,
        ),
      ).rejects.toThrow(/not found or inactive/);
    });

    it('takes a payment with no account selected at all', async () => {
      const { actor, item, easypaisa } = await setupBase();
      const billed = await billedOrder(item, actor);
      const result = await recordPayment(ctx.db, billed.id, { paymentMethodId: easypaisa.id, amountMinor: billed.totalMinor }, actor);
      expect(result.payment.paymentAccountId).toBeNull();
    });

    it('lists only the active accounts for a method, and every account when asked', async () => {
      const { actor, easypaisa } = await setupBase();
      const live = await createPaymentAccount(ctx.db, { paymentMethodId: easypaisa.id, label: 'Counter wallet' }, actor);
      const retired = await createPaymentAccount(ctx.db, { paymentMethodId: easypaisa.id, label: 'Old wallet' }, actor);
      await updatePaymentAccount(ctx.db, retired.id, { active: false }, actor);

      const active = await listPaymentAccounts(ctx.db, { paymentMethodId: easypaisa.id });
      expect(active.map((a) => a.id)).toEqual([live.id]);

      const all = await listPaymentAccounts(ctx.db, { paymentMethodId: easypaisa.id, includeInactive: true });
      expect(all).toHaveLength(2);
    });
  });
});
