-- consumption/: staff and owner meals. A named person (never free text —
-- so reports can total per person) consumes food that goes through the
-- normal sales pipeline at full menu price; what they actually pay is a
-- separate figure, driven by their own meal policy, and never dilutes
-- the owning partner's allocation. See docs/decisions/009 for exactly
-- how meal_policy and settlement_type interact.
--
-- kind: staff | partner — "partner" here covers an owner eating their
-- own restaurant's food (an owner_meal order), distinct from a
-- payment-collecting "customer" order.
CREATE TABLE person (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('staff', 'partner')),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  meal_policy       TEXT NOT NULL CHECK (meal_policy IN ('free', 'discounted', 'full_price', 'payroll_deduction')),
  meal_discount_bp  INTEGER NOT NULL DEFAULT 0
);

-- One row per settled staff/owner meal order. policy_snapshot freezes
-- the person's meal_policy/meal_discount_bp at settlement time, same
-- "snapshot, never recompute" rule as item_ownership's share_bp_snapshot
-- (docs/decisions/006) — a later change to the person's policy must
-- never alter this record.
--
-- settlement_minor is menu_value_minor - charged_minor: the gap between
-- what the food is worth and what the person actually paid, which has
-- to be settled somehow (settlement_type) — money the OWNING PARTNER is
-- never charged for (spec: "not written off against the owning
-- partner"). settlement_type is NULL exactly when settlement_minor is
-- zero (nothing to settle) and required otherwise — enforced below by a
-- CHECK, the same "the database is the last line of defense" posture
-- every other CHECK constraint in this schema takes.
CREATE TABLE consumption_record (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES "order" (id),
  person_id         INTEGER NOT NULL REFERENCES person (id),
  policy_snapshot   TEXT NOT NULL,
  menu_value_minor  INTEGER NOT NULL,
  charged_minor     INTEGER NOT NULL,
  settlement_minor  INTEGER NOT NULL,
  settlement_type   TEXT CHECK (settlement_type IN ('house_expense', 'payroll_deduction', 'partner_personal')),
  created_at        TEXT NOT NULL,
  CHECK ((settlement_minor = 0 AND settlement_type IS NULL) OR (settlement_minor != 0 AND settlement_type IS NOT NULL))
);

CREATE INDEX idx_consumption_record_order ON consumption_record (order_id);
CREATE INDEX idx_consumption_record_person ON consumption_record (person_id);

-- The deferred column migration 0004 promised: an order only carries a
-- beneficiary once a staff_meal/owner_meal order can name one.
ALTER TABLE "order" ADD COLUMN beneficiary_person_id INTEGER REFERENCES person (id);
