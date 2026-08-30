# 12. The partner-statement reconciliation counts only original allocations

## Context

The spec requires the partner statement to "display a reconciliation
line showing total allocation base versus total allocated, with the
variance, which must always be zero." The first, most literal
implementation summed *every* `line_allocation` row tied to a line in
the reporting period — originals and reversals alike — against that
line's stored `allocation_base_minor`. That breaks the moment an order
in the period is refunded: the reversal cancels the original allocation
(correctly — the partner is no longer owed that money), but the line's
`allocation_base_minor` is an immutable snapshot, per this system's own
append-only principle, and never changes to reflect the refund. The
report then shows a non-zero variance for an order where nothing was
ever mis-allocated — a false alarm on the one figure the spec says must
always read zero.

## Decision

`allocationReconciliation` counts only *original* `line_allocation` rows
(`reverses_allocation_id IS NULL`) against `order_line.allocation_base_minor`.
This checks the thing the spec's line is actually meant to prove: that
the allocation engine distributed 100% of every sale's value correctly
*at the time it happened* — the same guarantee `distribute()`'s own
exact-sum assertion already enforces at write time (docs/decisions/002),
surfaced here for a human reading the report. A later refund is a
separate, subsequent event; it doesn't retroactively make the original
distribution wrong, and correctly reducing what a partner is still owed
is gratuity's and billing's job, proven by their own reversal tests —
folding that into this reconciliation would make every routine refund
look like a broken allocation.

`partnerStatement`'s own headline figures (`totalAllocatedMinor`,
`customerSalesAllocatedMinor`, `consumptionAllocatedMinor`) are a
completely separate query and are **not** narrowed this way — they sum
every `line_allocation` row, reversals included, because "how much has
this partner actually been allocated, net of refunds" is exactly what a
partner wants to see when they read their own statement. Only the
reconciliation line beneath it answers the narrower, structural
question.

## Consequences

- `reporting/service.test.ts` proves both halves directly: a refunded
  order still reconciles to zero (`allocationReconciliation`), while the
  same refund correctly reduces what shows up as owed elsewhere if the
  test asked (it doesn't need to — `refundOrder`'s own reversal
  correctness is already proven in `billing/service.test.ts` and
  `partners/service.test.ts`).
- Scoping is by which **order** closed in the reporting window
  (`order.closed_at`), not by a `line_allocation` row's own timestamp —
  so every original allocation tied to an order that closed in range is
  counted exactly once, regardless of when (or whether) it was later
  reversed.
