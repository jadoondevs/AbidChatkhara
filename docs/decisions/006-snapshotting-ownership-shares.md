# 6. Snapshotting ownership shares onto every allocation

## Context

Partner ownership changes over time — a partner buys in, sells out, or
two owners renegotiate a split on an existing dish. `item_ownership` and
`modifier_ownership` are effective-dated for exactly this reason (same
pattern as `item_price`: close the open row, insert a new one, never
edit `share_bp` in place).

But an *allocation* — a `line_allocation` row recording that a specific
partner is owed a specific number of paisa from a specific sale — is a
historical fact about a transaction that already happened. If a refund,
or a report re-run six months later, looked up ownership by joining
`line_allocation` to `item_ownership` at read time, then editing
ownership today would silently rewrite what a partner was owed for a
sale from before that edit. The spec is explicit that this must never
happen ("changing ownership later cannot alter historical statements") —
this is the general "snapshot, don't recompute" principle applied to the
one place getting it wrong would mean paying someone the wrong amount
for money that already changed hands.

## Decision

Every `line_allocation` row carries `share_bp_snapshot` — the exact
basis-point share used to compute that row's `amount_minor`, copied from
the ownership row that was active at the moment of allocation, not a
foreign key to it. A reversal (`reverseLineAllocations` /
`reverseOrderAllocations` in `partners/service.ts`) reads the
**original allocation row's own** `share_bp_snapshot` to compute the
reversing row's amount — it never re-looks-up current ownership, even
when reversing an allocation for an item whose ownership has since
changed completely. `getActiveItemOwnership`/`getActiveModifierOwnership`
(the effective-dated lookup) is called exactly once per line, at
allocation time; nothing downstream of that moment ever calls it again
for that same allocation.

## Consequences

- A partner statement for last month is unaffected by an ownership
  change made today, by construction — there is no query path from a
  historical `line_allocation` row back to the *current* ownership
  table at all, only to the snapshot already sitting on the row.
- A refund is correct even months after an ownership change, verified
  directly: `service.test.ts`'s "a refund reverses using the original
  snapshotted shares even after ownership has since changed" test
  changes ownership between allocating and reversing, and checks the
  reversing row still carries the original partner and the original
  `share_bp_snapshot`.
- The cost is one denormalized integer column per allocation row —
  cheap, and the alternative (recomputing history from current
  configuration) is exactly what principle 5 rules out.
