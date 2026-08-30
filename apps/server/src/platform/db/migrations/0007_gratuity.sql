-- gratuity/: service charge as a liability held for the waiter, never
-- revenue — see docs/decisions/008. Append-only, like every other
-- financial table; a void or refund writes a new reversing row rather
-- than editing this one.
--
-- shift_id is deliberately absent, same reasoning as order's own
-- deferred columns (migration 0004): the shift table doesn't exist
-- until the shifts milestone, which ALTER TABLEs this one to add it.
CREATE TABLE service_charge_entry (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES "order" (id),
  waiter_id         INTEGER NOT NULL REFERENCES user (id),
  amount_minor      INTEGER NOT NULL,
  created_by        INTEGER NOT NULL REFERENCES user (id),
  created_at        TEXT NOT NULL,
  reverses_entry_id INTEGER REFERENCES service_charge_entry (id)
);

CREATE INDEX idx_service_charge_entry_order ON service_charge_entry (order_id);
CREATE INDEX idx_service_charge_entry_waiter ON service_charge_entry (waiter_id);
