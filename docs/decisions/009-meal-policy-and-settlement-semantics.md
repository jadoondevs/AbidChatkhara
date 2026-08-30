# 9. What `meal_policy` charges, and what `settlement_type` means

## Context

The spec gives the consumption schema —

```
person(id, name, kind, active, meal_policy, meal_discount_bp)
   -- meal_policy: free | discounted | full_price | payroll_deduction
consumption_record(id, order_id, person_id, policy_snapshot,
                   menu_value_minor, charged_minor, settlement_minor,
                   settlement_type, created_at)
```

— and one paragraph of narrative: `charged_minor` is what the person
actually pays, driven by `meal_policy` and `meal_discount_bp`; "the
difference (`settlement_minor`) is recorded against `settlement_type`
(`house_expense`, `payroll_deduction`, or `partner_personal`)". That's
enough to build `free`, `discounted`, and `full_price` unambiguously.
It leaves one real question open: `meal_policy` and `settlement_type`
both have a value literally named `payroll_deduction` — one governs what
a person is charged, the other how an unpaid gap gets settled — and the
spec never says how a `payroll_deduction` *policy* interacts with a
`settlement_type` field that also carries that name.

## Decision

`meal_policy` decides `charged_minor` alone, computed by
`consumption/policy.ts`'s `computeMealCharge` — a pure function, same
shape as partners' `allocateOne`:

- `full_price`: `charged_minor = menu_value_minor`, `settlement_minor = 0`.
- `discounted`: split `menu_value_minor` by `meal_discount_bp` using
  `splitByShares` — the same exact, remainder-safe primitive behind
  every other split in this system — so `charged + settlement` is exact
  by construction, never independently rounded.
- `free` **and** `payroll_deduction` charge *identically*:
  `charged_minor = 0`, `settlement_minor = menu_value_minor`. Nothing is
  collected at the till either way — the till isn't how a payroll
  deduction gets collected. What differs between the two policies is
  only which `settlement_type` is expected: a `payroll_deduction`-policy
  person's settlement defaults to `settlement_type = 'payroll_deduction'`
  when the caller doesn't say otherwise; every other policy that leaves
  a gap (`free`, `discounted`) requires an explicit `settlement_type` —
  there's no sensible default, since e.g. a free meal could just as
  easily be a house gift as an owner's personal draw, and guessing wrong
  silently misbooks it.

`settlement_type` is otherwise the caller's choice at settlement time,
not a value hard-derived from `meal_policy` — the same person's
`discounted` shortfall might be `house_expense` one day and
`partner_personal` another, depending on who's actually eating and why,
and the schema has no way to know that from the policy alone.

The consumption_record schema (unlike `service_charge_entry`) has no
reversal column — a refund of a staff/owner meal order reverses the
payment and the partner allocation the same way any refund does, but the
consumption_record itself stands as the historical fact of what was
charged and settled at the time, exactly as the spec's schema shows it.

## Consequences

- `computeMealCharge` is pure and exhaustively property-tested
  (`consumption/policy.test.ts`): for any menu value, policy, and
  discount, `chargedMinor + settlementMinor` always equals
  `menuValueMinor` exactly.
- A `CHECK` constraint on `consumption_record` (migration 0008) makes the
  "`settlement_type` is null exactly when `settlement_minor` is zero"
  invariant impossible to violate at the database layer, not just in
  application code — the same "the database is the last line of
  defense" posture as every other CHECK constraint in this schema.
- `billing.settleConsumption` never needs to ask "was this paid in
  cash?" separately from "is there a `payment` row" — a free or
  payroll-deducted meal writes none, which is exactly how a later
  shift's expected-cash reconciliation excludes it without a special
  case (see ARCHITECTURE.md's "Consumption" section).
