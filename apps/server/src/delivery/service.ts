import { paisa, sum, type Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { Database } from '../platform/db/types.js';

/**
 * Delivery charges owed to riders — the exact twin of gratuity's service
 * charge owed to waiters. A delivery charge is money HELD for the rider,
 * never revenue (docs/decisions/008): collected as part of a delivery
 * bill's total, attributed straight to `order.rider_id`, and paid out to
 * that rider. Everything here mirrors gratuity/service.ts, down to how a
 * refund reverses an entry so a payout nets out.
 */
export interface DeliveryChargeActor {
  readonly actorId: number;
  readonly terminalId: string;
}

export interface DeliveryChargeEntrySummary {
  readonly id: number;
  readonly orderId: number;
  readonly riderId: number;
  readonly amountMinor: Paisa;
  readonly shiftId: number | null;
  readonly createdBy: number;
  readonly createdAt: string;
  readonly reversesEntryId: number | null;
}

interface DeliveryChargeEntryRow {
  id: number;
  order_id: number;
  rider_id: number;
  amount_minor: Paisa;
  shift_id: number | null;
  created_by: number;
  created_at: string;
  reverses_entry_id: number | null;
}

function toSummary(row: DeliveryChargeEntryRow): DeliveryChargeEntrySummary {
  return {
    id: row.id,
    orderId: row.order_id,
    riderId: row.rider_id,
    amountMinor: row.amount_minor,
    shiftId: row.shift_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    reversesEntryId: row.reverses_entry_id,
  };
}

/**
 * Records the order's delivery charge as money held for its rider, once
 * the order is fully paid. A no-op (returns null) when the charge is
 * zero — the normal case for a dine-in or a delivery with no fee.
 */
export async function recordDeliveryChargeEntryInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  actor: DeliveryChargeActor,
): Promise<DeliveryChargeEntrySummary | null> {
  const order = await trx.selectFrom('order').select(['delivery_charge_minor', 'rider_id', 'shift_id']).where('id', '=', orderId).executeTakeFirstOrThrow();
  if (order.delivery_charge_minor <= 0) return null;
  if (order.rider_id === null) {
    // ordering's billOrder already refuses a non-zero delivery charge on
    // a riderless order — this is a defensive re-check, unreachable in
    // practice.
    throw new Error(`order ${orderId} has a non-zero delivery charge but no rider to attribute it to`);
  }

  const now = new Date().toISOString();
  const row = await trx
    .insertInto('delivery_charge_entry')
    .values({
      order_id: orderId,
      rider_id: order.rider_id,
      amount_minor: order.delivery_charge_minor,
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
    action: 'delivery_charge.record',
    entity: 'order',
    entityId: orderId,
    after: toSummary(row),
  });

  return toSummary(row);
}

/** Reverses every not-yet-reversed delivery charge entry for an order — a
 * full-order refund. Carries the ORIGINAL entry's shift, so a refund on a
 * later shift corrects the shift whose payout it belongs to. */
export async function reverseDeliveryChargeEntriesInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  actor: DeliveryChargeActor,
): Promise<DeliveryChargeEntrySummary[]> {
  const originals = await trx
    .selectFrom('delivery_charge_entry')
    .selectAll()
    .where('order_id', '=', orderId)
    .where('reverses_entry_id', 'is', null)
    .execute();

  const now = new Date().toISOString();
  const reversed: DeliveryChargeEntrySummary[] = [];
  for (const original of originals) {
    const already = await trx.selectFrom('delivery_charge_entry').select('id').where('reverses_entry_id', '=', original.id).executeTakeFirst();
    if (already) continue; // safe to call more than once

    const row = await trx
      .insertInto('delivery_charge_entry')
      .values({
        order_id: original.order_id,
        rider_id: original.rider_id,
        amount_minor: paisa(-original.amount_minor),
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
      action: 'delivery_charge.reverse',
      entity: 'order',
      entityId: orderId,
      after: { count: reversed.length, total: sum(reversed.map((r) => r.amountMinor)) },
    });
  }

  return reversed;
}

// ---------------------------------------------------------------------
// Payout reporting
// ---------------------------------------------------------------------

export interface RiderPayoutLine {
  readonly riderId: number;
  readonly riderName: string;
  readonly totalMinor: Paisa;
}

export interface RiderPayoutRangeOptions {
  readonly fromInclusive?: string | undefined;
  readonly toExclusive?: string | undefined;
  /** Scopes to one shift's entries via delivery_charge_entry.shift_id —
   * the rider payout sheet for that shift. Reversed entries net out. */
  readonly shiftId?: number | undefined;
}

/** Amount currently owed to each rider — reversed entries net out since
 * they are negative rows summed alongside the originals. */
export async function riderPayoutTotals(db: Kysely<Database>, opts: RiderPayoutRangeOptions = {}): Promise<RiderPayoutLine[]> {
  let query = db
    .selectFrom('delivery_charge_entry')
    .innerJoin('rider', 'rider.id', 'delivery_charge_entry.rider_id')
    .select(['delivery_charge_entry.rider_id as riderId', 'rider.name as riderName', 'delivery_charge_entry.amount_minor as amountMinor']);
  if (opts.fromInclusive) query = query.where('delivery_charge_entry.created_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) query = query.where('delivery_charge_entry.created_at', '<', opts.toExclusive);
  if (opts.shiftId !== undefined) query = query.where('delivery_charge_entry.shift_id', '=', opts.shiftId);

  const rows = await query.execute();
  const byRider = new Map<number, { riderName: string; amounts: Paisa[] }>();
  for (const row of rows) {
    const entry = byRider.get(row.riderId) ?? { riderName: row.riderName, amounts: [] };
    entry.amounts.push(row.amountMinor);
    byRider.set(row.riderId, entry);
  }

  return [...byRider.entries()]
    .map(([riderId, { riderName, amounts }]) => ({ riderId, riderName, totalMinor: sum(amounts) }))
    .filter((line) => line.totalMinor !== 0)
    .sort((a, b) => a.riderName.localeCompare(b.riderName));
}
