import type { Kysely } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import type { Database } from '../platform/db/types.js';

/**
 * Delivery riders — a small first-class list, the delivery equivalent of
 * the waiter roster. A rider is named, can be retired (never deleted, so
 * a past delivery keeps pointing at a real rider), and is who a delivery
 * charge is owed to. Mirrors partners' create/list/rename/retire shape.
 */
export interface RiderSummary {
  readonly id: number;
  readonly name: string;
  readonly active: boolean;
  readonly createdAt: string;
}

interface RiderRow {
  id: number;
  name: string;
  active: number;
  created_at: string;
}

function toRiderSummary(row: RiderRow): RiderSummary {
  return { id: row.id, name: row.name, active: row.active === 1, createdAt: row.created_at };
}

export async function createRider(db: Kysely<Database>, name: string, actor: ActorContext): Promise<RiderSummary> {
  if (!name.trim()) throw new Error('a rider needs a name');
  const now = new Date().toISOString();
  const row = await db
    .insertInto('rider')
    .values({ name: name.trim(), active: 1, created_at: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toRiderSummary(row);
  await recordAudit(db, { actorId: actor.actorId, terminalId: actor.terminalId, action: 'rider.create', entity: 'rider', entityId: row.id, after: summary });
  return summary;
}

export async function listRiders(db: Kysely<Database>, opts: { includeInactive?: boolean | undefined } = {}): Promise<RiderSummary[]> {
  let query = db.selectFrom('rider').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('name', 'asc').execute();
  return rows.map(toRiderSummary);
}

export async function getRider(db: Kysely<Database>, id: number): Promise<RiderSummary | null> {
  const row = await db.selectFrom('rider').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toRiderSummary(row) : null;
}

/** Rename a rider. Safe any time: delivery orders and charge entries join
 * riders by id, so correcting a spelling rewrites no history. */
export async function renameRider(db: Kysely<Database>, id: number, name: string, actor: ActorContext): Promise<RiderSummary> {
  if (!name.trim()) throw new Error('a rider needs a name');
  const before = await db.selectFrom('rider').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`rider ${id} not found`);
  const after = await db.updateTable('rider').set({ name: name.trim() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'rider.rename',
    entity: 'rider',
    entityId: id,
    before: toRiderSummary(before),
    after: toRiderSummary(after),
  });
  return toRiderSummary(after);
}

export async function setRiderActive(db: Kysely<Database>, id: number, active: boolean, actor: ActorContext): Promise<RiderSummary> {
  const before = await db.selectFrom('rider').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`rider ${id} not found`);
  const after = await db.updateTable('rider').set({ active: active ? 1 : 0 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: active ? 'rider.reactivate' : 'rider.deactivate',
    entity: 'rider',
    entityId: id,
    before: toRiderSummary(before),
    after: toRiderSummary(after),
  });
  return toRiderSummary(after);
}
