-- delivery/: delivery charges owed to riders. The delivery equivalent of
-- the service charge owed to waiters (0007): an OPTIONAL, flat PKR amount
-- a cashier adds to a delivery bill, collected as part of the total but
-- NEVER revenue — it is money held for the rider, exactly as service
-- charge is money held for the waiter (docs/decisions/008).
--
-- Unlike service charge there is no configured rate: a delivery fee is a
-- flat amount per order, so this stores only the amount.
ALTER TABLE "order" ADD COLUMN delivery_charge_minor INTEGER NOT NULL DEFAULT 0;

-- One entry per collected delivery charge, attributed to the rider it is
-- owed to — no pooling. A reversal (refund) is a second row with a
-- negative amount and a reverses_entry_id, the same shape as
-- service_charge_entry, so a rider's payout nets out automatically.
CREATE TABLE delivery_charge_entry (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES "order" (id),
  rider_id          INTEGER NOT NULL REFERENCES rider (id),
  amount_minor      INTEGER NOT NULL,
  shift_id          INTEGER REFERENCES shift (id),
  created_by        INTEGER NOT NULL REFERENCES user (id),
  created_at        TEXT NOT NULL,
  reverses_entry_id INTEGER REFERENCES delivery_charge_entry (id)
);

CREATE INDEX idx_delivery_charge_entry_order ON delivery_charge_entry (order_id);
CREATE INDEX idx_delivery_charge_entry_rider ON delivery_charge_entry (rider_id);
