import { format, paisa, sum, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import { ReceiptBuilder } from '../platform/printing/escpos.js';
import { PrintError, sendToPrinter, type PrinterTarget } from '../platform/printing/client.js';
import { renderBillHtml, renderReceiptHtml } from './receipt-html.js';
import type { Database } from '../platform/db/types.js';
import { getAllSettings } from '../settings/service.js';
import type { ReceiptSettings, RestaurantSettings, ServiceChargeSettings } from '../settings/schema.js';

const RECEIPT_WIDTH = 42; // characters — a standard 80mm thermal printer at font A

export interface TicketLine {
  readonly itemName: string;
  readonly qty: number;
  readonly modifierNames: readonly string[];
  /** The kitchen instruction, printed under the line so the customer's
   * copy says what was actually asked for. */
  readonly note: string | null;
  readonly lineTotalMinor: Paisa;
}

export interface PaymentOptionAccount {
  readonly label: string;
  readonly accountNumber: string | null;
}

export interface PaymentOption {
  readonly displayName: string;
  readonly accountTitle: string | null;
  readonly accountNumber: string | null;
  readonly bankName: string | null;
  readonly instructionsLine: string | null;
  /** Every configured account a customer could actually send money to
   * for this method — a restaurant with three Easypaisa wallets prints
   * all three. */
  readonly accounts: readonly PaymentOptionAccount[];
}

/**
 * The restaurant's own identity and receipt wording, as configured in
 * Settings. Passed IN to the renderers rather than read by them: the
 * renderers stay pure functions of their input, which is what lets the
 * printing tests assert on exact bytes without a database.
 */
export interface TicketBranding {
  readonly restaurant: RestaurantSettings;
  readonly receipt: ReceiptSettings;
}

export interface BillTicketData {
  readonly branding: TicketBranding;
  readonly orderId: number;
  readonly tableLabel: string | null;
  readonly orderType: string;
  readonly waiterName: string | null;
  readonly lines: readonly TicketLine[];
  readonly subtotalMinor: Paisa;
  readonly discountMinor: Paisa;
  readonly discountReason: string | null;
  readonly taxMinor: Paisa;
  readonly serviceChargeMinor: Paisa;
  /** What the customer reads for the charge, rate included — worked out
   * from the rate stored on THIS order, never from today's setting. */
  readonly serviceChargeLabel: string;
  readonly roundingAdjustmentMinor: Paisa;
  readonly totalMinor: Paisa;
  readonly printedAt: string;
  readonly paymentOptions: readonly PaymentOption[];
}

function twoColumn(left: string, right: string, width: number = RECEIPT_WIDTH): string {
  const space = Math.max(1, width - left.length - right.length);
  return `${left}${' '.repeat(space)}${right}`;
}

/**
 * The restaurant's own name and contact details at the top of a ticket
 * — every line of it configurable, none of it compiled in. A
 * restaurant that has configured nothing gets no header at all rather
 * than a placeholder name it would have to notice and remove.
 */
function printHeader(b: ReceiptBuilder, branding: TicketBranding): void {
  const { restaurant, receipt } = branding;
  const name = receipt.headerName.trim() || restaurant.name.trim();

  b.align('center');
  if (name) b.doubleSize(true).line(name).doubleSize(false);
  if (receipt.showAddress) {
    if (restaurant.addressLine1.trim()) b.line(restaurant.addressLine1.trim());
    if (restaurant.addressLine2.trim()) b.line(restaurant.addressLine2.trim());
  }
  if (receipt.showPhone && restaurant.phone.trim()) b.line(restaurant.phone.trim());
  if (restaurant.registrationLine.trim()) b.line(restaurant.registrationLine.trim());
  if (receipt.headerNote.trim()) b.line(receipt.headerNote.trim());
  b.align('left');
}

function printFooter(b: ReceiptBuilder, branding: TicketBranding): void {
  const { receipt } = branding;
  b.align('center').feed(1);
  if (receipt.footerMessage.trim()) b.line(receipt.footerMessage.trim());
  if (receipt.footerNote.trim()) b.line(receipt.footerNote.trim());
  b.align('left');
  b.feed(receipt.feedLines).cut();
}

/**
 * The pro-forma bill (spec's billing stage 1) — "clearly marked as a
 * bill, not a receipt": no invoice number (it doesn't have one yet —
 * see docs/decisions/007), and headed "BILL" in large type so nobody
 * mistakes it for the restaurant's record copy.
 */
export function renderBillTicket(data: BillTicketData): Buffer {
  const b = new ReceiptBuilder().init();
  printHeader(b, data.branding);
  b.align('center').doubleSize(true).line('BILL').doubleSize(false).line('(not a receipt)').align('left').rule();

  if (data.branding.receipt.showOrderNumber) b.line(`Order: #${data.orderId}`);
  b.line(`Date: ${data.printedAt}`);
  // A table label is optional (a counter sale has none), so the order
  // type is shown as well as, not instead of, the table — an operator
  // reading a stack of bills needs to know a table-less one is takeaway
  // rather than assume the label failed to print.
  if (data.branding.receipt.showTable && data.tableLabel) b.line(`Table: ${data.tableLabel}`);
  b.line(`Order type: ${data.orderType}`);
  if (data.branding.receipt.showWaiter && data.waiterName) b.line(`Waiter: ${data.waiterName}`);
  b.rule();

  for (const line of data.lines) {
    b.line(twoColumn(`${line.qty} x ${line.itemName}`, format(line.lineTotalMinor)));
    for (const modifierName of line.modifierNames) b.line(`   + ${modifierName}`);
    if (line.note) b.line(`   * ${line.note}`);
  }
  b.rule();

  b.line(twoColumn('Subtotal', format(data.subtotalMinor)));
  if (data.discountMinor > 0) {
    b.line(twoColumn(`Discount${data.discountReason ? ` (${data.discountReason})` : ''}`, `-${format(data.discountMinor)}`));
  }
  if (data.taxMinor > 0) b.line(twoColumn('Tax', format(data.taxMinor)));
  if (data.serviceChargeMinor > 0) b.line(twoColumn(data.serviceChargeLabel, format(data.serviceChargeMinor)));
  if (data.roundingAdjustmentMinor !== 0) b.line(twoColumn('Rounding', format(data.roundingAdjustmentMinor)));
  b.rule();
  b.bold(true).line(twoColumn('TOTAL', format(data.totalMinor))).bold(false);

  if (data.branding.receipt.showPaymentAccounts && data.paymentOptions.length > 0) {
    b.rule();
    b.line('Payment options:');
    for (const option of data.paymentOptions) {
      b.line(`  ${option.displayName}`);
      if (option.accountTitle) b.line(`    ${option.accountTitle}`);
      if (option.accountNumber) b.line(`    ${option.accountNumber}`);
      if (option.bankName) b.line(`    ${option.bankName}`);
      if (option.instructionsLine) b.line(`    ${option.instructionsLine}`);
      for (const account of option.accounts) {
        b.line(`    ${account.label}${account.accountNumber ? `: ${account.accountNumber}` : ''}`);
      }
    }
  }

  printFooter(b, data.branding);
  return b.build();
}

export interface PaymentLine {
  readonly methodName: string;
  readonly amountMinor: Paisa;
  readonly referenceNo: string | null;
  readonly accountLabel: string | null;
}

export interface ReceiptTicketData {
  readonly branding: TicketBranding;
  readonly orderId: number;
  readonly invoiceNo: number;
  readonly closedAt: string;
  readonly tableLabel: string | null;
  readonly orderType: string;
  readonly waiterName: string | null;
  readonly lines: readonly TicketLine[];
  readonly subtotalMinor: Paisa;
  readonly discountMinor: Paisa;
  readonly taxMinor: Paisa;
  readonly serviceChargeMinor: Paisa;
  readonly serviceChargeLabel: string;
  readonly roundingAdjustmentMinor: Paisa;
  readonly totalMinor: Paisa;
  readonly payments: readonly PaymentLine[];
  /** Total cash handed over and handed back across this order's cash
   * payments; null when none were cash. */
  readonly cashTenderedMinor: Paisa | null;
  readonly changeGivenMinor: Paisa | null;
  /** Kicks the cash drawer only when true — spec: "Open the cash drawer
   * only when a cash payment was recorded." */
  readonly cashPaymentReceived: boolean;
}

/** The final receipt (spec's billing stage 2) — the restaurant's record
 * copy, carrying the invoice number this bill only gets once it closes. */
export function renderReceiptTicket(data: ReceiptTicketData): Buffer {
  const b = new ReceiptBuilder().init();
  printHeader(b, data.branding);
  b.align('center').doubleSize(true).line('RECEIPT').doubleSize(false).line(`Invoice #${data.invoiceNo}`).align('left').rule();

  b.line(`Date: ${data.closedAt}`);
  if (data.branding.receipt.showOrderNumber) b.line(`Order: #${data.orderId}`);
  if (data.branding.receipt.showTable && data.tableLabel) b.line(`Table: ${data.tableLabel}`);
  b.line(`Order type: ${data.orderType}`);
  if (data.branding.receipt.showWaiter && data.waiterName) b.line(`Waiter: ${data.waiterName}`);
  b.rule();

  for (const line of data.lines) {
    b.line(twoColumn(`${line.qty} x ${line.itemName}`, format(line.lineTotalMinor)));
    for (const modifierName of line.modifierNames) b.line(`   + ${modifierName}`);
    if (line.note) b.line(`   * ${line.note}`);
  }
  b.rule();

  b.line(twoColumn('Subtotal', format(data.subtotalMinor)));
  if (data.discountMinor > 0) b.line(twoColumn('Discount', `-${format(data.discountMinor)}`));
  if (data.taxMinor > 0) b.line(twoColumn('Tax', format(data.taxMinor)));
  if (data.serviceChargeMinor > 0) b.line(twoColumn(data.serviceChargeLabel, format(data.serviceChargeMinor)));
  if (data.roundingAdjustmentMinor !== 0) b.line(twoColumn('Rounding', format(data.roundingAdjustmentMinor)));
  b.rule();
  b.bold(true).line(twoColumn('TOTAL', format(data.totalMinor))).bold(false);
  b.rule();

  b.line('Paid via:');
  for (const payment of data.payments) {
    b.line(twoColumn(`  ${payment.methodName}${payment.referenceNo ? ` (${payment.referenceNo})` : ''}`, format(payment.amountMinor)));
    if (payment.accountLabel) b.line(`    to ${payment.accountLabel}`);
  }
  // Only ever shown, never used to derive a total: `amountMinor` above
  // is what the bill actually received (see migration 0013).
  if (data.cashTenderedMinor !== null && data.changeGivenMinor !== null && data.changeGivenMinor > 0) {
    b.line(twoColumn('  Cash tendered', format(data.cashTenderedMinor)));
    b.line(twoColumn('  Change', format(data.changeGivenMinor)));
  }

  printFooter(b, data.branding);
  if (data.cashPaymentReceived) b.kickDrawer();
  return b.build();
}

// ---------------------------------------------------------------------
// Assembling ticket data from the database
// ---------------------------------------------------------------------

/**
 * The lines as they were sold.
 *
 * Names come from the order line's own snapshot, never from a join to
 * `item` — a receipt reprinted after the menu was renamed must still
 * say what the customer bought (migration 0017). The fallbacks only
 * fire for rows written before that migration, which the migration
 * itself backfilled.
 */
async function loadTicketLines(db: Kysely<Database>, orderId: number): Promise<TicketLine[]> {
  const lines = await db
    .selectFrom('order_line')
    .select([
      'order_line.id as id',
      'order_line.item_id as itemId',
      'order_line.qty as qty',
      'order_line.net_sales_minor as lineTotalMinor',
      'order_line.item_name_snapshot as itemName',
      'order_line.note as note',
    ])
    .where('order_line.order_id', '=', orderId)
    .where('order_line.voided', '=', 0)
    .orderBy('order_line.id', 'asc')
    .execute();

  const modifierRows = await db
    .selectFrom('order_line_modifier')
    .select([
      'order_line_modifier.order_line_id as orderLineId',
      'order_line_modifier.modifier_id as modifierId',
      'order_line_modifier.modifier_name_snapshot as name',
    ])
    .where(
      'order_line_modifier.order_line_id',
      'in',
      lines.map((l) => l.id),
    )
    .execute();

  return lines.map((line) => ({
    itemName: line.itemName ?? `item ${line.itemId}`,
    qty: line.qty,
    note: line.note,
    lineTotalMinor: line.lineTotalMinor,
    modifierNames: modifierRows
      .filter((m) => m.orderLineId === line.id)
      .map((m) => m.name ?? `modifier ${m.modifierId}`),
  }));
}

/** The configured branding and charge wording both renderers need,
 * fetched once. */
async function loadTicketConfig(db: Kysely<Database>): Promise<{ branding: TicketBranding; serviceCharge: ServiceChargeSettings }> {
  const settings = await getAllSettings(db);
  return {
    branding: { restaurant: settings.restaurant, receipt: settings.receipt },
    serviceCharge: settings.serviceCharge,
  };
}

/**
 * What to call the service charge on a ticket.
 *
 * The wording is the restaurant's current one — renaming "Service
 * charge" to "Service fee" should change every ticket, including
 * reprints. The RATE is not: it comes from the order itself, so a
 * receipt reprinted today for a bill taken when the rate was 5% still
 * reads 5%. A charge a cashier overrode carries no rate at all,
 * because no rate produced it.
 */
export function serviceChargeLabel(config: ServiceChargeSettings, rateBp: number | null): string {
  return rateBp === null ? config.displayName : `${config.displayName} (${rateBp / 100}%)`;
}

export async function buildBillTicketData(db: Kysely<Database>, orderId: number): Promise<BillTicketData> {
  const order = await db.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
  const waiter = order.waiter_id ? await db.selectFrom('user').select('name').where('id', '=', order.waiter_id).executeTakeFirst() : undefined;
  const lines = await loadTicketLines(db, orderId);
  const methods = await db.selectFrom('payment_method').selectAll().where('active', '=', 1).where('print_on_bill', '=', 1).orderBy('sort_order', 'asc').execute();
  const accounts = await db
    .selectFrom('payment_account')
    .selectAll()
    .where('active', '=', 1)
    .orderBy('sort_order', 'asc')
    .orderBy('label', 'asc')
    .execute();

  const config = await loadTicketConfig(db);

  return {
    branding: config.branding,
    orderId: order.id,
    tableLabel: order.table_label,
    orderType: order.order_type,
    waiterName: waiter?.name ?? null,
    lines,
    subtotalMinor: order.subtotal_minor,
    discountMinor: order.order_discount_minor,
    discountReason: order.discount_reason,
    taxMinor: order.tax_minor,
    serviceChargeMinor: order.service_charge_minor,
    serviceChargeLabel: serviceChargeLabel(config.serviceCharge, order.service_charge_rate_bp),
    roundingAdjustmentMinor: order.rounding_adjustment_minor,
    totalMinor: order.total_minor,
    printedAt: order.billed_at ?? new Date().toISOString(),
    paymentOptions: methods.map((m) => ({
      displayName: m.display_name,
      accountTitle: m.account_title,
      accountNumber: m.account_number,
      bankName: m.bank_name,
      instructionsLine: m.instructions_line,
      accounts: accounts
        .filter((a) => a.payment_method_id === m.id)
        .map((a) => ({ label: a.label, accountNumber: a.account_number })),
    })),
  };
}

export async function buildReceiptTicketData(db: Kysely<Database>, orderId: number): Promise<ReceiptTicketData> {
  const order = await db.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
  if (order.invoice_no === null || order.closed_at === null) {
    throw new Error(`order ${orderId} has not been closed — no receipt to print yet`);
  }
  const waiter = order.waiter_id ? await db.selectFrom('user').select('name').where('id', '=', order.waiter_id).executeTakeFirst() : undefined;
  const lines = await loadTicketLines(db, orderId);

  const paymentRows = await db
    .selectFrom('payment')
    .innerJoin('payment_method', 'payment_method.id', 'payment.payment_method_id')
    .leftJoin('payment_account', 'payment_account.id', 'payment.payment_account_id')
    .select([
      'payment_method.display_name as methodName',
      'payment_method.kind as kind',
      'payment.amount_minor as amountMinor',
      'payment.reference_no as referenceNo',
      'payment.tendered_minor as tenderedMinor',
      'payment.change_minor as changeMinor',
      'payment_account.label as accountLabel',
    ])
    .where('payment.order_id', '=', orderId)
    .where('payment.reversed_by_payment_id', 'is', null)
    .orderBy('payment.received_at', 'asc')
    .execute();

  const cashRows = paymentRows.filter((p) => p.kind === 'cash' && p.tenderedMinor !== null);

  const config = await loadTicketConfig(db);

  return {
    branding: config.branding,
    orderId: order.id,
    invoiceNo: order.invoice_no,
    closedAt: order.closed_at,
    tableLabel: order.table_label,
    orderType: order.order_type,
    waiterName: waiter?.name ?? null,
    lines,
    subtotalMinor: order.subtotal_minor,
    discountMinor: order.order_discount_minor,
    taxMinor: order.tax_minor,
    serviceChargeMinor: order.service_charge_minor,
    serviceChargeLabel: serviceChargeLabel(config.serviceCharge, order.service_charge_rate_bp),
    roundingAdjustmentMinor: order.rounding_adjustment_minor,
    totalMinor: order.total_minor,
    payments: paymentRows.map((p) => ({
      methodName: p.methodName,
      amountMinor: p.amountMinor,
      referenceNo: p.referenceNo,
      accountLabel: p.accountLabel ?? null,
    })),
    cashTenderedMinor: cashRows.length > 0 ? sum(cashRows.map((p) => p.tenderedMinor as Paisa)) : null,
    changeGivenMinor: cashRows.length > 0 ? sum(cashRows.map((p) => p.changeMinor ?? paisa(0))) : null,
    cashPaymentReceived: paymentRows.some((p) => p.kind === 'cash'),
  };
}

/**
 * What happened when a ticket was printed.
 *
 * `thermal` means the configured printer took it and the cashier can
 * tear it off. Anything else hands back `html` — the same ticket,
 * rendered for the browser's own print dialog — so the till can offer
 * Windows printing (and therefore "Microsoft Print to PDF") instead of
 * telling the cashier the print failed.
 *
 * `reason` distinguishes the two fallback cases for the message the
 * cashier sees, and for the logs: nothing configured at all is a
 * settings choice, an unreachable printer is a fault someone may want
 * to fix.
 */
export type PrintOutcome =
  | { readonly method: 'thermal' }
  | { readonly method: 'fallback'; readonly reason: 'not_configured' | 'unreachable'; readonly detail: string | null; readonly html: string };

/**
 * Try the configured thermal printer, and fall back to browser-printable
 * HTML rather than failing.
 *
 * A print is never allowed to be the thing that fails: by the time
 * either of these is called the bill is already finalised or the
 * payment already recorded, and a printer that is off, missing or
 * misconfigured is not a reason to tell a cashier their sale did not
 * work. The worst case is that they print from Windows instead.
 */
async function printOrFallBack(target: PrinterTarget | null, bytes: Buffer, html: string): Promise<PrintOutcome> {
  if (!target) return { method: 'fallback', reason: 'not_configured', detail: null, html };
  try {
    await sendToPrinter(target, bytes);
    return { method: 'thermal' };
  } catch (error) {
    // Only a printer/transport failure falls back. Anything else is a
    // real fault in this server and must surface, not be papered over
    // with a print dialog.
    if (!(error instanceof PrintError)) throw error;
    return { method: 'fallback', reason: 'unreachable', detail: error.message, html };
  }
}

/** Print the pro-forma bill — may be called any number of times without
 * changing any state (spec). */
export async function printBill(db: Kysely<Database>, orderId: number, target: PrinterTarget | null): Promise<PrintOutcome> {
  const data = await buildBillTicketData(db, orderId);
  return printOrFallBack(target, renderBillTicket(data), renderBillHtml(data));
}

/** Print the final receipt, kicking the cash drawer only if a cash
 * payment was part of this order's settlement. */
export async function printReceipt(db: Kysely<Database>, orderId: number, target: PrinterTarget | null): Promise<PrintOutcome> {
  const data = await buildReceiptTicketData(db, orderId);
  return printOrFallBack(target, renderReceiptTicket(data), renderReceiptHtml(data));
}
