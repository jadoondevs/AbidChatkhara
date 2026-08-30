import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface EnqueueInput {
  readonly taskType: string;
  readonly payload: unknown;
}

/** Enqueue a task, due immediately. Returns the new row's id. */
export async function enqueue(db: Kysely<Database>, input: EnqueueInput): Promise<number> {
  const now = new Date().toISOString();
  const row = await db
    .insertInto('sync_queue_entry')
    .values({
      task_type: input.taskType,
      payload_json: JSON.stringify(input.payload),
      status: 'pending',
      attempts: 0,
      last_error: null,
      created_at: now,
      next_attempt_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface DueEntry {
  readonly id: number;
  readonly taskType: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** The tasks that are pending and due to run, oldest-due first. */
export async function claimDue(db: Kysely<Database>, limit = 20, now: Date = new Date()): Promise<DueEntry[]> {
  const rows = await db
    .selectFrom('sync_queue_entry')
    .selectAll()
    .where('status', '=', 'pending')
    .where('next_attempt_at', '<=', now.toISOString())
    .orderBy('next_attempt_at', 'asc')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    taskType: row.task_type,
    payload: JSON.parse(row.payload_json) as unknown,
    attempts: row.attempts,
  }));
}

export async function markSucceeded(db: Kysely<Database>, id: number): Promise<void> {
  await db.updateTable('sync_queue_entry').set({ status: 'succeeded' }).where('id', '=', id).execute();
}

export interface BackoffPolicy {
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseDelaySeconds: 30,
  maxDelaySeconds: 60 * 60,
  maxAttempts: 10,
};

/** Exponential backoff, capped, seeded by the attempt number (1-based). */
export function backoffDelaySeconds(attempts: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const delay = policy.baseDelaySeconds * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, policy.maxDelaySeconds);
}

/**
 * Record a failed attempt. Once `attempts` reaches `policy.maxAttempts`
 * the task is marked `dead` instead of being rescheduled — it stops
 * consuming retry cycles and waits for a human to look at `last_error`,
 * rather than retrying an internet-dependent task forever.
 */
export async function markFailed(
  db: Kysely<Database>,
  id: number,
  currentAttempts: number,
  error: string,
  now: Date = new Date(),
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): Promise<void> {
  const attempts = currentAttempts + 1;
  if (attempts >= policy.maxAttempts) {
    await db
      .updateTable('sync_queue_entry')
      .set({ status: 'dead', attempts, last_error: error })
      .where('id', '=', id)
      .execute();
    return;
  }
  const nextAttemptAt = new Date(now.getTime() + backoffDelaySeconds(attempts, policy) * 1000).toISOString();
  await db
    .updateTable('sync_queue_entry')
    .set({ status: 'pending', attempts, last_error: error, next_attempt_at: nextAttemptAt })
    .where('id', '=', id)
    .execute();
}
