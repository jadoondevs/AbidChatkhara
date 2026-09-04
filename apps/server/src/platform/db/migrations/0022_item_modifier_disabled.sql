-- One option of a shared group, switched off for ONE item.
--
-- A "Half / Full" group is attached to every karahi, but a particular
-- dish might only ever be sold Full. Rather than fork the shared group
-- into a per-item copy, this records "item X does not offer option Y":
-- the option stays on the group and on every other item, and the till
-- simply does not show it for this one.
--
-- It is the per-item counterpart to item_availability (which is the whole
-- item, tonight) and item_modifier_price (which is the option's price on
-- this item). A row here means "not offered"; no row means "offered".
--
-- Deliberately NOT effective-dated: this is a menu-configuration switch,
-- not a price, and historical sales are protected the same way they
-- always are — order_line_modifier snapshots the option it sold, so
-- disabling an option here never touches a bill that already sold it.

CREATE TABLE item_modifier_disabled (
  item_id     INTEGER NOT NULL REFERENCES item (id),
  modifier_id INTEGER NOT NULL REFERENCES modifier (id),
  PRIMARY KEY (item_id, modifier_id)
);

CREATE INDEX idx_item_modifier_disabled_item ON item_modifier_disabled (item_id);
