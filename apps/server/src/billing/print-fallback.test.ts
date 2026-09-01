import { createServer, type Server } from 'node:net';
import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCategory, createItem, renameItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder, setOrderCustomer } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import type { PrinterTarget } from '../platform/printing/client.js';
import { saveSetting } from '../settings/service.js';
import { defaultsFor } from '../settings/schema.js';
import { activeAccountsForMethod, createPaymentAccount, createPaymentMethod, recordPayment, updatePaymentAccount, updatePaymentMethod } from './service.js';
import { buildBillTicketData, buildReceiptTicketData, printBill, printReceipt } from './printing.js';
import { renderReceiptHtml } from './receipt-html.js';

/** A loopback socket standing in for a network thermal printer: it
 * accepts a connection and keeps whatever bytes arrive, so a test can
 * assert the DIRECT path was taken and see the ESC/POS that reached it. */
function fakePrinter(): Promise<{ target: PrinterTarget; received: () => Buffer; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const server: Server = createServer((socket) => {
      socket.on('data', (chunk) => chunks.push(chunk));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('unexpected address');
      resolve({
        target: { host: '127.0.0.1', port: address.port },
        received: () => Buffer.concat(chunks),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** A port nothing is listening on — a printer that is configured but
 * switched off, unplugged, or on a machine that has since moved. */
function unreachablePrinter(): PrinterTarget {
  // Port 1 is privileged and never bound by a normal process, so a
  // connection to it fails immediately rather than hanging.
  return { host: '127.0.0.1', port: 1 };
}

describe('printing — direct printer, and the Windows fallback', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupClosedOrder() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1_850_00), actor);
    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);

    await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: 'Demo Karahi House' }, actor);

    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    const billed = await billOrder(ctx.db, order.id, {}, actor);
    const paid = await recordPayment(
      ctx.db,
      order.id,
      { paymentMethodId: cash.id, amountMinor: paisa(2_000_00) },
      actor,
    );

    return { actor, order, billed, paid, item, cash };
  }

  it('prints DIRECTLY to a configured, reachable printer', async () => {
    const { order } = await setupClosedOrder();
    const printer = await fakePrinter();

    const outcome = await printReceipt(ctx.db, order.id, printer.target);
    expect(outcome.method).toBe('thermal');

    // The bytes really reached the printer, and are ESC/POS (0x1b 0x40
    // is the initialise command every ticket starts with).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bytes = printer.received();
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    await printer.close();
  });

  it('does NOT return fallback HTML when the direct print worked', async () => {
    const { order } = await setupClosedOrder();
    const printer = await fakePrinter();

    const outcome = await printReceipt(ctx.db, order.id, printer.target);
    // Nothing for the till to open a print dialog with — showing one
    // after a successful thermal print would be a second copy.
    expect(outcome).toEqual({ method: 'thermal' });
    await printer.close();
  });

  it('falls back to HTML when NO printer is configured', async () => {
    const { order } = await setupClosedOrder();

    const outcome = await printReceipt(ctx.db, order.id, null);
    expect(outcome.method).toBe('fallback');
    if (outcome.method !== 'fallback') throw new Error('unreachable');
    expect(outcome.reason).toBe('not_configured');
    expect(outcome.html).toContain('RECEIPT');
    expect(outcome.html).toContain('Demo Karahi House');
  });

  it('falls back to HTML when the configured printer cannot be reached', async () => {
    const { order } = await setupClosedOrder();

    const outcome = await printReceipt(ctx.db, order.id, unreachablePrinter());
    expect(outcome.method).toBe('fallback');
    if (outcome.method !== 'fallback') throw new Error('unreachable');
    expect(outcome.reason).toBe('unreachable');
    // The underlying fault is reported, for whoever has to fix the
    // printer — without stopping the cashier printing now.
    expect(outcome.detail).toMatch(/failed to print to 127\.0\.0\.1:1/);
    expect(outcome.html).toContain('RECEIPT');
  });

  it('never throws for a missing or broken printer — a print is not a failure', async () => {
    const { order } = await setupClosedOrder();

    await expect(printReceipt(ctx.db, order.id, null)).resolves.toBeDefined();
    await expect(printReceipt(ctx.db, order.id, unreachablePrinter())).resolves.toBeDefined();
    await expect(printBill(ctx.db, order.id, null)).resolves.toBeDefined();
    await expect(printBill(ctx.db, order.id, unreachablePrinter())).resolves.toBeDefined();
  });

  it('leaves the payment intact when printing falls back', async () => {
    const { order, paid } = await setupClosedOrder();

    await printReceipt(ctx.db, order.id, unreachablePrinter());
    await printReceipt(ctx.db, order.id, null);

    // Printing touches nothing: the sale is still one closed order with
    // exactly one payment, however many times it was printed.
    const payments = await ctx.db.selectFrom('payment').selectAll().where('order_id', '=', order.id).execute();
    expect(payments).toHaveLength(1);
    expect(payments[0]?.id).toBe(paid.payment.id);

    const row = await ctx.db.selectFrom('order').selectAll().where('id', '=', order.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('closed');
    expect(row.invoice_no).toBe(paid.invoiceNo);
  });

  it('reprints the same receipt any number of times, by either path', async () => {
    const { order } = await setupClosedOrder();
    const printer = await fakePrinter();

    const first = await printReceipt(ctx.db, order.id, printer.target);
    const second = await printReceipt(ctx.db, order.id, printer.target);
    const fallback = await printReceipt(ctx.db, order.id, null);

    expect(first.method).toBe('thermal');
    expect(second.method).toBe('thermal');
    expect(fallback.method).toBe('fallback');

    const payments = await ctx.db.selectFrom('payment').selectAll().where('order_id', '=', order.id).execute();
    expect(payments).toHaveLength(1);
    await printer.close();
  });

  it('renders the SAME totals down both print paths', async () => {
    const { order, paid } = await setupClosedOrder();
    const printer = await fakePrinter();

    await printReceipt(ctx.db, order.id, printer.target);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const thermalText = printer.received().toString('utf8');

    const outcome = await printReceipt(ctx.db, order.id, null);
    if (outcome.method !== 'fallback') throw new Error('unreachable');

    // Both renderers are pure functions of the one ticket data — so the
    // total on a PDF printed from Windows is the total on the thermal
    // ticket, to the paisa.
    const expected = 'Rs 1,850.00';
    expect(thermalText).toContain(expected);
    expect(outcome.html).toContain(expected);
    expect(outcome.html).toContain(`Invoice #${paid.invoiceNo}`);
    expect(thermalText).toContain(`Invoice #${paid.invoiceNo}`);
    await printer.close();
  });

  it('carries the cash tendered and change down the fallback path too', async () => {
    const { order } = await setupClosedOrder();

    const outcome = await printReceipt(ctx.db, order.id, null);
    if (outcome.method !== 'fallback') throw new Error('unreachable');
    expect(outcome.html).toContain('Cash tendered');
    expect(outcome.html).toContain('Rs 2,000.00');
    expect(outcome.html).toContain('Change');
    expect(outcome.html).toContain('Rs 150.00');
  });

  it('produces HTML a browser can actually print', async () => {
    const { order } = await setupClosedOrder();

    const outcome = await printReceipt(ctx.db, order.id, null);
    if (outcome.method !== 'fallback') throw new Error('unreachable');
    expect(outcome.html.startsWith('<!doctype html>')).toBe(true);
    // A receipt-shaped page, so printing to PDF gives a receipt rather
    // than a ticket stranded at the top of an A4 sheet.
    expect(outcome.html).toContain('@page { size: 80mm auto');
    expect(outcome.html).toContain('</html>');
  });

  it('escapes restaurant and item text rather than letting it become markup', async () => {
    const { actor, order } = await setupClosedOrder();
    await saveSetting(ctx.db, 'restaurant', { ...defaultsFor('restaurant'), name: '<script>alert(1)</script>' }, actor);

    const outcome = await printReceipt(ctx.db, order.id, null);
    if (outcome.method !== 'fallback') throw new Error('unreachable');
    expect(outcome.html).not.toContain('<script>alert(1)</script>');
    expect(outcome.html).toContain('&lt;script&gt;');
  });

  it('renders a bill (not a receipt) for the pro-forma path', async () => {
    const { order } = await setupClosedOrder();

    const outcome = await printBill(ctx.db, order.id, null);
    if (outcome.method !== 'fallback') throw new Error('unreachable');
    expect(outcome.html).toContain('BILL');
    expect(outcome.html).toContain('not a receipt');
    expect(outcome.html).not.toContain('Invoice #');
  });

  it('is a renderer, not a second calculation — the HTML total is the ticket data total', async () => {
    const { order } = await setupClosedOrder();
    const data = await buildReceiptTicketData(ctx.db, order.id);

    // Rendering the same data twice cannot disagree with itself, and
    // the amount rendered is the one the data carries.
    expect(renderReceiptHtml(data)).toBe(renderReceiptHtml(data));
    expect(renderReceiptHtml(data)).toContain('Rs 1,850.00');
    expect(data.totalMinor).toBe(1_850_00);
  });

  /**
   * A ticket is a record of a sale, so what it says must not move when
   * the menu does. The line names used to be read live through a join
   * to `item`, which meant renaming a dish rewrote every receipt ever
   * printed for it.
   */
  describe('a reprint says what was actually sold', () => {
    it('keeps the name the item was sold under after it is renamed', async () => {
      const { actor, order, item } = await setupClosedOrder();
      await renameItem(ctx.db, item.id, 'Chicken Karahi (full)', actor);

      const ticket = await buildReceiptTicketData(ctx.db, order.id);
      expect(ticket.lines[0]?.itemName).toBe('Karahi');
    });

    it('prints the kitchen note under its line', async () => {
      const { actor, item } = await setupClosedOrder();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1, note: 'no onions' }, actor);
      await billOrder(ctx.db, order.id, {}, actor);

      const ticket = await buildBillTicketData(ctx.db, order.id);
      expect(ticket.lines[0]?.note).toBe('no onions');

      // And it survives into both print paths, not just the data.
      const outcome = await printBill(ctx.db, order.id, null);
      expect(outcome.method).toBe('fallback');
      if (outcome.method === 'fallback') expect(outcome.html).toContain('no onions');
    });

    it('carries the customer through to the order record', async () => {
      const { actor } = await setupClosedOrder();
      const order = await createOrder(ctx.db, { orderType: 'delivery', customerName: 'A. Customer' }, actor);
      const updated = await setOrderCustomer(ctx.db, order.id, { customerPhone: '0300-0000000' }, actor);
      expect(updated.customerName).toBe('A. Customer');
      expect(updated.customerPhone).toBe('0300-0000000');
    });
  });

  /**
   * A ticket tells a customer where to send money, and a receipt says
   * where money went. Both read accounts, and both have to be immune to
   * an account being edited afterwards.
   */
  describe('accounts on a ticket', () => {
    it('prints only the accounts marked to print', async () => {
      const { actor, order } = await setupClosedOrder();
      const wallet = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
      await createPaymentAccount(ctx.db, { paymentMethodId: wallet.id, label: 'Counter wallet', accountNumber: '0300-1111111' }, actor);
      await createPaymentAccount(
        ctx.db,
        { paymentMethodId: wallet.id, label: 'Delivery wallet', accountNumber: '0300-2222222', printOnReceipt: false },
        actor,
      );

      const ticket = await buildBillTicketData(ctx.db, order.id);
      const labels = ticket.paymentOptions.flatMap((option) => option.accounts.map((account) => account.label));
      expect(labels).toContain('Counter wallet');
      expect(labels).not.toContain('Delivery wallet');
    });

    it('drops an account from the ticket without stopping it taking money', async () => {
      const { actor, order } = await setupClosedOrder();
      const wallet = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
      const account = await createPaymentAccount(ctx.db, { paymentMethodId: wallet.id, label: 'Counter wallet' }, actor);

      await updatePaymentAccount(ctx.db, account.id, { printOnReceipt: false }, actor);

      const ticket = await buildBillTicketData(ctx.db, order.id);
      expect(ticket.paymentOptions).toHaveLength(0);
      // Still live for the till: the 0/1/many rule sees it.
      expect((await activeAccountsForMethod(ctx.db, wallet.id)).map((a) => a.label)).toEqual(['Counter wallet']);
    });

    it('reprints a receipt with the account as it was, not as it has been edited', async () => {
      ctx = createTestDb();
      const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
      const actor = { actorId: admin.id, terminalId: 'till-1' };
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
      await setItemPrice(ctx.db, item.id, paisa(1_000_00), actor);
      const partner = await createPartner(ctx.db, 'Alice', actor);
      await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
      const wallet = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
      const account = await createPaymentAccount(ctx.db, { paymentMethodId: wallet.id, label: 'Saif', accountNumber: '1234567' }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(
        ctx.db,
        order.id,
        { paymentMethodId: wallet.id, amountMinor: billed.totalMinor, paymentAccountId: account.id },
        actor,
      );

      await updatePaymentAccount(ctx.db, account.id, { label: 'Ali', accountNumber: '9999999' }, actor);
      await updatePaymentMethod(ctx.db, wallet.id, { displayName: 'EP Wallet' }, actor);

      const receipt = await buildReceiptTicketData(ctx.db, order.id);
      expect(receipt.payments[0]?.accountLabel).toBe('Saif');
      expect(receipt.payments[0]?.methodName).toBe('Easypaisa');
    });

    it('keeps an unprinted account off the receipt it was paid into', async () => {
      ctx = createTestDb();
      const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
      const actor = { actorId: admin.id, terminalId: 'till-1' };
      const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
      const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
      await setItemPrice(ctx.db, item.id, paisa(1_000_00), actor);
      const partner = await createPartner(ctx.db, 'Alice', actor);
      await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
      const wallet = await createPaymentMethod(ctx.db, { code: 'easypaisa', displayName: 'Easypaisa', kind: 'wallet' }, actor);
      const account = await createPaymentAccount(
        ctx.db,
        { paymentMethodId: wallet.id, label: 'Delivery wallet', printOnReceipt: false },
        actor,
      );

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await recordPayment(
        ctx.db,
        order.id,
        { paymentMethodId: wallet.id, amountMinor: billed.totalMinor, paymentAccountId: account.id },
        actor,
      );

      const receipt = await buildReceiptTicketData(ctx.db, order.id);
      expect(receipt.payments[0]?.accountLabel).toBeNull();
      // The payment still knows which account it was — only the
      // printing is suppressed.
      const payment = await ctx.db.selectFrom('payment').selectAll().where('order_id', '=', order.id).executeTakeFirstOrThrow();
      expect(payment.payment_account_id).toBe(account.id);
    });
  });
});
