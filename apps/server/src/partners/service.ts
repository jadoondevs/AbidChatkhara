import { paisa, sum, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import type { Database } from '../platform/db/types.js';
import { allocateAll, type AllocatedAmount, type AllocationTarget, type OwnershipShare } from './engine.js';

// ---------------------------------------------------------------------
// Partner
// ---------------------------------------------------------------------

export interface PartnerSummary {
  readonly id: number;
  readonly name: string;
  readonly active: boolean;
  readonly joinedAt: string;
  readonly leftAt: string | null;
}

interface PartnerRow {
  id: number;
  name: string;
  active: number;
  joined_at: string;
  left_at: string | null;
}

function toPartnerSummary(row: PartnerRow): PartnerSummary {
  return { id: row.id, name: row.name, active: row.active === 1, joinedAt: row.joined_at, leftAt: row.left_at };
}

export async function createPartner(db: Kysely<Database>, name: string, actor: ActorContext): Promise<PartnerSummary> {
  const now = new Date().toISOString();
  const row = await db
    .insertInto('partner')
    .values({ name, active: 1, joined_at: now, left_at: null })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toPartnerSummary(row);
  await recordAudit(db, { actorId: actor.actorId, terminalId: actor.terminalId, action: 'partner.create', entity: 'partner', entityId: row.id, after: summary });
  return summary;
}

export async function listPartners(db: Kysely<Database>, opts: { includeInactive?: boolean | undefined } = {}): Promise<PartnerSummary[]> {
  let query = db.selectFrom('partner').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('name', 'asc').execute();
  return rows.map(toPartnerSummary);
}

export async function setPartnerActive(db: Kysely<Database>, id: number, active: boolean, actor: ActorContext): Promise<PartnerSummary> {
  const before = await db.selectFrom('partner').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`partner ${id} not found`);
  const now = new Date().toISOString();
  const after = await db
    .updateTable('partner')
    .set({ active: active ? 1 : 0, left_at: active ? null : now })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: active ? 'partner.reactivate' : 'partner.deactivate',
    entity: 'partner',
    entityId: id,
    before: toPartnerSummary(before),
    after: toPartnerSummary(after),
  });
  return toPartnerSummary(after);
}

// ---------------------------------------------------------------------
// Ownership (item and modifier), effective-dated
// ---------------------------------------------------------------------

export interface OwnershipSplitEntry {
  readonly partnerId: number;
  readonly shareBp: number;
}

function assertValidSplit(split: readonly OwnershipSplitEntry[]): void {
  const partnerIds = new Set(split.map((s) => s.partnerId));
  if (partnerIds.size !== split.length) throw new Error('ownership split lists the same partner more than once');
  const total = split.reduce((a, s) => a + s.shareBp, 0);
  if (split.length > 0 && total !== 10_000) {
    throw new Error(`ownership split must sum to exactly 10000 basis points; got ${total}`);
  }
}

export interface OwnershipRow {
  readonly id: number;
  readonly partnerId: number;
  readonly shareBp: number;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/**
 * Replace an item's whole ownership split, effective now: closes every
 * currently-open row for the item and inserts one new row per partner in
 * `split` — the whole split is edited together, never one partner's row
 * at a time, so "shares sum to exactly 10000" can be validated before
 * anything is written. Manager-only (enforced by the route, not here —
 * matches every other module's convention) and audit-logged.
 */
export async function setItemOwnership(
  db: Kysely<Database>,
  itemId: number,
  split: readonly OwnershipSplitEntry[],
  actor: ActorContext,
): Promise<OwnershipRow[]> {
  assertValidSplit(split);
  const item = await db.selectFrom('item').select('id').where('id', '=', itemId).executeTakeFirst();
  if (!item) throw new Error(`item ${itemId} not found`);

  return db.transaction().execute(async (trx) => {
    const before = await trx.selectFrom('item_ownership').selectAll().where('item_id', '=', itemId).where('valid_to', 'is', null).execute();
    const now = new Date().toISOString();
    if (before.length > 0) {
      await trx.updateTable('item_ownership').set({ valid_to: now }).where('item_id', '=', itemId).where('valid_to', 'is', null).execute();
    }

    const inserted: OwnershipRow[] = [];
    for (const entry of split) {
      const row = await trx
        .insertInto('item_ownership')
        .values({ item_id: itemId, partner_id: entry.partnerId, share_bp: entry.shareBp, valid_from: now, valid_to: null })
        .returningAll()
        .executeTakeFirstOrThrow();
      inserted.push({ id: row.id, partnerId: row.partner_id, shareBp: row.share_bp, validFrom: row.valid_from, validTo: row.valid_to });
    }

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'item.set_ownership',
      entity: 'item',
      entityId: itemId,
      before: before.map((r) => ({ partnerId: r.partner_id, shareBp: r.share_bp })),
      after: split,
    });

    return inserted;
  });
}

/** Active ownership for an item at `atInstant`, sorted by partner_id
 * ascending — the order the allocation engine needs for a deterministic
 * remainder tie-break. */
export async function getActiveItemOwnership(
  db: Kysely<Database> | Transaction<Database>,
  itemId: number,
  atInstant: Date = new Date(),
): Promise<OwnershipShare[]> {
  const at = atInstant.toISOString();
  const rows = await db
    .selectFrom('item_ownership')
    .select(['partner_id', 'share_bp'])
    .where('item_id', '=', itemId)
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .orderBy('partner_id', 'asc')
    .execute();
  return rows.map((r) => ({ partnerId: r.partner_id, shareBp: r.share_bp }));
}

/** Same as setItemOwnership, for a modifier's own (optional) ownership. */
export async function setModifierOwnership(
  db: Kysely<Database>,
  modifierId: number,
  split: readonly OwnershipSplitEntry[],
  actor: ActorContext,
): Promise<OwnershipRow[]> {
  assertValidSplit(split);
  const modifier = await db.selectFrom('modifier').select('id').where('id', '=', modifierId).executeTakeFirst();
  if (!modifier) throw new Error(`modifier ${modifierId} not found`);

  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('modifier_ownership')
      .selectAll()
      .where('modifier_id', '=', modifierId)
      .where('valid_to', 'is', null)
      .execute();
    const now = new Date().toISOString();
    if (before.length > 0) {
      await trx.updateTable('modifier_ownership').set({ valid_to: now }).where('modifier_id', '=', modifierId).where('valid_to', 'is', null).execute();
    }

    const inserted: OwnershipRow[] = [];
    for (const entry of split) {
      const row = await trx
        .insertInto('modifier_ownership')
        .values({ modifier_id: modifierId, partner_id: entry.partnerId, share_bp: entry.shareBp, valid_from: now, valid_to: null })
        .returningAll()
        .executeTakeFirstOrThrow();
      inserted.push({ id: row.id, partnerId: row.partner_id, shareBp: row.share_bp, validFrom: row.valid_from, validTo: row.valid_to });
    }

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'modifier.set_ownership',
      entity: 'modifier',
      entityId: modifierId,
      before: before.map((r) => ({ partnerId: r.partner_id, shareBp: r.share_bp })),
      after: split,
    });

    return inserted;
  });
}

export async function getActiveModifierOwnership(
  db: Kysely<Database> | Transaction<Database>,
  modifierId: number,
  atInstant: Date = new Date(),
): Promise<OwnershipShare[]> {
  const at = atInstant.toISOString();
  const rows = await db
    .selectFrom('modifier_ownership')
    .select(['partner_id', 'share_bp'])
    .where('modifier_id', '=', modifierId)
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .orderBy('partner_id', 'asc')
    .execute();
  return rows.map((r) => ({ partnerId: r.partner_id, shareBp: r.share_bp }));
}

// ---------------------------------------------------------------------
// Allocating an order
// ---------------------------------------------------------------------

export interface LineAllocationRow {
  readonly id: number;
  readonly orderLineId: number;
  readonly orderLineModifierId: number | null;
  readonly partnerId: number;
  readonly shareBpSnapshot: number;
  readonly amountMinor: Paisa;
  readonly allocationBaseMode: string;
  readonly createdAt: string;
  readonly reversesAllocationId: number | null;
}

/**
 * Compute and write partner allocations for every non-voided line (and
 * every separately-owned modifier) on an order, using ownership as of
 * `atInstant` (the billing milestone will call this at close time,
 * passing the order's closed_at). A modifier with no ownership rows of
 * its own follows its base item's ownership — its value is simply left
 * inside the line's own allocation base rather than carved out.
 *
 * Not wired into any close transaction yet (ordering stops at "billed" —
 * see docs/decisions/005) — this is the orchestration the billing
 * milestone's close operation will call, built and proven now so that
 * transaction only has to call it, not design it.
 */
export async function allocateOrder(db: Kysely<Database>, orderId: number, atInstant: Date, actor: ActorContext): Promise<LineAllocationRow[]> {
  return db.transaction().execute((trx) => allocateOrderInTransaction(trx, orderId, atInstant, actor));
}

/**
 * The same logic as `allocateOrder`, but running inside a transaction
 * the caller already holds open — what billing's close operation calls,
 * so allocating an order's revenue happens in the same atomic
 * transaction as allocating its invoice number and recording its
 * closure, rather than as a second, separately-committed step.
 */
export async function allocateOrderInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  atInstant: Date,
  actor: ActorContext,
): Promise<LineAllocationRow[]> {
  const lines = await trx.selectFrom('order_line').selectAll().where('order_id', '=', orderId).where('voided', '=', 0).execute();
  const modifiers = await trx
    .selectFrom('order_line_modifier')
    .selectAll()
    .where(
      'order_line_id',
      'in',
      lines.map((l) => l.id),
    )
    .execute();

  const targets: AllocationTarget[] = [];
  const targetLineId = new Map<string, { orderLineId: number; orderLineModifierId: number | null }>();
  // Two lines can be the same item (a dish ordered in two separate
  // addLine calls) — cache each item's/modifier's ownership lookup
  // across the whole order rather than re-querying it per line.
  const itemOwnershipCache = new Map<number, OwnershipShare[]>();
  const modifierOwnershipCache = new Map<number, OwnershipShare[]>();

  for (const line of lines) {
    const lineModifiers = modifiers.filter((m) => m.order_line_id === line.id);
    let itemOwnBase = line.allocation_base_minor;

    for (const modifier of lineModifiers) {
      let modifierShares = modifierOwnershipCache.get(modifier.modifier_id);
      if (!modifierShares) {
        modifierShares = await getActiveModifierOwnership(trx, modifier.modifier_id, atInstant);
        modifierOwnershipCache.set(modifier.modifier_id, modifierShares);
      }
      if (modifierShares.length === 0) continue; // follows the item's own ownership — stays in itemOwnBase

      itemOwnBase = paisa(itemOwnBase - modifier.allocation_base_minor);
      const key = `modifier:${modifier.id}`;
      targets.push({ key, allocationBaseMinor: modifier.allocation_base_minor, shares: modifierShares, allocationBaseMode: 'NET_SALES_EX_TAX' });
      targetLineId.set(key, { orderLineId: line.id, orderLineModifierId: modifier.id });
    }

    let itemShares = itemOwnershipCache.get(line.item_id);
    if (!itemShares) {
      itemShares = await getActiveItemOwnership(trx, line.item_id, atInstant);
      itemOwnershipCache.set(line.item_id, itemShares);
    }
    const key = `line:${line.id}`;
    targets.push({ key, allocationBaseMinor: itemOwnBase, shares: itemShares, allocationBaseMode: 'NET_SALES_EX_TAX' });
    targetLineId.set(key, { orderLineId: line.id, orderLineModifierId: null });
  }

  const allocated: AllocatedAmount[] = allocateAll(targets);

  const now = new Date().toISOString();
  const written: LineAllocationRow[] = [];
  for (const a of allocated) {
    const target = targetLineId.get(a.key);
    if (!target) throw new Error(`allocateOrder: no line mapping for allocation target "${a.key}"`); // unreachable
    const row = await trx
      .insertInto('line_allocation')
      .values({
        order_line_id: target.orderLineId,
        order_line_modifier_id: target.orderLineModifierId,
        partner_id: a.partnerId,
        share_bp_snapshot: a.shareBpSnapshot,
        amount_minor: a.amountMinor,
        allocation_base_mode: a.allocationBaseMode,
        created_at: now,
        reverses_allocation_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    written.push(toLineAllocationRow(row));
  }

  // Defense in depth: everything just allocated must sum to the
  // order's own net sales — the reconciliation the partner-statement
  // report will surface later, checked here before it's ever wrong.
  const order = await trx.selectFrom('order').select('net_sales_minor').where('id', '=', orderId).executeTakeFirstOrThrow();
  const totalAllocated = sum(written.map((w) => w.amountMinor));
  if (totalAllocated !== order.net_sales_minor) {
    throw new Error(
      `allocateOrder: allocated ${totalAllocated} but order ${orderId}'s net_sales_minor is ${order.net_sales_minor} — refusing to commit`,
    );
  }

  await recordAudit(trx, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'order.allocate',
    entity: 'order',
    entityId: orderId,
    after: { count: written.length, totalAllocated },
  });

  return written;
}

function toLineAllocationRow(row: {
  id: number;
  order_line_id: number;
  order_line_modifier_id: number | null;
  partner_id: number;
  share_bp_snapshot: number;
  amount_minor: Paisa;
  allocation_base_mode: string;
  created_at: string;
  reverses_allocation_id: number | null;
}): LineAllocationRow {
  return {
    id: row.id,
    orderLineId: row.order_line_id,
    orderLineModifierId: row.order_line_modifier_id,
    partnerId: row.partner_id,
    shareBpSnapshot: row.share_bp_snapshot,
    amountMinor: row.amount_minor,
    allocationBaseMode: row.allocation_base_mode,
    createdAt: row.created_at,
    reversesAllocationId: row.reverses_allocation_id,
  };
}

// ---------------------------------------------------------------------
// Reversal (refunds, post-close voids)
// ---------------------------------------------------------------------

async function reverseOneAllocation(trx: Transaction<Database>, allocationId: number, now: string): Promise<LineAllocationRow> {
  const original = await trx.selectFrom('line_allocation').selectAll().where('id', '=', allocationId).executeTakeFirst();
  if (!original) throw new Error(`line_allocation ${allocationId} not found`);
  if (original.reverses_allocation_id !== null) {
    throw new Error(`line_allocation ${allocationId} is itself a reversal — cannot reverse a reversal`);
  }
  const alreadyReversed = await trx
    .selectFrom('line_allocation')
    .select('id')
    .where('reverses_allocation_id', '=', allocationId)
    .executeTakeFirst();
  if (alreadyReversed) throw new Error(`line_allocation ${allocationId} has already been reversed`);

  const row = await trx
    .insertInto('line_allocation')
    .values({
      order_line_id: original.order_line_id,
      order_line_modifier_id: original.order_line_modifier_id,
      partner_id: original.partner_id,
      // The snapshotted shares from the ORIGINAL row — never current
      // ownership, even if it has since changed. This is the whole
      // point of a snapshot.
      share_bp_snapshot: original.share_bp_snapshot,
      amount_minor: paisa(-original.amount_minor),
      allocation_base_mode: original.allocation_base_mode,
      created_at: now,
      reverses_allocation_id: original.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toLineAllocationRow(row);
}

/**
 * Reverse every not-yet-reversed allocation for one order line (and its
 * modifiers) — a partial refund or a post-close void of a single item.
 * Each reversing row uses that original row's own snapshotted
 * share_bp_snapshot, so a reversal is correct even if ownership has
 * changed since the original allocation was written.
 */
export async function reverseLineAllocations(db: Kysely<Database>, orderLineId: number, actor: ActorContext): Promise<LineAllocationRow[]> {
  return db.transaction().execute((trx) => reverseLineAllocationsInTransaction(trx, orderLineId, actor));
}

/** Same as `reverseLineAllocations`, composable into a transaction the
 * caller already holds open — billing's refund flow uses this so
 * reversing allocations and recording the refund payment happen
 * atomically together. */
export async function reverseLineAllocationsInTransaction(
  trx: Transaction<Database>,
  orderLineId: number,
  actor: ActorContext,
): Promise<LineAllocationRow[]> {
  const originals = await trx
    .selectFrom('line_allocation')
    .select('id')
    .where('order_line_id', '=', orderLineId)
    .where('reverses_allocation_id', 'is', null)
    .execute();

  const now = new Date().toISOString();
  const reversed: LineAllocationRow[] = [];
  for (const o of originals) {
    // Skip rows already reversed by an earlier call instead of
    // failing the whole batch — reverseLineAllocations is safe to
    // call more than once for the same line.
    const already = await trx.selectFrom('line_allocation').select('id').where('reverses_allocation_id', '=', o.id).executeTakeFirst();
    if (already) continue;
    reversed.push(await reverseOneAllocation(trx, o.id, now));
  }

  if (reversed.length > 0) {
    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'order_line.reverse_allocations',
      entity: 'order_line',
      entityId: orderLineId,
      after: { count: reversed.length, total: sum(reversed.map((r) => r.amountMinor)) },
    });
  }

  return reversed;
}

/** Reverse every allocation for a whole order — a full refund or void
 * after close. */
export async function reverseOrderAllocations(db: Kysely<Database>, orderId: number, actor: ActorContext): Promise<LineAllocationRow[]> {
  return db.transaction().execute((trx) => reverseOrderAllocationsInTransaction(trx, orderId, actor));
}

/** Same as `reverseOrderAllocations`, composable into a transaction the
 * caller already holds open. */
export async function reverseOrderAllocationsInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  actor: ActorContext,
): Promise<LineAllocationRow[]> {
  const lines = await trx.selectFrom('order_line').select('id').where('order_id', '=', orderId).execute();
  const results: LineAllocationRow[] = [];
  for (const line of lines) {
    results.push(...(await reverseLineAllocationsInTransaction(trx, line.id, actor)));
  }
  return results;
}

// ---------------------------------------------------------------------
// Integrity check ("nightly integrity job")
// ---------------------------------------------------------------------

export interface OwnershipIntegrityViolation {
  readonly kind: 'item' | 'modifier';
  readonly id: number;
  readonly totalShareBp: number;
}

/**
 * Every active item's (and every modifier with its own ownership rows')
 * active shares must sum to exactly 10000 at any instant — enforced at
 * write time by setItemOwnership/setModifierOwnership, but this is the
 * defense-in-depth sweep the spec also asks for: "enforce on write and
 * with a nightly integrity job". An item with NO ownership configured
 * (sum = 0) is not a violation — it's simply unconfigured; only a
 * nonzero sum that isn't exactly 10000 indicates something got into a
 * bad state despite the write-time guard.
 */
export async function checkOwnershipIntegrity(db: Kysely<Database>, atInstant: Date = new Date()): Promise<OwnershipIntegrityViolation[]> {
  const violations: OwnershipIntegrityViolation[] = [];

  // Basis points, not money — plain integer addition, not the money
  // module's sum() (which brands its inputs as Paisa; a share_bp is not
  // an amount of money and shouldn't be dressed up as one).
  const sumBp = (shares: readonly OwnershipShare[]): number => shares.reduce((total, s) => total + s.shareBp, 0);

  const items = await db.selectFrom('item').select('id').where('active', '=', 1).execute();
  for (const item of items) {
    const shares = await getActiveItemOwnership(db, item.id, atInstant);
    const total = sumBp(shares);
    if (total !== 0 && total !== 10_000) {
      violations.push({ kind: 'item', id: item.id, totalShareBp: total });
    }
  }

  const modifiersWithOwnership = await db.selectFrom('modifier_ownership').select('modifier_id').where('valid_to', 'is', null).distinct().execute();
  for (const { modifier_id: modifierId } of modifiersWithOwnership) {
    const shares = await getActiveModifierOwnership(db, modifierId, atInstant);
    const total = sumBp(shares);
    if (total !== 0 && total !== 10_000) {
      violations.push({ kind: 'modifier', id: modifierId, totalShareBp: total });
    }
  }

  return violations;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The "nightly integrity job" half of the spec's "enforce on write and
 * with a nightly integrity job" — runs `checkOwnershipIntegrity` on an
 * interval and logs any violations found (there is nowhere else for a
 * background finding like this to surface yet; the reporting milestone
 * may give it a real destination). Returns a function that cancels the
 * schedule, for tests and for a clean shutdown.
 */
export function scheduleOwnershipIntegrityCheck(db: Kysely<Database>, intervalMs: number = ONE_DAY_MS): () => void {
  const timer = setInterval(() => {
    checkOwnershipIntegrity(db)
      .then((violations) => {
        if (violations.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`[ownership-integrity] ${violations.length} violation(s) found`, violations);
        }
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[ownership-integrity] check failed', err);
      });
  }, intervalMs);
  timer.unref(); // a scheduled check should never be the reason the process stays alive
  return () => clearInterval(timer);
}
