import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../platform/db/types.js';
import { normaliseUsername, verifySecret } from './credentials.js';
import type { Role } from './roles.js';

/** A working day plus margin. Staff log in again after this; the server
 * does not keep a persistent "current user" beyond the session table. */
const SESSION_LIFETIME_MS = 18 * 60 * 60 * 1000;

/** Verified against when no user matched, so a miss costs the same
 * scrypt work as a hit — see the note on `login`. Its plaintext is
 * irrelevant and deliberately unguessable. */
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export interface Session {
  readonly userId: number;
  readonly name: string;
  readonly username: string;
  readonly role: Role;
  readonly terminalId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly terminalId: string;
}

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly session: Session }
  | { readonly ok: false; readonly reason: 'invalid_credentials' | 'inactive' };

/**
 * Sign in with a username and password typed on a keyboard.
 *
 * A missing user and a wrong password are the same answer
 * ('invalid_credentials') on purpose: telling them apart would let
 * anyone who can reach the till enumerate who works here. The password
 * is verified even when no user matched, against a throwaway hash, so
 * the two cases also take the same time rather than the miss returning
 * measurably faster.
 */
export async function login(db: Kysely<Database>, input: LoginInput): Promise<LoginResult> {
  const username = normaliseUsername(input.username);
  const user = await db.selectFrom('user').selectAll().where('username', '=', username).executeTakeFirst();
  const passwordOk = verifySecret(input.password, user?.pin_hash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  if (user.active !== 1) {
    return { ok: false, reason: 'inactive' };
  }

  const token = randomBytes(32).toString('hex');
  const now = new Date();
  await db
    .insertInto('session')
    .values({
      token_hash: hashToken(token),
      user_id: user.id,
      terminal_id: input.terminalId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
      revoked_at: null,
    })
    .execute();

  return {
    ok: true,
    token,
    session: {
      userId: user.id,
      name: user.name,
      username: user.username ?? username,
      role: user.role,
      terminalId: input.terminalId,
    },
  };
}

/** Resolve a bearer token to the session it belongs to, or null if the
 * token is unknown, revoked, expired, or its user has since been
 * deactivated. */
export async function resolveSession(db: Kysely<Database>, token: string): Promise<Session | null> {
  const tokenHash = hashToken(token);
  const session = await db.selectFrom('session').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst();
  if (!session) return null;
  if (session.revoked_at !== null) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const user = await db.selectFrom('user').selectAll().where('id', '=', session.user_id).executeTakeFirst();
  if (!user || user.active !== 1) return null;

  return {
    userId: user.id,
    name: user.name,
    username: user.username ?? '',
    role: user.role,
    terminalId: session.terminal_id,
  };
}

export async function logout(db: Kysely<Database>, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db
    .updateTable('session')
    .set({ revoked_at: new Date().toISOString() })
    .where('token_hash', '=', tokenHash)
    .where('revoked_at', 'is', null)
    .execute();
}
