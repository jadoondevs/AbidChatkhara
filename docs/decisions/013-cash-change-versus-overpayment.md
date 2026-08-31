# 13. Cash overpayment is change; every other method rejects it

## Context

`recordPayment` rejected any payment above the remaining balance:

    payment of 200000 exceeds the remaining balance of 180000

That made the single most common transaction in the restaurant — a
customer handing over an Rs 2,000 note for an Rs 1,800 bill — an error
the cashier had to work around by computing the change themselves and
keying the exact bill amount.

## Decision

For a **cash** payment, the amount applied to the bill is capped at the
remaining balance and the excess is change. For every other method
(wallet, bank transfer, card) an overpayment is still rejected.

`payment.amount_minor` stores only the amount **applied**. What the
customer handed over and what was handed back are stored alongside it,
in `tendered_minor` and `change_minor`, and nothing financial is derived
from them.

## Why

**Cash and a transfer are different in kind, not in degree.** Change can
be handed back from the drawer; an Easypaisa transfer of Rs 200 too much
cannot. Treating them the same would either make change impossible or
silently accept an over-transfer that the restaurant then owes back
through a channel the POS has no way to reverse.

**Storing the applied amount is what makes every downstream figure stay
correct with no changes at all.** Sales, partner allocations, the
invoice-closing check ("do payments sum to `total_minor`?") and the
shift's expected cash all read `amount_minor`. Because change never
enters it, none of them needed to learn that change exists — the drawer
nets out to exactly what was applied, which is exactly right. The
alternative, storing the tender and subtracting change everywhere, would
have put a correction term into five separate queries and made each one
a place to get it wrong.

**Change is neither a sale nor a refund**, so it gets neither a
`payment` row of its own nor an allocation reversal. It is money that
passed through the cashier's hands without ever belonging to the
restaurant. The two columns exist so the Z-report can show "cash handled
by customers" beside "cash that stayed in the drawer", and so a variance
investigation can see the tender — not so any total can be computed from
them.

## Consequences

- A cashier keys the note, not the arithmetic. The screen previews the
  applied amount and the change before they commit; the server computes
  both again, and its answer is the recorded one.
- Splitting still works unchanged: each payment applies against the
  balance remaining at that moment, so change appears only on the
  payment that closes the bill.
- A tender smaller than the amount being applied is rejected — that is a
  keying error, not a partial payment, and the partial-payment path is
  to key the smaller amount.
- Non-cash overpayment stays a 422 with the same message as before.
