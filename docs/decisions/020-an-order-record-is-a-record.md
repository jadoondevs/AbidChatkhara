# 20. A historical order is a record of what happened, not a query about today

## Context

Opening a completed order took the cashier to the payment screen's
"Paid in full" card: an invoice number, a total, and nothing else. Any
question about a past order — what was on it, who served it, which
account the money landed in, what the customer asked for — had to be
answered from the paper receipt or not at all. The data was in the
database; nothing showed it.

Worse, some of what would have been shown was not stored. `order_line`
snapshotted the price but read the item NAME live through `item_id`, so
renaming "Chicken Karahi" to "Chicken Karahi (full)" rewrote every
historical bill that had ever sold one.

## Decision

`GET /api/orders/:id/history` returns the complete record, and
`/orders/:id/detail` shows it. Every figure on it is read back from the
rows written at the time of the sale:

| What | Comes from |
| --- | --- |
| Item and modifier names | `order_line.item_name_snapshot`, `order_line_modifier.modifier_name_snapshot` |
| Prices and line totals | the order line's own snapshotted amounts |
| Service-charge rate | `order.service_charge_rate_bp` |
| Payment account and reference | the `payment` row |
| Partner shares | `line_allocation.share_bp_snapshot` |
| Customer and kitchen notes | `order.customer_name` / `_phone`, `order_line.note` |

The one exception is people. Waiter, cashier and partner NAMES are read
live.

Opening the record cannot modify the order: the route is a `GET` and
the screen has no mutation on it besides an explicit reprint.

## Why

**A record answers "what happened", not "what would happen now".** A
receipt reprinted a year later has to match the paper the customer took
home. That is only true if every number and every word on it was
written down at the time — a live lookup is a different question with a
coincidentally similar answer, right up until someone edits the menu.

**People are identities, not strings.** A waiter who marries and changes
their name is still the person who served that table; showing the old
spelling would be worse, not more faithful. A renamed menu item is the
opposite case: "Chicken Karahi (full)" is a different thing being sold
from what the customer bought, so the old name is the true one. The
difference is whether the string identifies the thing or merely
describes it.

**Snapshotting the name is what makes renaming safe to offer.** Before
migration 0017 there was no rename operation in the system at all,
because there was no way to add one that did not corrupt history.
`renameItem` and `renamePartner` exist now, and are audited, because
the record no longer depends on them.

## Consequences

- Migration 0017 backfills the name columns from the current menu. For
  rows written before it, that is the best available answer, and the
  same answer the live lookup was giving a moment earlier.
- A deleted or deactivated item, modifier, or payment account leaves
  every past order fully readable.
- The floor's completed list routes to the record. Awaiting-payment
  rows still route to the till — that cashier's job is to take the
  money — with the record one click away from there.
