-- A modifier's price delta, overridden for ONE item.
--
-- `modifier.price_delta_minor` is global to the modifier, which is right
-- for "extra cheese, +Rs 100" — it costs the same wherever it is added.
-- It is wrong for a size. A "Half / Full" group is meant to be attached
-- to every karahi on the menu, but Full is +Rs 1,000 on a Chicken Karahi
-- and +Rs 1,800 on a Shinwari. One shared delta cannot say both, and a
-- group per item would defeat the point of a shared group.
--
-- So this table answers "what does THIS modifier cost on THIS item", and
-- the modifier's own delta remains the default for every item that has
-- no row here. Effective-dated exactly like item_price: a price change
-- closes the open row and inserts a new one, never updates in place, so
-- the catalog keeps its own history. Historical sales are protected
-- separately and already — order_line_modifier snapshots the delta it
-- charged at the time.

CREATE TABLE item_modifier_price (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id           INTEGER NOT NULL REFERENCES item (id),
  modifier_id       INTEGER NOT NULL REFERENCES modifier (id),
  -- No non-negative check, matching `modifier.price_delta_minor`: a
  -- modifier is allowed to take money off as well as add it.
  price_delta_minor INTEGER NOT NULL,
  valid_from        TEXT NOT NULL,
  valid_to          TEXT
);

CREATE INDEX idx_item_modifier_price_lookup ON item_modifier_price (item_id, modifier_id, valid_from);

-- At most one currently-open override per (item, modifier), enforced at
-- the schema level as well as by the service function.
CREATE UNIQUE INDEX idx_item_modifier_price_open
  ON item_modifier_price (item_id, modifier_id) WHERE valid_to IS NULL;
