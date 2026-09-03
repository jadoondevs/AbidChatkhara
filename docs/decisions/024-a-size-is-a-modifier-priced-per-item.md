# 24. A size is a modifier, priced per item

## Context

This restaurant's menu sells sixteen items in sizes: nine karahi and
four barbecue dishes as Half/Full, golgappa as Half/Full, mineral water
as Small/Large, and soft drinks by the bottle. Two ways to model that:

**As separate items.** "Chicken Karahi (half)" and "Chicken Karahi
(full)" become two rows in `item`, each with its own price history and
its own ownership split. That is what the demo seed does, and it is what
this project first recommended: the two sizes are genuinely different
products, and the item-mix report then tells you how many halves sold.

**As one item plus a size modifier group.** One tile on the till, one
name in the reports, one ownership split, and a required choice that
carries the price difference.

The restaurant asked for the second.

That choice has a cost that the first does not, and it is the reason
this record exists. A modifier group's price delta lives on the
`modifier` row, which is shared by every item the group is attached to.
One "Half / Full" group cannot carry sixteen different Full prices:
+Rs 1,000 on a Chicken Karahi, +Rs 1,100 on a Makhni, +Rs 320 on a
golgappa. Attaching sixteen near-identical groups instead would put
sixteen "Half / Full" entries in front of whoever configures the next
item, which is its own kind of wrong.

## Decision

A size is a modifier group, and what one of its options costs is a
property of **the item it is on**, not of the option.

`item_modifier_price` (migration 0020) holds that: one effective-dated
row per (item, modifier), closing and reopening exactly as `item_price`
does. `addLine` resolves each chosen modifier's delta through it,
falling back to the modifier's own delta when no override exists, and
`order_line_modifier` snapshots whatever it resolved — so history is
unaffected either way.

Consequences that had to follow, each of which was a real defect until
it was fixed:

- **The till shows the override, not the default.** The group's own
  delta for a size is zero — a size means nothing without an item to be
  a size of — so a picker reading `modifier.priceDeltaMinor` displayed
  "Full" with no uplift while charging a thousand rupees more.
- **Options are ordered by entry, not by name.** The picker pre-selects
  the first option of a required group. Alphabetically, "Half / Full" is
  Full, Half — so the default was the dearer size, and a cashier who
  accepted it charged double.
- **Every option of a sized item must be priced explicitly.** The
  importer writes an override for each one, including the base size's
  zero, rather than leaving any of them to a default that is only
  correct by accident.

## Consequences

The item-mix report counts "Chicken Karahi" once rather than splitting
halves from fulls — the thing separate items would have given for free.
The order line's modifier breakdown still records which size was sold,
so the information is there; no report reads it that way yet.

Ownership is per item, so both sizes of a dish are owned identically.
For this restaurant that is correct — the split follows the dish, not
the portion.
