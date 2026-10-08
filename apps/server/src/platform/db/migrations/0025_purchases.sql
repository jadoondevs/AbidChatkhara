-- purchases/: a daily purchase ledger. The restaurant buys stock and
-- supplies every day; this records each purchase — what it was, how much
-- it cost, which partner it was for, and under which purchase category —
-- so a shift (or a date range) can be totalled without a notebook.
--
-- Deliberately a PURE ledger: a purchase is NOT netted against sales,
-- revenue or the cash drawer (records only, by request). It is scoped by
-- shift_id, exactly like an order, so "this shift's purchases" is correct
-- across midnight and reuses the same shift/date reporting.

-- The owner's own list of purchase categories (Tawa Chicken, Tea, Meat,
-- Gas, …), managed in Settings. Separate from the MENU categories on
-- purpose: a purchase (oil, gas, packaging) often maps to no menu dish,
-- and a menu rename must never rewrite purchase history.
CREATE TABLE purchase_category (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_purchase_category_active ON purchase_category (active);

-- One row per purchase: one partner, one category, one amount — buying
-- for two partners is two rows. A correction is a VOID (voided = 1), not
-- an edit, so the ledger is append-only and history is never rewritten.
CREATE TABLE purchase (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id             INTEGER REFERENCES shift (id),
  partner_id           INTEGER NOT NULL REFERENCES partner (id),
  purchase_category_id INTEGER NOT NULL REFERENCES purchase_category (id),
  description          TEXT,
  amount_minor         INTEGER NOT NULL,
  note                 TEXT,
  created_by           INTEGER NOT NULL REFERENCES user (id),
  created_at           TEXT NOT NULL,
  voided               INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  voided_by            INTEGER REFERENCES user (id),
  voided_at            TEXT,
  void_reason          TEXT
);

CREATE INDEX idx_purchase_shift ON purchase (shift_id);
CREATE INDEX idx_purchase_partner ON purchase (partner_id);
CREATE INDEX idx_purchase_category ON purchase (purchase_category_id);
CREATE INDEX idx_purchase_created ON purchase (created_at);
