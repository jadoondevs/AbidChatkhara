import { format, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import { ReceiptBuilder } from '../platform/printing/escpos.js';
import { sendToPrinter, type PrinterTarget } from '../platform/printing/client.js';
import type { Database } from '../platform/db/types.js';

const RECEIPT_WIDTH = 42; // characters — a standard 80mm thermal printer at font A

export interface TicketLine {
  readonly itemName: string;
  readonly qty: number;
  readonly modifierNames: readonly string[];
  readonly lineTotalMinor: Paisa;
}

export interface PaymentOption {
  readonly displayName: string;
  readonly accountTitle: string | null;
  readonly accountNumber: string | null;
  readonly bankName: string | null;
  readonly instructionsLine: string | null;
}

export interface BillTicketData {
  readonly tableLabel: string | null;
  readonly orderType: string;
  readonly waiterName: string | null;
  readonly lines: readonly TicketLine[];
  readonly subtotalMinor: Paisa;
  readonly discountMinor: Paisa;
  readonly discountReason: string | null;
  readonly serviceChargeMinor: Paisa;
  readonly totalMinor: Paisa;
  readonly paymentOptions: readonly PaymentOption[];
}

function twoColumn(left: string, right: string, width: number = RECEIPT_WIDTH): string {
  const space = Math.max(1, width - left.length - right.length);
  return `${left}${' '.repeat(space)}${right}`;
}

/**
 * The pro-forma bill (spec's billing stage 1) — "clearly marked as a
 * bill, not a receipt": no invoice number (it doesn't have one yet —
 * see docs/decisions/007), and headed "BILL" in large type so nobody
 * mistakes it for the restaurant's record copy.
 */
export function renderBillTicket(data: BillTicketData): Buffer {
  const b = new ReceiptBuilder().init().align('center').doubleSize(true).line('BILL').doubleSize(false).line('(not a receipt)').align('left').rule();

  b.line(data.tableLabel ? `Table: ${data.tableLabel}` : `Order type: ${data.orderType}`);
  if (data.waiterName) b.line(`Waiter: ${data.waiterName}`);
  b.rule();

  for (const line of data.lines) {
    b.line(twoColumn(`${line.qty} x ${line.itemName}`, format(line.lineTotalMinor)));
    for (const modifierName of line.modifierNames) b.line(`   + ${modifierName}`);
  }
  b.rule();

  b.line(twoColumn('Subtotal', format(data.subtotalMinor)));
  if (data.discountMinor > 0) {
    b.line(twoColumn(`Discount${data.discountReason ? ` (${data.discountReason})` : ''}`, `-${format(data.discountMinor)}`));
  }
  if (data.serviceChargeMinor > 0) b.line(twoColumn('Service charge', format(data.serviceChargeMinor)));
  b.rule();
  b.bold(true).line(twoColumn('TOTAL', format(data.totalMinor))).bold(false);

  if (data.paymentOptions.length > 0) {
    b.rule();
    b.line('Payment options:');
    for (const option of data.paymentOptions) {
      b.line(`  ${option.displayName}`);
      if (option.accountTitle) b.line(`    ${option.accountTitle}`);
      if (option.accountNumber) b.line(`    ${option.accountNumber}`);
      if (option.bankName) b.line(`    ${option.bankName}`);
      if (option.instructionsLine) b.line(`    ${option.instructionsLine}`);
    }
  }

  b.feed(3).cut();
  return b.build();
}

export interface PaymentLine {
  readonly methodName: string;
  readonly amountMinor: Paisa;
  readonly referenceNo: string | null;
}

export interface ReceiptTicketData {
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
  readonly roundingAdjustmentMinor: Paisa;
  readonly totalMinor: Paisa;
  readonly payments: readonly PaymentLine[];
  /** Kicks the cash drawer only when true — spec: "Open the cash drawer
   * only when a cash payment was recorded." */
  readonly cashPaymentReceived: boolean;
}

/** The final receipt (spec's billing stage 2) — the restaurant's record
 * copy, carrying the invoice number this bill only gets once it closes. */
export function renderReceiptTicket(data: ReceiptTicketData): Buffer {
  const b = new ReceiptBuilder()
    .init()
    .align('center')
    .doubleSize(true)
    .line('RECEIPT')
    .doubleSize(false)
    .line(`Invoice #${data.invoiceNo}`)
    .align('left')
    .rule();

  b.line(`Date: ${data.closedAt}`);
  b.line(data.tableLabel ? `Table: ${data.tableLabel}` : `Order type: ${data.orderType}`);
  if (data.waiterName) b.line(`Waiter: ${data.waiterName}`);
  b.rule();

  for (const line of data.lines) {
    b.line(twoColumn(`${line.qty} x ${line.itemName}`, format(line.lineTotalMinor)));
    for (const modifierName of line.modifierNames) b.line(`   + ${modifierName}`);
  }
  b.rule();

  b.line(twoColumn('Subtotal', format(data.subtotalMinor)));
  if (data.discountMinor > 0) b.line(twoColumn('Discount', `-${format(data.discountMinor)}`));
  if (data.taxMinor > 0) b.line(twoColumn('Tax', format(data.taxMinor)));
  if (data.serviceChargeMinor > 0) b.line(twoColumn('Service charge', format(data.serviceChargeMinor)));
  if (data.roundingAdjustmentMinor !== 0) b.line(twoColumn('Rounding', format(data.roundingAdjustmentMinor)));
  b.rule();
  b.bold(true).line(twoColumn('TOTAL', format(data.totalMinor))).bold(false);
  b.rule();

  b.line('Paid via:');
  for (const payment of data.payments) {
    b.line(twoColumn(`  ${payment.methodName}${payment.referenceNo ? ` (${payment.referenceNo})` : ''}`, format(payment.amountMinor)));
  }

  b.align('center').feed(1).line('Thank you').align('left');
  b.feed(3).cut();
  if (data.cashPaymentReceived) b.kickDrawer();
  return b.build();
}

// ---------------------------------------------------------------------
// Assembling ticket data from the database
// ---------------------------------------------------------------------

async function loadTicketLines(db: Kysely<Database>, orderId: number): Promise<TicketLine[]> {
  const lines = await db
    .selectFrom('order_line')
    .innerJoin('item', 'item.id', 'order_line.item_id')
    .select(['order_line.id as id', 'order_line.qty as qty', 'order_line.net_sales_minor as lineTotalMinor', 'item.name as itemName'])
    .where('order_line.order_id', '=', orderId)
    .where('order_line.voided', '=', 0)
    .orderBy('order_line.id', 'asc')
    .execute();

  const modifierRows = await db
    .selectFrom('order_line_modifier')
    .innerJoin('modifier', 'modifier.id', 'order_line_modifier.modifier_id')
    .select(['order_line_modifier.order_line_id as orderLineId', 'modifier.name as name'])
    .where(
      'order_line_modifier.order_line_id',
      'in',
      lines.map((l) => l.id),
    )
    .execute();

  return lines.map((line) => ({
    itemName: line.itemName,
    qty: line.qty,
    lineTotalMinor: line.lineTotalMinor,
    modifierNames: modifierRows.filter((m) => m.orderLineId === line.id).map((m) => m.name),
  }));
}

export async function buildBillTicketData(db: Kysely<Database>, orderId: number): Promise<BillTicketData> {
  const order = await db.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
  const waiter = order.waiter_id ? await db.selectFrom('user').select('name').where('id', '=', order.waiter_id).executeTakeFirst() : undefined;
  const lines = await loadTicketLines(db, orderId);
  const methods = await db.selectFrom('payment_method').selectAll().where('active', '=', 1).where('print_on_bill', '=', 1).orderBy('sort_order', 'asc').execute();

  return {
    tableLabel: order.table_label,
    orderType: order.order_type,
    waiterName: waiter?.name ?? null,
    lines,
    subtotalMinor: order.subtotal_minor,
    discountMinor: order.order_discount_minor,
    discountReason: order.discount_reason,
    serviceChargeMinor: order.service_charge_minor,
    totalMinor: order.total_minor,
    paymentOptions: methods.map((m) => ({
      displayName: m.display_name,
      accountTitle: m.account_title,
      accountNumber: m.account_number,
      bankName: m.bank_name,
      instructionsLine: m.instructions_line,
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
    .select(['payment_method.display_name as methodName', 'payment_method.kind as kind', 'payment.amount_minor as amountMinor', 'payment.reference_no as referenceNo'])
    .where('payment.order_id', '=', orderId)
    .where('payment.reversed_by_payment_id', 'is', null)
    .orderBy('payment.received_at', 'asc')
    .execute();

  return {
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
    roundingAdjustmentMinor: order.rounding_adjustment_minor,
    totalMinor: order.total_minor,
    payments: paymentRows.map((p) => ({ methodName: p.methodName, amountMinor: p.amountMinor, referenceNo: p.referenceNo })),
    cashPaymentReceived: paymentRows.some((p) => p.kind === 'cash'),
  };
}

/** Print the pro-forma bill — may be called any number of times without
 * changing any state (spec). */
export async function printBill(db: Kysely<Database>, orderId: number, target: PrinterTarget): Promise<void> {
  const data = await buildBillTicketData(db, orderId);
  await sendToPrinter(target, renderBillTicket(data));
}

/** Print the final receipt, kicking the cash drawer only if a cash
 * payment was part of this order's settlement. */
export async function printReceipt(db: Kysely<Database>, orderId: number, target: PrinterTarget): Promise<void> {
  const data = await buildReceiptTicketData(db, orderId);
  await sendToPrinter(target, renderReceiptTicket(data));
}
