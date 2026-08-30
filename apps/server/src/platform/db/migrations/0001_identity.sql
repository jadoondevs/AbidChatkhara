-- identity/: users, PIN login sessions, and the audit log every other
-- module writes to. Every other module's tables reference user(id) for
-- attribution, so this is the first migration.

CREATE TABLE user (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('server', 'cashier', 'manager', 'admin')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

-- A PIN login session, bound to the terminal it was issued from. Only a
-- hash of the bearer token is stored, so a database dump or backup never
-- contains a usable credential.
CREATE TABLE session (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES user (id),
  terminal_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE INDEX idx_session_user ON session (user_id);

-- Append-only. Every mutation anywhere in the system writes one row here:
-- who (actor_id), from where (terminal_id), what (action/entity/entity_id),
-- and, where useful for a diff, the before/after state as JSON.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES user (id),
  terminal_id TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_audit_log_entity ON audit_log (entity, entity_id);
CREATE INDEX idx_audit_log_actor ON audit_log (actor_id);
