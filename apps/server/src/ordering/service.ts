import { add, paisa, proportionalAmount, roundToRupee, sub, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { getItem, getModifier, getCurrentPrice, listModifierGroupsForItem } from '../catalog/service.js';
import { recordAudit } from '../identity/audit.js';
import type { Database } from '../platform/db/types.js';
import { eventBus } from '../platform/events/bus.js';
import { getSetting } from '../settings/service.js';
import { computeTaxForOrder } from '../tax/service.js';
import { computeOrderPipeline, type LineInput } from './pipeline.js';
import type { OrderChannel, OrderStatus, OrderType, VoidKind } from './tables.js';

declare module '../platform/events/types.js' {
  interface DomainEventMap {
    OrderVoided: { orderId: number; reason: string; voidedBy: number; voidedAt: string };
  }
}

/** Every ordering mutation has a real, logged-in actor — unlike identity's
 * own bootstrap case, there is no "system" order. */
export interface OrderActor {
  readonly actorId: number;
  readonly terminalId: string;
}

/**
 * Thrown when a write is conditioned on a version that no longer matches
 * the row — i.e. optimistic concurrency's actual check. Every mutation
 * here bumps `order.version`, but each of THIS milestone's functions
 * reads the current version and writes it back inside one transaction,
 * so on this single SQLite connection (Kysely serializes concurrent
 * `.transaction()` calls against it — see ARCHITECTURE.md) two racing
 * requests can never observe a stale version between each other: the
 * second one simply reads whatever the first one already committed.
 * What actually rejects an invalid double-transition today is the
 * status check (`requireOpenOrder` etc.) each function does first — see
 * the concurrency test in service.test.ts.
 *
 * This error, and `versionedUpdate` below, become load-bearing once a
 * caller supplies a version it read *earlier* — separately from the
 * mutating transaction — rather than one read fresh inside it. That's
 * exactly the spec's double-close test (billing milestone): two
 * terminals that already loaded the same bill both try to settle it, and
 * only one may. `versionedUpdate` already does the right check for that
 * case; billing's close operation will thread a caller-supplied expected
 * version through it instead of the freshly-read one used here.
 */
export class ConcurrentModificationError extends Error {
  constructor(orderId: number) {
    super(`order ${orderId} was modified by another request — reload and retry`);
    this.name = 'ConcurrentModificationError';
  }
}

/**
 * An upper bound on a single line's quantity. Not a business rule so
 * much as a typo guard: a cashier typing into a quantity field can
 * produce "1000" from a slipped finger, and a bill for a thousand
 * karahis is a worse outcome than being made to split the line.
 */
export const MAX_LINE_QTY = 999;

export class OrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderStateError';
  }
}

// ---------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------

export interface OrderSummary {
  readonly id: number;
  readonly invoiceNo: number | null;
  readonly orderType: OrderType;
  readonly channel: OrderChannel;
  readonly tableLabel: string | null;
  /** Who the order is for. Optional everywhere — a dine-in customer
   * rarely gives a name, a delivery always does (migration 0018). */
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly waiterId: number | null;
  readonly beneficiaryPersonId: number | null;
  readonly shiftId: number | null;
  readonly openedAt: string;
  readonly billedAt: string | null;
  /** When this order was FIRST billed — survives a reopen, unlike
   * `billedAt`. Null means nothing has ever been printed for it. */
  readonly firstBilledAt: string | null;
  readonly closedAt: string | null;
  readonly openedBy: number;
  readonly closedBy: number | null;
  readonly status: OrderStatus;
  readonly subtotalMinor: Paisa;
  readonly orderDiscountMinor: Paisa;
  readonly discountReason: string | null;
  readonly netSalesMinor: Paisa;
  readonly taxMinor: Paisa;
  readonly serviceChargeMinor: Paisa;
  /** The rate that produced it, or null — see migration 0016. */
  readonly serviceChargeRateBp: number | null;
  readonly roundingAdjustmentMinor: Paisa;
  readonly totalMinor: Paisa;
  readonly version: number;
}

interface OrderRow {
  id: number;
  invoice_no: number | null;
  order_type: OrderType;
  channel: OrderChannel;
  table_label: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  waiter_id: number | null;
  beneficiary_person_id: number | null;
  shift_id: number | null;
  opened_at: string;
  billed_at: string | null;
  first_billed_at: string | null;
  closed_at: string | null;
  opened_by: number;
  closed_by: number | null;
  status: OrderStatus;
  subtotal_minor: Paisa;
  order_discount_minor: Paisa;
  discount_reason: string | null;
  net_sales_minor: Paisa;
  tax_minor: Paisa;
  service_charge_minor: Paisa;
  service_charge_rate_bp: number | null;
  rounding_adjustment_minor: Paisa;
  total_minor: Paisa;
  version: number;
}

function toOrderSummary(row: OrderRow): OrderSummary {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    orderType: row.order_type,
    channel: row.channel,
    tableLabel: row.table_label,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    waiterId: row.waiter_id,
    beneficiaryPersonId: row.beneficiary_person_id,
    shiftId: row.shift_id,
    openedAt: row.opened_at,
    billedAt: row.billed_at,
    firstBilledAt: row.first_billed_at,
    closedAt: row.closed_at,
    openedBy: row.opened_by,
    closedBy: row.closed_by,
    status: row.status,
    subtotalMinor: row.subtotal_minor,
    orderDiscountMinor: row.order_discount_minor,
    discountReason: row.discount_reason,
    netSalesMinor: row.net_sales_minor,
    taxMinor: row.tax_minor,
    serviceChargeMinor: row.service_charge_minor,
    serviceChargeRateBp: row.service_charge_rate_bp,
    roundingAdjustmentMinor: row.rounding_adjustment_minor,
    totalMinor: row.total_minor,
    version: row.version,
  };
}

export interface OrderLineModifierDetail {
  readonly id: number;
  readonly modifierId: number;
  /** What it was called when it was sold, not what it is called now. */
  readonly modifierName: string;
  readonly priceDeltaMinor: Paisa;
  readonly grossMinor: Paisa;
  readonly proratedDiscountMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly allocationBaseMinor: Paisa;
}

export interface OrderLineDetail {
  readonly id: number;
  readonly itemId: number;
  /** What it was called when it was sold, not what it is called now. */
  readonly itemName: string;
  readonly qty: number;
  readonly unitPriceMinor: Paisa;
  readonly grossMinor: Paisa;
  readonly proratedDiscountMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly allocationBaseMinor: Paisa;
  readonly voided: boolean;
  readonly voidReason: string | null;
  readonly voidApprovedBy: number | null;
  readonly voidKind: VoidKind | null;
  /** What the kitchen was told — "no onions", "well done". */
  readonly note: string | null;
  // Not `readonly` (unlike the fields above): this is serialized
  // straight through a Zod response schema at the HTTP layer, and Zod's
  // inferred array type there is mutable — a readonly array isn't
  // assignable to it.
  readonly modifiers: OrderLineModifierDetail[];
}

export interface OrderDetail extends OrderSummary {
  readonly lines: OrderLineDetail[]; // see the same note on OrderLineDetail.modifiers above
  /** Unreversed payments so far, and what is still owed. On the detail
   * rather than only on the floor board because the payment screen is
   * reachable directly by URL — a cashier who reloads it must still be
   * told what is left to collect, not the whole total again. */
  readonly paidMinor: Paisa;
  readonly balanceMinor: Paisa;
}

async function loadLines(
  executor: Kysely<Database> | Transaction<Database>,
  orderId: number,
): Promise<OrderLineDetail[]> {
  const lineRows = await executor.selectFrom('order_line').selectAll().where('order_id', '=', orderId).orderBy('id', 'asc').execute();
  const modifierRows = await executor
    .selectFrom('order_line_modifier')
    .selectAll()
    .where(
      'order_line_id',
      'in',
      lineRows.map((l) => l.id),
    )
    .orderBy('id', 'asc')
    .execute();

  return lineRows.map((line) => ({
    id: line.id,
    itemId: line.item_id,
    itemName: line.item_name_snapshot ?? `item ${line.item_id}`,
    qty: line.qty,
    unitPriceMinor: line.unit_price_minor,
    grossMinor: line.gross_minor,
    proratedDiscountMinor: line.prorated_discount_minor,
    netSalesMinor: line.net_sales_minor,
    allocationBaseMinor: line.allocation_base_minor,
    voided: line.voided === 1,
    voidReason: line.void_reason,
    voidApprovedBy: line.void_approved_by,
    voidKind: line.void_kind,
    note: line.note,
    modifiers: modifierRows
      .filter((m) => m.order_line_id === line.id)
      .map((m) => ({
        id: m.id,
        modifierId: m.modifier_id,
        modifierName: m.modifier_name_snapshot ?? `modifier ${m.modifier_id}`,
        priceDeltaMinor: m.price_delta_minor,
        grossMinor: m.gross_minor,
        proratedDiscountMinor: m.prorated_discount_minor,
        netSalesMinor: m.net_sales_minor,
        allocationBaseMinor: m.allocation_base_minor,
      })),
  }));
}

/** The one way an OrderDetail is assembled, so `paidMinor` and
 * `balanceMinor` cannot be right in some responses and missing in
 * others. */
async function toOrderDetail(
  executor: Kysely<Database> | Transaction<Database>,
  row: OrderRow,
  lines: OrderLineDetail[],
): Promise<OrderDetail> {
  const paidMinor = (await paidTotals(executor, [row.id])).get(row.id) ?? paisa(0);
  return { ...toOrderSummary(row), lines, paidMinor, balanceMinor: sub(row.total_minor, paidMinor) };
}

export async function getOrder(db: Kysely<Database>, orderId: number): Promise<OrderDetail | null> {
  const row = await db.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
  if (!row) return null;
  return toOrderDetail(db, row, await loadLines(db, orderId));
}

export interface ListOrdersOptions {
  readonly status?: readonly OrderStatus[] | undefined;
}

/** The floor view's "open orders" and "awaiting payment" lists — oldest
 * first, so "how long it has been sitting" reads naturally top to bottom. */
export async function listOrders(db: Kysely<Database>, opts: ListOrdersOptions = {}): Promise<OrderSummary[]> {
  let query = db.selectFrom('order').selectAll();
  if (opts.status && opts.status.length > 0) query = query.where('status', 'in', opts.status);
  const rows = await query.orderBy('opened_at', 'asc').execute();
  return rows.map(toOrderSummary);
}

/**
 * What the floor board shows: every order that is still live, split
 * into the three states an operator actually distinguishes, plus the
 * ones finished during the window they can still be looked up in.
 *
 * The split is derived here, from `order.status` and the payments
 * already recorded — not in the browser. A closed order is closed in
 * one place, so no screen can accidentally leave a settled bill sitting
 * in a list of things that still need money taken for them.
 *
 *  - `open`            — still being taken; no bill printed.
 *  - `awaitingPayment` — billed, and payments so far do not cover the
 *                        total. `paidMinor`/`balanceMinor` say how far
 *                        along it is, so a partly-paid bill reads as
 *                        partly paid rather than as untouched.
 *  - `completed`       — closed (fully paid, invoice allocated).
 *
 * A voided order is in none of them: it is not work outstanding and it
 * is not a sale.
 */
export interface FloorOrder extends OrderSummary {
  readonly paidMinor: Paisa;
  readonly balanceMinor: Paisa;
}

export interface FloorBoard {
  readonly open: FloorOrder[];
  readonly awaitingPayment: FloorOrder[];
  readonly completed: FloorOrder[];
}

export interface FloorBoardOptions {
  /** How many of the most recently closed orders to carry in
   * `completed`. The finished list exists so a cashier can find the
   * bill they just settled — to reprint it, or to check it — not to be
   * a sales report, so it stays short by default. */
  readonly completedLimit?: number | undefined;
}

export async function getFloorBoard(db: Kysely<Database>, opts: FloorBoardOptions = {}): Promise<FloorBoard> {
  const completedLimit = opts.completedLimit ?? 20;

  const live = await db
    .selectFrom('order')
    .selectAll()
    .where('status', 'in', ['open', 'billed'])
    .orderBy('opened_at', 'asc')
    .execute();

  const completedRows = await db
    .selectFrom('order')
    .selectAll()
    .where('status', '=', 'closed')
    .orderBy('closed_at', 'desc')
    .limit(completedLimit)
    .execute();

  const rows = [...live, ...completedRows];
  const paidByOrder = await paidTotals(
    db,
    rows.map((row) => row.id),
  );

  const decorate = (row: OrderRow): FloorOrder => {
    const paidMinor = paidByOrder.get(row.id) ?? paisa(0);
    return { ...toOrderSummary(row), paidMinor, balanceMinor: sub(row.total_minor, paidMinor) };
  };

  return {
    open: live.filter((row) => row.status === 'open').map(decorate),
    awaitingPayment: live.filter((row) => row.status === 'billed').map(decorate),
    completed: completedRows.map(decorate),
  };
}

/**
 * Unreversed payments per order. Reversed rows are excluded the same
 * way billing itself excludes them, so a refunded order does not read
 * as still paid.
 */
async function paidTotals(
  db: Kysely<Database> | Transaction<Database>,
  orderIds: readonly number[],
): Promise<Map<number, Paisa>> {
  const totals = new Map<number, Paisa>();
  if (orderIds.length === 0) return totals;

  const rows = await db
    .selectFrom('payment')
    .select(['order_id', 'amount_minor'])
    .where('order_id', 'in', orderIds)
    .where('reversed_by_payment_id', 'is', null)
    .execute();

  for (const row of rows) {
    totals.set(row.order_id, add(totals.get(row.order_id) ?? paisa(0), row.amount_minor));
  }
  return totals;
}

// ---------------------------------------------------------------------
// Lifecycle: open
// ---------------------------------------------------------------------

export interface CreateOrderInput {
  readonly orderType: OrderType;
  /** Defaults to 'customer'. staff_meal/owner_meal require a
   * beneficiaryPersonId of the matching kind (see below) — this is the
   * "pick person first" step of the spec's staff meal flow (screen 6),
   * done once at order creation, same moment as picking the waiter for
   * a dine_in order. */
  readonly channel?: OrderChannel | undefined;
  readonly tableLabel?: string | undefined;
  /** Optional on every order type. A delivery that has neither cannot
   * be delivered, but that is the driver's problem to raise, not a
   * reason for the till to refuse the sale. */
  readonly customerName?: string | undefined;
  readonly customerPhone?: string | undefined;
  readonly waiterId?: number | undefined;
  readonly beneficiaryPersonId?: number | undefined;
}

/**
 * Opens a new order. There is no "current order" anywhere — every order
 * this creates is immediately and only addressable by its own id; the
 * caller (a route, ultimately a specific tablet) never becomes bound to
 * it (see ARCHITECTURE.md, "no current order").
 */
export async function createOrder(db: Kysely<Database>, input: CreateOrderInput, actor: OrderActor): Promise<OrderSummary> {
  // A table label is optional on every order type, dine_in included: a
  // restaurant with a counter, a garden, or simply a customer standing
  // at the till has a real dine-in sale and no table number to give it.
  // The waiter is still required for dine_in — service charge and the
  // payout sheet are attributed to a person, and there is nobody to
  // attribute them to without one.
  if (input.orderType === 'dine_in' && !input.waiterId) {
    throw new OrderStateError('dine_in orders require a waiter');
  }
  if (input.waiterId !== undefined) {
    const waiter = await db.selectFrom('user').select('id').where('id', '=', input.waiterId).executeTakeFirst();
    if (!waiter) throw new Error(`user ${input.waiterId} not found`);
  }

  const channel = input.channel ?? 'customer';
  // consumption's `person` table is read directly, not through its
  // service module — that direction (ordering -> consumption) would
  // create the one cycle this codebase otherwise avoids, since
  // consumption itself needs to call back into ordering to close a
  // settled meal. Same convention billing already uses for `order`/
  // `payment_method` (see billing/service.ts): a simple existence/shape
  // check reads the table directly; only an actual state-changing
  // operation goes through the owning module's exported function.
  if (channel === 'staff_meal' || channel === 'owner_meal') {
    if (!input.beneficiaryPersonId) throw new OrderStateError(`${channel} orders require a beneficiary person`);
    const expectedKind = channel === 'staff_meal' ? 'staff' : 'partner';
    const person = await db.selectFrom('person').selectAll().where('id', '=', input.beneficiaryPersonId).executeTakeFirst();
    if (!person) throw new Error(`person ${input.beneficiaryPersonId} not found`);
    if (person.active !== 1) throw new OrderStateError(`person ${input.beneficiaryPersonId} is not active`);
    if (person.kind !== expectedKind) {
      throw new OrderStateError(`a ${channel} order requires a person of kind '${expectedKind}'; person ${input.beneficiaryPersonId} is '${person.kind}'`);
    }
  } else if (input.beneficiaryPersonId !== undefined) {
    throw new OrderStateError('beneficiaryPersonId is only valid for staff_meal/owner_meal orders');
  }

  // Tags the order with whichever shift is currently open, the same
  // direct-table-read convention as the person lookup above — not a
  // hard requirement (a restaurant that hasn't opened a shift yet, or
  // any test fixture that doesn't care about shifts, still works; the
  // order simply carries shift_id: null). A real shift's own close-time
  // cash reconciliation is necessarily scoped to orders that WERE
  // tagged, so day-to-day operation opening a shift before taking orders
  // is what actually keeps that reconciliation meaningful — see
  // ARCHITECTURE.md's "Shifts" section.
  const openShift = await db.selectFrom('shift').select('id').where('closed_at', 'is', null).executeTakeFirst();

  const now = new Date().toISOString();
  const row = await db
    .insertInto('order')
    .values({
      invoice_no: null,
      order_type: input.orderType,
      channel,
      table_label: input.tableLabel?.trim() ? input.tableLabel.trim() : null,
      customer_name: input.customerName?.trim() ? input.customerName.trim() : null,
      customer_phone: input.customerPhone?.trim() ? input.customerPhone.trim() : null,
      waiter_id: input.waiterId ?? null,
      beneficiary_person_id: input.beneficiaryPersonId ?? null,
      shift_id: openShift?.id ?? null,
      opened_at: now,
      billed_at: null,
      first_billed_at: null,
      closed_at: null,
      opened_by: actor.actorId,
      closed_by: null,
      status: 'open',
      subtotal_minor: paisa(0),
      order_discount_minor: paisa(0),
      discount_reason: null,
      net_sales_minor: paisa(0),
      tax_minor: paisa(0),
      service_charge_minor: paisa(0),
      service_charge_rate_bp: null,
      rounding_adjustment_minor: paisa(0),
      total_minor: paisa(0),
      version: 0,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const summary = toOrderSummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'order.create',
    entity: 'order',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

// ---------------------------------------------------------------------
// Shared: load-with-version-check and recompute-and-persist
// ---------------------------------------------------------------------

async function requireOpenOrder(trx: Transaction<Database>, orderId: number): Promise<OrderRow> {
  const row = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
  if (!row) throw new Error(`order ${orderId} not found`);
  if (row.status !== 'open') {
    throw new OrderStateError(`order ${orderId} is ${row.status}, not open — reopen it first`);
  }
  return row;
}

/** Bumps `version`, guarded by the version last read — throws
 * ConcurrentModificationError if another write raced ahead of this one. */
async function versionedUpdate(
  trx: Transaction<Database>,
  orderId: number,
  expectedVersion: number,
  set: Partial<OrderRow>,
): Promise<OrderRow> {
  const updated = await trx
    .updateTable('order')
    .set({ ...set, version: expectedVersion + 1 })
    .where('id', '=', orderId)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new ConcurrentModificationError(orderId);
  return updated;
}

/**
 * Re-pulls every non-voided line (and its modifiers) for `orderId`,
 * re-runs the money pipeline against their already-snapshotted unit
 * prices (never re-fetches current catalog prices — a line's price is
 * fixed at the moment it's added), and writes the recomputed gross /
 * discount / net-sales / allocation-base back to every line, modifier,
 * and the order's own subtotal/net-sales — inside the caller's
 * transaction, version-checked. Called after any change that affects the
 * pipeline: adding or voiding a line, or changing the order discount.
 */
async function recomputeAndPersist(trx: Transaction<Database>, order: OrderRow): Promise<OrderRow> {
  const lineRows = await trx
    .selectFrom('order_line')
    .selectAll()
    .where('order_id', '=', order.id)
    .where('voided', '=', 0)
    .orderBy('id', 'asc')
    .execute();
  const modifierRows = await trx
    .selectFrom('order_line_modifier')
    .selectAll()
    .where(
      'order_line_id',
      'in',
      lineRows.map((l) => l.id),
    )
    .execute();

  const lineInputs: LineInput[] = lineRows.map((line) => ({
    key: String(line.id),
    unitPriceMinor: line.unit_price_minor,
    qty: line.qty,
    modifiers: modifierRows
      .filter((m) => m.order_line_id === line.id)
      .map((m) => ({ key: String(m.id), priceDeltaMinor: m.price_delta_minor })),
  }));

  const result = computeOrderPipeline(lineInputs, order.order_discount_minor);

  for (const computedLine of result.lines) {
    await trx
      .updateTable('order_line')
      .set({
        gross_minor: computedLine.grossMinor,
        prorated_discount_minor: computedLine.proratedDiscountMinor,
        net_sales_minor: computedLine.netSalesMinor,
        allocation_base_minor: computedLine.allocationBaseMinor,
      })
      .where('id', '=', Number(computedLine.key))
      .execute();

    for (const computedModifier of computedLine.modifiers) {
      await trx
        .updateTable('order_line_modifier')
        .set({
          gross_minor: computedModifier.grossMinor,
          prorated_discount_minor: computedModifier.proratedDiscountMinor,
          net_sales_minor: computedModifier.netSalesMinor,
          allocation_base_minor: computedModifier.allocationBaseMinor,
        })
        .where('id', '=', Number(computedModifier.key))
        .execute();
    }
  }

  return versionedUpdate(trx, order.id, order.version, {
    subtotal_minor: result.subtotalMinor,
    net_sales_minor: result.netSalesMinor,
  });
}

// ---------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------

/**
 * Validates that `modifierIds` are all linked to `itemId` and satisfy
 * every linked group's min/max select — the spec's "choose your protein:
 * min 1 max 1" kind of rule — not just that the ids individually exist.
 */
async function validateModifierSelection(
  db: Kysely<Database> | Transaction<Database>,
  itemId: number,
  modifierIds: readonly number[],
): Promise<void> {
  const linkedGroups = await listModifierGroupsForItem(db, itemId);
  const linkedGroupIds = new Set(linkedGroups.map((g) => g.id));

  const countByGroup = new Map<number, number>();
  for (const modifierId of modifierIds) {
    const modifier = await getModifier(db, modifierId);
    if (!modifier) throw new Error(`modifier ${modifierId} not found`);
    if (!linkedGroupIds.has(modifier.groupId)) {
      throw new OrderStateError(`modifier ${modifierId} does not belong to a modifier group linked to item ${itemId}`);
    }
    countByGroup.set(modifier.groupId, (countByGroup.get(modifier.groupId) ?? 0) + 1);
  }

  for (const group of linkedGroups) {
    const count = countByGroup.get(group.id) ?? 0;
    if (count < group.minSelect || count > group.maxSelect) {
      throw new OrderStateError(
        `"${group.name}" requires between ${group.minSelect} and ${group.maxSelect} selection(s); got ${count}`,
      );
    }
  }
}

export interface AddLineInput {
  readonly itemId: number;
  readonly qty: number;
  readonly modifierIds?: readonly number[] | undefined;
  /** A kitchen instruction for this line. Two otherwise identical lines
   * with different notes are different things and never merge. */
  readonly note?: string | undefined;
}

/**
 * The live line on this order for the same item with exactly the same
 * modifiers, if there is one. `modifierKey` is the sorted modifier-id
 * list, so a Karahi with [mild] matches another Karahi with [mild] and
 * never one with [hot] — and the comparison does not depend on which
 * order the cashier happened to tap the modifiers in.
 */
async function findMergeableLine(
  trx: Transaction<Database>,
  orderId: number,
  itemId: number,
  modifierKey: string,
  note: string | null,
): Promise<{ id: number; qty: number } | null> {
  const candidates = await trx
    .selectFrom('order_line')
    .select(['id', 'qty', 'note'])
    .where('order_id', '=', orderId)
    .where('item_id', '=', itemId)
    .where('voided', '=', 0)
    // A Karahi "no onions" is not the same thing as a Karahi, so it
    // gets its own line — merging them would send one of the two
    // instructions to the kitchen and drop the other.
    .where('note', note === null ? 'is' : '=', note)
    .orderBy('id', 'asc')
    .execute();
  if (candidates.length === 0) return null;

  const modifierRows = await trx
    .selectFrom('order_line_modifier')
    .select(['order_line_id', 'modifier_id'])
    .where(
      'order_line_id',
      'in',
      candidates.map((c) => c.id),
    )
    .execute();

  for (const candidate of candidates) {
    const key = modifierRows
      .filter((m) => m.order_line_id === candidate.id)
      .map((m) => m.modifier_id)
      .sort((a, b) => a - b)
      .join(',');
    if (key === modifierKey) return candidate;
  }
  return null;
}

/**
 * Add an item to an order.
 *
 * Tapping the same item twice increments the line already on the bill
 * rather than stacking two identical rows — the behaviour a cashier
 * expects from an item grid, and the reason the fast path (tap an item,
 * it lands on the running bill) does not need a quantity dialog at all.
 * Lines merge only when they are genuinely the same thing: the same
 * item, the same set of modifiers, not voided, and on an order that has
 * never been billed. Once a bill has been printed, a new tap is a new
 * line, because merging would silently rewrite a line the customer has
 * already seen.
 */
export async function addLine(db: Kysely<Database>, orderId: number, input: AddLineInput, actor: OrderActor): Promise<OrderDetail> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error('qty must be a positive integer');
  if (input.qty > MAX_LINE_QTY) throw new OrderStateError(`qty ${input.qty} is implausible — the maximum is ${MAX_LINE_QTY}`);

  const item = await getItem(db, input.itemId);
  if (!item || !item.active) throw new Error(`item ${input.itemId} not found or inactive`);
  const unitPriceMinor = await getCurrentPrice(db, input.itemId);
  if (unitPriceMinor === null) throw new OrderStateError(`item ${input.itemId} has no price set`);

  const modifierIds = input.modifierIds ?? [];
  await validateModifierSelection(db, input.itemId, modifierIds);
  const modifiers = await Promise.all(modifierIds.map((id) => getModifier(db, id)));

  const modifierKey = [...modifierIds].sort((a, b) => a - b).join(',');
  const note = input.note?.trim() ? input.note.trim() : null;

  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);

    const mergeTarget = order.first_billed_at === null ? await findMergeableLine(trx, orderId, input.itemId, modifierKey, note) : null;
    if (mergeTarget) {
      const mergedQty = mergeTarget.qty + input.qty;
      if (mergedQty > MAX_LINE_QTY) {
        throw new OrderStateError(`this line is already at ${mergeTarget.qty} — the maximum quantity per line is ${MAX_LINE_QTY}`);
      }
      await trx.updateTable('order_line').set({ qty: mergedQty }).where('id', '=', mergeTarget.id).execute();
      await recomputeAndPersist(trx, order);

      await recordAudit(trx, {
        actorId: actor.actorId,
        terminalId: actor.terminalId,
        action: 'order.add_line',
        entity: 'order',
        entityId: orderId,
        before: { lineId: mergeTarget.id, qty: mergeTarget.qty },
        after: { lineId: mergeTarget.id, itemId: input.itemId, qty: mergedQty, modifierIds, merged: true },
      });

      const mergedOrder = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
      return toOrderDetail(trx, mergedOrder, await loadLines(trx, orderId));
    }

    const lineRow = await trx
      .insertInto('order_line')
      .values({
        order_id: orderId,
        item_id: input.itemId,
        // The name is snapshotted alongside the price: a bill must not
        // change when the menu does (migration 0017).
        item_name_snapshot: item.name,
        qty: input.qty,
        unit_price_minor: unitPriceMinor,
        gross_minor: paisa(0),
        prorated_discount_minor: paisa(0),
        net_sales_minor: paisa(0),
        allocation_base_minor: paisa(0),
        voided: 0,
        void_reason: null,
        void_approved_by: null,
        void_kind: null,
        note,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    for (const modifier of modifiers) {
      // Non-null: validateModifierSelection already confirmed every id exists.
      const m = modifier as NonNullable<typeof modifier>;
      await trx
        .insertInto('order_line_modifier')
        .values({
          order_line_id: lineRow.id,
          modifier_id: m.id,
          modifier_name_snapshot: m.name,
          price_delta_minor: m.priceDeltaMinor,
          gross_minor: paisa(0),
          prorated_discount_minor: paisa(0),
          net_sales_minor: paisa(0),
          allocation_base_minor: paisa(0),
        })
        .execute();
    }

    await recomputeAndPersist(trx, order);

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.add_line',
      entity: 'order',
      entityId: orderId,
      after: { lineId: lineRow.id, itemId: input.itemId, qty: input.qty, modifierIds },
    });

    const finalOrder = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
    const lines = await loadLines(trx, orderId);
    return toOrderDetail(trx, finalOrder, lines);
  });
}

export interface VoidLineInput {
  readonly reason: string;
}

/**
 * Whether a line can be taken off this order as a CORRECTION — a
 * mis-tap on an order that has never been billed — or only as a VOID,
 * which needs manager approval and a reason.
 *
 * The dividing line is `order.first_billed_at`: once a pro-forma bill has
 * been finalised, that line has been printed, totalled and very likely
 * shown to a customer, so removing it is a void whatever the order's
 * current status says (a reopened order is `open` again, and its
 * `billed_at` has been cleared, but `first_billed_at` remembers).
 * Before that moment nothing has left the till and the cashier is
 * simply fixing their own keystroke.
 */
export function lineRemovalRequiresApproval(order: Pick<OrderRow, 'first_billed_at'>): boolean {
  return order.first_billed_at !== null;
}

/**
 * Take a line off an order.
 *
 * Never deletes the row: `voided` is what the money pipeline reads, and
 * every removal — correction or void — stays in `order_line` and in the
 * audit log, so a bill can always be reconstructed exactly as it was
 * rung up. `void_kind` records which of the two happened, so the
 * theft-control report can show a manager-approved void without
 * drowning it in mis-taps (see migration 0014).
 *
 * A correction (`kind: 'correction'`) is allowed for any signed-in user
 * and needs no reason; a void needs both a reason and an actor the
 * caller has already checked is at least a manager (see
 * ordering/routes.ts) — `void_approved_by` is that actor.
 */
export async function voidLine(
  db: Kysely<Database>,
  orderId: number,
  lineId: number,
  input: VoidLineInput,
  actor: OrderActor,
): Promise<OrderDetail> {
  if (!input.reason.trim()) throw new Error('a void reason is required');
  return removeLineInternal(db, orderId, lineId, { kind: 'void', reason: input.reason }, actor);
}

/**
 * Remove a mis-tapped line from an order that has never been billed.
 * Refuses (rather than silently escalating to a void) once the order
 * has been billed, so the caller has to come back through `voidLine`
 * with a manager and a reason.
 */
export async function removeLine(db: Kysely<Database>, orderId: number, lineId: number, actor: OrderActor): Promise<OrderDetail> {
  return removeLineInternal(db, orderId, lineId, { kind: 'correction', reason: null }, actor);
}

async function removeLineInternal(
  db: Kysely<Database>,
  orderId: number,
  lineId: number,
  removal: { kind: VoidKind; reason: string | null },
  actor: OrderActor,
): Promise<OrderDetail> {
  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);
    if (removal.kind === 'correction' && lineRemovalRequiresApproval(order)) {
      throw new OrderStateError(
        `order ${orderId} has already been billed — removing a line from it is a void, which needs a manager and a reason`,
      );
    }

    const line = await trx.selectFrom('order_line').selectAll().where('id', '=', lineId).where('order_id', '=', orderId).executeTakeFirst();
    if (!line) throw new Error(`line ${lineId} not found on order ${orderId}`);
    if (line.voided === 1) throw new OrderStateError(`line ${lineId} is already off this order`);

    await trx
      .updateTable('order_line')
      .set({
        voided: 1,
        void_reason: removal.reason,
        void_kind: removal.kind,
        // Only a real void carries an approver: a correction is done by
        // whoever is at the till, and recording them as an "approver"
        // would make the audit trail claim an approval that never
        // happened.
        void_approved_by: removal.kind === 'void' ? actor.actorId : null,
      })
      .where('id', '=', lineId)
      .execute();

    await recomputeAndPersist(trx, order);

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      // Distinct actions, so the void report can tell a suspicious void
      // from a mis-tap without re-reading order_line (reporting/service.ts).
      action: removal.kind === 'void' ? 'order.void_line' : 'order.remove_line',
      entity: 'order_line',
      entityId: lineId,
      before: { voided: false, itemId: line.item_id, qty: line.qty, grossMinor: line.gross_minor },
      after: { voided: true, kind: removal.kind, reason: removal.reason, approvedBy: removal.kind === 'void' ? actor.actorId : null },
    });

    const finalOrder = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
    const lines = await loadLines(trx, orderId);
    return toOrderDetail(trx, finalOrder, lines);
  });
}

export interface SetLineQtyInput {
  readonly qty: number;
}

/**
 * Set a line's quantity outright — what a cashier typing "5" into the
 * running bill actually needs, rather than five round trips through an
 * increment.
 *
 * Setting a quantity is not a removal: qty must stay at least 1, and a
 * cashier who wants the line gone uses `removeLine`/`voidLine`, which
 * keeps the "nothing leaves a bill without a record" rule in exactly
 * one place instead of two. Voided lines are immutable — their
 * quantity is part of what the audit trail preserved.
 */
export async function setLineQty(
  db: Kysely<Database>,
  orderId: number,
  lineId: number,
  input: SetLineQtyInput,
  actor: OrderActor,
): Promise<OrderDetail> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error('qty must be a positive integer');
  if (input.qty > MAX_LINE_QTY) throw new OrderStateError(`qty ${input.qty} is implausible — the maximum is ${MAX_LINE_QTY}`);

  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);
    const line = await trx.selectFrom('order_line').selectAll().where('id', '=', lineId).where('order_id', '=', orderId).executeTakeFirst();
    if (!line) throw new Error(`line ${lineId} not found on order ${orderId}`);
    if (line.voided === 1) throw new OrderStateError(`line ${lineId} is off this order — its quantity cannot be changed`);

    await trx.updateTable('order_line').set({ qty: input.qty }).where('id', '=', lineId).execute();
    await recomputeAndPersist(trx, order);

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.set_line_qty',
      entity: 'order_line',
      entityId: lineId,
      before: { qty: line.qty },
      after: { qty: input.qty },
    });

    const finalOrder = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
    const lines = await loadLines(trx, orderId);
    return toOrderDetail(trx, finalOrder, lines);
  });
}

// ---------------------------------------------------------------------
// Who the order is for, and what the kitchen was told
// ---------------------------------------------------------------------

export interface SetOrderCustomerInput {
  readonly customerName?: string | undefined;
  readonly customerPhone?: string | undefined;
}

/**
 * Record (or correct) the customer on an order.
 *
 * Separate from order creation because that is how it actually happens:
 * the phone rings, the order goes in, and the name and number are read
 * back while the kitchen is already cooking. Editable until the order
 * closes and not after — a settled order is a record of what happened,
 * and this is part of that record.
 *
 * Passing an empty string clears the field; omitting it leaves it
 * alone, so the delivery screen can save a phone number without having
 * to re-send the name.
 */
export async function setOrderCustomer(
  db: Kysely<Database>,
  orderId: number,
  input: SetOrderCustomerInput,
  actor: OrderActor,
): Promise<OrderDetail> {
  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
    if (!order) throw new Error(`order ${orderId} not found`);
    if (order.status === 'closed' || order.status === 'voided') {
      throw new OrderStateError(`order ${orderId} is ${order.status} — its customer details can no longer be changed`);
    }

    const patch: { customer_name?: string | null; customer_phone?: string | null } = {};
    if (input.customerName !== undefined) patch.customer_name = input.customerName.trim() || null;
    if (input.customerPhone !== undefined) patch.customer_phone = input.customerPhone.trim() || null;

    if (Object.keys(patch).length > 0) {
      await versionedUpdate(trx, orderId, order.version, patch);
      await recordAudit(trx, {
        actorId: actor.actorId,
        terminalId: actor.terminalId,
        action: 'order.set_customer',
        entity: 'order',
        entityId: orderId,
        before: { customerName: order.customer_name, customerPhone: order.customer_phone },
        after: {
          customerName: patch.customer_name ?? order.customer_name,
          customerPhone: patch.customer_phone ?? order.customer_phone,
        },
      });
    }

    const updated = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
    return toOrderDetail(trx, updated, await loadLines(trx, orderId));
  });
}

export interface SetLineNoteInput {
  readonly note: string;
}

/**
 * Change what the kitchen is told about one line.
 *
 * Only while the order is still open: once a bill is printed the note
 * has already been acted on, and rewriting it would change a record of
 * what was actually cooked. It does not touch a single money field, so
 * nothing is recomputed — but it is audited, because "who told the
 * kitchen to leave the onions out" is a real question.
 */
export async function setLineNote(
  db: Kysely<Database>,
  orderId: number,
  lineId: number,
  input: SetLineNoteInput,
  actor: OrderActor,
): Promise<OrderDetail> {
  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);
    const line = await trx.selectFrom('order_line').selectAll().where('id', '=', lineId).where('order_id', '=', orderId).executeTakeFirst();
    if (!line) throw new Error(`line ${lineId} not found on order ${orderId}`);
    if (line.voided === 1) throw new OrderStateError(`line ${lineId} is off this order — its note cannot be changed`);

    const note = input.note.trim() || null;
    await trx.updateTable('order_line').set({ note }).where('id', '=', lineId).execute();

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.set_line_note',
      entity: 'order_line',
      entityId: lineId,
      before: { note: line.note },
      after: { note },
    });

    return toOrderDetail(trx, order, await loadLines(trx, orderId));
  });
}

// ---------------------------------------------------------------------
// Order-level discount
// ---------------------------------------------------------------------

export interface SetDiscountInput {
  readonly discountMinor: Paisa;
  readonly reason?: string | undefined;
}

export async function setDiscount(db: Kysely<Database>, orderId: number, input: SetDiscountInput, actor: OrderActor): Promise<OrderDetail> {
  if (input.discountMinor > 0 && !input.reason?.trim()) {
    throw new Error('a reason is required when applying a discount');
  }

  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);
    if (input.discountMinor > 0 && order.channel !== 'customer') {
      // A staff/owner meal flows through the pipeline at full menu
      // price on purpose (spec, "Staff and owner meals") — the
      // partner allocation and the consumption record's menu_value_minor
      // both read order.net_sales_minor, and an order-level discount
      // here would silently understate both. What the person actually
      // pays is a separate figure, computed from their own meal policy
      // at settlement — see consumption/policy.ts.
      throw new OrderStateError(`a ${order.channel} order is always billed at full menu price — use the person's meal policy instead of an order discount`);
    }
    if (input.discountMinor > order.subtotal_minor) {
      throw new OrderStateError(`discount ${input.discountMinor} exceeds subtotal ${order.subtotal_minor}`);
    }

    await trx
      .updateTable('order')
      .set({ order_discount_minor: input.discountMinor, discount_reason: input.discountMinor > 0 ? (input.reason ?? null) : null })
      .where('id', '=', orderId)
      .execute();

    const refreshed = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
    await recomputeAndPersist(trx, refreshed);

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.set_discount',
      entity: 'order',
      entityId: orderId,
      before: { discountMinor: order.order_discount_minor, reason: order.discount_reason },
      after: { discountMinor: input.discountMinor, reason: input.reason ?? null },
    });

    const finalOrder = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
    const lines = await loadLines(trx, orderId);
    return toOrderDetail(trx, finalOrder, lines);
  });
}

// ---------------------------------------------------------------------
// Billing stage 1: pro-forma bill (open -> billed)
// ---------------------------------------------------------------------

export interface BillOrderInput {
  readonly serviceChargeMinor?: Paisa | undefined;
}

export interface BillTotals {
  readonly subtotalMinor: Paisa;
  readonly orderDiscountMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly taxMinor: Paisa;
  readonly serviceChargeMinor: Paisa;
  /** The configured rate this service charge came from, or null when
   * none did — no charge, or a cashier-entered amount. Carried through
   * so a bill can say "Service charge (5%)" rather than leaving a
   * manager to work out which rate was in force that day. */
  readonly serviceChargeRateBp: number | null;
  readonly serviceChargeName: string;
  readonly roundingAdjustmentMinor: Paisa;
  readonly totalMinor: Paisa;
}

/**
 * What this order's service charge should be, from the restaurant's
 * configured rule — and, so a historical bill can say so, the rate that
 * produced it.
 *
 * THE one place a service charge is worked out. Nothing else in the
 * system multiplies a rate by a total: `billOrder` persists what this
 * returns, `previewBillTotals` shows what this returns, and the receipt
 * prints the amount that was persisted. A screen that did its own
 * percentage would be a second answer.
 *
 * A cashier may still override the amount — waiving service on a
 * complaint is ordinary restaurant practice, and the old POS allowed it
 * — but an override records `rateBp: null`, because no rate produced
 * it and claiming one would be a lie on the receipt.
 */
export async function computeServiceCharge(
  db: Kysely<Database> | Transaction<Database>,
  order: Pick<OrderRow, 'order_type' | 'waiter_id' | 'net_sales_minor' | 'channel'>,
  override: Paisa | undefined,
): Promise<{ amountMinor: Paisa; rateBp: number | null; displayName: string }> {
  const config = await getSetting(db, 'serviceCharge');

  if (override !== undefined) {
    if (override < 0) throw new OrderStateError('service charge cannot be negative');
    if (override > 0 && !config.enabled) {
      throw new OrderStateError('service charge is switched off for this restaurant — enable it in Settings first');
    }
    if (override > 0 && order.waiter_id === null) {
      throw new OrderStateError('service charge requires a waiter; this order has none');
    }
    return { amountMinor: override, rateBp: null, displayName: config.displayName };
  }

  // Every reason there is no charge, in one place, so "disabled means
  // zero" cannot be true on one screen and not another.
  const applies =
    config.enabled &&
    config.rateBp > 0 &&
    order.waiter_id !== null &&
    // A staff or owner meal is not table service being sold.
    order.channel === 'customer' &&
    (!config.dineInOnly || order.order_type === 'dine_in');

  if (!applies) return { amountMinor: paisa(0), rateBp: null, displayName: config.displayName };

  return {
    amountMinor: proportionalAmount(order.net_sales_minor, config.rateBp, 10_000),
    rateBp: config.rateBp,
    displayName: config.displayName,
  };
}

/**
 * Money pipeline stages 5-7 — tax, service charge, and rounding to the
 * rupee — over an order's already-computed net sales.
 *
 * THE one place these are worked out. `billOrder` calls it to persist a
 * bill; `previewBillTotals` calls it to show a cashier what the total
 * WILL be before they commit to printing. A second implementation on
 * the screen would be a second answer, and the whole point of showing a
 * total before printing is that it is the total that gets printed.
 */
async function computeBillTotals(
  trx: Kysely<Database> | Transaction<Database>,
  order: OrderRow,
  serviceChargeOverride: Paisa | undefined,
  at: Date,
): Promise<BillTotals> {
  const serviceCharge = await computeServiceCharge(trx, order, serviceChargeOverride);

  const { taxMinor } = await computeTaxForOrder(trx, order.id, order.order_type, at);
  const preRound = add(add(order.net_sales_minor, taxMinor), serviceCharge.amountMinor);
  const { total, adjustment } = roundToRupee(preRound);

  return {
    subtotalMinor: order.subtotal_minor,
    orderDiscountMinor: order.order_discount_minor,
    netSalesMinor: order.net_sales_minor,
    taxMinor,
    serviceChargeMinor: serviceCharge.amountMinor,
    serviceChargeRateBp: serviceCharge.rateBp,
    serviceChargeName: serviceCharge.displayName,
    roundingAdjustmentMinor: adjustment,
    totalMinor: total,
  };
}

/**
 * What this order would total if it were billed right now with the
 * given service charge — computed, not guessed, and changing nothing.
 *
 * Safe to call on an already-billed order too, in which case it simply
 * recomputes the same figures that are already stored; a cashier
 * reviewing a finalised bill sees the same numbers either way.
 */
export async function previewBillTotals(
  db: Kysely<Database>,
  orderId: number,
  serviceChargeOverride?: Paisa,
): Promise<BillTotals> {
  const order = await db.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
  if (!order) throw new Error(`order ${orderId} not found`);
  return computeBillTotals(db, order, serviceChargeOverride, new Date());
}

/**
 * Stage 1 of the two-stage billing flow: finalises the pro-forma bill.
 * Sets status to 'billed' and computes the final total — but allocates
 * NO invoice number, records NO payment, and writes NO partner
 * allocations (those happen only at close, in the billing milestone).
 * Tax (money pipeline stage 5) is computed here via tax/service.ts's
 * computeTaxForOrder — zero on every order while no tax_rule is active,
 * exactly as the spec requires, without a single line of code changing
 * when a rule is turned on.
 */
export async function billOrder(db: Kysely<Database>, orderId: number, input: BillOrderInput, actor: OrderActor): Promise<OrderDetail> {
  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);

    const nonVoidedLineCount = await trx
      .selectFrom('order_line')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('order_id', '=', orderId)
      .where('voided', '=', 0)
      .executeTakeFirstOrThrow();
    if (Number(nonVoidedLineCount.n) === 0) {
      throw new OrderStateError(`order ${orderId} has no items to bill`);
    }

    const now = new Date();
    const totals = await computeBillTotals(trx, order, input.serviceChargeMinor, now);

    const updated = await versionedUpdate(trx, orderId, order.version, {
      status: 'billed',
      billed_at: now.toISOString(),
      // Stamped once and never overwritten: a rebill after a reopen must
      // not move the moment a customer first saw this bill.
      first_billed_at: order.first_billed_at ?? now.toISOString(),
      tax_minor: totals.taxMinor,
      service_charge_minor: totals.serviceChargeMinor,
      service_charge_rate_bp: totals.serviceChargeRateBp,
      rounding_adjustment_minor: totals.roundingAdjustmentMinor,
      total_minor: totals.totalMinor,
    });

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.bill',
      entity: 'order',
      entityId: orderId,
      after: toOrderSummary(updated),
    });

    const lines = await loadLines(trx, orderId);
    return toOrderDetail(trx, updated, lines);
  });
}

/** A billed order, reopened by a manager to add or remove items — clears
 * billed_at and returns it to open; the caller must reprint once billed
 * again (spec: reopening "requires reprinting"). */
export async function reopenOrder(db: Kysely<Database>, orderId: number, actor: OrderActor): Promise<OrderDetail> {
  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
    if (!order) throw new Error(`order ${orderId} not found`);
    if (order.status !== 'billed') {
      throw new OrderStateError(`order ${orderId} is ${order.status}, not billed — nothing to reopen`);
    }

    const updated = await versionedUpdate(trx, orderId, order.version, {
      status: 'open',
      billed_at: null,
    });

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.reopen',
      entity: 'order',
      entityId: orderId,
      before: { status: 'billed' },
      after: { status: 'open' },
    });

    const lines = await loadLines(trx, orderId);
    return toOrderDetail(trx, updated, lines);
  });
}

export interface CloseOrderInput {
  readonly invoiceNo: number;
  readonly closedBy: number;
  readonly terminalId: string;
}

/**
 * The `billed -> closed` state transition — ordering's own piece of the
 * spec's two-stage close. This is the ONLY place that ever writes
 * `invoice_no`/`closed_at`/`closed_by`; billing (which owns payments and
 * the invoice counter) calls this from inside its own close transaction
 * once it has verified payments sum to `total_minor` and allocated the
 * invoice number — ordering never touches payments or invoice numbering
 * itself, only its own table. Composable into a caller's transaction
 * (like partners' `allocateOrderInTransaction`) so allocating the
 * invoice number, writing partner allocations, and this transition all
 * commit together or not at all, per the spec's close requirement.
 */
export async function closeOrderInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  input: CloseOrderInput,
): Promise<OrderSummary> {
  const order = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
  if (!order) throw new Error(`order ${orderId} not found`);
  if (order.status !== 'billed') {
    throw new OrderStateError(`order ${orderId} is ${order.status}, not billed — cannot close`);
  }

  const now = new Date().toISOString();
  const updated = await versionedUpdate(trx, orderId, order.version, {
    status: 'closed',
    closed_at: now,
    closed_by: input.closedBy,
    invoice_no: input.invoiceNo,
  });

  await recordAudit(trx, {
    actorId: input.closedBy,
    terminalId: input.terminalId,
    action: 'order.close',
    entity: 'order',
    entityId: orderId,
    before: { status: 'billed' },
    after: { status: 'closed', invoiceNo: input.invoiceNo },
  });

  return toOrderSummary(updated);
}

// ---------------------------------------------------------------------
// Order-level void
// ---------------------------------------------------------------------

export interface VoidOrderInput {
  readonly reason: string;
}

export async function voidOrder(db: Kysely<Database>, orderId: number, input: VoidOrderInput, actor: OrderActor): Promise<OrderDetail> {
  if (!input.reason.trim()) throw new Error('a void reason is required');

  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
    if (!order) throw new Error(`order ${orderId} not found`);
    if (order.status === 'closed' || order.status === 'voided') {
      throw new OrderStateError(`order ${orderId} is already ${order.status}`);
    }

    const now = new Date().toISOString();
    const updated = await versionedUpdate(trx, orderId, order.version, { status: 'voided' });

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.void',
      entity: 'order',
      entityId: orderId,
      before: { status: order.status },
      after: { status: 'voided', reason: input.reason },
    });

    eventBus.emit('OrderVoided', { orderId, reason: input.reason, voidedBy: actor.actorId, voidedAt: now });

    const lines = await loadLines(trx, orderId);
    return toOrderDetail(trx, updated, lines);
  });
}
