-- catalog/: categories, items, effective-dated prices, modifier groups,
-- modifiers, and item availability.

CREATE TABLE category (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES category (id),
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX idx_item_category ON item (category_id);

-- Effective-dated: a price change closes the current row (valid_to) and
-- inserts a new one, never updates price_minor in place. Editing a price
-- must never alter historical sales (those snapshot their own unit price
-- onto order_line at the time of sale) — this table is the catalog's own
-- price history, independent of any specific sale.
CREATE TABLE item_price (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES item (id),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  valid_from  TEXT NOT NULL,
  valid_to    TEXT
);

CREATE INDEX idx_item_price_item ON item_price (item_id, valid_from);

-- At most one currently-open price per item, enforced at the schema
-- level as well as by the service function that opens/closes rows.
CREATE UNIQUE INDEX idx_item_price_open ON item_price (item_id) WHERE valid_to IS NULL;

CREATE TABLE modifier_group (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  min_select INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select INTEGER NOT NULL CHECK (max_select >= min_select)
);

CREATE TABLE modifier (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          INTEGER NOT NULL REFERENCES modifier_group (id),
  name              TEXT NOT NULL,
  price_delta_minor INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_modifier_group ON modifier (group_id);

CREATE TABLE item_modifier_group (
  item_id  INTEGER NOT NULL REFERENCES item (id),
  group_id INTEGER NOT NULL REFERENCES modifier_group (id),
  PRIMARY KEY (item_id, group_id)
);

-- One row per item, updated in place (unlike item_price, availability
-- has no historical-sales requirement to protect) but still attributed
-- via changed_by/changed_at, and every mutation additionally lands in
-- audit_log the same as everywhere else.
CREATE TABLE item_availability (
  item_id    INTEGER PRIMARY KEY REFERENCES item (id),
  available  INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  changed_by INTEGER REFERENCES user (id),
  changed_at TEXT NOT NULL
);
