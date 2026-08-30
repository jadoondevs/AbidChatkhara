import type { Generated } from 'kysely';
import type { Role } from './roles.js';

export interface UserTable {
  id: Generated<number>;
  name: string;
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
