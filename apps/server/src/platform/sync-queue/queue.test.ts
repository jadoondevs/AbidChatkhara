import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/test-helpers.js';
import { backoffDelaySeconds, claimDue, enqueue, markFailed, markSucceeded } from './queue.js';

describe('sync-queue', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  it('enqueues a task as immediately due', async () => {
    ctx = createTestDb();
    await enqueue(ctx.db, { taskType: 'noop', payload: { foo: 'bar' } });
    const due = await claimDue(ctx.db);
    expect(due).toHaveLength(1);
    expect(due[0]?.taskType).toBe('noop');
    expect(due[0]?.payload).toEqual({ foo: 'bar' });
    expect(due[0]?.attempts).toBe(0);
  });

  it('does not claim a task scheduled in the future', async () => {
    ctx = createTestDb();
    const id = await enqueue(ctx.db, { taskType: 'noop', payload: {} });
    await markFailed(ctx.db, id, 0, 'transient error', new Date());

    const due = await claimDue(ctx.db);
    expect(due).toHaveLength(0);
  });

  it('markSucceeded removes a task from the due set', async () => {
    ctx = createTestDb();
    const id = await enqueue(ctx.db, { taskType: 'noop', payload: {} });
    await markSucceeded(ctx.db, id);

    const due = await claimDue(ctx.db);
    expect(due).toHaveLength(0);
  });

  it('markFailed reschedules with backoff until maxAttempts, then marks dead', async () => {
    ctx = createTestDb();
    const id = await enqueue(ctx.db, { taskType: 'noop', payload: {} });
    const policy = { baseDelaySeconds: 1, maxDelaySeconds: 100, maxAttempts: 2 };
    const now = new Date('2026-01-01T00:00:00Z');

    await markFailed(ctx.db, id, 0, 'err 1', now, policy);
    let row = await ctx.db.selectFrom('sync_queue_entry').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);

    await markFailed(ctx.db, id, 1, 'err 2', now, policy);
    row = await ctx.db.selectFrom('sync_queue_entry').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe('err 2');
  });

  it('backoffDelaySeconds grows exponentially and is capped', () => {
    const policy = { baseDelaySeconds: 10, maxDelaySeconds: 100, maxAttempts: 99 };
    expect(backoffDelaySeconds(1, policy)).toBe(10);
    expect(backoffDelaySeconds(2, policy)).toBe(20);
    expect(backoffDelaySeconds(3, policy)).toBe(40);
    expect(backoffDelaySeconds(10, policy)).toBe(100); // capped
  });
});
