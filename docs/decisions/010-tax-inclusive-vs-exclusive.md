# 10. What `tax_rule.inclusive` changes, and what it doesn't

## Context

The money pipeline is specified as one fixed sequence with one formula
per stage, run "in exactly this order":

```
5. Tax
   order.tax_minor = 0 at launch (no active tax rules).
   When enabled, computed from net_sales_minor per the active rules.
   Tax is NEVER part of the allocation base.

7. Rounding to nearest rupee
   pre_round = net_sales_minor + tax_minor + service_charge_minor
```

`tax_rule` carries an `inclusive` flag, but the spec never says how it
interacts with stage 7's formula. In ordinary tax terminology,
"inclusive" usually means the listed price already contains the tax, so
the customer's total shouldn't change when the rule is turned on — only
how much of what they're already paying gets *labelled* as tax. But
stage 7's formula is unconditional: it always adds `tax_minor` to
`net_sales_minor`. Read literally as written, there is no branch in the
pipeline where an inclusive rule's tax *doesn't* get added — and
`net_sales_minor` itself is fixed even earlier, at stage 3-4, well
before tax is computed, so there's no stage where "inclusive" could
instead mean "reduce net_sales_minor by the embedded tax so the total
stays the same." Doing that would also directly contradict the explicit
requirement that enabling tax must never change a partner's allocation
(`line.allocation_base_minor = line.net_sales_minor`, unconditionally,
at stage 8) — if turning on an inclusive rule shrank `net_sales_minor`,
every partner's allocation would shrink too, which is exactly the
outcome the spec's own definition-of-done test rules out.

## Decision

`inclusive` changes **how a rule's rate is applied to compute the
figure**, not **whether that figure gets added at stage 7**. Both modes
produce a genuine `tax_minor` that stage 7 adds to `net_sales_minor`,
unconditionally, exactly as written:

- **exclusive** (the default): `tax_minor = net_sales_minor * rate_bp / 10000`
  — a straightforward addition on top of the menu price.
- **inclusive**: `tax_minor = net_sales_minor * rate_bp / (10000 + rate_bp)`
  — the amount that *would* be embedded in a price of
  `net_sales_minor * (1 + rate_bp/10000)` if that price already included
  the tax. Because `net_sales_minor` here is always the pre-tax figure
  (fixed at an earlier pipeline stage, never adjusted for tax), this is
  smaller than the exclusive figure at the same nominal rate — but it is
  still added at stage 7, the same as an exclusive rule.

Both use one primitive, `proportionalAmount` (`packages/shared/src/money/rate.ts`):
`round_half_up(amount * numerator / denominator)`, with `denominator`
being `10000` for exclusive and `10000 + rate_bp` for inclusive.

This keeps stage 7's formula genuinely unconditional, matching the
spec's literal wording, and keeps `net_sales_minor` — and therefore
every partner's allocation — completely untouched by whether tax is on,
off, inclusive, or exclusive, which is what the spec's own
definition-of-done test actually checks.

## Consequences

- A restaurant that wants true "tax-inclusive menu pricing" (where the
  price on the menu is the price at the table, unchanged by turning tax
  on) needs to price its items *net of* the intended tax and use an
  inclusive rule only for how the receipt labels the split — not as a
  way to avoid the total changing. That's a real, documented limitation
  of `inclusive` as built here, not an oversight: the alternative
  (shrinking `net_sales_minor`) breaks the allocation invariant, and the
  spec is unambiguous that the invariant wins.
- `computeTax` (`tax/engine.ts`) is pure and takes only a line's
  already-discount-prorated `net_sales_minor`, the order's type, and the
  active rules — it never reads or writes `net_sales_minor` itself,
  so there's no code path by which enabling tax could reach a partner's
  allocation. Proven directly: `tax/service.test.ts` bills and closes an
  order with an active 16% rule and a configured partner, and checks the
  partner's allocation still equals the untaxed net sales exactly — the
  spec's own "enabling a test tax rule changes tax/totals but not
  partner allocations" check, end to end through a real close.
- Multiple applicable rules on one line stack additively, each computed
  independently against the line's own `net_sales_minor` — exact for
  the ordinary single-rule case, and a documented simplification for the
  rare case of two rules stacked on the same line (a fully compound
  calculation would need to know the rules' application order, which
  the schema doesn't capture).
