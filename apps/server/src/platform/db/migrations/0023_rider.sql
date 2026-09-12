-- riders/: delivery riders. A rider is a named person a delivery order
-- is assigned to, and whom a delivery charge is owed to — the delivery
-- equivalent of the waiter a dine-in order is attributed to.
--
-- Deliberately its own table, NOT a user role: a rider does not log in
-- to the till, has no password and no meal policy, so making them a
-- `user` would mean rebuilding the user table's role CHECK and handing
-- every rider a login they never use. This mirrors how `partner` is its
-- own first-class list rather than a kind of user.
CREATE TABLE rider (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_rider_active ON rider (active);

-- Which rider is carrying a delivery order. Nullable: a delivery with no
-- rider yet is valid; billing only requires one once a delivery charge
-- (owed to the rider) is actually added — the same shape as waiter_id and
-- service charge.
ALTER TABLE "order" ADD COLUMN rider_id INTEGER REFERENCES rider (id);

CREATE INDEX idx_order_rider ON "order" (rider_id);
