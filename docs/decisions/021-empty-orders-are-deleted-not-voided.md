# 21. An order that never became one is deleted, not voided

## Context

A till accumulates orders that are not orders: a table opened by
mistake, an order started for a customer who walked out, a double-tap
on "New order". They sit on the floor at Rs 0.00 forever, and because a
shift cannot close while any order is still open, they hold the day
open at midnight — a manager standing at a till at 1am being told they
cannot close because of table 19, which has never had anything on it.

Every other way of removing something from this system is append-only.
That is deliberate and must stay that way for anything that happened.

## Decision

`deleteEmptyOrder` removes the row, and the audit log keeps the fact
that it was removed, by whom, from which terminal, with the order's own
figures in the `before` payload.

It refuses anything that is not, at the moment of deletion and inside
the transaction:

- `status = 'open'` — never billed, never paid, never voided;
- zero rows in `order_line`, voided ones included;
- zero rows in `payment`;
- zero subtotal, total, discount and service charge.

All four are checked in the service, not the route, so the rule holds
for any caller.

## Why

**A void is a statement, and it would be a false one.** "Voided" means
this happened and was cancelled: the order is kept, the reason is kept,
it appears in the voids-and-discounts report, and a manager reviewing
that report is being told something. An order with nothing on it makes
that report worse, not better — it is noise in the one place someone
looks for staff cancelling real sales.

**Nothing is lost, because nothing was there.** The append-only rule
exists to protect the record of what happened. No item was ordered, no
bill was printed, no money moved, no partner was credited, no invoice
number was allocated. There is no transaction to preserve — and the
audit row means even the deletion itself is not invisible.

**A voided line still counts as something happening.** An order whose
only line was added and then taken off is a record of a mistake that
reached the kitchen or the customer, so it is refused here and voided
instead. The test for "empty" is the absence of any line ever, not the
absence of live ones.

## Consequences

- The floor offers this on open rows with no lines, and so does the
  shift-close blocker list, which is where the problem is actually
  felt.
- Any signed-in user can do it. An order opened by mistake is the
  cashier's own mess to clear, and the conditions above mean the action
  cannot reach anything that matters, whoever calls it.
- Preventing empty orders entirely was considered and rejected: a
  restaurant legitimately opens a table before the first item is
  ordered, and refusing that would break the workflow to avoid tidying
  up after it.
