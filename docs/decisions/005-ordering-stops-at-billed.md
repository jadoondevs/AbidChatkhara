# 5. Ordering builds through "billed", not "closed"

## Context

The order status enum is `open | billed | closed | voided`, all four
values present in the schema from the first migration. But the working
order the build spec lays out is explicit: `ordering` is its own
milestone, built *before* the partner allocation engine and the billing
module. Closing an order — the transition the spec's two-stage billing
flow calls settlement — needs machinery that doesn't exist yet at the
point ordering is built:

- A dedicated, gap-free invoice-number counter, allocated only at the
  moment of settlement (spec: "invoice numbers... allocated at settlement
  rather than at bill print" — one of the required decision records).
- The partner allocation engine, to write `line_allocation` rows from
  each line's `allocation_base_minor`.
- Payment recording, to know that payments actually sum to `total_minor`
  before a close is even allowed.

None of that exists when `ordering` is built. Building "close" now would
mean either faking those dependencies or building them out of their
proper milestone, both worse than the alternative.

## Decision

`ordering` implements every transition up to and including `open →
billed` (the pro-forma bill: subtotal, discount proration, net sales,
tax [hardcoded zero — no tax module yet], service charge entered by the
cashier, rounding, and the final `total_minor`), plus `billed → open`
(manager reopen) and voiding, both line- and order-level. It never
writes `status = 'closed'`, never touches `invoice_no`, and never writes
a `line_allocation` row. The `closed` status value sits in the schema's
`CHECK` constraint from day one (so a later migration doesn't need to
widen it), unused until the billing milestone lands and implements the
transition into it — invoice numbering, partner allocations, and payment
recording all together, inside one transaction, exactly as the spec's
billing-workflow section requires.

## Consequences

- A `billed` order in this milestone is a complete, correct pro-forma
  bill — everything the spec's stage 1 describes printing is already
  computed and stored — but genuinely cannot be settled yet; there is no
  code path to `closed` until the billing milestone adds one.
- The optimistic-concurrency column (`order.version`) and the
  `versionedUpdate` helper exist now, exercised by every mutation in this
  milestone, so the billing milestone's close operation — which the spec
  explicitly requires to use "optimistic concurrency on the order row"
  for the double-close test — reuses proven infrastructure rather than
  inventing its own.
- Nothing in ordering's schema or service layer needs to change shape
  when billing adds the close transition; it only adds new code that
  writes to columns (`invoice_no`, `closed_at`, `closed_by`) ordering
  already declared but never populates.
