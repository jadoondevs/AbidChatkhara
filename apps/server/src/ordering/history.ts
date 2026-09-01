import { sub, sum, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../platform/db/types.js';
import { getOrder, type OrderDetail } from './service.js';

/**
 * The complete record of what happened on one order: who took it, what
 * was on it, what it came to, and how it was paid.
 *
 * This is a HISTORICAL read, and every field it returns is one that was
 * recorded at the time — the item names and prices snapshotted onto the
 * lines, the service-charge rate snapshotted onto the order, the
 * account label recorded on each payment. Nothing here is re-derived
 * from today's menu, today's settings or today's account list, because
 * a record of a transaction that changes when the restaurant changes is
 * not a record.
 *
 * The one exception is the NAMES of the people involved, which are read
 * live from `user`. That is deliberate: a user row is the person, not a
 * value that was true at a moment, and a waiter who marries and changes
 * their name is still the person who served that table. Renaming a menu
 * item is a different act entirely — it makes a new thing, sold under a
 * new name, and old bills must not adopt it.
 */

export interface HistoricalPayment {
  readonly id: number;
  readonly methodName: string;
  readonly methodKind: string;
  readonly amountMinor: Paisa;
  readonly referenceNo: string | null;
  readonly accountId: number | null;
  readonly accountLabel: string | null;
  readonly accountNumber: string | null;
  readonly accountBankName: string | null;
  readonly tenderedMinor: Paisa | null;
  readonly changeMinor: Paisa | null;
  readonly receivedAt: string;
  readonly receivedByName: string | null;
  /** A refund is a negative payment; the row it reverses points at it. */
  readonly isRefund: boolean;
  readonly reversedByPaymentId: number | null;
}

export interface HistoricalAllocation {
  readonly partnerId: number;
  readonly partnerName: string;
  readonly amountMinor: Paisa;
  readonly shareBpSnapshot: number;
}

export interface OrderHistory {
  readonly order: OrderDetail;
  readonly waiterName: string | null;
  readonly openedByName: string | null;
  readonly closedByName: string | null;
  readonly beneficiaryName: string | null;
  readonly payments: HistoricalPayment[];
  readonly paidMinor: Paisa;
  readonly balanceMinor: Paisa;
  readonly changeGivenMinor: Paisa;
  /** What each partner was credited for this order, at the shares that
   * were in force when it closed — read from `line_allocation`'s own
   * snapshot, never recomputed from current ownership. */
  readonly partnerAllocations: HistoricalAllocation[];
}

export async function getOrderHistory(db: Kysely<Database>, orderId: number): Promise<OrderHistory | null> {
  const order = await getOrder(db, orderId);
  if (!order) return null;

  const userIds = [order.waiterId, order.openedBy, order.closedBy].filter((id): id is number => id !== null);
  const users = userIds.length
    ? await db.selectFrom('user').select(['id', 'name']).where('id', 'in', userIds).execute()
    : [];
  const nameOf = (id: number | null): string | null => (id === null ? null : (users.find((u) => u.id === id)?.name ?? null));

  const beneficiary =
    order.beneficiaryPersonId === null
      ? null
      : ((await db.selectFrom('person').select('name').where('id', '=', order.beneficiaryPersonId).executeTakeFirst())?.name ?? null);

  const paymentRows = await db
    .selectFrom('payment')
    .innerJoin('payment_method', 'payment_method.id', 'payment.payment_method_id')
    .leftJoin('user', 'user.id', 'payment.received_by')
    .select([
      'payment.id as id',
      'payment.amount_minor as amountMinor',
      'payment.reference_no as referenceNo',
      'payment.tendered_minor as tenderedMinor',
      'payment.change_minor as changeMinor',
      'payment.received_at as receivedAt',
      'payment.reversed_by_payment_id as reversedByPaymentId',
      // Snapshots, not a live join: this page is a record of what
      // happened, and editing an account today must not rewrite where
      // last month's money went (migration 0019).
      'payment.method_name_snapshot as methodNameSnapshot',
      'payment_method.display_name as methodNameLive',
      'payment_method.kind as methodKind',
      'payment.payment_account_id as accountId',
      'payment.account_label_snapshot as accountLabel',
      'payment.account_number_snapshot as accountNumber',
      'payment.account_bank_snapshot as accountBankName',
      'user.name as receivedByName',
    ])
    .where('payment.order_id', '=', orderId)
    .orderBy('payment.received_at', 'asc')
    .orderBy('payment.id', 'asc')
    .execute();

  const payments: HistoricalPayment[] = paymentRows.map((row) => ({
    id: row.id,
    methodName: row.methodNameSnapshot ?? row.methodNameLive,
    methodKind: row.methodKind,
    amountMinor: row.amountMinor,
    referenceNo: row.referenceNo,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    accountNumber: row.accountNumber,
    accountBankName: row.accountBankName,
    tenderedMinor: row.tenderedMinor,
    changeMinor: row.changeMinor,
    receivedAt: row.receivedAt,
    receivedByName: row.receivedByName,
    isRefund: row.amountMinor < 0,
    reversedByPaymentId: row.reversedByPaymentId,
  }));

  // Every payment counts toward what was paid, refunds included —
  // they are negative rows, so they net out without a special case.
  const paidMinor = sum(payments.map((payment) => payment.amountMinor));
  const changeGivenMinor = sum(payments.map((payment) => payment.changeMinor ?? (0 as Paisa)));

  const allocationRows = await db
    .selectFrom('line_allocation')
    .innerJoin('order_line', 'order_line.id', 'line_allocation.order_line_id')
    .innerJoin('partner', 'partner.id', 'line_allocation.partner_id')
    .select([
      'line_allocation.partner_id as partnerId',
      'partner.name as partnerName',
      'line_allocation.amount_minor as amountMinor',
      'line_allocation.share_bp_snapshot as shareBpSnapshot',
    ])
    .where('order_line.order_id', '=', orderId)
    .execute();

  const byPartner = new Map<number, HistoricalAllocation>();
  for (const row of allocationRows) {
    const existing = byPartner.get(row.partnerId);
    byPartner.set(row.partnerId, {
      partnerId: row.partnerId,
      partnerName: row.partnerName,
      amountMinor: sum([existing?.amountMinor ?? (0 as Paisa), row.amountMinor]),
      shareBpSnapshot: row.shareBpSnapshot,
    });
  }

  return {
    order,
    waiterName: nameOf(order.waiterId),
    openedByName: nameOf(order.openedBy),
    closedByName: nameOf(order.closedBy),
    beneficiaryName: beneficiary,
    payments,
    paidMinor,
    balanceMinor: sub(order.totalMinor, paidMinor),
    changeGivenMinor,
    partnerAllocations: [...byPartner.values()].sort((a, b) => a.partnerName.localeCompare(b.partnerName)),
  };
}
