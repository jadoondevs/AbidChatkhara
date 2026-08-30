import type { Kysely } from 'kysely';
import type { Database } from '../platform/db/types.js';

export interface AuditEntryInput {
  readonly actorId: number | null;
  readonly terminalId: string | null;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string | number;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * Write one append-only audit_log row. Every module's mutating service
 * function calls this — it is identity/'s one piece of shared surface
 * every other module depends on (see ARCHITECTURE.md).
 */
export async function recordAudit(db: Kysely<Database>, entry: AuditEntryInput): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      actor_id: entry.actorId,
      terminal_id: entry.terminalId,
      action: entry.action,
      entity: entry.entity,
      entity_id: String(entry.entityId),
      before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
      after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
      created_at: new Date().toISOString(),
    })
    .execute();
}
