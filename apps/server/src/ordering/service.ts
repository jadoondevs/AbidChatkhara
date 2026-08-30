import { add, paisa, roundToRupee, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { getItem, getModifier, getCurrentPrice, listModifierGroupsForItem } from '../catalog/service.js';
import { recordAudit } from '../identity/audit.js';
import type { Database } from '../platform/db/types.js';
import { eventBus } from '../platform/events/bus.js';
import { computeOrderPipeline, type LineInput } from './pipeline.js';
import type { OrderChannel, OrderStatus, OrderType } from './tables.js';

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
  readonly waiterId: number | null;
  readonly openedAt: string;
  readonly billedAt: string | null;
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
  waiter_id: number | null;
  opened_at: string;
  billed_at: string | null;
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
    waiterId: row.waiter_id,
    openedAt: row.opened_at,
    billedAt: row.billed_at,
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
    roundingAdjustmentMinor: row.rounding_adjustment_minor,
    totalMinor: row.total_minor,
    version: row.version,
  };
}

export interface OrderLineModifierDetail {
  readonly id: number;
  readonly modifierId: number;
  readonly priceDeltaMinor: Paisa;
  readonly grossMinor: Paisa;
  readonly proratedDiscountMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly allocationBaseMinor: Paisa;
}

export interface OrderLineDetail {
  readonly id: number;
  readonly itemId: number;
  readonly qty: number;
  readonly unitPriceMinor: Paisa;
  readonly grossMinor: Paisa;
  readonly proratedDiscountMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly allocationBaseMinor: Paisa;
  readonly voided: boolean;
  readonly voidReason: string | null;
  readonly voidApprovedBy: number | null;
  // Not `readonly` (unlike the fields above): this is serialized
  // straight through a Zod response schema at the HTTP layer, and Zod's
  // inferred array type there is mutable — a readonly array isn't
  // assignable to it.
  readonly modifiers: OrderLineModifierDetail[];
}

export interface OrderDetail extends OrderSummary {
  readonly lines: OrderLineDetail[]; // see the same note on OrderLineDetail.modifiers above
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
    qty: line.qty,
    unitPriceMinor: line.unit_price_minor,
    grossMinor: line.gross_minor,
    proratedDiscountMinor: line.prorated_discount_minor,
    netSalesMinor: line.net_sales_minor,
    allocationBaseMinor: line.allocation_base_minor,
    voided: line.voided === 1,
    voidReason: line.void_reason,
    voidApprovedBy: line.void_approved_by,
    modifiers: modifierRows
      .filter((m) => m.order_line_id === line.id)
      .map((m) => ({
        id: m.id,
        modifierId: m.modifier_id,
        priceDeltaMinor: m.price_delta_minor,
        grossMinor: m.gross_minor,
        proratedDiscountMinor: m.prorated_discount_minor,
        netSalesMinor: m.net_sales_minor,
        allocationBaseMinor: m.allocation_base_minor,
      })),
  }));
}

export async function getOrder(db: Kysely<Database>, orderId: number): Promise<OrderDetail | null> {
  const row = await db.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirst();
  if (!row) return null;
  const lines = await loadLines(db, orderId);
  return { ...toOrderSummary(row), lines };
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

// ---------------------------------------------------------------------
// Lifecycle: open
// ---------------------------------------------------------------------

export interface CreateOrderInput {
  readonly orderType: OrderType;
  readonly tableLabel?: string | undefined;
  readonly waiterId?: number | undefined;
}

/**
 * Opens a new order. There is no "current order" anywhere — every order
 * this creates is immediately and only addressable by its own id; the
 * caller (a route, ultimately a specific tablet) never becomes bound to
 * it (see ARCHITECTURE.md, "no current order").
 */
export async function createOrder(db: Kysely<Database>, input: CreateOrderInput, actor: OrderActor): Promise<OrderSummary> {
  if (input.orderType === 'dine_in') {
    if (!input.waiterId) throw new OrderStateError('dine_in orders require a waiter');
    if (!input.tableLabel) throw new OrderStateError('dine_in orders require a table label');
  }
  if (input.waiterId !== undefined) {
    const waiter = await db.selectFrom('user').select('id').where('id', '=', input.waiterId).executeTakeFirst();
    if (!waiter) throw new Error(`user ${input.waiterId} not found`);
  }

  const now = new Date().toISOString();
  const row = await db
    .insertInto('order')
    .values({
      invoice_no: null,
      order_type: input.orderType,
      channel: 'customer',
      table_label: input.tableLabel ?? null,
      waiter_id: input.waiterId ?? null,
      opened_at: now,
      billed_at: null,
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
}

export async function addLine(db: Kysely<Database>, orderId: number, input: AddLineInput, actor: OrderActor): Promise<OrderDetail> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error('qty must be a positive integer');

  const item = await getItem(db, input.itemId);
  if (!item || !item.active) throw new Error(`item ${input.itemId} not found or inactive`);
  const unitPriceMinor = await getCurrentPrice(db, input.itemId);
  if (unitPriceMinor === null) throw new OrderStateError(`item ${input.itemId} has no price set`);

  const modifierIds = input.modifierIds ?? [];
  await validateModifierSelection(db, input.itemId, modifierIds);
  const modifiers = await Promise.all(modifierIds.map((id) => getModifier(db, id)));

  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);

    const lineRow = await trx
      .insertInto('order_line')
      .values({
        order_id: orderId,
        item_id: input.itemId,
        qty: input.qty,
        unit_price_minor: unitPriceMinor,
        gross_minor: paisa(0),
        prorated_discount_minor: paisa(0),
        net_sales_minor: paisa(0),
        allocation_base_minor: paisa(0),
        voided: 0,
        void_reason: null,
        void_approved_by: null,
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
    return { ...toOrderSummary(finalOrder), lines };
  });
}

export interface VoidLineInput {
  readonly reason: string;
}

/** Line void with manager approval — the caller must already have
 * checked the actor's role is at least manager (see ordering/routes.ts);
 * `void_approved_by` is that actor. */
export async function voidLine(
  db: Kysely<Database>,
  orderId: number,
  lineId: number,
  input: VoidLineInput,
  actor: OrderActor,
): Promise<OrderDetail> {
  if (!input.reason.trim()) throw new Error('a void reason is required');

  return db.transaction().execute(async (trx) => {
    const order = await requireOpenOrder(trx, orderId);
    const line = await trx.selectFrom('order_line').selectAll().where('id', '=', lineId).where('order_id', '=', orderId).executeTakeFirst();
    if (!line) throw new Error(`line ${lineId} not found on order ${orderId}`);
    if (line.voided === 1) throw new OrderStateError(`line ${lineId} is already voided`);

    await trx
      .updateTable('order_line')
      .set({ voided: 1, void_reason: input.reason, void_approved_by: actor.actorId })
      .where('id', '=', lineId)
      .execute();

    await recomputeAndPersist(trx, order);

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order.void_line',
      entity: 'order_line',
      entityId: lineId,
      before: { voided: false },
      after: { voided: true, reason: input.reason, approvedBy: actor.actorId },
    });

    const finalOrder = await trx.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
    const lines = await loadLines(trx, orderId);
    return { ...toOrderSummary(finalOrder), lines };
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
    return { ...toOrderSummary(finalOrder), lines };
  });
}

// ---------------------------------------------------------------------
// Billing stage 1: pro-forma bill (open -> billed)
// ---------------------------------------------------------------------

export interface BillOrderInput {
  readonly serviceChargeMinor?: Paisa | undefined;
}

/**
 * Stage 1 of the two-stage billing flow: finalises the pro-forma bill.
 * Sets status to 'billed' and computes the final total — but allocates
 * NO invoice number, records NO payment, and writes NO partner
 * allocations (those happen only at close, in the billing milestone).
 * Tax is hardcoded to zero here (no tax module wired in yet — see
 * ARCHITECTURE.md); enabling a tax rule later changes this line without
 * touching anything else in the pipeline.
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

    const serviceChargeMinor = input.serviceChargeMinor ?? paisa(0);
    if (serviceChargeMinor > 0 && order.waiter_id === null) {
      throw new OrderStateError('service charge requires a waiter; this order has none');
    }

    const taxMinor = paisa(0); // no active tax rules — see the tax module (a later milestone)
    const preRound = add(add(order.net_sales_minor, taxMinor), serviceChargeMinor);
    const { total, adjustment } = roundToRupee(preRound);

    const now = new Date().toISOString();
    const updated = await versionedUpdate(trx, orderId, order.version, {
      status: 'billed',
      billed_at: now,
      tax_minor: taxMinor,
      service_charge_minor: serviceChargeMinor,
      rounding_adjustment_minor: adjustment,
      total_minor: total,
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
    return { ...toOrderSummary(updated), lines };
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
    return { ...toOrderSummary(updated), lines };
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
    return { ...toOrderSummary(updated), lines };
  });
}
