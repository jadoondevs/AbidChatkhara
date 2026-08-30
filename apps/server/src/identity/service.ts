import type { Kysely } from 'kysely';
import type { Database } from '../platform/db/types.js';
import { recordAudit } from './audit.js';
import { hashPin } from './pin.js';
import type { Role } from './roles.js';

export interface UserSummary {
  readonly id: number;
  readonly name: string;
  readonly role: Role;
  readonly active: boolean;
}

interface UserRow {
  id: number;
  name: string;
  role: Role;
  active: number;
}

function toSummary(row: UserRow): UserSummary {
  return { id: row.id, name: row.name, role: row.role, active: row.active === 1 };
}

export interface ActorContext {
  /** null for a system action with no human actor yet — e.g. the seed
   * script creating the very first admin account. */
  readonly actorId: number | null;
  readonly terminalId: string;
}

export interface CreateUserInput {
  readonly name: string;
  readonly pin: string;
  readonly role: Role;
}

export async function createUser(
  db: Kysely<Database>,
  input: CreateUserInput,
  actor: ActorContext,
): Promise<UserSummary> {
  const row = await db
    .insertInto('user')
    .values({
      name: input.name,
      pin_hash: hashPin(input.pin),
      role: input.role,
      active: 1,
      created_at: new Date().toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const summary = toSummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'user.create',
    entity: 'user',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listUsers(
  db: Kysely<Database>,
  opts: { includeInactive?: boolean | undefined } = {},
): Promise<UserSummary[]> {
  let query = db.selectFrom('user').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('name', 'asc').execute();
  return rows.map(toSummary);
}

export async function getUser(db: Kysely<Database>, userId: number): Promise<UserSummary | null> {
  const row = await db.selectFrom('user').selectAll().where('id', '=', userId).executeTakeFirst();
  return row ? toSummary(row) : null;
}

async function requireUserRow(db: Kysely<Database>, userId: number): Promise<UserRow> {
  const row = await db.selectFrom('user').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!row) throw new Error(`user ${userId} not found`);
  return row;
}

export async function setUserActive(
  db: Kysely<Database>,
  userId: number,
  active: boolean,
  actor: ActorContext,
): Promise<UserSummary> {
  const before = await requireUserRow(db, userId);
  const after = await db
    .updateTable('user')
    .set({ active: active ? 1 : 0 })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: active ? 'user.activate' : 'user.deactivate',
    entity: 'user',
    entityId: userId,
    before: toSummary(before),
    after: toSummary(after),
  });
  return toSummary(after);
}

export async function changeUserRole(
  db: Kysely<Database>,
  userId: number,
  role: Role,
  actor: ActorContext,
): Promise<UserSummary> {
  const before = await requireUserRow(db, userId);
  const after = await db
    .updateTable('user')
    .set({ role })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'user.change_role',
    entity: 'user',
    entityId: userId,
    before: toSummary(before),
    after: toSummary(after),
  });
  return toSummary(after);
}
