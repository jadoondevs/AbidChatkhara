import { paisa, sum, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { Database } from '../platform/db/types.js';

export interface ServiceChargeActor {
  readonly actorId: number;
  readonly terminalId: string;
}

export interface ServiceChargeEntrySummary {
  readonly id: number;
  readonly orderId: number;
  readonly waiterId: number;
  readonly amountMinor: Paisa;
  readonly shiftId: number | null;
  readonly createdBy: number;
  readonly createdAt: string;
  readonly reversesEntryId: number | null;
}

interface ServiceChargeEntryRow {
  id: number;
  order_id: number;
  waiter_id: number;
  amount_minor: Paisa;
  shift_id: number | null;
  created_by: number;
  created_at: string;
  reverses_entry_id: number | null;
}

function toSummary(row: ServiceChargeEntryRow): ServiceChargeEntrySummary {
  return {
    id: row.id,
    orderId: row.order_id,
    waiterId: row.waiter_id,
    amountMinor: row.amount_minor,
    shiftId: row.shift_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    reversesEntryId: row.reverses_entry_id,
  };
}

/**
 * Records the order's service charge as money HELD for its waiter —
 * never revenue (see docs/decisions/008) — attributed directly to
 * `order.waiter_id`, no pooling. Called from billing's close
 * transaction, alongside partner allocation, once an order is fully
 * paid; a no-op (returns null, writes nothing) when the service charge
 * is zero — "may be zero or left blank" (spec) — which is the normal
 * case for most orders, not an error.
 */
export async function recordServiceChargeEntryInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  actor: ServiceChargeActor,
): Promise<ServiceChargeEntrySummary | null> {
  const order = await trx.selectFrom('order').select(['service_charge_minor', 'waiter_id', 'shift_id']).where('id', '=', orderId).executeTakeFirstOrThrow();
  if (order.service_charge_minor <= 0) return null;
  if (order.waiter_id === null) {
    // ordering's billOrder already refuses a non-zero service charge on
    // a waiterless order — this is a defensive re-check, not the
    // primary guard, and should be unreachable in practice.
    throw new Error(`order ${orderId} has a non-zero service charge but no waiter to attribute it to`);
  }

  const now = new Date().toISOString();
  const row = await trx
    .insertInto('service_charge_entry')
    .values({
      order_id: orderId,
      waiter_id: order.waiter_id,
      amount_minor: order.service_charge_minor,
      shift_id: order.shift_id,
      created_by: actor.actorId,
      created_at: now,
      reverses_entry_id: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(trx, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'service_charge.record',
    entity: 'order',
    entityId: orderId,
    after: toSummary(row),
  });

  return toSummary(row);
}

export async function recordServiceChargeEntry(
  db: Kysely<Database>,
  orderId: number,
  actor: ServiceChargeActor,
): Promise<ServiceChargeEntrySummary | null> {
  return db.transaction().execute((trx) => recordServiceChargeEntryInTransaction(trx, orderId, actor));
}

/**
 * Reverses every not-yet-reversed service charge entry for an order — a
 * void or a full-order refund (spec: "voids and refunds reverse the
 * corresponding entry with a reverses_entry_id row"). A partial, single-
 * line refund does not call this: service charge is order-level, not
 * per-line, and doesn't change because one item was refunded.
 */
export async function reverseServiceChargeEntriesInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  actor: ServiceChargeActor,
): Promise<ServiceChargeEntrySummary[]> {
  const originals = await trx
    .selectFrom('service_charge_entry')
    .selectAll()
    .where('order_id', '=', orderId)
    .where('reverses_entry_id', 'is', null)
    .execute();

  const now = new Date().toISOString();
  const reversed: ServiceChargeEntrySummary[] = [];
  for (const original of originals) {
    const already = await trx.selectFrom('service_charge_entry').select('id').where('reverses_entry_id', '=', original.id).executeTakeFirst();
    if (already) continue; // safe to call more than once, same convention as partners' reversal

    const row = await trx
      .insertInto('service_charge_entry')
      .values({
        order_id: original.order_id,
        waiter_id: original.waiter_id,
        amount_minor: paisa(-original.amount_minor),
        // Carries the ORIGINAL entry's shift, not whatever shift happens
        // to be open when the reversal is recorded — the reversal
        // belongs to the shift whose payout it corrects, so a refund
        // processed on a later shift doesn't wrongly show up as a debit
        // against that later shift's own payout sheet.
        shift_id: original.shift_id,
        created_by: actor.actorId,
        created_at: now,
        reverses_entry_id: original.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    reversed.push(toSummary(row));
  }

  if (reversed.length > 0) {
    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'service_charge.reverse',
      entity: 'order',
      entityId: orderId,
      after: { count: reversed.length, total: sum(reversed.map((r) => r.amountMinor)) },
    });
  }

  return reversed;
}

export async function reverseServiceChargeEntries(
  db: Kysely<Database>,
  orderId: number,
  actor: ServiceChargeActor,
): Promise<ServiceChargeEntrySummary[]> {
  return db.transaction().execute((trx) => reverseServiceChargeEntriesInTransaction(trx, orderId, actor));
}

// ---------------------------------------------------------------------
// Payout reporting
// ---------------------------------------------------------------------

export interface WaiterPayoutLine {
  readonly waiterId: number;
  readonly waiterName: string;
  readonly totalMinor: Paisa;
}

export interface PayoutRangeOptions {
  readonly fromInclusive?: string | undefined;
  readonly toExclusive?: string | undefined;
  /** Scopes to one shift's entries via service_charge_entry.shift_id —
   * the spec's "payout sheet listing amount owed per waiter for that
   * shift". Combine with a date range, or use alone; either way,
   * reversed entries net out the same way. */
  readonly shiftId?: number | undefined;
}

/**
 * Amount currently owed to each waiter — reversed entries net out
 * automatically since they're just negative rows summed alongside the
 * originals. Unscoped (the whole system's history) unless a shiftId or
 * date range is given; the reporting milestone reuses this same shape
 * for its own "per date range" service charge report.
 */
export async function waiterPayoutTotals(db: Kysely<Database>, opts: PayoutRangeOptions = {}): Promise<WaiterPayoutLine[]> {
  let query = db
    .selectFrom('service_charge_entry')
    .innerJoin('user', 'user.id', 'service_charge_entry.waiter_id')
    .select(['service_charge_entry.waiter_id as waiterId', 'user.name as waiterName', 'service_charge_entry.amount_minor as amountMinor']);
  if (opts.fromInclusive) query = query.where('service_charge_entry.created_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) query = query.where('service_charge_entry.created_at', '<', opts.toExclusive);
  if (opts.shiftId !== undefined) query = query.where('service_charge_entry.shift_id', '=', opts.shiftId);

  const rows = await query.execute();
  const byWaiter = new Map<number, { waiterName: string; amounts: Paisa[] }>();
  for (const row of rows) {
    const entry = byWaiter.get(row.waiterId) ?? { waiterName: row.waiterName, amounts: [] };
    entry.amounts.push(row.amountMinor);
    byWaiter.set(row.waiterId, entry);
  }

  return [...byWaiter.entries()]
    .map(([waiterId, { waiterName, amounts }]) => ({ waiterId, waiterName, totalMinor: sum(amounts) }))
    .filter((line) => line.totalMinor !== 0) // fully-reversed waiters (net zero) have nothing owed
    .sort((a, b) => a.waiterName.localeCompare(b.waiterName));
}
