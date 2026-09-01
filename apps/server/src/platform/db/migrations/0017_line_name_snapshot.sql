-- What the item and its modifiers were CALLED when they were sold.
--
-- order_line already snapshots the price (`unit_price_minor`), because
-- a bill must not change when a price does. The name was left to be
-- looked up live through `item_id` — so renaming "Chicken Karahi" to
-- "Chicken Karahi (full)" silently rewrote every historical bill that
-- ever sold one, and deleting an item would leave old orders unable to
-- say what was on them at all.
--
-- A receipt is a record of a transaction, not a live query. These
-- columns make the name as immutable as the price already was.
--
-- Backfilled from the current names: for existing rows that IS the best
-- available answer, and it is the same answer the live lookup was
-- giving a moment before this migration ran.
ALTER TABLE order_line ADD COLUMN item_name_snapshot TEXT;
ALTER TABLE order_line_modifier ADD COLUMN modifier_name_snapshot TEXT;

UPDATE order_line
SET item_name_snapshot = (SELECT item.name FROM item WHERE item.id = order_line.item_id)
WHERE item_name_snapshot IS NULL;

UPDATE order_line_modifier
SET modifier_name_snapshot = (SELECT modifier.name FROM modifier WHERE modifier.id = order_line_modifier.modifier_id)
WHERE modifier_name_snapshot IS NULL;
