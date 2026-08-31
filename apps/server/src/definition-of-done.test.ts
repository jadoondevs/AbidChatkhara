import { add, paisa, sub, sum, type Paisa } from '@pos/shared';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordPayment, refundOrder, settleConsumption } from './billing/service.js';
import { printBill, printReceipt } from './billing/printing.js';
import { addLine, billOrder, createOrder, setDiscount, voidLine } from './ordering/service.js';
import { createTestDb } from './platform/db/test-helpers.js';
import type { PrinterTarget } from './platform/printing/client.js';
import { allocationReconciliation, dailySalesReport, partnerStatement } from './reporting/service.js';
import { seed, type SeedResult } from './seed.js';
import { closeShift, getZReport, openShift } from './shifts/service.js';

/**
 * The spec's definition of done, as one executable day: "open shift,
 * dine-in order with waiter and service charge, takeaway order, delivery
 * order, order-level discount, staff meal, owner meal, void with manager
 * approval, split payment across cash and Easypaisa, bill printed then
 * paid then receipt printed, refund, close shift, Z-report, partner
 * statements" — followed by the four figures the spec says must hold at
 * the end of that day.
 *
 * Nothing here reaches the internet. The only external device is the
 * printer, and it's a real TCP socket served by this test, so the
 * "bill printed then paid then receipt printed" step is genuinely
 * exercised rather than skipped.
 */
describe('definition of done — a full day, offline', () => {
  let ctx: ReturnType<typeof createTestDb>;
  let printerServer: Server | undefined;
  let printer: PrinterTarget;
  let printed: Buffer[] = [];

  beforeEach(async () => {
    ctx = createTestDb();
    printed = [];
    printer = await new Promise((resolve) => {
      printerServer = createServer((socket) => {
        socket.on('data', (chunk) => printed.push(chunk));
      });
      printerServer.listen(0, '127.0.0.1', () => {
        const address = printerServer?.address() as AddressInfo;
        resolve({ host: '127.0.0.1', port: address.port });
      });
    });
  });

  afterEach(async () => {
    ctx?.sqlite.close();
    if (printerServer) await new Promise<void>((resolve) => printerServer?.close(() => resolve()));
    printerServer = undefined;
  });

  it('runs the whole day and every closing figure holds', async () => {
    const data: SeedResult = await seed(ctx.db);
    const admin = { actorId: data.users.admin, terminalId: 'till-1' };
    const manager = { actorId: data.users.manager, terminalId: 'till-1' };
    const cashier = { actorId: data.users.cashier, terminalId: 'till-2' };
    const { cash, easypaisa } = data.paymentMethods;
    const karahi = data.items['Chicken Karahi (full)'] as number;
    const biryani = data.items['Chicken Biryani'] as number;
    const water = data.items['Mineral water'] as number;
    const kebab = data.items['Seekh kebab (6 pcs)'] as number;
    const mild = data.modifiers['Mild'] as number; // Karahi's spice group is min 1

    // ---- open the shift ----
    const shift = await openShift(ctx.db, { openingCashMinor: paisa(5_000_00) }, admin);

    // ---- 1. dine-in, with a waiter, a service charge, and a line
    // voided with manager approval ----
    const dineIn = await createOrder(
      ctx.db,
      { orderType: 'dine_in', tableLabel: 'T4', waiterId: data.users.waiterOne },
      cashier,
    );
    await addLine(ctx.db, dineIn.id, { itemId: karahi, qty: 1, modifierIds: [mild] }, cashier);
    const withExtra = await addLine(ctx.db, dineIn.id, { itemId: water, qty: 4 }, cashier);
    const waterLine = withExtra.lines.find((line) => line.itemId === water);
    // Voiding needs a manager — the cashier alone may not (routes gate
    // this at requireRole('manager')); here the manager is the actor,
    // which is what void_approved_by records.
    await voidLine(ctx.db, dineIn.id, waterLine!.id, { reason: 'customer changed their mind' }, manager);
    const dineInBilled = await billOrder(ctx.db, dineIn.id, { serviceChargeMinor: paisa(200_00) }, cashier);
    expect(dineInBilled.netSalesMinor).toBe(1_850_00); // the voided water is gone
    expect(dineInBilled.totalMinor).toBe(2_050_00); // + Rs 200 service charge

    // Bill printed, THEN paid, THEN receipt printed — the spec's order.
    await printBill(ctx.db, dineIn.id, printer);
    const splitOne = await recordPayment(ctx.db, dineIn.id, { paymentMethodId: cash, amountMinor: paisa(1_000_00) }, cashier);
    expect(splitOne.orderClosed).toBe(false); // partial: stays awaiting payment
    const splitTwo = await recordPayment(
      ctx.db,
      dineIn.id,
      { paymentMethodId: easypaisa, amountMinor: paisa(1_050_00), referenceNo: 'EP-DEMO-1' },
      cashier,
    );
    expect(splitTwo.orderClosed).toBe(true); // split across cash and Easypaisa
    expect(splitTwo.invoiceNo).toBe(1);
    await printReceipt(ctx.db, dineIn.id, printer);

    // ---- 2. takeaway, with an order-level discount ----
    const takeaway = await createOrder(ctx.db, { orderType: 'takeaway' }, cashier);
    await addLine(ctx.db, takeaway.id, { itemId: biryani, qty: 3 }, cashier); // Rs 2,100
    await setDiscount(ctx.db, takeaway.id, { discountMinor: paisa(100_00), reason: 'regular customer' }, manager);
    const takeawayBilled = await billOrder(ctx.db, takeaway.id, {}, cashier);
    expect(takeawayBilled.netSalesMinor).toBe(2_000_00);
    const takeawaySettled = await recordPayment(
      ctx.db,
      takeaway.id,
      { paymentMethodId: cash, amountMinor: takeawayBilled.totalMinor, tenderedMinor: paisa(2_500_00) },
      cashier,
    );
    expect(takeawaySettled.changeMinor).toBe(500_00);
    expect(takeawaySettled.invoiceNo).toBe(2);

    // ---- 3. delivery, later refunded in full ----
    const delivery = await createOrder(ctx.db, { orderType: 'delivery' }, cashier);
    await addLine(ctx.db, delivery.id, { itemId: kebab, qty: 2 }, cashier); // Rs 1,900, shared 50/50
    const deliveryBilled = await billOrder(ctx.db, delivery.id, {}, cashier);
    await recordPayment(ctx.db, delivery.id, { paymentMethodId: cash, amountMinor: deliveryBilled.totalMinor }, cashier);
    const refund = await refundOrder(ctx.db, delivery.id, { reason: 'never delivered' }, manager);
    expect(refund.amountMinor).toBe(1_900_00);

    // ---- 4. staff meal (free policy) ----
    const staffPerson = data.people['Rashid (kitchen)'] as number;
    const staffMeal = await createOrder(
      ctx.db,
      { orderType: 'takeaway', channel: 'staff_meal', beneficiaryPersonId: staffPerson },
      cashier,
    );
    await addLine(ctx.db, staffMeal.id, { itemId: biryani, qty: 1 }, cashier); // Rs 700 menu value
    await billOrder(ctx.db, staffMeal.id, {}, cashier);
    const staffSettled = await settleConsumption(ctx.db, staffMeal.id, { settlementType: 'house_expense' }, cashier);
    expect(staffSettled.payment).toBeNull(); // nothing collected: free meal
    expect(staffSettled.consumptionRecord).toMatchObject({ menuValueMinor: 700_00, chargedMinor: 0, settlementMinor: 700_00 });

    // ---- 5. owner meal (discounted policy, pays the charged half) ----
    const ownerPerson = data.people['Bilal Foods — owner'] as number;
    const ownerMeal = await createOrder(
      ctx.db,
      { orderType: 'takeaway', channel: 'owner_meal', beneficiaryPersonId: ownerPerson },
      cashier,
    );
    await addLine(ctx.db, ownerMeal.id, { itemId: karahi, qty: 1, modifierIds: [mild] }, cashier); // Rs 1,850 menu value
    await billOrder(ctx.db, ownerMeal.id, {}, cashier);
    const ownerSettled = await settleConsumption(
      ctx.db,
      ownerMeal.id,
      { paymentMethodId: cash, settlementType: 'partner_personal' },
      cashier,
    );
    // 25% off: pays Rs 1,387.50, Rs 462.50 settled as a partner draw.
    expect(ownerSettled.consumptionRecord).toMatchObject({ menuValueMinor: 1_850_00, chargedMinor: 1_387_50, settlementMinor: 462_50 });
    expect(ownerSettled.payment?.amountMinor).toBe(1_387_50);

    // The printer really was spoken to, twice (bill then receipt).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(printed.length).toBeGreaterThanOrEqual(2);

    // ================================================================
    // The closing figures the spec names
    // ================================================================

    // ---- sum of all partner allocations equals total net sales ----
    const allocations = await ctx.db.selectFrom('line_allocation').selectAll().execute();
    const closedOrders = await ctx.db.selectFrom('order').select(['net_sales_minor']).where('status', '=', 'closed').execute();
    const totalNetSales = sum(closedOrders.map((order) => order.net_sales_minor));
    const originalAllocations = allocations.filter((row) => row.reverses_allocation_id === null);
    expect(sum(originalAllocations.map((row) => row.amount_minor))).toBe(totalNetSales);

    // The refunded delivery order's allocations net to zero, so what
    // partners are actually owed is net sales minus that refund.
    expect(sum(allocations.map((row) => row.amount_minor))).toBe(sub(totalNetSales, paisa(1_900_00)));

    // ---- partner statement reconciliation variance is exactly zero ----
    const reconciliation = await allocationReconciliation(ctx.db);
    expect(reconciliation.varianceMinor).toBe(0);
    for (const partnerId of Object.values(data.partners)) {
      const statement = await partnerStatement(ctx.db, partnerId);
      expect(statement.reconciliation.varianceMinor).toBe(0);
      // Each partner's own total splits cleanly into customer versus
      // consumption revenue — the spec's required breakdown.
      expect(add(statement.customerSalesAllocatedMinor, statement.consumptionAllocatedMinor)).toBe(statement.totalAllocatedMinor);
    }

    // ---- expected cash matches a hand-computed figure, with service
    // charge shown separately as held-not-earned ----
    //
    // Cash in the drawer, by hand:
    //   opening float                        5,000.00
    //   dine-in, cash part of the split      +1,000.00
    //   takeaway, paid in cash               +2,000.00
    //   delivery, paid in cash               +1,900.00
    //   delivery refund, cash back out       -1,900.00
    //   owner meal, charged portion          +1,387.50
    //   ---------------------------------------------
    //   expected                              9,387.50
    // The dine-in's Rs 1,050 Easypaisa half is NOT cash, and the free
    // staff meal collected nothing at all.
    const handComputedCash = paisa(9_387_50);
    const closed = await closeShift(ctx.db, shift.id, { countedCashMinor: handComputedCash }, admin);
    expect(closed.expectedCashMinor).toBe(handComputedCash);
    expect(closed.varianceMinor).toBe(0);

    // ---- Z-report: service charge separate from sales ----
    const zReport = await getZReport(ctx.db, shift.id);
    expect(zReport.serviceChargeCollectedMinor).toBe(200_00); // held for the waiter
    // ...and NOT inside the sales figures: customer sales is the sum of
    // the three customer orders' net sales, service charge excluded.
    expect(zReport.customerSalesMinor).toBe(add(add(paisa(1_850_00), paisa(2_000_00)), paisa(1_900_00)));
    expect(zReport.consumptionMinor).toBe(add(paisa(700_00), paisa(1_850_00)));
    expect(zReport.combinedSalesMinor).toBe(add(zReport.customerSalesMinor, zReport.consumptionMinor));

    // ---- partner statements and the daily sales report agree ----
    const daily = await dailySalesReport(ctx.db);
    expect(daily.customerSalesMinor).toBe(zReport.customerSalesMinor);
    expect(daily.consumptionMinor).toBe(zReport.consumptionMinor);
    expect(daily.serviceChargeByWaiter).toEqual([{ waiterId: data.users.waiterOne, waiterName: 'Faisal Ahmed', totalMinor: 200_00 }]);
  });

  it('enabling a tax rule changes tax and totals but leaves every partner allocation identical', async () => {
    // Run the same basket twice against two databases — one untaxed,
    // one with a 16% rule — and compare what each partner was allocated.
    const runBasket = async (withTax: boolean): Promise<{ total: Paisa; tax: Paisa; byPartner: Map<number, Paisa> }> => {
      const local = createTestDb();
      try {
        const data = await seed(local.db);
        const actor = { actorId: data.users.admin, terminalId: 'till-1' };
        if (withTax) {
          const { createTaxRule } = await import('./tax/service.js');
          await createTaxRule(local.db, { name: 'Test GST', rateBp: 1_600 }, actor);
        }

        await openShift(local.db, { openingCashMinor: paisa(0) }, actor);
        const order = await createOrder(local.db, { orderType: 'takeaway' }, actor);
        await addLine(local.db, order.id, { itemId: data.items['Chicken Biryani'] as number, qty: 3 }, actor);
        await addLine(local.db, order.id, { itemId: data.items['Seekh kebab (6 pcs)'] as number, qty: 1 }, actor);
        const billed = await billOrder(local.db, order.id, {}, actor);
        await recordPayment(local.db, order.id, { paymentMethodId: data.paymentMethods.cash, amountMinor: billed.totalMinor }, actor);

        const rows = await local.db.selectFrom('line_allocation').select(['partner_id', 'amount_minor']).execute();
        const byPartner = new Map<number, Paisa>();
        for (const row of rows) byPartner.set(row.partner_id, add(byPartner.get(row.partner_id) ?? paisa(0), row.amount_minor));
        return { total: billed.totalMinor, tax: billed.taxMinor, byPartner };
      } finally {
        local.sqlite.close();
      }
    };

    const untaxed = await runBasket(false);
    const taxed = await runBasket(true);

    expect(untaxed.tax).toBe(0);
    expect(taxed.tax).toBeGreaterThan(0);
    expect(taxed.total).toBeGreaterThan(untaxed.total);
    // The whole point: every partner's allocation is byte-for-byte the
    // same basket, taxed or not (docs/decisions/010).
    expect([...taxed.byPartner.entries()].sort()).toEqual([...untaxed.byPartner.entries()].sort());
  });
});
