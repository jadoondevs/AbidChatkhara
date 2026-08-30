# 4. order_line_modifier carries its own allocation breakdown

## Context

The spec's schema gives `order_line_modifier` its own `gross_minor`,
`prorated_discount_minor`, `net_sales_minor`, and `allocation_base_minor`
columns — the same shape as `order_line` itself — even though `order_line`'s
own `gross_minor` is explicitly defined to already include its modifiers
(`line.gross_minor = unit_price_minor * qty + sum(modifier.price_delta_minor) * qty`).
Modifier ownership is optional (spec: "A modifier with no ownership rows
follows the base item's ownership"), which means a modifier can be owned
by a *different* partner than the item it's attached to — e.g. a base
dish owned by one partner, with an add-on owned by another. The allocation
engine (a later milestone) needs a way to carve that add-on's revenue out
of the line and allocate it separately, without either double-counting it
(paying both the item's owner and the modifier's owner for the same
paisa) or dropping it (paying neither).

## Decision

`order_line`'s own totals represent the **full line** — item and all its
modifiers combined — exactly as the spec's `gross_minor` formula states.
`order_line_modifier`'s totals are a **breakdown of a slice of that
total**, not an addition to it: each modifier's own gross is
`price_delta_minor * qty`, discount-prorated independently, giving it its
own `net_sales_minor` / `allocation_base_minor`.

The order-level discount is prorated in two stages: first across lines
(by each line's full gross, exactly as the spec's proration formula
says), then — within a line — that line's own discount share is
prorated again, across the item's own portion and each of its
modifiers' portions, using the same largest-remainder primitive
(`distribute`) both times. This is why `computeOrderPipeline`
(`ordering/pipeline.ts`) calls `distribute` at two levels rather than
once.

The allocation engine, when it lands, allocates a line's item-owner
share as `line.allocation_base_minor - sum(that line's separately-owned
modifiers' allocation_base_minor)`, and each separately-owned modifier's
own `allocation_base_minor` to its own owners — so `order.net_sales_minor`
(summed from `order_line` alone, per the spec's stage-4 formula) still
adds up correctly, while the allocation engine has everything it needs to
split a line's revenue across more than one partner when a modifier's
ownership diverges from its item's.

## Consequences

- `sum(order_line.net_sales_minor)` still equals `order.net_sales_minor`
  without needing to know anything about modifier ownership — ordering
  stays entirely ignorant of partners, exactly as the module boundary
  requires.
- The allocation engine can treat "does this modifier have its own
  ownership rows" as the only branch it needs — the numbers to allocate
  either way already exist, computed once, by ordering.
- Tie-breaking within a line always resolves toward the item's own
  portion before its modifiers (the item's portion is index 0 in the
  inner `distribute` call), so which get the odd paisa is deterministic
  and reproducible, the same guarantee `distribute` already gives at the
  line level.
