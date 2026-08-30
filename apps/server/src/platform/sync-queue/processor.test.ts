import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/test-helpers.js';
import { enqueue } from './queue.js';
import { processPending, SyncTaskRegistry } from './processor.js';

describe('processPending', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  it('leaves a due task with no registered handler pending, untouched', async () => {
    ctx = createTestDb();
    await enqueue(ctx.db, { taskType: 'unregistered-task', payload: {} });

    const result = await processPending(ctx.db, new SyncTaskRegistry());

    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0, skippedNoHandler: 1 });
    const row = await ctx.db.selectFrom('sync_queue_entry').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
  });

  it('runs a registered handler and marks the task succeeded', async () => {
    ctx = createTestDb();
    await enqueue(ctx.db, { taskType: 'greet', payload: { name: 'partner' } });

    const seen: unknown[] = [];
    const registry = new SyncTaskRegistry();
    registry.register('greet', async (payload) => {
      seen.push(payload);
    });

    const result = await processPending(ctx.db, registry);

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, skippedNoHandler: 0 });
    expect(seen).toEqual([{ name: 'partner' }]);
    const row = await ctx.db.selectFrom('sync_queue_entry').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('succeeded');
  });

  it('records a handler failure and reschedules the task rather than losing it', async () => {
    ctx = createTestDb();
    await enqueue(ctx.db, { taskType: 'flaky', payload: {} });

    const registry = new SyncTaskRegistry();
    registry.register('flaky', async () => {
      throw new Error('network unreachable');
    });

    const result = await processPending(ctx.db, registry);

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, skippedNoHandler: 0 });
    const row = await ctx.db.selectFrom('sync_queue_entry').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('pending'); // rescheduled, not lost
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('network unreachable');
  });

  it('rejects registering two handlers for the same task type', () => {
    const registry = new SyncTaskRegistry();
    registry.register('a', async () => {});
    expect(() => registry.register('a', async () => {})).toThrow(/already registered/);
  });
});
