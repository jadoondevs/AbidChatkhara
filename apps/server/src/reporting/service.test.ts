import { paisa, sum } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentMethod, recordPayment, refundOrder, settleConsumption } from '../billing/service.js';
import { createCategory, createItem, createModifier, createModifierGroup, linkModifierGroup, setItemPrice } from '../catalog/service.js';
import { createPerson } from '../consumption/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder, setDiscount, voidLine, voidOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership, setModifierOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { createTaxRule } from '../tax/service.js';
import {
  allocationReconciliation,
  consumptionReport,
  dailySalesReport,
  itemMixReport,
  partnerItemBills,
  partnerStatement,
  voidAndDiscountReport,
} from './service.js';

describe('reporting/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };
    const waiter = await createUser(ctx.db, { name: 'Bilal', username: 'bilal', password: '1111', role: 'server' }, actor);

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1000_00), actor);

    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);

    return { admin, actor, waiter, category, item, partner, cash };
  }

  async function closedCustomerOrder(
    item: { id: number },
    cashId: number,
    actor: { actorId: number; terminalId: string },
    waiterId?: number,
    serviceChargeMinor = paisa(0),
  ) {
    const order = await createOrder(ctx.db, waiterId ? { orderType: 'dine_in', tableLabel: 'T1', waiterId } : { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, { serviceChargeMinor }, actor);
    const { order: closed } = await recordPayment(ctx.db, order.id, { paymentMethodId: cashId, amountMinor: billed.totalMinor }, actor);
    return closed;
  }

  describe('dailySalesReport', () => {
    it('splits customer sales from consumption and totals tax/rounding/payment-method/service-charge figures', async () => {
      const { actor, item, cash, waiter } = await setupBase();
      await closedCustomerOrder(item, cash.id, actor, waiter.id, paisa(50_00));

      const person = await createPerson(ctx.db, { name: 'Ahmed', kind: 'staff', mealPolicy: 'free' }, actor);
      const mealOrder = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, mealOrder.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, mealOrder.id, {}, actor);
      await settleConsumption(ctx.db, mealOrder.id, { settlementType: 'house_expense' }, actor);

      const report = await dailySalesReport(ctx.db);
      expect(report.customerSalesMinor).toBe(1000_00);
      expect(report.consumptionMinor).toBe(1000_00);
      expect(report.combinedSalesMinor).toBe(2000_00);
      expect(report.taxCollectedMinor).toBe(0);
      expect(report.serviceChargeByWaiter).toEqual([{ waiterId: waiter.id, waiterName: 'Bilal', totalMinor: 50_00 }]);
      expect(report.paymentMethodBreakdown).toMatchObject([{ paymentMethodName: 'Cash', totalMinor: 1050_00 }]);
    });

    it('filters by order.closed_at range', async () => {
      const { actor, item, cash } = await setupBase();
      await closedCustomerOrder(item, cash.id, actor);

      const future = new Date(Date.now() + 60_000).toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();
      expect((await dailySalesReport(ctx.db, { fromInclusive: future })).customerSalesMinor).toBe(0);
      expect((await dailySalesReport(ctx.db, { fromInclusive: past })).customerSalesMinor).toBe(1000_00);
    });
  });

  describe('allocationReconciliation (spec: variance must always be zero)', () => {
    it('balances for a plain closed order', async () => {
      const { actor, item, cash } = await setupBase();
      await closedCustomerOrder(item, cash.id, actor);
      const rec = await allocationReconciliation(ctx.db);
      expect(rec.allocationBaseMinor).toBe(1000_00);
      expect(rec.totalAllocatedMinor).toBe(1000_00);
      expect(rec.varianceMinor).toBe(0);
    });

    it('a later refund does not break reconciliation — only the ORIGINAL allocation counts', async () => {
      const { actor, item, cash } = await setupBase();
      const closed = await closedCustomerOrder(item, cash.id, actor);
      await refundOrder(ctx.db, closed.id, { reason: 'complaint' }, actor);

      // The reversal is excluded, not summed in: this proves the
      // ORIGINAL sale was correctly allocated at the time it happened,
      // which the refund doesn't retroactively change. (What the
      // partner is now net owed, after the refund, is a different
      // question — partnerStatement's own totals answer that one.)
      const rec = await allocationReconciliation(ctx.db);
      expect(rec.varianceMinor).toBe(0);
      expect(rec.totalAllocatedMinor).toBe(1000_00);
      expect(rec.allocationBaseMinor).toBe(1000_00);
    });

    it('balances when a modifier has its own separate ownership, carved out of the item', async () => {
      const { actor, item, cash, category } = await setupBase();
      const group = await createModifierGroup(ctx.db, { name: 'Extras', minSelect: 0, maxSelect: 1 }, actor);
      const modifier = await createModifier(ctx.db, { groupId: group.id, name: 'Cheese', priceDeltaMinor: paisa(100_00) }, actor);
      await linkModifierGroup(ctx.db, item.id, group.id, actor);
      const cheesePartner = await createPartner(ctx.db, 'Bob', actor);
      await setModifierOwnership(ctx.db, modifier.id, [{ partnerId: cheesePartner.id, shareBp: 10_000 }], actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, modifierIds: [modifier.id] }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);
      void category;

      const rec = await allocationReconciliation(ctx.db);
      expect(rec.varianceMinor).toBe(0);
      expect(rec.allocationBaseMinor).toBe(1100_00); // Rs 1000 item + Rs 100 modifier
    });
  });

  describe('partnerStatement', () => {
    it('splits allocated total by customer sales vs consumption, drills down to item and to individual bills', async () => {
      const { actor, item, cash, partner } = await setupBase();
      const closed1 = await closedCustomerOrder(item, cash.id, actor);

      const person = await createPerson(ctx.db, { name: 'Ahmed', kind: 'staff', mealPolicy: 'free' }, actor);
      const mealOrder = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, mealOrder.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, mealOrder.id, {}, actor);
      await settleConsumption(ctx.db, mealOrder.id, { settlementType: 'house_expense' }, actor);

      const statement = await partnerStatement(ctx.db, partner.id);
      expect(statement.totalAllocatedMinor).toBe(2000_00);
      expect(statement.customerSalesAllocatedMinor).toBe(1000_00);
      expect(statement.consumptionAllocatedMinor).toBe(1000_00);
      expect(statement.items).toEqual([{ itemId: item.id, itemName: 'Karahi', qty: 2, allocatedMinor: 2000_00 }]);
      expect(statement.reconciliation.varianceMinor).toBe(0);

      const bills = await partnerItemBills(ctx.db, partner.id, item.id);
      expect(bills).toHaveLength(2);
      expect(sum(bills.map((b) => b.amountMinor))).toBe(2000_00);
      expect(bills.every((b) => b.invoiceNo !== null)).toBe(true);
      void closed1;
    });
  });

  describe('itemMixReport', () => {
    it('totals quantity and value per item, with the item\'s current owners and shares', async () => {
      const { actor, item, cash, partner } = await setupBase();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 3 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);

      const report = await itemMixReport(ctx.db);
      expect(report).toEqual([
        { itemId: item.id, itemName: 'Karahi', qty: 3, netSalesMinor: 3000_00, owners: [{ partnerId: partner.id, partnerName: 'Alice', shareBp: 10_000 }] },
      ]);
    });
  });

  describe('consumptionReport', () => {
    it('itemises records and rolls them up per person', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Ahmed', kind: 'staff', mealPolicy: 'discounted', mealDiscountBp: 5_000 }, actor);
      const cash = (await createPaymentMethod(ctx.db, { code: 'cash2', displayName: 'Cash2', kind: 'cash' }, actor)).id;

      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await billOrder(ctx.db, order.id, {}, actor);
      await settleConsumption(ctx.db, order.id, { paymentMethodId: cash, settlementType: 'house_expense' }, actor);

      const report = await consumptionReport(ctx.db);
      expect(report.records).toHaveLength(1);
      expect(report.byPerson).toEqual([{ personId: person.id, personName: 'Ahmed', menuValueMinor: 1000_00, chargedMinor: 500_00, settlementMinor: 500_00 }]);
    });
  });

  describe('consumptionReport — per-item detail', () => {
    it('names every item consumed, with its quantity, menu value and charged share', async () => {
      const { actor, category, item, partner } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Rashid', kind: 'staff', mealPolicy: 'free' }, actor);

      const drink = await createItem(ctx.db, { categoryId: category.id, name: 'Fresh lime' }, actor);
      await setItemPrice(ctx.db, drink.id, paisa(200_00), actor);
      await setItemOwnership(ctx.db, drink.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 2 }, actor);
      await addLine(ctx.db, order.id, { itemId: drink.id, qty: 1 }, actor);
      await billOrder(ctx.db, order.id, {}, actor);
      await settleConsumption(ctx.db, order.id, { settlementType: 'house_expense' }, actor);

      const report = await consumptionReport(ctx.db);
      expect(report.lines).toHaveLength(2);

      const karahi = report.lines.find((l) => l.itemName === 'Karahi');
      expect(karahi).toMatchObject({
        personName: 'Rashid',
        qty: 2,
        menuValueMinor: 2000_00,
        chargedMinor: 0,
        mealPolicy: 'free',
        settlementType: 'house_expense',
        settlementStatus: 'settled',
      });
      expect(karahi?.orderId).toBe(order.id);

      const lime = report.lines.find((l) => l.itemName === 'Fresh lime');
      expect(lime).toMatchObject({ qty: 1, menuValueMinor: 200_00, chargedMinor: 0 });
    });

    it('splits what the person was charged across the items, adding back up exactly', async () => {
      const { actor, category, item, partner } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Nadia', kind: 'staff', mealPolicy: 'discounted', mealDiscountBp: 5_000 }, actor);
      const cash = (await createPaymentMethod(ctx.db, { code: 'cash3', displayName: 'Cash3', kind: 'cash' }, actor)).id;

      const drink = await createItem(ctx.db, { categoryId: category.id, name: 'Fresh lime' }, actor);
      await setItemPrice(ctx.db, drink.id, paisa(333_33), actor);
      await setItemOwnership(ctx.db, drink.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await addLine(ctx.db, order.id, { itemId: drink.id, qty: 1 }, actor);
      await billOrder(ctx.db, order.id, {}, actor);
      await settleConsumption(ctx.db, order.id, { paymentMethodId: cash, settlementType: 'house_expense' }, actor);

      const report = await consumptionReport(ctx.db);
      const record = report.records[0]!;
      const chargedAcrossItems = sum(report.lines.map((l) => l.chargedMinor));
      // No paisa invented, none lost — the same guarantee the rest of
      // the money pipeline gives.
      expect(chargedAcrossItems).toBe(record.chargedMinor);
      expect(sum(report.lines.map((l) => l.menuValueMinor))).toBe(record.menuValueMinor);
    });

    it('records the modifiers chosen, so the detail is what was actually eaten', async () => {
      const { actor, category, partner } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Rashid', kind: 'staff', mealPolicy: 'free' }, actor);

      const karahi = await createItem(ctx.db, { categoryId: category.id, name: 'Chicken Karahi' }, actor);
      await setItemPrice(ctx.db, karahi.id, paisa(1_850_00), actor);
      await setItemOwnership(ctx.db, karahi.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
      const group = await createModifierGroup(ctx.db, { name: 'Spice level', minSelect: 1, maxSelect: 1 }, actor);
      const hot = await createModifier(ctx.db, { groupId: group.id, name: 'Extra hot', priceDeltaMinor: paisa(0) }, actor);
      await linkModifierGroup(ctx.db, karahi.id, group.id, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      await addLine(ctx.db, order.id, { itemId: karahi.id, qty: 1, modifierIds: [hot.id] }, actor);
      await billOrder(ctx.db, order.id, {}, actor);
      await settleConsumption(ctx.db, order.id, { settlementType: 'house_expense' }, actor);

      const report = await consumptionReport(ctx.db);
      expect(report.lines[0]?.modifierNames).toBe('Extra hot');
    });

    it('excludes a voided line from the detail', async () => {
      const { actor, category, item, partner } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Rashid', kind: 'staff', mealPolicy: 'free' }, actor);

      const drink = await createItem(ctx.db, { categoryId: category.id, name: 'Fresh lime' }, actor);
      await setItemPrice(ctx.db, drink.id, paisa(200_00), actor);
      await setItemOwnership(ctx.db, drink.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
      const added = await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await addLine(ctx.db, order.id, { itemId: drink.id, qty: 1 }, actor);
      await voidLine(ctx.db, order.id, added.lines[0]!.id, { reason: 'wrong item' }, actor);
      await billOrder(ctx.db, order.id, {}, actor);
      await settleConsumption(ctx.db, order.id, { settlementType: 'house_expense' }, actor);

      const report = await consumptionReport(ctx.db);
      expect(report.lines.map((l) => l.itemName)).toEqual(['Fresh lime']);
    });

    it('filters the detail to one person', async () => {
      const { actor, item } = await setupBase();
      const rashid = await createPerson(ctx.db, { name: 'Rashid', kind: 'staff', mealPolicy: 'free' }, actor);
      const nadia = await createPerson(ctx.db, { name: 'Nadia', kind: 'staff', mealPolicy: 'free' }, actor);

      for (const person of [rashid, nadia]) {
        const order = await createOrder(ctx.db, { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: person.id }, actor);
        await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
        await billOrder(ctx.db, order.id, {}, actor);
        await settleConsumption(ctx.db, order.id, { settlementType: 'house_expense' }, actor);
      }

      const report = await consumptionReport(ctx.db, { personId: rashid.id });
      expect(report.lines.map((l) => l.personName)).toEqual(['Rashid']);
    });

    it('returns no detail lines when nothing was consumed', async () => {
      await setupBase();
      const report = await consumptionReport(ctx.db);
      expect(report.lines).toEqual([]);
    });
  });

  describe('voidAndDiscountReport', () => {
    it('lists line voids, order voids, and non-zero discounts, attributed to their actor', async () => {
      const { actor, category, item, waiter } = await setupBase();

      // Two DIFFERENT items, so voiding one leaves the other paying for
      // the discount below — a repeat tap of the same item would merge
      // into one line (see ordering's addLine).
      const secondItem = await createItem(ctx.db, { categoryId: category.id, name: 'Pulao' }, actor);
      await setItemPrice(ctx.db, secondItem.id, paisa(1000_00), actor);

      const order1 = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      const detail = await addLine(ctx.db, order1.id, { itemId: item.id, qty: 1 }, actor);
      await addLine(ctx.db, order1.id, { itemId: secondItem.id, qty: 1 }, actor);
      const lineId = detail.lines[0]!.id;
      await voidLine(ctx.db, order1.id, lineId, { reason: 'wrong item' }, actor);
      await setDiscount(ctx.db, order1.id, { discountMinor: paisa(50_00), reason: 'loyal customer' }, actor);
      await setDiscount(ctx.db, order1.id, { discountMinor: paisa(0) }, actor); // cleared — must not appear

      const order2 = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order2.id, { itemId: item.id, qty: 1 }, actor);
      await voidOrder(ctx.db, order2.id, { reason: 'customer left' }, actor);

      const entries = await voidAndDiscountReport(ctx.db);
      expect(entries).toHaveLength(3);
      const kinds = entries.map((e) => e.kind).sort();
      expect(kinds).toEqual(['discount', 'void_line', 'void_order']);
      expect(entries.every((e) => e.actorId === actor.actorId && e.actorName === 'Admin')).toBe(true);

      const voidLineEntry = entries.find((e) => e.kind === 'void_line')!;
      expect(voidLineEntry.orderId).toBe(order1.id);
      expect(voidLineEntry.reason).toBe('wrong item');

      const discountEntry = entries.find((e) => e.kind === 'discount')!;
      expect(discountEntry.discountMinor).toBe(50_00);

      const voidOrderEntry = entries.find((e) => e.kind === 'void_order')!;
      expect(voidOrderEntry.orderId).toBe(order2.id);
      void waiter;
    });

    it('filters by actorId', async () => {
      const { actor, item } = await setupBase();
      const other = await createUser(ctx.db, { name: 'Manager', username: 'manager', password: '5555', role: 'manager' }, actor);
      const otherActor = { actorId: other.id, terminalId: 'till-2' };

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      await voidOrder(ctx.db, order.id, { reason: 'x' }, otherActor);

      expect(await voidAndDiscountReport(ctx.db, { actorId: actor.actorId })).toEqual([]);
      expect(await voidAndDiscountReport(ctx.db, { actorId: other.id })).toHaveLength(1);
    });
  });

  describe('tax collected shows up in dailySalesReport', () => {
    it('includes tax from an active rule', async () => {
      const { actor, item, cash, category } = await setupBase();
      await createTaxRule(ctx.db, { name: 'GST', rateBp: 1_600, appliesToCategoryId: category.id }, actor);
      await closedCustomerOrder(item, cash.id, actor);
      const report = await dailySalesReport(ctx.db);
      expect(report.taxCollectedMinor).toBe(160_00);
    });
  });
});
