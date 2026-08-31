import { add, paisa, sub, sum, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { OrderStatus, OrderType } from '../ordering/tables.js';
import type { Database } from '../platform/db/types.js';
import { eventBus } from '../platform/events/bus.js';

declare module '../platform/events/types.js' {
  interface DomainEventMap {
    ShiftClosed: { shiftId: number; closedAt: string; closedBy: number; expectedCashMinor: Paisa; countedCashMinor: Paisa; varianceMinor: Paisa };
  }
}

export interface ShiftActor {
  readonly actorId: number;
  readonly terminalId: string;
}

export class ShiftStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftStateError';
  }
}

export interface BlockingOrderSummary {
  readonly id: number;
  readonly orderType: OrderType;
  readonly status: OrderStatus;
  readonly tableLabel: string | null;
}

/** Carries the list of what's blocking a close — the spec's "refuse to
 * close while any order is still open or awaiting payment, listing
 * which ones" needs the list itself, not just a message. */
export class ShiftCloseBlockedError extends Error {
  readonly blockingOrders: readonly BlockingOrderSummary[];

  constructor(blockingOrders: readonly BlockingOrderSummary[]) {
    super(`cannot close: ${blockingOrders.length} order(s) still open or awaiting payment (${blockingOrders.map((o) => `#${o.id} ${o.status}`).join(', ')})`);
    this.name = 'ShiftCloseBlockedError';
    this.blockingOrders = blockingOrders;
  }
}

export interface ShiftSummary {
  readonly id: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly openedBy: number;
  readonly closedBy: number | null;
  readonly openingCashMinor: Paisa;
  readonly countedCashMinor: Paisa | null;
  readonly expectedCashMinor: Paisa | null;
  readonly varianceMinor: Paisa | null;
}

interface ShiftRow {
  id: number;
  opened_at: string;
  closed_at: string | null;
  opened_by: number;
  closed_by: number | null;
  opening_cash_minor: Paisa;
  counted_cash_minor: Paisa | null;
  expected_cash_minor: Paisa | null;
  variance_minor: Paisa | null;
}

function toShiftSummary(row: ShiftRow): ShiftSummary {
  return {
    id: row.id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openedBy: row.opened_by,
    closedBy: row.closed_by,
    openingCashMinor: row.opening_cash_minor,
    countedCashMinor: row.counted_cash_minor,
    expectedCashMinor: row.expected_cash_minor,
    varianceMinor: row.variance_minor,
  };
}

export async function getOpenShift(db: Kysely<Database>): Promise<ShiftSummary | null> {
  const row = await db.selectFrom('shift').selectAll().where('closed_at', 'is', null).executeTakeFirst();
  return row ? toShiftSummary(row) : null;
}

export async function getShift(db: Kysely<Database>, shiftId: number): Promise<ShiftSummary | null> {
  const row = await db.selectFrom('shift').selectAll().where('id', '=', shiftId).executeTakeFirst();
  return row ? toShiftSummary(row) : null;
}

export async function listShifts(db: Kysely<Database>): Promise<ShiftSummary[]> {
  const rows = await db.selectFrom('shift').selectAll().orderBy('opened_at', 'desc').execute();
  return rows.map(toShiftSummary);
}

export interface OpenShiftInput {
  readonly openingCashMinor: Paisa;
}

/** At most one shift is ever open at a time — enforced here, since
 * SQLite has no direct "at most one row where X" constraint. */
export async function openShift(db: Kysely<Database>, input: OpenShiftInput, actor: ShiftActor): Promise<ShiftSummary> {
  if (input.openingCashMinor < 0) throw new Error('openingCashMinor cannot be negative');

  return db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('shift').select('id').where('closed_at', 'is', null).executeTakeFirst();
    if (existing) throw new ShiftStateError(`shift ${existing.id} is already open — close it before opening another`);

    const now = new Date().toISOString();
    const row = await trx
      .insertInto('shift')
      .values({
        opened_at: now,
        closed_at: null,
        opened_by: actor.actorId,
        closed_by: null,
        opening_cash_minor: input.openingCashMinor,
        counted_cash_minor: null,
        expected_cash_minor: null,
        variance_minor: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const summary = toShiftSummary(row);
    await recordAudit(trx, { actorId: actor.actorId, terminalId: actor.terminalId, action: 'shift.open', entity: 'shift', entityId: row.id, after: summary });
    return summary;
  });
}

/** Orders tagged with this shift that are still `open` or `billed` —
 * the spec's own close-blocking list. */
export async function getBlockingOrders(db: Kysely<Database> | Transaction<Database>, shiftId: number): Promise<BlockingOrderSummary[]> {
  const rows = await db
    .selectFrom('order')
    .select(['id', 'order_type', 'status', 'table_label'])
    .where('shift_id', '=', shiftId)
    .where('status', 'in', ['open', 'billed'])
    .orderBy('id', 'asc')
    .execute();
  return rows.map((r) => ({ id: r.id, orderType: r.order_type, status: r.status, tableLabel: r.table_label }));
}

export interface CloseShiftInput {
  readonly countedCashMinor: Paisa;
}

/**
 * Expected cash = opening float + every unreversed CASH payment
 * received against an order tagged with this shift — refunds are
 * already negative `payment` rows, so they net out of the same sum
 * without a special case. A cash-collected service charge is already
 * inside that same payment amount (it's part of what the customer
 * handed over), so it's included here exactly as the spec requires
 * ("included in total_minor and therefore in expected cash") without
 * this query needing to know service charge exists at all — see
 * ARCHITECTURE.md's "Shifts" section for the full reasoning.
 */
async function computeExpectedCash(trx: Transaction<Database>, shift: ShiftRow): Promise<Paisa> {
  const rows = await trx
    .selectFrom('payment')
    .innerJoin('payment_method', 'payment_method.id', 'payment.payment_method_id')
    .innerJoin('order', 'order.id', 'payment.order_id')
    .select('payment.amount_minor')
    .where('order.shift_id', '=', shift.id)
    .where('payment_method.kind', '=', 'cash')
    .execute();
  return add(shift.opening_cash_minor, sum(rows.map((r) => r.amount_minor)));
}

/**
 * Refuses to close while any order this shift owns is still open or
 * awaiting payment (spec, screen 12) — the caller gets the full list via
 * ShiftCloseBlockedError, not just a count, so the UI can show exactly
 * which orders need clearing first.
 */
export async function closeShift(db: Kysely<Database>, shiftId: number, input: CloseShiftInput, actor: ShiftActor): Promise<ShiftSummary> {
  if (input.countedCashMinor < 0) throw new Error('countedCashMinor cannot be negative');

  return db.transaction().execute(async (trx) => {
    const shift = await trx.selectFrom('shift').selectAll().where('id', '=', shiftId).executeTakeFirst();
    if (!shift) throw new Error(`shift ${shiftId} not found`);
    if (shift.closed_at !== null) throw new ShiftStateError(`shift ${shiftId} is already closed`);

    const blocking = await getBlockingOrders(trx, shiftId);
    if (blocking.length > 0) throw new ShiftCloseBlockedError(blocking);

    const expectedCashMinor = await computeExpectedCash(trx, shift);
    const varianceMinor = sub(input.countedCashMinor, expectedCashMinor);
    const now = new Date().toISOString();

    const updated = await trx
      .updateTable('shift')
      .set({
        closed_at: now,
        closed_by: actor.actorId,
        counted_cash_minor: input.countedCashMinor,
        expected_cash_minor: expectedCashMinor,
        variance_minor: varianceMinor,
      })
      .where('id', '=', shiftId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const summary = toShiftSummary(updated);
    await recordAudit(trx, { actorId: actor.actorId, terminalId: actor.terminalId, action: 'shift.close', entity: 'shift', entityId: shiftId, after: summary });
    eventBus.emit('ShiftClosed', { shiftId, closedAt: now, closedBy: actor.actorId, expectedCashMinor, countedCashMinor: input.countedCashMinor, varianceMinor });
    return summary;
  });
}

// ---------------------------------------------------------------------
// Z-report
// ---------------------------------------------------------------------

export interface PaymentMethodBreakdownLine {
  readonly paymentMethodId: number;
  readonly paymentMethodName: string;
  readonly totalMinor: Paisa;
}

export interface ZReport {
  readonly shift: ShiftSummary;
  /** Net sales from customer-channel orders only — the spec's "default
   * the headline number to customer sales only". */
  readonly customerSalesMinor: Paisa;
  /** Net sales (menu value) from staff_meal/owner_meal orders — "with
   * consumption on its own line directly beneath it". */
  readonly consumptionMinor: Paisa;
  readonly combinedSalesMinor: Paisa;
  /** Menu value of staff/owner meals that nobody was charged for — the
   * part of `consumptionMinor` the house absorbed. */
  readonly consumptionUnchargedMinor: Paisa;
  readonly discountsGivenMinor: Paisa;
  /** Menu value taken off bills by voided lines and voided orders —
   * what was rung up and then removed, which is the number a manager
   * scans a Z-report for. */
  readonly voidedSalesMinor: Paisa;
  readonly taxCollectedMinor: Paisa;
  /** Service charge actually collected as part of a real payment —
   * money held for waiters, never revenue (docs/decisions/008); shown
   * here as cash held, not earned, per the spec. */
  readonly serviceChargeCollectedMinor: Paisa;
  readonly roundingAdjustmentMinor: Paisa;
  /** The cash drawer, spelled out: what it started with, what came in,
   * what was counted, and the difference. `changeGivenMinor` is shown
   * for completeness — it is already netted out of `cashPaymentsMinor`,
   * which records what was applied to bills rather than what customers
   * handed over. */
  readonly openingFloatMinor: Paisa;
  readonly cashPaymentsMinor: Paisa;
  readonly cashTenderedMinor: Paisa;
  readonly changeGivenMinor: Paisa;
  readonly nonCashPaymentsMinor: Paisa;
  readonly expectedCashMinor: Paisa;
  readonly countedCashMinor: Paisa | null;
  readonly varianceMinor: Paisa | null;
  // Not `readonly` (unlike the fields above): this is serialized straight
  // through a Zod response schema at the HTTP layer, and Zod's inferred
  // array type there is mutable — a readonly array isn't assignable to
  // it (same reason ordering's OrderDetail.lines isn't readonly either).
  readonly paymentMethodBreakdown: PaymentMethodBreakdownLine[];
}

/**
 * The shift-close screen's Z-report (spec, screen 12) — scoped entirely
 * by `order.shift_id`, so it only ever reflects orders actually tagged
 * with this shift. By the time a shift is closeable, every one of its
 * orders is `closed` or `voided` (closeShift refuses otherwise), and a
 * voided order never billed, so summing every order regardless of
 * status is equivalent to summing only closed ones here — simpler, and
 * correct given that invariant.
 */
export async function getZReport(db: Kysely<Database>, shiftId: number): Promise<ZReport> {
  const shift = await getShift(db, shiftId);
  if (!shift) throw new Error(`shift ${shiftId} not found`);

  const orders = await db
    .selectFrom('order')
    .select([
      'id',
      'channel',
      'status',
      'subtotal_minor',
      'order_discount_minor',
      'net_sales_minor',
      'tax_minor',
      'service_charge_minor',
      'rounding_adjustment_minor',
    ])
    .where('shift_id', '=', shiftId)
    .execute();

  const customerSalesMinor = sum(orders.filter((o) => o.channel === 'customer' && o.status !== 'voided').map((o) => o.net_sales_minor));
  const consumptionMinor = sum(orders.filter((o) => o.channel !== 'customer' && o.status !== 'voided').map((o) => o.net_sales_minor));
  const taxCollectedMinor = sum(orders.filter((o) => o.status !== 'voided').map((o) => o.tax_minor));
  const roundingAdjustmentMinor = sum(orders.filter((o) => o.status !== 'voided').map((o) => o.rounding_adjustment_minor));
  const discountsGivenMinor = sum(orders.filter((o) => o.status !== 'voided').map((o) => o.order_discount_minor));

  // What was rung up and then taken back off: whole voided orders at
  // their subtotal, plus individually voided lines on orders that
  // survived. Corrections (a mis-tap on a bill nobody has seen) are
  // excluded — they are keystrokes, not removed sales.
  const voidedOrderSalesMinor = sum(orders.filter((o) => o.status === 'voided').map((o) => o.subtotal_minor));
  const voidedLineRows = await db
    .selectFrom('order_line')
    .innerJoin('order', 'order.id', 'order_line.order_id')
    .select('order_line.gross_minor as grossMinor')
    .where('order.shift_id', '=', shiftId)
    .where('order.status', '<>', 'voided')
    .where('order_line.voided', '=', 1)
    .where('order_line.void_kind', '=', 'void')
    .execute();
  const voidedSalesMinor = add(voidedOrderSalesMinor, sum(voidedLineRows.map((r) => r.grossMinor)));

  const consumptionRows = await db
    .selectFrom('consumption_record')
    .innerJoin('order', 'order.id', 'consumption_record.order_id')
    .select(['consumption_record.menu_value_minor as menuValueMinor', 'consumption_record.charged_minor as chargedMinor'])
    .where('order.shift_id', '=', shiftId)
    .execute();
  const consumptionUnchargedMinor = sum(consumptionRows.map((r) => sub(r.menuValueMinor, r.chargedMinor)));

  const serviceChargeRows = await db.selectFrom('service_charge_entry').select('amount_minor').where('shift_id', '=', shiftId).execute();
  const serviceChargeCollectedMinor = sum(serviceChargeRows.map((r) => r.amount_minor));

  const paymentRows = await db
    .selectFrom('payment')
    .innerJoin('payment_method', 'payment_method.id', 'payment.payment_method_id')
    .innerJoin('order', 'order.id', 'payment.order_id')
    .select([
      'payment_method.id as paymentMethodId',
      'payment_method.display_name as paymentMethodName',
      'payment_method.kind as kind',
      'payment.amount_minor as amountMinor',
      'payment.tendered_minor as tenderedMinor',
      'payment.change_minor as changeMinor',
    ])
    .where('order.shift_id', '=', shiftId)
    .execute();

  const cashRows = paymentRows.filter((p) => p.kind === 'cash');
  const cashPaymentsMinor = sum(cashRows.map((p) => p.amountMinor));
  const cashTenderedMinor = sum(cashRows.map((p) => p.tenderedMinor ?? p.amountMinor));
  const changeGivenMinor = sum(cashRows.map((p) => p.changeMinor ?? paisa(0)));
  const nonCashPaymentsMinor = sum(paymentRows.filter((p) => p.kind !== 'cash').map((p) => p.amountMinor));
  const byMethod = new Map<number, { name: string; amounts: Paisa[] }>();
  for (const row of paymentRows) {
    const entry = byMethod.get(row.paymentMethodId) ?? { name: row.paymentMethodName, amounts: [] };
    entry.amounts.push(row.amountMinor);
    byMethod.set(row.paymentMethodId, entry);
  }
  const paymentMethodBreakdown = [...byMethod.entries()]
    .map(([paymentMethodId, { name, amounts }]) => ({ paymentMethodId, paymentMethodName: name, totalMinor: sum(amounts) }))
    .sort((a, b) => a.paymentMethodName.localeCompare(b.paymentMethodName));

  // The same arithmetic closeShift itself uses, so a Z-report read
  // before closing predicts exactly the expected-cash figure the close
  // will compute — and a Z-report read after closing agrees with what
  // was recorded.
  const expectedCashMinor = add(shift.openingCashMinor, cashPaymentsMinor);

  return {
    shift,
    customerSalesMinor,
    consumptionMinor,
    combinedSalesMinor: add(customerSalesMinor, consumptionMinor),
    consumptionUnchargedMinor,
    discountsGivenMinor,
    voidedSalesMinor,
    taxCollectedMinor,
    serviceChargeCollectedMinor,
    roundingAdjustmentMinor,
    openingFloatMinor: shift.openingCashMinor,
    cashPaymentsMinor,
    cashTenderedMinor,
    changeGivenMinor,
    nonCashPaymentsMinor,
    expectedCashMinor,
    countedCashMinor: shift.countedCashMinor,
    varianceMinor: shift.varianceMinor,
    paymentMethodBreakdown,
  };
}
