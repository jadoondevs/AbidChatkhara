-- purchases/: where a purchase's money came from — the cash drawer, or a
-- person who fronted it (a partner paying out of pocket, say). A pure
-- record, exactly like the purchase itself: recording a source does NOT
-- move the drawer, the sales, or any other balance. Knowing "how much of
-- the buying came from the drawer vs. what someone paid" is the whole
-- point, and it also sets up an optional drawer reconciliation later.
--
-- Its own owner-configured list (managed in Settings), so a new payer can
-- be added without a code change — the same shape as purchase_category.
CREATE TABLE purchase_source (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_purchase_source_active ON purchase_source (active);

-- Which source funded a purchase. Nullable: purchases recorded before
-- this existed carry none, and a purchase can still be saved without one;
-- the till pre-selects the first source for new entries.
ALTER TABLE purchase ADD COLUMN payment_source_id INTEGER REFERENCES purchase_source (id);

CREATE INDEX idx_purchase_payment_source ON purchase (payment_source_id);
