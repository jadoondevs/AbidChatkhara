import type { Kysely } from 'kysely';
import type { Database } from '../platform/db/types.js';
import { recordAudit } from './audit.js';
import { hashSecret, normaliseUsername, validateUsername } from './credentials.js';
import type { Role } from './roles.js';

export interface UserSummary {
  readonly id: number;
  readonly name: string;
  readonly username: string;
  readonly role: Role;
  readonly active: boolean;
}

interface UserRow {
  id: number;
  name: string;
  username: string | null;
  role: Role;
  active: number;
}

/** Never carries `pin_hash`: a UserSummary is what leaves this module,
 * and a credential hash has no business in an API response, an audit
 * log entry, or a log line. */
function toSummary(row: UserRow): UserSummary {
  return { id: row.id, name: row.name, username: row.username ?? '', role: row.role, active: row.active === 1 };
}

/** Thrown when a username is already taken. Its own type so routes can
 * answer 409 rather than a generic 500 — the cashier-facing fix
 * ("choose another name") is entirely different from a server fault. */
export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username "${username}" is already taken`);
    this.name = 'UsernameTakenError';
  }
}

async function assertUsernameFree(db: Kysely<Database>, username: string, exceptUserId?: number): Promise<void> {
  let query = db.selectFrom('user').select('id').where('username', '=', username);
  if (exceptUserId !== undefined) query = query.where('id', '<>', exceptUserId);
  if (await query.executeTakeFirst()) throw new UsernameTakenError(username);
}

export interface ActorContext {
  /** null for a system action with no human actor yet — e.g. the seed
   * script creating the very first admin account. */
  readonly actorId: number | null;
  readonly terminalId: string;
}

export interface CreateUserInput {
  readonly name: string;
  readonly username: string;
  /** The sign-in secret: a PIN or a password (see credentials.ts). */
  readonly password: string;
  readonly role: Role;
}

export async function createUser(
  db: Kysely<Database>,
  input: CreateUserInput,
  actor: ActorContext,
): Promise<UserSummary> {
  const username = validateUsername(input.username);
  await assertUsernameFree(db, username);

  const row = await db
    .insertInto('user')
    .values({
      name: input.name,
      username,
      pin_hash: hashSecret(input.password),
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

export interface RosterEntry {
  readonly id: number;
  readonly name: string;
  readonly role: Role;
}

/**
 * Who is on today, by name — what the floor board needs to show
 * "Faisal" beside a table, and what the new-order dialog needs to fill
 * its waiter picker.
 *
 * Separate from `listUsers` because the two answer different questions.
 * `listUsers` is the management view: it carries usernames and active
 * flags, is how an admin administers credentials, and stays manager+.
 * This is a roster of first-class names, readable by anyone already
 * signed in — a waiter who cannot see their colleagues' names cannot
 * take a dine-in order at all, which is what the manager-only list was
 * quietly causing.
 *
 * Inactive users are excluded: they cannot be assigned new work.
 */
export async function listRoster(db: Kysely<Database>): Promise<RosterEntry[]> {
  const rows = await db.selectFrom('user').select(['id', 'name', 'role']).where('active', '=', 1).orderBy('name', 'asc').execute();
  return rows.map((row) => ({ id: row.id, name: row.name, role: row.role }));
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

export interface UpdateUserInput {
  readonly name?: string | undefined;
  readonly username?: string | undefined;
  readonly role?: Role | undefined;
  readonly active?: boolean | undefined;
}

/**
 * Change a user's profile — everything except their password, which
 * goes through `setUserPassword` so that a credential change is always
 * its own audit entry rather than being buried inside a rename.
 */
export async function updateUser(
  db: Kysely<Database>,
  userId: number,
  input: UpdateUserInput,
  actor: ActorContext,
): Promise<UserSummary> {
  const before = await requireUserRow(db, userId);

  const username = input.username === undefined ? undefined : validateUsername(input.username);
  if (username !== undefined && username !== before.username) {
    await assertUsernameFree(db, username, userId);
  }

  const after = await db
    .updateTable('user')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
    })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'user.update',
    entity: 'user',
    entityId: userId,
    before: toSummary(before),
    after: toSummary(after),
  });
  return toSummary(after);
}

/**
 * Set (or reset) a user's sign-in secret.
 *
 * The audit entry records THAT the credential changed and who changed
 * it — never the old or new value, not even hashed. A hash in the audit
 * log would be an offline-crackable copy of every password the
 * restaurant has ever used, sitting in the one table nothing is ever
 * deleted from.
 */
export async function setUserPassword(
  db: Kysely<Database>,
  userId: number,
  password: string,
  actor: ActorContext,
): Promise<UserSummary> {
  const before = await requireUserRow(db, userId);
  const after = await db
    .updateTable('user')
    .set({ pin_hash: hashSecret(password) })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'user.set_password',
    entity: 'user',
    entityId: userId,
    after: { userId, username: before.username, changedBy: actor.actorId },
  });
  return toSummary(after);
}

export async function findUserByUsername(db: Kysely<Database>, username: string): Promise<UserSummary | null> {
  const row = await db
    .selectFrom('user')
    .selectAll()
    .where('username', '=', normaliseUsername(username))
    .executeTakeFirst();
  return row ? toSummary(row) : null;
}
