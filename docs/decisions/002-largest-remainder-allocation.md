# 2. Largest-remainder distribution for discounts and allocations

## Context

Two places in this system split an integer amount into parts by proportion,
and both require the parts to sum back to the exact original amount, not an
amount a paisa or two off:

- **Order-discount proration**: an order-level discount is spread across
  lines in proportion to each line's gross amount (spec: money pipeline,
  step 3).
- **Partner allocation**: a line's net sales are split across its owning
  partners in proportion to basis-point ownership shares (spec: the
  allocation engine).

Splitting an amount by percentage and rounding each part independently
does not sum back to the original amount in general — e.g. Rs 100 split
three equal ways is Rs 33.33 each by naive rounding, which sums to Rs 99.99,
losing a paisa. For discounts this is a rounding nuisance; for partner
allocations it is a correctness bug with a real owner's money attached, and
the spec is explicit that the allocation engine must "assert sum(amounts)
== allocation_base_minor exactly. If not, fail the bill close with a loud
error. Never write a partial allocation."

## Decision

Both cases are implemented as one primitive,
`distribute(total: Paisa, weights: number[]): Paisa[]`
(`packages/shared/src/money/distribute.ts`), using the largest-remainder
method:

1. Compute each part's exact proportional share, `total * weight_i / sum(weights)`.
2. Floor each part.
3. The whole amount left over after flooring (`total - sum(floors)`) is
   always a small non-negative integer, at most `weights.length - 1` —
   distribute it one paisa at a time to the parts with the largest
   fractional remainder.
4. Break ties by ascending index in the `weights` array — callers that need
   a specific tie-break order (e.g. "partner_id ascending", as the spec
   requires) simply pass weights pre-sorted by that key. `distribute`
   itself is generic over what a "key" means, so it makes no assumption
   about partner ids, line ids, or any other domain concept.

`splitByShares` (ownership, basis points summing to 10000) and `prorate`
(discount proration, weights are gross amounts) are both thin, named
wrappers over `distribute` — one algorithm, two call sites, so a fix or a
property test written once covers both.

The arithmetic is done in `bigint`, not floating point, so the floor and
the fractional-remainder comparison used for tie-breaking are exact
regardless of how large the amounts get — there is no float-precision edge
case to reason about at the boundary of `Number.MAX_SAFE_INTEGER`.

`distribute` asserts its own output sums to `total` before returning, and
throws rather than returning a partial result if that invariant is ever
violated — the "fail loudly, never write a partial allocation" requirement
is enforced structurally in the one function both call sites share, not
re-implemented at each call site.

## Consequences

- Property tests (`packages/shared/src/money/distribute.test.ts`) verify,
  over thousands of generated cases, that `distribute`'s output always sums
  exactly to the input, for both discount proration and share-based
  splitting — this is the strongest guarantee available short of a formal
  proof, and it is cheap to run on every change.
- The tie-break rule is deterministic and reproducible: the same total and
  weights, in the same order, always produce the same split — required for
  a refund to be able to reverse an allocation exactly, and for a report to
  be re-run and match a prior run.
- Because the primitive doesn't know about partners or order lines, the
  future cost-based allocation strategy mentioned in the spec (once
  inventory exists) is a new set of weights fed into the same `distribute`
  — not a new distribution algorithm to write and re-verify.
