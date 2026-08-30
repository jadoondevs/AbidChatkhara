# 7. Invoice numbers allocated at settlement, not at bill print

## Context

The two-stage billing flow means a bill can be printed (stage 1) long
before — sometimes much longer — the customer actually pays and the
order closes (stage 2). Any number of orders can sit `billed`
simultaneously, and they settle in whatever order the tills actually get
to them, not the order they were printed in. A restaurant's invoice
sequence is expected to be gap-free and strictly sequential (a
requirement for tax and audit purposes), which creates a direct conflict
if numbers were handed out at print time: table 3's bill might print
first but get paid last, table 7's print last but pay first, and a void
between billing and payment would burn a number for a sale that never
happened at all.

## Decision

`invoice_no` is `NULL` on every order until the moment it closes.
Allocation happens exactly once, inside the same transaction that
closes the order (`billing/service.ts`'s `recordPayment`, once payments
reach `total_minor`), by an `UPDATE invoice_counter SET next_value =
next_value + 1 WHERE id = 1 RETURNING next_value` against a dedicated
single-row counter table — one atomic statement, not a
read-then-write with a race window between them. A bill printed first
may well close second and receive the *later* number; that is correct
and expected, not a bug to work around.

Because SQLite serializes the `UPDATE` itself and Kysely serializes
concurrent transactions against this server's one connection (see
ARCHITECTURE.md), two closing transactions can never read the same
`next_value` — the second one always sees what the first one already
committed.

## Consequences

- The sequence has no gaps from voided or abandoned bills: a bill that
  never closes never calls `allocateInvoiceNumber`, so it never consumes
  a number. Only a real, closed sale ever has one.
- Two terminals racing to close the same order can't both allocate a
  number for it either — the second transaction, on the same order, is
  rejected by the status check in `closeOrderInTransaction` (the order
  is already `closed` by the time it runs) before it would ever reach
  the counter.
- The cost is that `invoice_no` cannot be printed on the pro-forma bill
  (stage 1) — by design, since the spec is explicit that a pro-forma bill
  "must be clearly marked as a bill, not a receipt", and a receipt is
  precisely the document that carries the invoice number.
