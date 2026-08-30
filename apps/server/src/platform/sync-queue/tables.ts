import type { Generated } from 'kysely';

export type SyncTaskStatus = 'pending' | 'succeeded' | 'failed' | 'dead';

export interface SyncQueueEntryTable {
  id: Generated<number>;
  task_type: string;
  payload_json: string;
  status: SyncTaskStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
}

export interface SyncQueueTables {
  sync_queue_entry: SyncQueueEntryTable;
}
