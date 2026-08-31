# 14. A mis-tap is a correction, not a void

## Context

Every way of taking a line off an order went through `voidLine`, which
requires a manager's approval and a written reason. That is right for a
line the customer has already seen on a printed bill. It is absurd for a
cashier who tapped the wrong item two seconds ago on an order nobody has
looked at: it puts a manager's approval, and an entry in the
theft-control report, against a keystroke.

The opposite mistake — letting anyone remove anything — would destroy
the auditability the whole system is built on.

## Decision

Two operations, distinguished by whether the order has **ever** been
billed:

- **Correction** (`removeLine`) — the order has never been billed. Any
  signed-in user, no reason, no approver. Audited as
  `order.remove_line`.
- **Void** (`voidLine`) — the order has been billed at least once, even
  if it has since been reopened. Manager, reason, and `void_approved_by`
  records who approved it. Audited as `order.void_line`.

Neither deletes the row. `order_line.voided` remains the flag the money
pipeline reads; `void_kind` records which of the two happened.

## Why

**The dividing line is "has a customer seen this?", and `billed_at`
cannot answer it.** Reopening an order clears `billed_at` — that is what
makes it open again — so after a reopen, a bill that was printed and
handed to a customer looks identical to one that never left the kitchen.
Migration 0014 adds `first_billed_at`, stamped once and never cleared,
so the rule survives a reopen. The same column stops `addLine` from
merging a repeat tap into a line the customer has already seen.

**Deleting the row was never an option.** A bill has to be
reconstructable exactly as it was rung up, including what came off it.
Both kinds keep the row and both are in the audit log.

**Corrections stay in the void-and-discount report**, under their own
kind. A cashier ringing items in and out repeatedly before billing is
exactly the pattern that report exists to surface — excluding
corrections entirely would have opened a hole in it. What changed is
that a manager reading it can now tell a mis-tap from an approved void
instead of seeing one undifferentiated list.

**A correction records no approver.** Writing the cashier into
`void_approved_by` would make the audit trail claim an approval that
never happened.

## Consequences

- The running bill shows "Remove" before a bill has been printed and
  "Void" after, and the second opens the reason-and-manager flow.
- The Z-report's "voided sales" counts real voids only. A mis-tap is a
  keystroke, not removed revenue.
- `removeLine` refuses rather than silently escalating once an order has
  been billed, so a caller has to come back through `voidLine`
  deliberately.
