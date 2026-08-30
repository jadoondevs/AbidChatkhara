-- shifts/: shift open/close, cash reconciliation. At most one shift is
-- ever open at a time (closed_at IS NULL) — enforced in shifts/service.ts,
-- since SQLite has no direct "at most one row where X" constraint.
--
-- counted/expected/variance are all NULL until close: they are only
-- knowable then, the same reasoning invoice_no stays NULL until an
-- order actually closes.
CREATE TABLE shift (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at            TEXT NOT NULL,
  closed_at            TEXT,
  opened_by            INTEGER NOT NULL REFERENCES user (id),
  closed_by            INTEGER REFERENCES user (id),
  opening_cash_minor   INTEGER NOT NULL,
  counted_cash_minor   INTEGER,
  expected_cash_minor  INTEGER,
  variance_minor       INTEGER
);

CREATE INDEX idx_shift_closed_at ON shift (closed_at);

-- The deferred columns migrations 0004 and 0007 promised, now that
-- shift rows exist to reference. Nullable at the database layer only
-- because SQLite's ALTER TABLE can't add a NOT NULL column without a
-- default that would lie about which shift a row belongs to — the real
-- invariant (every order gets a real shift_id; an order cannot be
-- opened while no shift is open) is enforced in application code:
-- ordering's createOrder refuses to open an order with no shift open,
-- and gratuity's recordServiceChargeEntryInTransaction copies the
-- order's own shift_id onto the entry it writes.
ALTER TABLE "order" ADD COLUMN shift_id INTEGER REFERENCES shift (id);
ALTER TABLE service_charge_entry ADD COLUMN shift_id INTEGER REFERENCES shift (id);
