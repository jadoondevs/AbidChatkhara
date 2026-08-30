-- platform/sync-queue: the durable retry queue every internet-dependent
-- task goes through (principle: "local-first... anything needing the
-- internet goes through a durable retry queue"). No task types are
-- registered yet at launch — this milestone builds the mechanism only, so
-- that tax e-invoicing sync and similar future integrations are a handler
-- registration, not a schema change.

CREATE TABLE sync_queue_entry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type       TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL
);

CREATE INDEX idx_sync_queue_status_next_attempt ON sync_queue_entry (status, next_attempt_at);
