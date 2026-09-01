# 17. A non-cash payment must name the account it landed in

## Context

`payment.payment_account_id` was optional for every method. A wallet or
bank payment could be recorded without saying which of the restaurant's
accounts actually received the money — and with no accounts configured
at all, one could be recorded against nothing.

That is unreconcilable. At the end of the month somebody holds three
Easypaisa statements and a list of payments that cannot be matched to
any of them.

## Decision

`recordPayment` and `settleConsumption` resolve the account before
writing anything, and refuse the payment when they cannot:

| Active accounts for the method | Account given | Result |
| --- | --- | --- |
| 0 | — | **refused** — "No X account is configured…" |
| 1 | none | that account is used |
| 2+ | none | **refused** — "Choose which X account received this payment" |
| any | one | validated: exists, active, belongs to THIS method |

Cash is exempt entirely: it is handed over at the till and lands in the
drawer. Passing an account for a cash payment is itself an error.

## Why

**Refusing is better than recording something wrong.** The alternatives
to refusing a zero-account payment are to record `NULL` (the problem) or
to invent an account (worse). A refusal is recoverable in about a minute
by an admin; an unattributable payment is permanent.

**Auto-selecting one account is not the same as guessing.** With one
active account there is exactly one possible answer, so asking the
cashier is pure ceremony. With two there are two possible answers and
the POS has no basis to prefer either — picking the first would file
money in the wrong account silently, which is the failure this rule
exists to prevent.

**The rule lives in the service, not the screen.** The payment screen
disables what it can, but a rule about money has to hold for any caller
— a second terminal, a future integration, a script. `/api/payment-options`
exists so the screen shows the server's own words rather than
maintaining a second copy of the rule that can drift from it.

**One message for three rejection cases.** "No such account",
"inactive", and "belongs to another method" all mean the same thing to
the cashier — the account they picked cannot receive this payment — and
distinguishing them would leak which account ids exist.

## Consequences

- **An upgraded database has no accounts, so non-cash methods are
  blocked until an admin adds one.** This is the intended behaviour and
  is called out in the README's upgrade notes: a restaurant that takes
  Easypaisa must configure at least one account before its next
  service. Cash is unaffected.
- Historical payments recorded before this rule keep `NULL` and are left
  untouched — the rule governs new payments, and rewriting history to
  satisfy it would be inventing data.
- Deactivating the last active account for a method blocks that method,
  which is the same statement as "we no longer take Easypaisa".
