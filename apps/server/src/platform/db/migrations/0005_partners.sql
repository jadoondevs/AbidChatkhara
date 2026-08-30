-- partners/: partners, ownership shares (basis points, effective-dated,
-- same pattern as item_price), and the append-only partner allocation
-- ledger.

CREATE TABLE partner (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  joined_at  TEXT NOT NULL,
  left_at    TEXT
);

-- Effective-dated ownership, same "close the open row(s), insert new
-- ones, never update share_bp in place" pattern as item_price. A whole
-- item's split is replaced together (every partner's row at once), not
-- one partner at a time, so "shares sum to exactly 10000" can be
-- checked before any row is written — see partners/service.ts.
CREATE TABLE item_ownership (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES item (id),
  partner_id INTEGER NOT NULL REFERENCES partner (id),
  share_bp   INTEGER NOT NULL CHECK (share_bp > 0 AND share_bp <= 10000),
  valid_from TEXT NOT NULL,
  valid_to   TEXT
);

CREATE INDEX idx_item_ownership_item ON item_ownership (item_id, valid_from);
-- At most one open row per (item, partner) pair at a time.
CREATE UNIQUE INDEX idx_item_ownership_open ON item_ownership (item_id, partner_id) WHERE valid_to IS NULL;

-- Optional: a modifier with no rows here follows its base item's
-- ownership (spec). Same effective-dating pattern as item_ownership.
CREATE TABLE modifier_ownership (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  modifier_id INTEGER NOT NULL REFERENCES modifier (id),
  partner_id  INTEGER NOT NULL REFERENCES partner (id),
  share_bp    INTEGER NOT NULL CHECK (share_bp > 0 AND share_bp <= 10000),
  valid_from  TEXT NOT NULL,
  valid_to    TEXT
);

CREATE INDEX idx_modifier_ownership_modifier ON modifier_ownership (modifier_id, valid_from);
CREATE UNIQUE INDEX idx_modifier_ownership_open ON modifier_ownership (modifier_id, partner_id) WHERE valid_to IS NULL;

-- Append-only. A refund or post-close void writes new rows with negative
-- amount_minor and a non-null reverses_allocation_id, using the
-- snapshotted share_bp_snapshot from the original row — never current
-- ownership. Never UPDATE or DELETE a row here.
CREATE TABLE line_allocation (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_line_id          INTEGER NOT NULL REFERENCES order_line (id),
  order_line_modifier_id INTEGER REFERENCES order_line_modifier (id),
  partner_id             INTEGER NOT NULL REFERENCES partner (id),
  share_bp_snapshot       INTEGER NOT NULL,
  amount_minor           INTEGER NOT NULL,
  allocation_base_mode    TEXT NOT NULL CHECK (allocation_base_mode IN ('NET_SALES_EX_TAX')),
  created_at             TEXT NOT NULL,
  reverses_allocation_id INTEGER REFERENCES line_allocation (id)
);

CREATE INDEX idx_line_allocation_line ON line_allocation (order_line_id);
CREATE INDEX idx_line_allocation_partner ON line_allocation (partner_id);
CREATE INDEX idx_line_allocation_reverses ON line_allocation (reverses_allocation_id);
