import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { claimDue, markFailed, markSucceeded } from './queue.js';

export type SyncTaskHandler = (payload: unknown) => Promise<void>;

/**
 * Where future modules register what a task type actually does. No task
 * types are registered at launch (there is nothing internet-dependent to
 * do yet), so `processPending` below claims nothing to run and is a
 * working no-op — the seam future sync tasks (tax e-invoicing, etc.) plug
 * into without a schema or call-site change.
 */
export class SyncTaskRegistry {
  private readonly handlers = new Map<string, SyncTaskHandler>();

  register(taskType: string, handler: SyncTaskHandler): void {
    if (this.handlers.has(taskType)) {
      throw new Error(`sync-queue: a handler is already registered for task type "${taskType}"`);
    }
    this.handlers.set(taskType, handler);
  }

  get(taskType: string): SyncTaskHandler | undefined {
    return this.handlers.get(taskType);
  }
}

export interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  skippedNoHandler: number;
}

/**
 * Claim due tasks and run each through its registered handler, retrying
 * with backoff on failure (see markFailed). A due task whose type has no
 * registered handler is left pending, untouched, rather than erroring —
 * that is the expected state of every task type today.
 */
export async function processPending(
  db: Kysely<Database>,
  registry: SyncTaskRegistry,
  limit = 20,
): Promise<ProcessResult> {
  const due = await claimDue(db, limit);
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skippedNoHandler: 0 };

  for (const entry of due) {
    const handler = registry.get(entry.taskType);
    if (!handler) {
      result.skippedNoHandler += 1;
      continue;
    }
    result.processed += 1;
    try {
      await handler(entry.payload);
      await markSucceeded(db, entry.id);
      result.succeeded += 1;
    } catch (err) {
      await markFailed(db, entry.id, entry.attempts, err instanceof Error ? err.message : String(err));
      result.failed += 1;
    }
  }

  return result;
}
