# 1. Integer money and the branded `Paisa` type

## Context

This system computes real money for a live restaurant: line totals, prorated
discounts, tax, service charge, rounding, and — the part with zero tolerance
for drift — partner ownership allocations that must sum to the exact paisa.

Floating-point currency arithmetic is a well-known source of bugs that are
invisible in testing and expensive in production: `0.1 + 0.2 !== 0.3` in
IEEE 754 double precision, and the error compounds silently across a day's
worth of orders until a partner statement or a shift reconciliation is off
by a paisa or two with no discoverable cause. A restaurant's owners will
notice a wrong number on a partner statement long before anyone notices a
subtle rounding bug in the code that produced it.

Beyond float-vs-integer, a plain `number` for money also lets a quantity, a
percentage, or a basis-point share get passed where a money value belongs
(or vice versa) with no error until it's wrong in production — TypeScript's
structural typing means `number` and `number` are interchangeable no matter
what they represent.

## Decision

- Every monetary value is an integer number of paisa (1/100 of a rupee).
  There is no other representation anywhere in the system — not in the
  database (SQLite has no decimal type; columns are plain integers), not in
  the API (Zod schemas use `z.number().int()`), not in business logic.
- Money values are the branded type `Paisa = number & { readonly __brand: 'Paisa' }`,
  constructed only via `paisa(n)`, which rejects non-integers. The brand
  means a plain `number` cannot be passed where a `Paisa` is expected without
  an explicit, visible conversion — the type checker catches "quantity where
  money was expected" mistakes at compile time.
- All arithmetic on `Paisa` values goes through `packages/shared/src/money/`:
  `add`, `sub`, `negate`, `mulQty` (money × integer quantity), `distribute`
  (the largest-remainder split behind both discount proration and partner
  allocation — see ADR 2), and `roundToRupee`. Nowhere else may a `Paisa`
  value be multiplied or divided — `distribute` and `mulQty` are the only
  operations where that is ever meaningful, and both live inside this
  module. A workspace-wide test
  (`tools/money-arithmetic-guard`, run via
  `packages/shared/src/money`'s test suite and gated in CI) type-checks
  every source file with the TypeScript compiler API and fails the build
  if a `*` or `/` appears on a `Paisa`-typed operand anywhere outside this
  directory.
- `format()` — turning `Paisa` into a human-readable "Rs 1,234.56" string —
  is the only place money becomes a decimal, and it happens only at the
  presentation layer, never in a computation.
- This module lives in the shared workspace package
  (`packages/shared/src/money`), not only inside the server, because the
  frontend needs the identical `Paisa` type and `format()` function to
  display amounts the server computed — duplicating even display-only
  formatting logic between server and frontend would be a second place for
  a money bug to hide.

## Consequences

- A number can't silently become money, or money silently become a plain
  number, without an explicit `paisa()` call or a caught test failure —
  the type system and the guard test both have to agree to let it through.
- Every module that touches money imports from `@pos/shared`'s money module
  rather than writing its own arithmetic — the money pipeline (spec's
  "money pipeline" section) is implemented once, not once per module that
  needs a subtotal.
- Division always produces a remainder that must be explicitly accounted
  for (`distribute` returns parts that sum exactly to the input; nothing
  in this module returns a bare "rounded" quotient that silently drops a
  paisa). There is no code path that can produce money whose parts don't
  sum to the whole.
- The cost is a small amount of ceremony — `paisa(500)` instead of `500`,
  and reaching for `add`/`sub`/`mulQty` instead of `+`/`-`/`*` — paid once
  per call site, in exchange for a class of bug this system cannot afford
  to ship.
