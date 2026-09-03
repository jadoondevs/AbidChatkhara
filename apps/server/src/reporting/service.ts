import { add, paisa, prorate, sub, sum, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import { listConsumptionRecords, type ConsumptionRecordSummary } from '../consumption/service.js';
import { waiterPayoutTotals, type WaiterPayoutLine } from '../gratuity/service.js';
import { getActiveItemOwnership } from '../partners/service.js';
import type { Database } from '../platform/db/types.js';

export interface DateRangeOptions {
  readonly fromInclusive?: string | undefined;
  readonly toExclusive?: string | undefined;
}

export interface PaymentMethodBreakdownLine {
  readonly paymentMethodId: number;
  readonly paymentMethodName: string;
  readonly totalMinor: Paisa;
}

async function paymentMethodBreakdownForOrders(db: Kysely<Database>, orderIds: readonly number[]): Promise<PaymentMethodBreakdownLine[]> {
  if (orderIds.length === 0) return [];
  const rows = await db
    .selectFrom('payment')
    .innerJoin('payment_method', 'payment_method.id', 'payment.payment_method_id')
    .select(['payment_method.id as paymentMethodId', 'payment_method.display_name as paymentMethodName', 'payment.amount_minor as amountMinor'])
    .where('payment.order_id', 'in', orderIds)
    .execute();
  const byMethod = new Map<number, { name: string; amounts: Paisa[] }>();
  for (const row of rows) {
    const entry = byMethod.get(row.paymentMethodId) ?? { name: row.paymentMethodName, amounts: [] };
    entry.amounts.push(row.amountMinor);
    byMethod.set(row.paymentMethodId, entry);
  }
  return [...byMethod.entries()]
    .map(([paymentMethodId, { name, amounts }]) => ({ paymentMethodId, paymentMethodName: name, totalMinor: sum(amounts) }))
    .sort((a, b) => a.paymentMethodName.localeCompare(b.paymentMethodName));
}

// ---------------------------------------------------------------------
// Daily sales
// ---------------------------------------------------------------------

export interface DailySalesReport {
  /** Menu value before any discount — what was rung up. */
  readonly grossSalesMinor: Paisa;
  readonly discountsMinor: Paisa;
  readonly customerSalesMinor: Paisa;
  readonly consumptionMinor: Paisa;
  readonly combinedSalesMinor: Paisa;
  readonly taxCollectedMinor: Paisa;
  /** Service charge collected across the period, as its own line.
   * Deliberately NOT folded into a sales figure: it is money held for
   * the waiters, not revenue the restaurant earned
   * (docs/decisions/008). `serviceChargeByWaiter` is the same money
   * broken down by who is owed it. */
  readonly serviceChargeMinor: Paisa;
  readonly serviceChargeByWaiter: readonly WaiterPayoutLine[];
  readonly roundingAdjustmentMinor: Paisa;
  /** What customers actually paid: net sales + tax + service charge +
   * rounding. The figure the payment breakdown below adds up to. */
  readonly totalCollectedMinor: Paisa;
  readonly paymentMethodBreakdown: readonly PaymentMethodBreakdownLine[];
  /** How many CUSTOMER bills closed in the range. Staff and owner meals
   * are excluded: they are consumption, not trade, and counting them
   * would quietly deflate the average bill below. */
  readonly orderCount: number;
  /** Takings by hour of the local day, for the dashboard's shape-of-the-
   * evening bar. Only hours that actually saw a sale appear. */
  readonly salesByHour: readonly HourlySalesLine[];
}

/** One hour of trading. `hour` is 0-23 in LOCAL time — the same local-day
 * reasoning the date range itself uses, since a restaurant's evening
 * straddles UTC midnight here. */
export interface HourlySalesLine {
  readonly hour: number;
  readonly orderCount: number;
  readonly totalMinor: Paisa;
}

/**
 * Spec: "customer sales, staff/owner consumption, combined total, tax
 * collected, service charge collected per waiter, rounding adjustments,
 * payment method breakdown." Scoped by `order.closed_at` — every figure
 * here is pulled from orders that closed in the range, not from a
 * sub-row's own timestamp, so a same-day refund of a same-day sale
 * still nets out inside that one day's figures.
 */
export async function dailySalesReport(db: Kysely<Database>, opts: DateRangeOptions = {}): Promise<DailySalesReport> {
  let query = db
    .selectFrom('order')
    .select([
      'id',
      'channel',
      'closed_at',
      'subtotal_minor',
      'order_discount_minor',
      'net_sales_minor',
      'tax_minor',
      'service_charge_minor',
      'rounding_adjustment_minor',
      'total_minor',
    ])
    .where('status', '=', 'closed');
  if (opts.fromInclusive) query = query.where('closed_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) query = query.where('closed_at', '<', opts.toExclusive);
  const orders = await query.execute();

  const customerSalesMinor = sum(orders.filter((o) => o.channel === 'customer').map((o) => o.net_sales_minor));
  const consumptionMinor = sum(orders.filter((o) => o.channel !== 'customer').map((o) => o.net_sales_minor));
  const taxCollectedMinor = sum(orders.map((o) => o.tax_minor));
  const roundingAdjustmentMinor = sum(orders.map((o) => o.rounding_adjustment_minor));

  // Customer bills only — see the note on `orderCount`.
  const customerOrders = orders.filter((o) => o.channel === 'customer');

  const serviceChargeByWaiter = await waiterPayoutTotals(db, { fromInclusive: opts.fromInclusive, toExclusive: opts.toExclusive });
  const paymentMethodBreakdown = await paymentMethodBreakdownForOrders(
    db,
    orders.map((o) => o.id),
  );

  return {
    grossSalesMinor: sum(orders.map((o) => o.subtotal_minor)),
    discountsMinor: sum(orders.map((o) => o.order_discount_minor)),
    customerSalesMinor,
    consumptionMinor,
    combinedSalesMinor: add(customerSalesMinor, consumptionMinor),
    taxCollectedMinor,
    // From the orders themselves, not the payout sheet: the payout is
    // grouped by waiter and would omit a charge on an order whose
    // waiter has since been removed.
    serviceChargeMinor: sum(orders.map((o) => o.service_charge_minor)),
    serviceChargeByWaiter,
    roundingAdjustmentMinor,
    totalCollectedMinor: sum(orders.map((o) => o.total_minor)),
    paymentMethodBreakdown,
    orderCount: customerOrders.length,
    salesByHour: hourlySales(customerOrders),
  };
}

/**
 * Bucket takings by the LOCAL hour a bill closed.
 *
 * `new Date(...).getHours()` and not the UTC hour: an order settled at
 * 9pm in Lahore is a 9pm order, and reading it as 4pm would put the
 * dinner rush in the afternoon. This is the same reasoning the date
 * range itself uses for day boundaries.
 *
 * Hours with no trade are left out rather than padded with zeroes — the
 * caller draws a bar per row, and a restaurant that opens at 4pm should
 * not render sixteen empty bars before it.
 */
function hourlySales(orders: readonly { closed_at: string | null; total_minor: Paisa }[]): HourlySalesLine[] {
  const byHour = new Map<number, { orderCount: number; amounts: Paisa[] }>();
  for (const order of orders) {
    if (order.closed_at === null) continue;
    const hour = new Date(order.closed_at).getHours();
    const entry = byHour.get(hour) ?? { orderCount: 0, amounts: [] };
    entry.orderCount += 1;
    entry.amounts.push(order.total_minor);
    byHour.set(hour, entry);
  }
  return [...byHour.entries()]
    .map(([hour, { orderCount, amounts }]) => ({ hour, orderCount, totalMinor: sum(amounts) }))
    .sort((a, b) => a.hour - b.hour);
}

// ---------------------------------------------------------------------
// Allocation reconciliation (used by the partner statement)
// ---------------------------------------------------------------------

export interface AllocationReconciliation {
  readonly allocationBaseMinor: Paisa;
  readonly totalAllocatedMinor: Paisa;
  readonly varianceMinor: Paisa;
}

/**
 * System-wide sanity check, independent of which partner is being
 * viewed (spec: "Must display a reconciliation line showing total
 * allocation base versus total allocated ... which must always be
 * zero"). `order_line.allocation_base_minor` already accounts for every
 * owned modifier carved out of it (itemOwnBase + sum(owned modifier
 * bases) == line.allocation_base_minor exactly, by construction in
 * `partners.allocateOrderInTransaction`) — so summing it alone, with no
 * further modifier addition, is the correct total base; adding modifier
 * bases again would double-count the ones that stayed folded into the
 * line's own figure.
 *
 * Only ORIGINAL allocations count towards `totalAllocatedMinor`
 * (`reverses_allocation_id IS NULL`) — this proves the allocation
 * engine distributed every sale's full value correctly *at the time it
 * happened*, which is what "must always be zero" is actually checking.
 * A later refund's reversal doesn't retroactively make that original
 * distribution wrong; it's a separate, subsequent event, and correctly
 * reducing what a partner is still owed is exactly gratuity's and
 * billing's own job (see their own reversal tests) — mixing that into
 * this reconciliation would make a routine refund look like a broken
 * allocation, when nothing was ever mis-allocated.
 */
export async function allocationReconciliation(db: Kysely<Database>, opts: DateRangeOptions = {}): Promise<AllocationReconciliation> {
  let lineQuery = db
    .selectFrom('order_line')
    .innerJoin('order', 'order.id', 'order_line.order_id')
    .select(['order_line.id as orderLineId', 'order_line.allocation_base_minor as allocationBaseMinor'])
    .where('order.status', '=', 'closed')
    .where('order_line.voided', '=', 0);
  if (opts.fromInclusive) lineQuery = lineQuery.where('order.closed_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) lineQuery = lineQuery.where('order.closed_at', '<', opts.toExclusive);
  const lineRows = await lineQuery.execute();
  const orderLineIds = lineRows.map((r) => r.orderLineId);

  const allocationBaseMinor = sum(lineRows.map((r) => r.allocationBaseMinor));
  const allocRows =
    orderLineIds.length > 0
      ? await db.selectFrom('line_allocation').select('amount_minor').where('order_line_id', 'in', orderLineIds).where('reverses_allocation_id', 'is', null).execute()
      : [];
  const totalAllocatedMinor = sum(allocRows.map((r) => r.amount_minor));

  return { allocationBaseMinor, totalAllocatedMinor, varianceMinor: sub(totalAllocatedMinor, allocationBaseMinor) };
}

// ---------------------------------------------------------------------
// Partner statement
// ---------------------------------------------------------------------

export interface PartnerStatementItemLine {
  readonly itemId: number;
  readonly itemName: string;
  readonly qty: number;
  readonly allocatedMinor: Paisa;
}

export interface PartnerStatement {
  readonly partnerId: number;
  readonly partnerName: string;
  readonly totalAllocatedMinor: Paisa;
  readonly customerSalesAllocatedMinor: Paisa;
  readonly consumptionAllocatedMinor: Paisa;
  readonly items: readonly PartnerStatementItemLine[];
  readonly reconciliation: AllocationReconciliation;
}

/**
 * Spec: "per partner for any date range — total allocated, split by
 * customer sales versus consumption, drill down to item, then to
 * individual bill." `items` is the first drill-down level; `bill`
 * (below) is the second, reached by passing an `itemId` back in.
 * `reconciliation` is the same system-wide check regardless of which
 * partner is being viewed — see allocationReconciliation above.
 */
export async function partnerStatement(db: Kysely<Database>, partnerId: number, opts: DateRangeOptions = {}): Promise<PartnerStatement> {
  const partner = await db.selectFrom('partner').select(['id', 'name']).where('id', '=', partnerId).executeTakeFirstOrThrow();

  let rowsQuery = db
    .selectFrom('line_allocation')
    .innerJoin('order_line', 'order_line.id', 'line_allocation.order_line_id')
    .innerJoin('order', 'order.id', 'order_line.order_id')
    .select(['line_allocation.amount_minor as amountMinor', 'order.channel as channel', 'order_line.item_id as itemId', 'order_line.qty as qty'])
    .where('line_allocation.partner_id', '=', partnerId)
    .where('order.status', '=', 'closed');
  if (opts.fromInclusive) rowsQuery = rowsQuery.where('order.closed_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) rowsQuery = rowsQuery.where('order.closed_at', '<', opts.toExclusive);
  const rows = await rowsQuery.execute();

  const totalAllocatedMinor = sum(rows.map((r) => r.amountMinor));
  const customerSalesAllocatedMinor = sum(rows.filter((r) => r.channel === 'customer').map((r) => r.amountMinor));
  const consumptionAllocatedMinor = sum(rows.filter((r) => r.channel !== 'customer').map((r) => r.amountMinor));

  const byItem = new Map<number, { qty: number; amounts: Paisa[] }>();
  for (const row of rows) {
    const entry = byItem.get(row.itemId) ?? { qty: 0, amounts: [] };
    entry.qty += row.qty;
    entry.amounts.push(row.amountMinor);
    byItem.set(row.itemId, entry);
  }
  const itemIds = [...byItem.keys()];
  const itemRows = itemIds.length > 0 ? await db.selectFrom('item').select(['id', 'name']).where('id', 'in', itemIds).execute() : [];
  const itemNameById = new Map(itemRows.map((i) => [i.id, i.name]));
  const items: PartnerStatementItemLine[] = [...byItem.entries()]
    .map(([itemId, { qty, amounts }]) => ({ itemId, itemName: itemNameById.get(itemId) ?? `item ${itemId}`, qty, allocatedMinor: sum(amounts) }))
    .sort((a, b) => a.itemName.localeCompare(b.itemName));

  const reconciliation = await allocationReconciliation(db, opts);

  return { partnerId: partner.id, partnerName: partner.name, totalAllocatedMinor, customerSalesAllocatedMinor, consumptionAllocatedMinor, items, reconciliation };
}

export interface PartnerStatementBillLine {
  readonly orderId: number;
  readonly invoiceNo: number | null;
  readonly closedAt: string | null;
  readonly amountMinor: Paisa;
}

/** The second drill-down level: every individual bill (order) behind
 * one item's total on a partner's statement. */
export async function partnerItemBills(db: Kysely<Database>, partnerId: number, itemId: number, opts: DateRangeOptions = {}): Promise<PartnerStatementBillLine[]> {
  let query = db
    .selectFrom('line_allocation')
    .innerJoin('order_line', 'order_line.id', 'line_allocation.order_line_id')
    .innerJoin('order', 'order.id', 'order_line.order_id')
    .select(['order.id as orderId', 'order.invoice_no as invoiceNo', 'order.closed_at as closedAt', 'line_allocation.amount_minor as amountMinor'])
    .where('line_allocation.partner_id', '=', partnerId)
    .where('order_line.item_id', '=', itemId)
    .where('order.status', '=', 'closed');
  if (opts.fromInclusive) query = query.where('order.closed_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) query = query.where('order.closed_at', '<', opts.toExclusive);
  const rows = await query.orderBy('order.closed_at', 'asc').execute();
  return rows;
}

// ---------------------------------------------------------------------
// Item mix
// ---------------------------------------------------------------------

export interface ItemMixOwnerShare {
  readonly partnerId: number;
  readonly partnerName: string;
  readonly shareBp: number;
}

export interface ItemMixLine {
  /** The base menu item. Not unique across rows: an item sold in two
   * sizes produces two rows that share this id. */
  readonly itemId: number;
  readonly itemName: string;
  /** The modifiers this configuration was sold with, as their snapshot
   * names ("Half", "Full", "Small, Extra cheese"), or '' when the item
   * was sold plain. Taken from `order_line_modifier`'s frozen names, so
   * renaming a modifier later never rewrites a past report. */
  readonly modifierNames: string;
  /** What to show in the Item column: the item name, plus " — <sizes>"
   * when it was sold with modifiers. */
  readonly variantName: string;
  /** The section it sits under on the menu today. Null only if the item
   * has since lost its category — the report still names the item. */
  readonly categoryName: string | null;
  readonly qty: number;
  readonly netSalesMinor: Paisa;
  readonly owners: readonly ItemMixOwnerShare[];
}

/**
 * Spec: "quantity and value per item, with owning partners and their
 * shares shown" — but a size is not an item, so an item sold Half and
 * Full is two rows, not one aggregate. The split is by the SOLD
 * configuration, read from each line's own `order_line_modifier`
 * snapshot (names and, through the line's net-sales, the price it was
 * charged at), never from the current menu — so if Full is later
 * renamed or repriced, a past report still reads "Full" at what it sold
 * for. An item sold plain stays a single row. Because a line's
 * `net_sales_minor` is already the whole line (item + its modifiers,
 * see ordering/pipeline), the per-variant values still sum to exactly
 * the item's overall total.
 *
 * Ownership shown is the CURRENT active split, not a historical
 * snapshot — this report describes the menu as it stands today, unlike
 * a partner statement, which is built from each sale's own frozen
 * `share_bp_snapshot`. It is a property of the base item, so every
 * variant of an item shows the same owners.
 */
export async function itemMixReport(db: Kysely<Database>, opts: DateRangeOptions = {}): Promise<ItemMixLine[]> {
  let query = db
    .selectFrom('order_line')
    .innerJoin('order', 'order.id', 'order_line.order_id')
    .select(['order_line.id as lineId', 'order_line.item_id as itemId', 'order_line.qty as qty', 'order_line.net_sales_minor as netSalesMinor'])
    .where('order.status', '=', 'closed')
    .where('order_line.voided', '=', 0);
  if (opts.fromInclusive) query = query.where('order.closed_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) query = query.where('order.closed_at', '<', opts.toExclusive);
  const rows = await query.execute();

  // The sold configuration of each line, from the frozen snapshot — the
  // whole point is that this does not consult the current menu.
  const modifierRows = rows.length
    ? await db
        .selectFrom('order_line_modifier')
        .select([
          'order_line_modifier.order_line_id as lineId',
          'order_line_modifier.modifier_id as modifierId',
          'order_line_modifier.modifier_name_snapshot as name',
        ])
        .where(
          'order_line_modifier.order_line_id',
          'in',
          rows.map((r) => r.lineId),
        )
        .execute()
    : [];
  const modsByLine = new Map<number, { id: number; name: string }[]>();
  for (const m of modifierRows) {
    const list = modsByLine.get(m.lineId) ?? [];
    list.push({ id: m.modifierId, name: m.name ?? `modifier ${m.modifierId}` });
    modsByLine.set(m.lineId, list);
  }

  interface Variant {
    itemId: number;
    modifierNames: string;
    /** The configuration's modifier ids, ascending — used only to order
     * an item's variants the way the menu does (Half, a smaller id than
     * Full, comes first) rather than alphabetically. */
    sortIds: number[];
    qty: number;
    amounts: Paisa[];
  }
  const byVariant = new Map<string, Variant>();
  for (const row of rows) {
    const mods = (modsByLine.get(row.lineId) ?? []).slice().sort((a, b) => a.id - b.id);
    const modifierNames = mods.map((m) => m.name).join(', ');
    const key = `${row.itemId} ${modifierNames}`;
    const variant = byVariant.get(key) ?? { itemId: row.itemId, modifierNames, sortIds: mods.map((m) => m.id), qty: 0, amounts: [] };
    variant.qty += row.qty;
    variant.amounts.push(row.netSalesMinor);
    byVariant.set(key, variant);
  }

  const itemIds = [...new Set([...byVariant.values()].map((v) => v.itemId))];
  // The category rides along on the join the name already needs, so the
  // dashboard can group by section without a second query.
  const itemRows =
    itemIds.length > 0
      ? await db
          .selectFrom('item')
          .innerJoin('category', 'category.id', 'item.category_id')
          .select(['item.id as id', 'item.name as name', 'category.name as categoryName'])
          .where('item.id', 'in', itemIds)
          .execute()
      : [];
  const itemNameById = new Map(itemRows.map((i) => [i.id, i.name]));
  const categoryNameById = new Map(itemRows.map((i) => [i.id, i.categoryName]));

  // Owners are per base item, so resolve them once per item, not once
  // per variant.
  const ownersByItem = new Map<number, ItemMixOwnerShare[]>();
  for (const itemId of itemIds) {
    const owners = await getActiveItemOwnership(db, itemId);
    const partnerIds = owners.map((o) => o.partnerId);
    const partnerRows = partnerIds.length > 0 ? await db.selectFrom('partner').select(['id', 'name']).where('id', 'in', partnerIds).execute() : [];
    const partnerNameById = new Map(partnerRows.map((p) => [p.id, p.name]));
    ownersByItem.set(
      itemId,
      owners.map((o) => ({ partnerId: o.partnerId, partnerName: partnerNameById.get(o.partnerId) ?? `partner ${o.partnerId}`, shareBp: o.shareBp })),
    );
  }

  const firstSortId = (v: Variant) => (v.sortIds.length > 0 ? (v.sortIds[0] as number) : -1);
  const variants = [...byVariant.values()].sort((a, b) => {
    const nameA = itemNameById.get(a.itemId) ?? `item ${a.itemId}`;
    const nameB = itemNameById.get(b.itemId) ?? `item ${b.itemId}`;
    return nameA.localeCompare(nameB) || firstSortId(a) - firstSortId(b) || a.modifierNames.localeCompare(b.modifierNames);
  });

  return variants.map((v) => {
    const itemName = itemNameById.get(v.itemId) ?? `item ${v.itemId}`;
    return {
      itemId: v.itemId,
      itemName,
      modifierNames: v.modifierNames,
      variantName: v.modifierNames ? `${itemName} — ${v.modifierNames}` : itemName,
      categoryName: categoryNameById.get(v.itemId) ?? null,
      qty: v.qty,
      netSalesMinor: sum(v.amounts),
      owners: ownersByItem.get(v.itemId) ?? [],
    };
  });
}

// ---------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------

export interface ConsumptionPersonSubtotal {
  readonly personId: number;
  readonly personName: string;
  readonly menuValueMinor: Paisa;
  readonly chargedMinor: Paisa;
  readonly settlementMinor: Paisa;
}

export interface ConsumptionReport {
  readonly records: readonly ConsumptionRecordSummary[];
  /** One row per consumed item — see ConsumptionDetailLine. */
  readonly lines: readonly ConsumptionDetailLine[];
  readonly byPerson: readonly ConsumptionPersonSubtotal[];
}

/**
 * One row per ITEM consumed: who ate it, what it was, how many, what it
 * was worth on the menu and what they were actually charged for it.
 *
 * The per-order `consumption_record` answers "what did this meal cost
 * the house", which is the accounting question. It cannot answer "what
 * did Rashid actually eat", which is the question a manager reviewing
 * staff meals is asking — that needs the order's own lines. So the
 * charged amount is split across the meal's lines in proportion to
 * their menu value, using the same largest-remainder distribution the
 * rest of the system uses, and the per-line parts therefore still sum
 * exactly to what the record says was charged.
 */
export interface ConsumptionDetailLine {
  readonly consumptionRecordId: number;
  readonly orderId: number;
  readonly invoiceNo: number | null;
  readonly personId: number;
  readonly personName: string;
  readonly itemName: string;
  readonly modifierNames: string;
  readonly qty: number;
  readonly menuValueMinor: Paisa;
  readonly chargedMinor: Paisa;
  readonly mealPolicy: string;
  readonly settlementType: string | null;
  /** 'settled' once the meal has an order that closed; a record only
   * exists at settlement, so this is 'settled' in practice and exists to
   * make that explicit on the report rather than leave it implied. */
  readonly settlementStatus: string;
  readonly consumedAt: string;
}

async function consumptionDetailLines(
  db: Kysely<Database>,
  records: readonly ConsumptionRecordSummary[],
): Promise<ConsumptionDetailLine[]> {
  if (records.length === 0) return [];
  const orderIds = records.map((r) => r.orderId);

  // Names come from the line's own snapshot, not from a join to the
  // menu: this report says what a person ate on a given day, and
  // renaming a dish must not rewrite what they were served.
  const lineRows = await db
    .selectFrom('order_line')
    .innerJoin('order', 'order.id', 'order_line.order_id')
    .select([
      'order_line.id as lineId',
      'order_line.order_id as orderId',
      'order_line.item_id as itemId',
      'order_line.qty as qty',
      'order_line.net_sales_minor as menuValueMinor',
      'order_line.item_name_snapshot as itemName',
      'order.invoice_no as invoiceNo',
      'order.closed_at as closedAt',
    ])
    .where('order_line.order_id', 'in', orderIds)
    .where('order_line.voided', '=', 0)
    .orderBy('order_line.id', 'asc')
    .execute();

  const modifierRows = lineRows.length
    ? await db
        .selectFrom('order_line_modifier')
        .select([
          'order_line_modifier.order_line_id as lineId',
          'order_line_modifier.modifier_id as modifierId',
          'order_line_modifier.modifier_name_snapshot as name',
        ])
        .where(
          'order_line_modifier.order_line_id',
          'in',
          lineRows.map((l) => l.lineId),
        )
        .execute()
    : [];

  const detail: ConsumptionDetailLine[] = [];
  for (const record of records) {
    const lines = lineRows.filter((l) => l.orderId === record.orderId);
    if (lines.length === 0) continue;

    // Largest-remainder again, so the per-item charged amounts add back
    // up to exactly what the person was charged for the meal.
    const chargedParts = prorate(
      record.chargedMinor,
      lines.map((l) => l.menuValueMinor),
    );

    lines.forEach((line, i) => {
      detail.push({
        consumptionRecordId: record.id,
        orderId: record.orderId,
        invoiceNo: line.invoiceNo,
        personId: record.personId,
        personName: record.personName,
        itemName: line.itemName ?? `item ${line.itemId}`,
        modifierNames: modifierRows
          .filter((m) => m.lineId === line.lineId)
          .map((m) => m.name ?? `modifier ${m.modifierId}`)
          .join(', '),
        qty: line.qty,
        menuValueMinor: line.menuValueMinor,
        chargedMinor: chargedParts[i] as Paisa,
        mealPolicy: record.policySnapshot.mealPolicy,
        settlementType: record.settlementType,
        settlementStatus: line.closedAt === null ? 'pending' : 'settled',
        consumedAt: record.createdAt,
      });
    });
  }
  return detail;
}

/** Spec: "per person, itemised, menu value versus charged." Built
 * directly on consumption's own listConsumptionRecords (the itemised
 * list) plus a per-person rollup — reporting doesn't re-derive
 * consumption's own figures from `order`/`consumption_record` rows a
 * second time. `lines` adds the item-level breakdown on top, which is
 * what makes the report readable as "what was actually eaten" rather
 * than only as a column of totals. */
export async function consumptionReport(db: Kysely<Database>, opts: DateRangeOptions & { personId?: number | undefined } = {}): Promise<ConsumptionReport> {
  const records = await listConsumptionRecords(db, opts);
  const lines = await consumptionDetailLines(db, records);

  const byPersonMap = new Map<number, { personName: string; menuValue: Paisa[]; charged: Paisa[]; settlement: Paisa[] }>();
  for (const record of records) {
    const entry = byPersonMap.get(record.personId) ?? { personName: record.personName, menuValue: [], charged: [], settlement: [] };
    entry.menuValue.push(record.menuValueMinor);
    entry.charged.push(record.chargedMinor);
    entry.settlement.push(record.settlementMinor);
    byPersonMap.set(record.personId, entry);
  }
  const byPerson: ConsumptionPersonSubtotal[] = [...byPersonMap.entries()]
    .map(([personId, { personName, menuValue, charged, settlement }]) => ({
      personId,
      personName,
      menuValueMinor: sum(menuValue),
      chargedMinor: sum(charged),
      settlementMinor: sum(settlement),
    }))
    .sort((a, b) => a.personName.localeCompare(b.personName));

  return { records, lines, byPerson };
}

// ---------------------------------------------------------------------
// Void and discount (theft control)
// ---------------------------------------------------------------------

export type VoidOrDiscountKind = 'void_line' | 'void_order' | 'discount';

export interface VoidOrDiscountEntry {
  readonly id: number;
  readonly kind: VoidOrDiscountKind;
  readonly actorId: number | null;
  readonly actorName: string | null;
  readonly orderId: number | null;
  readonly reason: string | null;
  readonly discountMinor: Paisa | null;
  readonly createdAt: string;
}

export interface VoidAndDiscountOptions extends DateRangeOptions {
  readonly actorId?: number | undefined;
}

const ACTION_KIND: Record<string, VoidOrDiscountKind> = {
  'order.void_line': 'void_line',
  'order.void': 'void_order',
  'order.set_discount': 'discount',
};

/**
 * Spec: "per user, for theft control." Built from `audit_log` — the one
 * table that already records who did every mutation, when — rather than
 * from `order`/`order_line`'s own columns, since only line-level voids
 * carry their own `void_approved_by`; an order-level void and a
 * discount's actor exist only in the audit trail. A line void's
 * `entity_id` is the line id, not the order id, so its order is
 * resolved via one extra lookup against `order_line`; a discount
 * cleared back to zero is excluded — it isn't a discount that needs
 * scrutiny.
 */
export async function voidAndDiscountReport(db: Kysely<Database>, opts: VoidAndDiscountOptions = {}): Promise<VoidOrDiscountEntry[]> {
  let query = db
    .selectFrom('audit_log')
    .selectAll()
    .where('action', 'in', Object.keys(ACTION_KIND));
  if (opts.actorId !== undefined) query = query.where('actor_id', '=', opts.actorId);
  if (opts.fromInclusive) query = query.where('created_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) query = query.where('created_at', '<', opts.toExclusive);
  const rows = await query.orderBy('created_at', 'desc').execute();

  const lineIds = rows.filter((r) => r.entity === 'order_line').map((r) => Number(r.entity_id));
  const lineToOrder = new Map<number, number>();
  if (lineIds.length > 0) {
    const lines = await db.selectFrom('order_line').select(['id', 'order_id']).where('id', 'in', lineIds).execute();
    for (const line of lines) lineToOrder.set(line.id, line.order_id);
  }

  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((id): id is number => id !== null))];
  const users = actorIds.length > 0 ? await db.selectFrom('user').select(['id', 'name']).where('id', 'in', actorIds).execute() : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  const entries: VoidOrDiscountEntry[] = [];
  for (const row of rows) {
    const kind = ACTION_KIND[row.action];
    if (!kind) continue; // unreachable given the `where` above
    const after = row.after_json ? (JSON.parse(row.after_json) as { reason?: string; discountMinor?: number }) : null;
    if (kind === 'discount' && !(after?.discountMinor && after.discountMinor > 0)) continue;

    const orderId = row.entity === 'order' ? Number(row.entity_id) : (lineToOrder.get(Number(row.entity_id)) ?? null);
    entries.push({
      id: row.id,
      kind,
      actorId: row.actor_id,
      actorName: row.actor_id !== null ? (nameById.get(row.actor_id) ?? null) : null,
      orderId,
      reason: after?.reason ?? null,
      discountMinor: kind === 'discount' ? paisa(after?.discountMinor ?? 0) : null,
      createdAt: row.created_at,
    });
  }
  return entries;
}
