import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentAccount, createPaymentMethod, recordPayment } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb, enableServiceCharge } from '../platform/db/test-helpers.js';
import { businessDateOf, closeShift, getShiftReport, listShiftReports, openShift } from './service.js';

/**
 * Shift Reports (Reports → Shift Reports) and the complete Z-report.
 *
 * The load-bearing scenario is the after-midnight one: a shift opened at
 * 4pm on the 11th, orders rung up at 8pm and 11:50pm on the 11th and at
 * 1am and 3am on the 12th, and ALL FOUR belonging to the 11th's shift.
 * The orders here are deliberately given real timestamps that straddle
 * midnight, so this test also guards against anyone later swapping the
 * shift's `shift_id` scoping for a naive date filter that would drop the
 * after-midnight orders.
 */
describe('shifts/shift-report', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };
    await enableServiceCharge(ctx.db, actor);

    const tawaCat = await createCategory(ctx.db, { name: 'Tawa Chicken' }, actor);
    const tawa = await createItem(ctx.db, { categoryId: tawaCat.id, name: 'Tawa Piece' }, actor);
    await setItemPrice(ctx.db, tawa.id, paisa(800_00), actor);

    const biryaniCat = await createCategory(ctx.db, { name: 'Biryani' }, actor);
    const biryani = await createItem(ctx.db, { categoryId: biryaniCat.id, name: 'Matka Tikka Biryani' }, actor);
    await setItemPrice(ctx.db, biryani.id, paisa(600_00), actor);

    // Tawa is a partner item (Azhar owns it outright); biryani is a plain
    // restaurant item, which this system models as ownership by a house
    // "Restaurant" partner — every sold item is allocated to someone, so
    // the partner-share table breaks out Azhar's sales from the house's,
    // which is exactly the separation requirement 7 asks for.
    const azhar = await createPartner(ctx.db, 'Azhar', actor);
    const restaurant = await createPartner(ctx.db, 'Restaurant', actor);
    await setItemOwnership(ctx.db, tawa.id, [{ partnerId: azhar.id, shareBp: 10_000 }], actor);
    await setItemOwnership(ctx.db, biryani.id, [{ partnerId: restaurant.id, shareBp: 10_000 }], actor);

    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);
    const easypaisa = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
    await createPaymentAccount(ctx.db, { paymentMethodId: easypaisa.id, label: 'Counter wallet' }, actor);

    const waiter = await createUser(ctx.db, { name: 'Bilal', username: 'bilal', password: '1111', role: 'server' }, actor);

    return { admin, actor, tawa, biryani, azhar, cash, easypaisa, waiter };
  }

  /** Force an order's own timestamps, so the scenario genuinely straddles
   * midnight rather than sitting at whatever "now" the test ran at. Both
   * ends are set so a date filter on either would drop the row. */
  async function forceTimes(orderId: number, openedAt: string, closedAt: string): Promise<void> {
    await ctx.db.updateTable('order').set({ opened_at: openedAt, closed_at: closedAt }).where('id', '=', orderId).execute();
  }

  /**
   * One shift opened 4pm on the 11th, with four paid orders spanning
   * 8pm/11:50pm on the 11th and 1am/3am on the 12th:
   *   Tawa Piece ×2 (Rs 1600) + Rs 100 service charge, cash        (8:00pm 11th)
   *   Matka Tikka Biryani ×1 (Rs 600), Easypaisa                   (11:50pm 11th)
   *   Tawa Piece ×1 (Rs 800), cash                                 (1:00am 12th)
   *   Tawa Piece ×1 (Rs 800), cash                                 (3:00am 12th)
   */
  async function buildShift() {
    const base = await setup();
    const { actor, tawa, biryani, cash, easypaisa, waiter } = base;

    const shift = await openShift(ctx.db, { openingCashMinor: paisa(0) }, actor);
    await ctx.db.updateTable('shift').set({ opened_at: '2026-09-11T16:00:00' }).where('id', '=', shift.id).execute();

    const a = await createOrder(ctx.db, { orderType: 'dine_in', tableLabel: 'T1', waiterId: waiter.id }, actor);
    await addLine(ctx.db, a.id, { itemId: tawa.id, qty: 2 }, actor);
    const billedA = await billOrder(ctx.db, a.id, { serviceChargeMinor: paisa(100_00) }, actor);
    await recordPayment(ctx.db, a.id, { paymentMethodId: cash.id, amountMinor: billedA.totalMinor }, actor);
    await forceTimes(a.id, '2026-09-11T20:00:00', '2026-09-11T20:05:00');

    const b = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, b.id, { itemId: biryani.id, qty: 1 }, actor);
    const billedB = await billOrder(ctx.db, b.id, {}, actor);
    await recordPayment(ctx.db, b.id, { paymentMethodId: easypaisa.id, amountMinor: billedB.totalMinor }, actor);
    await forceTimes(b.id, '2026-09-11T23:50:00', '2026-09-11T23:55:00');

    const c = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, c.id, { itemId: tawa.id, qty: 1 }, actor);
    const billedC = await billOrder(ctx.db, c.id, {}, actor);
    await recordPayment(ctx.db, c.id, { paymentMethodId: cash.id, amountMinor: billedC.totalMinor }, actor);
    await forceTimes(c.id, '2026-09-12T01:00:00', '2026-09-12T01:05:00');

    const d = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, d.id, { itemId: tawa.id, qty: 1 }, actor);
    const billedD = await billOrder(ctx.db, d.id, {}, actor);
    await recordPayment(ctx.db, d.id, { paymentMethodId: cash.id, amountMinor: billedD.totalMinor }, actor);
    await forceTimes(d.id, '2026-09-12T03:00:00', '2026-09-12T03:05:00');

    return { ...base, shift };
  }

  it('files a shift under the LOCAL day it was opened, never the day an order fell on', () => {
    expect(businessDateOf('2026-09-11T20:00:00')).toBe('2026-09-11');
    // A shift OPENED at 1am is a 1am shift; it is the orders inside a
    // shift that follow the shift, not the shift that follows its orders.
    expect(businessDateOf('2026-09-12T01:00:00')).toBe('2026-09-12');
  });

  it('assigns all four orders — including the two after midnight — to the shift opened before midnight', async () => {
    const { shift } = await buildShift();
    const report = await getShiftReport(ctx.db, shift.id);

    expect(report.businessDate).toBe('2026-09-11');
    expect(report.orderCount).toBe(4);
    // 4 tawa + 1 biryani = 5 portions, even though two orders were rung
    // up after midnight on the 12th.
    expect(report.itemSalesQtyTotal).toBe(5);
  });

  it('aggregates item quantity and net sales across every order in the shift', async () => {
    const { shift } = await buildShift();
    const report = await getShiftReport(ctx.db, shift.id);

    const tawaRow = report.itemSales.find((line) => line.itemName === 'Tawa Piece');
    expect(tawaRow).toMatchObject({ qty: 4, netSalesMinor: 3200_00, categoryName: 'Tawa Chicken' });

    const biryaniRow = report.itemSales.find((line) => line.itemName === 'Matka Tikka Biryani');
    expect(biryaniRow).toMatchObject({ qty: 1, netSalesMinor: 600_00, categoryName: 'Biryani' });

    expect(report.itemSalesTotalMinor).toBe(3800_00);
  });

  it('rolls item sales up by menu category, biggest earner first', async () => {
    const { shift } = await buildShift();
    const report = await getShiftReport(ctx.db, shift.id);

    // Tawa Chicken (Rs 3200) outsells Biryani (Rs 600), so it sorts first.
    expect(report.categorySales).toEqual([
      { categoryName: 'Tawa Chicken', qty: 4, netSalesMinor: 3200_00 },
      { categoryName: 'Biryani', qty: 1, netSalesMinor: 600_00 },
    ]);
    // The category totals reconcile to the item-sales totals.
    const qty = report.categorySales.reduce((total, line) => total + line.qty, 0);
    const net = report.categorySales.reduce((total, line) => total + line.netSalesMinor, 0);
    expect(qty).toBe(report.itemSalesQtyTotal);
    expect(net).toBe(report.itemSalesTotalMinor);
  });

  it('keeps service charge OUT of revenue and reports it on its own line', async () => {
    const { shift } = await buildShift();
    const report = await getShiftReport(ctx.db, shift.id);

    // Revenue and item sales both exclude the Rs 100 service charge…
    expect(report.zReport.customerSalesMinor).toBe(3800_00);
    expect(report.itemSalesTotalMinor).toBe(3800_00);
    // …it is reported separately…
    expect(report.zReport.serviceChargeCollectedMinor).toBe(100_00);
    // …and only what was actually collected includes it.
    expect(report.totalCollectedMinor).toBe(3900_00);
  });

  it('reconciles the payment breakdown to the money collected', async () => {
    const { shift } = await buildShift();
    const report = await getShiftReport(ctx.db, shift.id);

    // Cash: 1700 (order A incl. SC) + 800 + 800 = 3300; Easypaisa: 600.
    expect(report.zReport.cashPaymentsMinor).toBe(3300_00);
    expect(report.zReport.nonCashPaymentsMinor).toBe(600_00);

    const breakdownTotal = report.zReport.paymentMethodBreakdown.reduce((total, line) => total + line.totalMinor, 0);
    expect(breakdownTotal).toBe(report.totalCollectedMinor);
    expect(report.totalCollectedMinor).toBe(3900_00);
  });

  it('aggregates partner share from partner-owned items only', async () => {
    const { shift } = await buildShift();
    const report = await getShiftReport(ctx.db, shift.id);

    // Azhar owns Tawa Piece (Rs 3200 sold); the house "Restaurant" owns
    // the biryani (Rs 600). Both are broken out, so Azhar's partner-item
    // sales are separately identifiable from the rest — the point of
    // requirement 7 — and, because every sold item is allocated, the
    // shares reconcile to item sales.
    expect(report.partnerShare).toEqual([
      { partnerId: expect.any(Number), partnerName: 'Azhar', amountMinor: 3200_00 },
      { partnerId: expect.any(Number), partnerName: 'Restaurant', amountMinor: 600_00 },
    ]);
    const azharShare = report.partnerShare.find((line) => line.partnerName === 'Azhar');
    expect(azharShare?.amountMinor).toBe(3200_00);
    expect(report.partnerShareTotalMinor).toBe(3800_00);
    expect(report.partnerShareTotalMinor).toBe(report.itemSalesTotalMinor);
  });

  it('keeps a closed shift retrievable, unchanged, under its original business date', async () => {
    const { shift, actor } = await buildShift();

    const beforeClose = await getShiftReport(ctx.db, shift.id);
    expect(beforeClose.status).toBe('open');

    // Opening float 0 + cash 3300 = expected 3300; count it exactly.
    await closeShift(ctx.db, shift.id, { countedCashMinor: paisa(3300_00) }, actor);

    const afterClose = await getShiftReport(ctx.db, shift.id);
    expect(afterClose.status).toBe('closed');
    expect(afterClose.businessDate).toBe('2026-09-11');
    expect(afterClose.orderCount).toBe(beforeClose.orderCount);
    expect(afterClose.itemSalesTotalMinor).toBe(beforeClose.itemSalesTotalMinor);
    expect(afterClose.partnerShareTotalMinor).toBe(beforeClose.partnerShareTotalMinor);
    expect(afterClose.closedByName).toBe('Admin');
  });

  it('lists shifts with business date, status, opener and headline takings', async () => {
    const { shift } = await buildShift();
    const list = await listShiftReports(ctx.db);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      businessDate: '2026-09-11',
      status: 'open',
      totalCollectedMinor: 3900_00,
      orderCount: 4,
      openedByName: 'Admin',
    });
    expect(list[0]?.shift.id).toBe(shift.id);
  });
});
