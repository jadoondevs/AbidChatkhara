# 25. Item mix splits by the sold configuration, from the snapshot

## Context

A size is a modifier, not a separate item (docs/decisions/024). That
keeps the menu to one "Chicken Karahi" and the till to one tile, but it
left the item-mix report aggregating every size of a dish into a single
number: "Chicken Karahi — 15" when six were Half and nine were Full. A
manager cannot order stock, cost a dish, or read demand from that.

The sizes are already on the sold line. `order_line_modifier` snapshots,
at the moment of sale, each chosen modifier's `modifier_name_snapshot`
and `price_delta_minor`, and `order_line.net_sales_minor` is the whole
line — item plus its modifiers combined (ordering/pipeline). So the
information the report needs is recorded; the report simply wasn't
reading it.

The constraint that shapes the fix: a historical report must not be
recomputed from the current menu. If Full is renamed or repriced next
week, last week's report must still read what was actually sold.

## Decision

`itemMixReport` groups by the base item AND the sold configuration —
the set of modifier snapshot names on the line — instead of by item
alone. One row per (item, configuration):

- An item sold with a size is `Chicken Karahi — Half`, a row of its own.
- An item sold plain is `Chapati`, a single row with no suffix.
- The names come only from `order_line_modifier.modifier_name_snapshot`,
  never from a join to the live `modifier` table, so a later rename or
  reprice cannot touch a past report.
- The value summed is `order_line.net_sales_minor`, which already
  includes the size's price, so the per-variant figures stay correct and
  add back to the item's overall total to the paisa.

Ownership stays a property of the base item (the current active split,
as before), so every variant of an item shows the same owners — the
report describes today's ownership of a dish, not a frozen snapshot,
exactly as it did before this change.

Within an item, variants are ordered by the configuration's modifier
ids (creation order — Half before Full) rather than alphabetically, so
the report reads in menu order.

## What was deliberately not done

- **No schema change.** The snapshot needed was already there.
- **No new "meaningful modifier" flag.** The report cannot ask the
  current menu whether a modifier is a size or an add-on without
  breaking the history rule, and it does not need to: grouping by the
  whole sold configuration is the honest answer — it distinguishes every
  configuration that was actually sold, and the quantities still sum to
  the item total either way.
- **Consumption was already variant-aware** — its per-item detail lines
  already carry `modifierNames` from the same snapshot — so only item
  mix (and the dashboard's top-sellers, which composes it) changed.

## Consequences

The item-mix CSV export gains `modifierNames` and `variantName` columns
automatically (the exporter serialises whatever fields a row carries).
The dashboard's "Top selling items" and "Best seller" now name the size.
A report row is keyed by item + configuration rather than item id alone,
so a single item legitimately appears on several rows — callers that
assumed one row per item (there were none outside the report's own UI)
would need to group.
