import { add, paisa, sub, sum, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { recordConsumptionInTransaction, type ConsumptionRecordSummary, type SettlementType } from '../consumption/service.js';
import { computeMealCharge } from '../consumption/policy.js';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import { closeOrderInTransaction, OrderStateError, type OrderSummary } from '../ordering/service.js';
import { recordServiceChargeEntryInTransaction, reverseServiceChargeEntriesInTransaction } from '../gratuity/service.js';
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
// Payment accounts
// ---------------------------------------------------------------------

/**
 * What kind of thing money lands in. Derived from the owning payment
 * method's `kind` rather than stored on the account — see
 * docs/decisions/016. A wallet method is an Easypaisa-style account, a
 * bank_transfer method is a bank account, and anything else is 'other'.
 */
export type PaymentAccountType = 'easypaisa' | 'bank' | 'other';

export function accountTypeForKind(kind: PaymentMethodKind): PaymentAccountType {
  if (kind === 'wallet') return 'easypaisa';
  if (kind === 'bank_transfer') return 'bank';
  return 'other';
}

/** Cash is handed over, not transferred — it lands in the drawer, and
 * there is no account for it to arrive in. */
export function methodRequiresAccount(kind: PaymentMethodKind): boolean {
  return kind !== 'cash';
}

export interface PaymentAccountSummary {
  readonly id: number;
  readonly paymentMethodId: number;
  readonly accountType: PaymentAccountType;
  readonly label: string;
  readonly accountTitle: string | null;
  readonly accountNumber: string | null;
  readonly bankName: string | null;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

interface PaymentAccountRow {
  id: number;
  payment_method_id: number;
  label: string;
  account_title: string | null;
  account_number: string | null;
  bank_name: string | null;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
}

function toPaymentAccountSummary(row: PaymentAccountRow, kind: PaymentMethodKind): PaymentAccountSummary {
  return {
    id: row.id,
    paymentMethodId: row.payment_method_id,
    accountType: accountTypeForKind(kind),
    label: row.label,
    accountTitle: row.account_title,
    accountNumber: row.account_number,
    bankName: row.bank_name,
    active: row.active === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreatePaymentAccountInput {
  readonly paymentMethodId: number;
  readonly label: string;
  readonly accountTitle?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly bankName?: string | undefined;
  readonly sortOrder?: number | undefined;
}

export async function createPaymentAccount(
  db: Kysely<Database>,
  input: CreatePaymentAccountInput,
  actor: ActorContext,
): Promise<PaymentAccountSummary> {
  const method = await db.selectFrom('payment_method').select(['id', 'kind']).where('id', '=', input.paymentMethodId).executeTakeFirst();
  if (!method) throw new Error(`payment method ${input.paymentMethodId} not found`);
  if (!methodRequiresAccount(method.kind)) {
    throw new PaymentAccountError(`${method.kind} payments are handed over at the till — they have no account to land in`);
  }
  if (!input.label.trim()) throw new Error('a payment account needs a label');

  const now = new Date().toISOString();
  const row = await db
    .insertInto('payment_account')
    .values({
      payment_method_id: input.paymentMethodId,
      label: input.label.trim(),
      account_title: input.accountTitle ?? null,
      account_number: input.accountNumber ?? null,
      bank_name: input.bankName ?? null,
      active: 1,
      sort_order: input.sortOrder ?? 0,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const summary = toPaymentAccountSummary(row, method.kind);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'payment_account.create',
    entity: 'payment_account',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listPaymentAccounts(
  db: Kysely<Database>,
  opts: { paymentMethodId?: number | undefined; includeInactive?: boolean | undefined } = {},
): Promise<PaymentAccountSummary[]> {
  let query = db
    .selectFrom('payment_account')
    .innerJoin('payment_method', 'payment_method.id', 'payment_account.payment_method_id')
    .selectAll('payment_account')
    .select('payment_method.kind as kind');
  if (opts.paymentMethodId !== undefined) query = query.where('payment_account.payment_method_id', '=', opts.paymentMethodId);
  if (!opts.includeInactive) query = query.where('payment_account.active', '=', 1);

  const rows = await query.orderBy('payment_account.sort_order', 'asc').orderBy('payment_account.label', 'asc').execute();
  return rows.map((row) => toPaymentAccountSummary(row, row.kind));
}

/**
 * The active accounts a payment by this method could land in — the one
 * query both the payment rule and the payment screen are built on, so
 * what the cashier is offered and what the server will accept cannot
 * disagree.
 */
export async function activeAccountsForMethod(
  db: Kysely<Database> | Transaction<Database>,
  paymentMethodId: number,
): Promise<PaymentAccountSummary[]> {
  const rows = await db
    .selectFrom('payment_account')
    .innerJoin('payment_method', 'payment_method.id', 'payment_account.payment_method_id')
    .selectAll('payment_account')
    .select('payment_method.kind as kind')
    .where('payment_account.payment_method_id', '=', paymentMethodId)
    .where('payment_account.active', '=', 1)
    .orderBy('payment_account.sort_order', 'asc')
    .orderBy('payment_account.label', 'asc')
    .execute();
  return rows.map((row) => toPaymentAccountSummary(row, row.kind));
}

export interface UpdatePaymentAccountInput {
  readonly label?: string | undefined;
  readonly accountTitle?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly bankName?: string | undefined;
  readonly active?: boolean | undefined;
  readonly sortOrder?: number | undefined;
}

/**
 * Deactivating rather than deleting is the only option offered: a
 * `payment` row references the account it landed in, so a deleted
 * account would orphan the answer to "where did this money go?" on
 * every historical payment.
 */
export async function updatePaymentAccount(
  db: Kysely<Database>,
  id: number,
  input: UpdatePaymentAccountInput,
  actor: ActorContext,
): Promise<PaymentAccountSummary> {
  const before = await db.selectFrom('payment_account').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`payment account ${id} not found`);
  const method = await db
    .selectFrom('payment_method')
    .select('kind')
    .where('id', '=', before.payment_method_id)
    .executeTakeFirstOrThrow();

  const after = await db
    .updateTable('payment_account')
    .set({
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.accountTitle !== undefined ? { account_title: input.accountTitle } : {}),
      ...(input.accountNumber !== undefined ? { account_number: input.accountNumber } : {}),
      ...(input.bankName !== undefined ? { bank_name: input.bankName } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'payment_account.update',
    entity: 'payment_account',
    entityId: id,
    before: toPaymentAccountSummary(before, method.kind),
    after: toPaymentAccountSummary(after, method.kind),
  });
  return toPaymentAccountSummary(after, method.kind);
}

/**
 * Thrown when a payment cannot name the account the money landed in.
 * Its own type so routes can answer 422 with a sentence a cashier can
 * act on — the fix is always either "configure an account" or "choose
 * one", never "try again".
 */
export class PaymentAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentAccountError';
  }
}

/**
 * Decide which account a payment landed in, and refuse the payment if
 * that cannot be answered.
 *
 * Cash is handed over at the till and lands in the drawer, so it has no
 * account and never needs one. Every other method moves money into a
 * specific wallet or bank account, and a payment that cannot say which
 * one is a payment nobody can reconcile — so:
 *
 *   no active account for this method  -> refuse; nothing to configure
 *                                         the payment against yet
 *   exactly one                        -> use it, without making the
 *                                         cashier pick from a list of one
 *   two or more, none chosen           -> refuse; picking one arbitrarily
 *                                         would file the money in the
 *                                         wrong place silently
 *   one chosen                         -> validate it: exists, active,
 *                                         and belongs to THIS method
 *
 * This is enforced here, in the service, not only in the payment
 * screen: the screen disables what it can, but a business rule about
 * money has to hold for any caller.
 */
async function resolvePaymentAccount(
  trx: Transaction<Database>,
  method: { id: number; kind: PaymentMethodKind; display_name: string },
  paymentAccountId: number | undefined,
): Promise<number | null> {
  if (!methodRequiresAccount(method.kind)) {
    if (paymentAccountId !== undefined) {
      throw new PaymentAccountError(`${method.display_name} is taken at the till — it does not land in an account`);
    }
    return null;
  }

  const active = await activeAccountsForMethod(trx, method.id);

  if (paymentAccountId === undefined) {
    if (active.length === 0) {
      throw new PaymentAccountError(
        `No ${method.display_name} account is configured. Add an active ${method.display_name} account in Settings before accepting this payment.`,
      );
    }
    if (active.length === 1) return (active[0] as PaymentAccountSummary).id;
    throw new PaymentAccountError(
      `Choose which ${method.display_name} account received this payment — ${active.length} are configured.`,
    );
  }

  const chosen = active.find((account) => account.id === paymentAccountId);
  if (!chosen) {
    // Deliberately one message for "no such account", "inactive" and
    // "belongs to another method": all three mean the same thing to the
    // cashier — the account they picked is not one this payment can go
    // to — and distinguishing them would only leak which accounts exist.
    throw new PaymentAccountError(
      `That account cannot receive a ${method.display_name} payment — it is not an active ${method.display_name} account.`,
    );
  }
  return chosen.id;
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
  readonly paymentAccountId: number | null;
  readonly tenderedMinor: Paisa | null;
  readonly changeMinor: Paisa | null;
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
  payment_account_id: number | null;
  tendered_minor: Paisa | null;
  change_minor: Paisa | null;
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
    paymentAccountId: row.payment_account_id,
    tenderedMinor: row.tendered_minor,
    changeMinor: row.change_minor,
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
  /** For cash, what the customer handed over — the amount actually
   * applied to the bill is capped at the balance and the rest is
   * change. For every other method, exactly what is being applied. */
  readonly amountMinor: Paisa;
  readonly referenceNo?: string | undefined;
  /** Which configured wallet/bank account received this money. Optional:
   * cash has no account, and a restaurant that has configured none can
   * still take payments. */
  readonly paymentAccountId?: number | undefined;
  /** Cash only, and only when the cashier keyed the tendered note
   * separately from the amount being applied. Defaults to
   * `amountMinor`. */
  readonly tenderedMinor?: Paisa | undefined;
}

export interface RecordPaymentResult {
  readonly payment: PaymentSummary;
  /** Cash handed back. Null for a non-cash payment; zero when the
   * customer paid exactly. */
  readonly changeMinor: Paisa | null;
  /** What actually went onto the bill — less than what was tendered
   * whenever there was change. */
  readonly appliedMinor: Paisa;
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
    if (order.channel === 'staff_meal' || order.channel === 'owner_meal') {
      throw new OrderStateError(`order ${orderId} is a ${order.channel} order — settle it via settleConsumption, not recordPayment`);
    }

    const method = await trx.selectFrom('payment_method').selectAll().where('id', '=', input.paymentMethodId).executeTakeFirst();
    if (!method || method.active !== 1) throw new Error(`payment method ${input.paymentMethodId} not found or inactive`);
    if (input.amountMinor <= 0) throw new Error('payment amount must be positive');

    const paymentAccountId = await resolvePaymentAccount(trx, method, input.paymentAccountId);

    const priorPayments = await unreversedPayments(trx, orderId);
    const paidSoFar = sum(priorPayments.map((p) => p.amount_minor));
    const remaining = sub(order.total_minor, paidSoFar);

    // Cash overpayment is change, not an error: a customer paying an
    // Rs 1,800 bill with an Rs 2,000 note is the single most common
    // transaction in the restaurant. Only what the bill can absorb is
    // applied to it — sales, partner allocations and expected cash all
    // read `amount_minor`, so change never inflates any of them.
    //
    // Every other method is different in kind: an Easypaisa transfer of
    // more than the bill cannot be handed back from the drawer, so it
    // stays a rejection the cashier has to resolve deliberately.
    const isCash = method.kind === 'cash';
    const tenderedMinor = isCash ? (input.tenderedMinor ?? input.amountMinor) : null;
    if (tenderedMinor !== null && tenderedMinor < input.amountMinor) {
      throw new OrderStateError(`cash tendered (${tenderedMinor}) is less than the ${input.amountMinor} being applied to the bill`);
    }
    if (!isCash && input.amountMinor > remaining) {
      throw new OrderStateError(`payment of ${input.amountMinor} exceeds the remaining balance of ${remaining}`);
    }

    const appliedMinor = isCash && input.amountMinor > remaining ? remaining : input.amountMinor;
    const changeMinor = tenderedMinor === null ? null : sub(tenderedMinor, appliedMinor);

    const now = new Date().toISOString();
    const paymentRow = await trx
      .insertInto('payment')
      .values({
        order_id: orderId,
        payment_method_id: input.paymentMethodId,
        amount_minor: appliedMinor,
        reference_no: input.referenceNo?.trim() ? input.referenceNo.trim() : null,
        payment_account_id: paymentAccountId,
        tendered_minor: tenderedMinor,
        change_minor: changeMinor,
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

    const newPaidTotal = add(paidSoFar, appliedMinor);
    const nowFullyPaid = newPaidTotal === order.total_minor;

    let closedOrder: OrderSummary = {
      id: order.id,
      invoiceNo: order.invoice_no,
      orderType: order.order_type,
      channel: order.channel,
      tableLabel: order.table_label,
      waiterId: order.waiter_id,
      beneficiaryPersonId: order.beneficiary_person_id,
      shiftId: order.shift_id,
      openedAt: order.opened_at,
      billedAt: order.billed_at,
      firstBilledAt: order.first_billed_at,
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
      await recordServiceChargeEntryInTransaction(trx, orderId, actor);
      closedOrder = await closeOrderInTransaction(trx, orderId, {
        invoiceNo,
        closedBy: actor.actorId,
        terminalId: actor.terminalId,
      });
      eventBus.emit('OrderClosed', { orderId, invoiceNo, closedAt: now, closedBy: actor.actorId });
    }

    return {
      payment: toPaymentSummary(paymentRow),
      changeMinor,
      appliedMinor,
      orderClosed: nowFullyPaid,
      order: closedOrder,
      invoiceNo,
    };
  });
}

// ---------------------------------------------------------------------
// Settling a staff/owner meal (consumption)
// ---------------------------------------------------------------------

export interface SettleConsumptionInput {
  readonly settlementType?: SettlementType | undefined;
  /** Required whenever the beneficiary's meal policy leaves something
   * charged (see consumption/policy.ts); must be omitted for a
   * free/payroll_deduction meal, where nothing is collected at the till. */
  readonly paymentMethodId?: number | undefined;
  readonly referenceNo?: string | undefined;
  readonly paymentAccountId?: number | undefined;
}

export interface SettleConsumptionResult {
  readonly consumptionRecord: ConsumptionRecordSummary;
  readonly payment: PaymentSummary | null;
  readonly order: OrderSummary;
  readonly invoiceNo: number;
}

/**
 * The staff/owner-meal counterpart to recordPayment: closes a billed
 * staff_meal/owner_meal order in one transaction, the same shape —
 * allocate the invoice number, write partner allocations (on the full,
 * undiscounted net_sales_minor, per the spec: "partner allocations are
 * written as usual"), write the service charge entry, transition to
 * closed. What differs is the completion condition: there is no "sum of
 * payments equals total_minor" here, because the beneficiary is very
 * often not paying total_minor at all. Instead, this always closes in
 * one call, and only inserts a `payment` row when the person's own meal
 * policy actually leaves something charged.
 *
 * That's also exactly how the spec's "must not count toward expected
 * cash unless the person actually paid cash" is satisfied structurally,
 * not by a special case: a shift's cash reconciliation (a later
 * milestone) will simply sum `payment` rows the same way it does for
 * every other order, and a free or payroll_deduction meal never writes
 * one.
 */
export async function settleConsumption(
  db: Kysely<Database>,
  orderId: number,
  input: SettleConsumptionInput,
  actor: BillingActor,
): Promise<SettleConsumptionResult> {
  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
    if (!order) throw new Error(`order ${orderId} not found`);
    if (order.status !== 'billed') {
      throw new OrderStateError(`order ${orderId} is ${order.status}, not billed — ${order.status === 'closed' ? 'this bill was already settled' : 'nothing to settle'}`);
    }
    if (order.channel !== 'staff_meal' && order.channel !== 'owner_meal') {
      throw new OrderStateError(`order ${orderId} is a '${order.channel}' order — settle it via recordPayment, not settleConsumption`);
    }

    // beneficiary_person_id is guaranteed non-null here: createOrder
    // refuses to open a staff_meal/owner_meal order without one.
    const person = await trx.selectFrom('person').selectAll().where('id', '=', order.beneficiary_person_id as number).executeTakeFirstOrThrow();
    const { chargedMinor } = computeMealCharge(order.net_sales_minor, person.meal_policy, person.meal_discount_bp);

    const now = new Date().toISOString();
    let paymentRow: PaymentRow | null = null;
    if (chargedMinor > 0) {
      if (!input.paymentMethodId) {
        throw new OrderStateError(`${person.name} owes ${chargedMinor} for this meal — a payment method is required to collect it`);
      }
      const method = await trx.selectFrom('payment_method').selectAll().where('id', '=', input.paymentMethodId).executeTakeFirst();
      if (!method || method.active !== 1) throw new Error(`payment method ${input.paymentMethodId} not found or inactive`);
      const paymentAccountId = await resolvePaymentAccount(trx, method, input.paymentAccountId);

      paymentRow = await trx
        .insertInto('payment')
        .values({
          order_id: orderId,
          payment_method_id: input.paymentMethodId,
          amount_minor: chargedMinor,
          reference_no: input.referenceNo?.trim() ? input.referenceNo.trim() : null,
          payment_account_id: paymentAccountId,
          // A staff meal is settled for exactly what is owed — there is
          // no tendering step and so never any change.
          tendered_minor: null,
          change_minor: null,
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
    } else if (input.paymentMethodId !== undefined) {
      throw new OrderStateError(`${person.name}'s meal is not charged — there is nothing to collect a payment for`);
    }

    const invoiceNo = await allocateInvoiceNumber(trx);
    await allocateOrderInTransaction(trx, orderId, new Date(now), actor);
    await recordServiceChargeEntryInTransaction(trx, orderId, actor);
    const consumptionRecord = await recordConsumptionInTransaction(trx, orderId, { settlementType: input.settlementType }, actor);
    const closedOrder = await closeOrderInTransaction(trx, orderId, {
      invoiceNo,
      closedBy: actor.actorId,
      terminalId: actor.terminalId,
    });
    eventBus.emit('OrderClosed', { orderId, invoiceNo, closedAt: now, closedBy: actor.actorId });

    return { consumptionRecord, payment: paymentRow ? toPaymentSummary(paymentRow) : null, order: closedOrder, invoiceNo };
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

    const isFullOrderRefund = input.orderLineId === undefined;
    const reversals = isFullOrderRefund
      ? await reverseOrderAllocationsInTransaction(trx, orderId, actor)
      : await reverseLineAllocationsInTransaction(trx, input.orderLineId, actor);

    if (reversals.length === 0) {
      throw new OrderStateError('nothing to refund — every allocation for this target has already been reversed');
    }

    // Service charge is order-level, not per-line — a full-order refund
    // reverses it too (spec: "voids and refunds reverse the
    // corresponding entry"); a partial, single-line refund leaves it
    // alone, since the waiter is still owed it regardless of which item
    // came back.
    if (isFullOrderRefund) {
      await reverseServiceChargeEntriesInTransaction(trx, orderId, actor);
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
        payment_account_id: originalPayment.payment_account_id,
        tendered_minor: null,
        change_minor: null,
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
