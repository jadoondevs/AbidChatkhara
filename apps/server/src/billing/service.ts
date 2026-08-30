import { add, paisa, sub, sum, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import { closeOrderInTransaction, OrderStateError, type OrderSummary } from '../ordering/service.js';
import { allocateOrderInTransaction, reverseLineAllocationsInTransaction, reverseOrderAllocationsInTransaction } from '../partners/service.js';
import type { Database } from '../platform/db/types.js';
import { eventBus } from '../platform/events/bus.js';
import type { PaymentMethodKind } from './tables.js';

declare module '../platform/events/types.js' {
  interface DomainEventMap {
    PaymentRecorded: { orderId: number; paymentId: number; amountMinor: Paisa; paymentMethodId: number };
    OrderClosed: { orderId: number; invoiceNo: number; closedAt: string; closedBy: number };
    RefundIssued: { orderId: number; orderLineId: number | null; amountMinor: Paisa; reason: string };
  }
}

/** Recording a payment or a refund always has a real, logged-in actor —
 * unlike identity's own bootstrap case, there is no "system" payment. */
export interface BillingActor {
  readonly actorId: number;
  readonly terminalId: string;
}

// ---------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------

export interface PaymentMethodSummary {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly kind: PaymentMethodKind;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly printOnBill: boolean;
  readonly accountTitle: string | null;
  readonly accountNumber: string | null;
  readonly bankName: string | null;
  readonly instructionsLine: string | null;
}

interface PaymentMethodRow {
  id: number;
  code: string;
  display_name: string;
  kind: PaymentMethodKind;
  active: number;
  sort_order: number;
  print_on_bill: number;
  account_title: string | null;
  account_number: string | null;
  bank_name: string | null;
  instructions_line: string | null;
}

function toPaymentMethodSummary(row: PaymentMethodRow): PaymentMethodSummary {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    kind: row.kind,
    active: row.active === 1,
    sortOrder: row.sort_order,
    printOnBill: row.print_on_bill === 1,
    accountTitle: row.account_title,
    accountNumber: row.account_number,
    bankName: row.bank_name,
    instructionsLine: row.instructions_line,
  };
}

export interface CreatePaymentMethodInput {
  readonly code: string;
  readonly displayName: string;
  readonly kind: PaymentMethodKind;
  readonly sortOrder?: number | undefined;
  readonly printOnBill?: boolean | undefined;
  readonly accountTitle?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly bankName?: string | undefined;
  readonly instructionsLine?: string | undefined;
}

/**
 * Not seeded automatically anywhere — the Definition-of-Done seed
 * script (a later milestone) calls this to populate Cash, Easypaisa,
 * and Bank transfer for a demo/test restaurant. Adding card support
 * later (spec: "the payment_method schema already supports kind =
 * card... adding it later must be seeding a row plus an integration")
 * is exactly this function, called once, with kind: 'card'.
 */
export async function createPaymentMethod(
  db: Kysely<Database>,
  input: CreatePaymentMethodInput,
  actor: ActorContext,
): Promise<PaymentMethodSummary> {
  const row = await db
    .insertInto('payment_method')
    .values({
      code: input.code,
      display_name: input.displayName,
      kind: input.kind,
      active: 1,
      sort_order: input.sortOrder ?? 0,
      print_on_bill: input.printOnBill ? 1 : 0,
      account_title: input.accountTitle ?? null,
      account_number: input.accountNumber ?? null,
      bank_name: input.bankName ?? null,
      instructions_line: input.instructionsLine ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toPaymentMethodSummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'payment_method.create',
    entity: 'payment_method',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listPaymentMethods(
  db: Kysely<Database>,
  opts: { includeInactive?: boolean | undefined } = {},
): Promise<PaymentMethodSummary[]> {
  let query = db.selectFrom('payment_method').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('sort_order', 'asc').orderBy('display_name', 'asc').execute();
  return rows.map(toPaymentMethodSummary);
}

export interface UpdatePaymentMethodInput {
  readonly displayName?: string | undefined;
  readonly active?: boolean | undefined;
  readonly sortOrder?: number | undefined;
  readonly printOnBill?: boolean | undefined;
  readonly accountTitle?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly bankName?: string | undefined;
  readonly instructionsLine?: string | undefined;
}

export async function updatePaymentMethod(
  db: Kysely<Database>,
  id: number,
  input: UpdatePaymentMethodInput,
  actor: ActorContext,
): Promise<PaymentMethodSummary> {
  const before = await db.selectFrom('payment_method').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`payment method ${id} not found`);

  const after = await db
    .updateTable('payment_method')
    .set({
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.printOnBill !== undefined ? { print_on_bill: input.printOnBill ? 1 : 0 } : {}),
      ...(input.accountTitle !== undefined ? { account_title: input.accountTitle } : {}),
      ...(input.accountNumber !== undefined ? { account_number: input.accountNumber } : {}),
      ...(input.bankName !== undefined ? { bank_name: input.bankName } : {}),
      ...(input.instructionsLine !== undefined ? { instructions_line: input.instructionsLine } : {}),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'payment_method.update',
    entity: 'payment_method',
    entityId: id,
    before: toPaymentMethodSummary(before),
    after: toPaymentMethodSummary(after),
  });
  return toPaymentMethodSummary(after);
}

// ---------------------------------------------------------------------
// Invoice numbering
// ---------------------------------------------------------------------

/**
 * Allocate the next invoice number from the dedicated counter, inside
 * the caller's transaction — see docs/decisions/007. `UPDATE ...
 * RETURNING` in one statement means there is no read-then-write window
 * for two closing transactions to race into the same number: SQLite
 * serializes the UPDATE itself, and Kysely serializes concurrent
 * transactions against this server's single connection on top of that.
 */
async function allocateInvoiceNumber(trx: Transaction<Database>): Promise<number> {
  const row = await trx
    .updateTable('invoice_counter')
    .set((eb) => ({ next_value: eb('next_value', '+', 1) }))
    .where('id', '=', 1)
    .returning('next_value')
    .executeTakeFirstOrThrow();
  // The counter holds the NEXT value to hand out; the invoice we just
  // allocated is one less than what's left in the counter after this UPDATE.
  return row.next_value - 1;
}

// ---------------------------------------------------------------------
// Payments and closing
// ---------------------------------------------------------------------

export interface PaymentSummary {
  readonly id: number;
  readonly orderId: number;
  readonly paymentMethodId: number;
  readonly amountMinor: Paisa;
  readonly referenceNo: string | null;
  readonly receivedBy: number;
  readonly receivedAt: string;
  readonly reversedByPaymentId: number | null;
}

interface PaymentRow {
  id: number;
  order_id: number;
  payment_method_id: number;
  amount_minor: Paisa;
  reference_no: string | null;
  received_by: number;
  received_at: string;
  reversed_by_payment_id: number | null;
}

function toPaymentSummary(row: PaymentRow): PaymentSummary {
  return {
    id: row.id,
    orderId: row.order_id,
    paymentMethodId: row.payment_method_id,
    amountMinor: row.amount_minor,
    referenceNo: row.reference_no,
    receivedBy: row.received_by,
    receivedAt: row.received_at,
    reversedByPaymentId: row.reversed_by_payment_id,
  };
}

/** Payments not reversed, for a given order — what actually counts
 * toward "has this order been paid off". */
async function unreversedPayments(trx: Transaction<Database>, orderId: number): Promise<PaymentRow[]> {
  return trx.selectFrom('payment').selectAll().where('order_id', '=', orderId).where('reversed_by_payment_id', 'is', null).execute();
}

export interface RecordPaymentInput {
  readonly paymentMethodId: number;
  readonly amountMinor: Paisa;
  readonly referenceNo?: string | undefined;
  /** Cash only: what the customer physically handed over, for change —
   * never persisted, only used to compute `changeMinor` in the response. */
  readonly tenderedMinor?: Paisa | undefined;
}

export interface RecordPaymentResult {
  readonly payment: PaymentSummary;
  readonly changeMinor: Paisa | null;
  readonly orderClosed: boolean;
  readonly order: OrderSummary;
  readonly invoiceNo: number | null;
}

/**
 * Record one payment against a billed order. Split payments work by
 * calling this once per method the customer used — partial payments
 * accumulate, and the order stays 'billed' until they sum to
 * `total_minor` exactly, at which point THIS call closes the order in
 * the same transaction: allocates the invoice number, writes partner
 * allocations, transitions the order to 'closed', and emits
 * OrderClosed — the spec's "single database transaction" requirement,
 * literally one Kysely transaction from the payment insert through the
 * close.
 */
export async function recordPayment(
  db: Kysely<Database>,
  orderId: number,
  input: RecordPaymentInput,
  actor: BillingActor,
): Promise<RecordPaymentResult> {
  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
    if (!order) throw new Error(`order ${orderId} not found`);
    if (order.status !== 'billed') {
      throw new OrderStateError(`order ${orderId} is ${order.status}, not billed — ${order.status === 'closed' ? 'this bill was already settled' : 'nothing to pay'}`);
    }

    const method = await trx.selectFrom('payment_method').selectAll().where('id', '=', input.paymentMethodId).executeTakeFirst();
    if (!method || method.active !== 1) throw new Error(`payment method ${input.paymentMethodId} not found or inactive`);
    if ((method.kind === 'wallet' || method.kind === 'bank_transfer') && !input.referenceNo?.trim()) {
      throw new OrderStateError(`a reference number is required for ${method.kind} payments`);
    }
    if (input.amountMinor <= 0) throw new Error('payment amount must be positive');

    const priorPayments = await unreversedPayments(trx, orderId);
    const paidSoFar = sum(priorPayments.map((p) => p.amount_minor));
    const remaining = sub(order.total_minor, paidSoFar);
    if (input.amountMinor > remaining) {
      throw new OrderStateError(`payment of ${input.amountMinor} exceeds the remaining balance of ${remaining}`);
    }

    const now = new Date().toISOString();
    const paymentRow = await trx
      .insertInto('payment')
      .values({
        order_id: orderId,
        payment_method_id: input.paymentMethodId,
        amount_minor: input.amountMinor,
        reference_no: input.referenceNo ?? null,
        received_by: actor.actorId,
        received_at: now,
        reversed_by_payment_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'payment.record',
      entity: 'order',
      entityId: orderId,
      after: toPaymentSummary(paymentRow),
    });
    eventBus.emit('PaymentRecorded', {
      orderId,
      paymentId: paymentRow.id,
      amountMinor: paymentRow.amount_minor,
      paymentMethodId: input.paymentMethodId,
    });

    const newPaidTotal = add(paidSoFar, input.amountMinor);
    const nowFullyPaid = newPaidTotal === order.total_minor;

    let closedOrder: OrderSummary = {
      id: order.id,
      invoiceNo: order.invoice_no,
      orderType: order.order_type,
      channel: order.channel,
      tableLabel: order.table_label,
      waiterId: order.waiter_id,
      openedAt: order.opened_at,
      billedAt: order.billed_at,
      closedAt: order.closed_at,
      openedBy: order.opened_by,
      closedBy: order.closed_by,
      status: order.status,
      subtotalMinor: order.subtotal_minor,
      orderDiscountMinor: order.order_discount_minor,
      discountReason: order.discount_reason,
      netSalesMinor: order.net_sales_minor,
      taxMinor: order.tax_minor,
      serviceChargeMinor: order.service_charge_minor,
      roundingAdjustmentMinor: order.rounding_adjustment_minor,
      totalMinor: order.total_minor,
      version: order.version,
    };
    let invoiceNo: number | null = null;

    if (nowFullyPaid) {
      invoiceNo = await allocateInvoiceNumber(trx);
      await allocateOrderInTransaction(trx, orderId, new Date(now), actor);
      closedOrder = await closeOrderInTransaction(trx, orderId, {
        invoiceNo,
        closedBy: actor.actorId,
        terminalId: actor.terminalId,
      });
      eventBus.emit('OrderClosed', { orderId, invoiceNo, closedAt: now, closedBy: actor.actorId });
    }

    const changeMinor =
      method.kind === 'cash' && input.tenderedMinor !== undefined ? sub(input.tenderedMinor, input.amountMinor) : null;

    return {
      payment: toPaymentSummary(paymentRow),
      changeMinor,
      orderClosed: nowFullyPaid,
      order: closedOrder,
      invoiceNo,
    };
  });
}

// ---------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------

export interface RefundInput {
  readonly reason: string;
  /** Refund one line (a partial refund) or the whole order — exactly one. */
  readonly orderLineId?: number | undefined;
}

export interface RefundResult {
  readonly refundPaymentId: number;
  readonly amountMinor: Paisa;
  readonly allocationsReversed: number;
}

/**
 * Refund a closed order, in full or for one line: reverses the
 * corresponding partner allocation(s) using their own snapshotted
 * shares (docs/decisions/006) and records a negative payment row against
 * the original payment method, referencing it via
 * reversed_by_payment_id — all in one transaction. Only valid on a
 * closed order (there is nothing to refund on a bill nobody has paid).
 */
export async function refundOrder(db: Kysely<Database>, orderId: number, input: RefundInput, actor: BillingActor): Promise<RefundResult> {
  if (!input.reason.trim()) throw new Error('a refund reason is required');

  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
    if (!order) throw new Error(`order ${orderId} not found`);
    if (order.status !== 'closed') {
      throw new OrderStateError(`order ${orderId} is ${order.status}, not closed — nothing to refund`);
    }

    const reversals =
      input.orderLineId !== undefined
        ? await reverseLineAllocationsInTransaction(trx, input.orderLineId, actor)
        : await reverseOrderAllocationsInTransaction(trx, orderId, actor);

    if (reversals.length === 0) {
      throw new OrderStateError('nothing to refund — every allocation for this target has already been reversed');
    }

    const amountToRefund = paisa(-sum(reversals.map((r) => r.amountMinor))); // reversal amounts are negative; refund is positive

    const originalPayment = await trx
      .selectFrom('payment')
      .selectAll()
      .where('order_id', '=', orderId)
      .where('reversed_by_payment_id', 'is', null)
      .orderBy('received_at', 'desc')
      .executeTakeFirst();
    if (!originalPayment) throw new Error(`order ${orderId} has no unreversed payment to refund against`);

    const now = new Date().toISOString();
    const refundRow = await trx
      .insertInto('payment')
      .values({
        order_id: orderId,
        payment_method_id: originalPayment.payment_method_id,
        amount_minor: paisa(-amountToRefund),
        reference_no: null,
        received_by: actor.actorId,
        received_at: now,
        reversed_by_payment_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx.updateTable('payment').set({ reversed_by_payment_id: refundRow.id }).where('id', '=', originalPayment.id).execute();

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.refund',
      entity: 'order',
      entityId: orderId,
      after: { reason: input.reason, amountMinor: amountToRefund, orderLineId: input.orderLineId ?? null },
    });
    eventBus.emit('RefundIssued', { orderId, orderLineId: input.orderLineId ?? null, amountMinor: amountToRefund, reason: input.reason });

    return { refundPaymentId: refundRow.id, amountMinor: amountToRefund, allocationsReversed: reversals.length };
  });
}
