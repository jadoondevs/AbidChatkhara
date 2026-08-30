# 8. Service charge as a liability, not revenue

## Context

A restaurant service charge in Pakistan (and elsewhere) is customarily
understood as money collected on behalf of the staff who served the
table — the restaurant is a custodian of it, not its earner. Every
revenue figure downstream of a sale (the money pipeline's net sales, the
partner allocation base, every report's "sales" figure) has to reflect
that a service charge isn't part of what the *business* sold, even
though it sits in the same cash drawer and the same `total_minor` the
customer actually pays.

Getting this wrong doesn't fail loudly — a service charge folded into
revenue just makes every partner's allocation, every sales report, and
every shift's cash reconciliation subtly, silently wrong, in a way that
compounds every day the mistake goes unnoticed.

## Decision

`service_charge_minor` is carried on the order row but never enters the
money pipeline's revenue figures: it is computed and added *after*
`net_sales_minor` (money pipeline stage 6, strictly separate from stages
1-4) and is never part of `subtotal_minor`, never prorated by the order
discount, and never contributes to `allocation_base_minor`. The partner
allocation engine only ever sees `net_sales_minor`-derived bases —
service charge isn't merely excluded by a filter somewhere, there is no
code path by which it could reach an allocation in the first place.

Once an order closes, the amount is recorded again, separately, in
`gratuity/`'s own append-only ledger (`service_charge_entry`),
attributed directly to `order.waiter_id` — money the restaurant holds
for a specific person, not the restaurant's own earnings. A void or
refund reverses that ledger entry the same way a partner allocation
reverses: a new row with a negative amount, referencing the original,
never an edit.

It **is** included in `total_minor`, and therefore in a shift's expected
cash — the customer really did hand over that cash, and the till really
does need to reconcile it. Shift reconciliation (a later milestone) will
show it as a distinct line: cash held, not earned, so "money in the
drawer" and "money the restaurant made" never get to look like the same
number.

## Consequences

- `sum(line_allocation.amount_minor)` for a closed order equals
  `net_sales_minor` exactly — never `total_minor` — verified directly by
  a test that gives an order both a service charge and a partner, and
  checks the allocation total against `net_sales_minor`, not the order's
  full total.
- A report that sums "revenue" from `order_line`/`order_line_modifier`
  rows is correct by construction; it doesn't need a special case to
  subtract service charge back out, because it was never in there.
- The waiter payout figure (`gratuity/service.ts`'s `waiterPayoutTotals`)
  comes from a ledger that exists for exactly this purpose, rather than
  being derived by summing `order.service_charge_minor` across orders at
  report time — the append-only entry, not the order row, is the source
  of truth for what's still owed, and it survives a void or refund
  correctly because reversal is built the same way partner allocation's
  is.
