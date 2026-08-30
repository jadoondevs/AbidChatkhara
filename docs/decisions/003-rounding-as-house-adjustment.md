# 3. Rounding held as a house adjustment

## Context

Cash in Pakistan is practically counted to the nearest rupee — paisa coins
are not in everyday circulation — so a bill's final total is rounded to the
nearest rupee even though every line, tax, and service-charge figure behind
it is exact to the paisa. That rounding has to land somewhere: some order's
true (pre-rounding) total is a few paisa more than what the customer is
actually asked to pay, and some order's is a few paisa less.

If that difference were silently dropped, the books would not balance:
`sum(payments received)` would not equal `sum(net_sales + tax + service_charge)`
computed from the unrounded figures, and nobody closing a shift would be
able to explain the gap without re-deriving it by hand.

## Decision

- `roundToRupee` (`packages/shared/src/money/round.ts`) rounds a pre-round
  total to the nearest 100 paisa (half up) and returns both the rounded
  `total` and the `adjustment` (`total - amount`) as an explicit,
  first-class value — never a value that gets computed and discarded.
- The order row stores `rounding_adjustment_minor` alongside `total_minor`
  (see the ordering module, spec's order table). It is attributed to the
  house, not to any partner and not to the waiter's service charge: it is
  neither part of the allocation base (partners are allocated from
  `net_sales_minor`, computed before rounding) nor added to
  `service_charge_minor` (which the cashier enters directly and which
  rounding must never silently inflate or shrink).
- The Z-report (shifts module) surfaces the day's total rounding
  adjustment as its own line, so "why doesn't cash collected exactly equal
  the sum of order totals" always has a one-line answer instead of an
  unexplained variance.

## Consequences

- Every order's rounding adjustment is individually recorded and
  auditable, not folded into any other figure — a manager can always
  answer "how much did rounding cost or gain the house today" exactly.
- Partner allocations and service charge are computed from pre-rounding
  figures and are therefore completely insulated from the rounding rule —
  changing how rounding works (e.g. rounding to the nearest 50 paisa
  instead of 100) can never change what a partner is owed or what a waiter
  is owed for service charge.
- The trade-off is one more figure on every order and on the Z-report —
  worth it, because the alternative is an unreconciled gap between what
  was charged and what the unrounded figures say should have been charged.
