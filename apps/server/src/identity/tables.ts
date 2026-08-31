import type { Generated } from 'kysely';
import type { Role } from './roles.js';

export interface UserTable {
  id: Generated<number>;
  name: string;
  /** Unique login name. Nullable at the database layer only because
   * SQLite's ALTER TABLE cannot add a NOT NULL column without a
   * default; migration 0011 backfills every existing row and
   * identity/service.ts never writes a null. */
  username: string | null;
  /** Salted scrypt hash of the sign-in secret — a PIN or a password;
   * the column keeps its original name (see migration 0011). */
  pin_hash: string;
  role: Role;
  /** SQLite has no boolean type; 0/1. */
  active: number;
  created_at: string;
}

export interface SessionTable {
  id: Generated<number>;
  token_hash: string;
  user_id: number;
  terminal_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  actor_id: number | null;
  terminal_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export interface IdentityTables {
  user: UserTable;
  session: SessionTable;
  audit_log: AuditLogTable;
}
