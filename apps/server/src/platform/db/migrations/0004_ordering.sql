-- ordering/: orders, order lines, and order-line modifiers.
--
-- shift_id, beneficiary_person_id, and consumption_settlement are
-- deliberately NOT included yet — they reference shift and person rows
-- that don't exist until the shifts and consumption milestones. Those
-- milestones ALTER TABLE this table to add them (SQLite supports adding
-- a column with a REFERENCES clause after the fact), rather than this
-- migration carrying an unconstrained placeholder column for several
-- milestones.
--
-- invoice_no is nullable and untouched here: it is allocated only at
-- close time, by the billing module, from a dedicated counter (see the
-- spec's invoice-numbering section) — ordering never writes it.
CREATE TABLE "order" (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no               INTEGER UNIQUE,
  order_type               TEXT NOT NULL CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
  channel                  TEXT NOT NULL DEFAULT 'customer' CHECK (channel IN ('customer', 'staff_meal', 'owner_meal')),
  table_label               TEXT,
  waiter_id                INTEGER REFERENCES user (id),
  opened_at                TEXT NOT NULL,
  billed_at                TEXT,
  closed_at                TEXT,
  opened_by                INTEGER NOT NULL REFERENCES user (id),
  closed_by                INTEGER REFERENCES user (id),
  status                   TEXT NOT NULL CHECK (status IN ('open', 'billed', 'closed', 'voided')),
  subtotal_minor           INTEGER NOT NULL DEFAULT 0,
  order_discount_minor     INTEGER NOT NULL DEFAULT 0,
  discount_reason          TEXT,
  net_sales_minor          INTEGER NOT NULL DEFAULT 0,
  tax_minor                INTEGER NOT NULL DEFAULT 0,
  service_charge_minor     INTEGER NOT NULL DEFAULT 0,
  rounding_adjustment_minor INTEGER NOT NULL DEFAULT 0,
  total_minor              INTEGER NOT NULL DEFAULT 0,
  -- Optimistic concurrency: every mutating write checks and bumps this,
  -- so two terminals racing to change (and, in the billing milestone,
  -- close) the same order can't silently clobber each other.
  version                  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_order_status ON "order" (status);
CREATE INDEX idx_order_waiter ON "order" (waiter_id);

CREATE TABLE order_line (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id               INTEGER NOT NULL REFERENCES "order" (id),
  item_id                INTEGER NOT NULL REFERENCES item (id),
  qty                    INTEGER NOT NULL CHECK (qty > 0),
  unit_price_minor       INTEGER NOT NULL,
  gross_minor            INTEGER NOT NULL,
  prorated_discount_minor INTEGER NOT NULL DEFAULT 0,
  net_sales_minor        INTEGER NOT NULL,
  allocation_base_minor  INTEGER NOT NULL,
  voided                 INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  void_reason            TEXT,
  void_approved_by       INTEGER REFERENCES user (id)
);

CREATE INDEX idx_order_line_order ON order_line (order_id);

CREATE TABLE order_line_modifier (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_line_id          INTEGER NOT NULL REFERENCES order_line (id),
  modifier_id            INTEGER NOT NULL REFERENCES modifier (id),
  price_delta_minor      INTEGER NOT NULL,
  gross_minor            INTEGER NOT NULL,
  prorated_discount_minor INTEGER NOT NULL DEFAULT 0,
  net_sales_minor        INTEGER NOT NULL,
  allocation_base_minor  INTEGER NOT NULL
);

CREATE INDEX idx_order_line_modifier_line ON order_line_modifier (order_line_id);
