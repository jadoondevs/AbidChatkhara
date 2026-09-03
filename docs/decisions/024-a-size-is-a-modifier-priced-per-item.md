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
- **The delta is an implementation detail — no human ever sees one.**
  The storage is a delta (`final − base`), but a delta is not a price
  anyone reasons in. So both faces of the app work in final prices: the
  item editor shows and takes "Half Rs 1,100, Full Rs 2,100" and does
  the `final − base` conversion itself, and the cashier's picker shows
  each size's final price and the resulting line price before the item
  is added. Optional add-on groups (extra cheese) are the one place a
  "+Rs" adjustment is shown, because that is honestly what an add-on is.
- **Modifiers are configured where the item is, not on a second screen.**
  They live inside Edit Item, alongside name/category/price, because a
  manager who opens an item to change its size expects to find the size
  there. The global "Modifier groups" screen keeps only the reusable
  definitions (names and choice rules); all pricing is per item.

## Consequences

The item-mix report splits by the sold configuration rather than
aggregating an item across its sizes: "Chicken Karahi — Half" and
"Chicken Karahi — Full" are two rows, an item sold plain stays one. The
split is read from each line's own `order_line_modifier` snapshot — the
frozen name and, through the line's net-sales, the price it was charged
at — so renaming or repricing a size never rewrites a past report.
Because a line's `net_sales_minor` is already the whole line (item + its
modifiers, see ordering/pipeline), the per-variant quantities and values
still sum to exactly the item's overall total. This is the one thing
separate items would have given for free, recovered here without them.
See docs/decisions/025.

Ownership is per item, so both sizes of a dish are owned identically —
the item-mix report shows the same owners on every variant of an item.
For this restaurant that is correct: the split follows the dish, not the
portion.
