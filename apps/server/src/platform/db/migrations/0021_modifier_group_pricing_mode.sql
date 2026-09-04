-- How a modifier group's option prices are meant to be read.
--
-- A group is one of two things, and they price in opposite directions:
--
--   * a VARIANT (a size): the customer picks exactly one, and the option
--     they pick IS the price of the line — Chicken Karahi "Full" is
--     Rs 2,000, not Rs 1,300 + Rs 2,000. The admin enters the final
--     selling price for each size.
--   * an ADD-ON: the customer picks any number, and each option ADDS to
--     the line — "Extra cheese" is +Rs 100 on top of whatever the item
--     already costs. The admin enters the extra charge.
--
-- Until now the till guessed which a group was from its select counts
-- (min = 1 AND max = 1 → a size), and a size group configured with any
-- other counts was silently treated as an add-on: picking the Rs 200
-- size of a Rs 200 drink charged Rs 400. The guess is the bug. This
-- column records the intent explicitly instead, so a variant stays a
-- variant whatever its min/max, and the admin chooses which it is.
--
-- Storage does not change: a variant option still stores a DELTA from the
-- item's base price (final − base), which is what item_modifier_price and
-- modifier.price_delta_minor already hold and what order_line_modifier
-- already snapshots. The delta of a base-priced size is 0 and of a
-- cheaper size is negative — both already allowed. So this migration
-- changes no charge and rewrites no history; it only labels each group.

ALTER TABLE modifier_group
  ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'add_on'
  CHECK (pricing_mode IN ('variant', 'add_on'));

-- Backfill the label to match exactly how each existing group was being
-- treated, so nothing a till currently charges changes: the groups the
-- old heuristic read as sizes (choose exactly one) become 'variant', and
-- every other group keeps the 'add_on' default it was already treated as.
UPDATE modifier_group SET pricing_mode = 'variant' WHERE min_select = 1 AND max_select = 1;
