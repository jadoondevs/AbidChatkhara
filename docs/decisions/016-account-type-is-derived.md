# 16. An account's type is derived from its payment method

## Context

Payment accounts have to distinguish an Easypaisa wallet from a bank
account: the payment screen groups them, the settings screen lists them
under separate headings, and a receipt prints them differently.

The obvious implementation is a column — `payment_account.account_type`
holding `'easypaisa'` or `'bank'`.

## Decision

There is no such column. `PaymentAccountSummary.accountType` is derived
from the owning `payment_method.kind`: a `wallet` method's accounts are
`easypaisa`, a `bank_transfer` method's are `bank`, anything else is
`other`.

## Why

**A stored type could disagree with the method it hangs off.** An
account already belongs to exactly one payment method, by foreign key.
Storing the type as well creates a second source of truth for the same
fact, and nothing would stop a row claiming to be a bank account while
sitting under the Easypaisa method — at which point the payment screen
and the receipt would disagree about what it is.

**The business rule is per-method anyway, not per-provider.** "An
Easypaisa payment needs an Easypaisa account" is a special case of the
rule the service actually enforces: *a payment by method X requires an
active account belonging to method X*. That generalisation is what
makes the code correct if the restaurant ever adds JazzCash or a second
bank — those get their own method, their own accounts, and their own
"no account configured" block, with no code change and no new enum
member.

**Grouping by method is better than grouping by type.** The Settings
screen groups accounts under their method's own display name, so a
restaurant with two wallet providers sees "Easypaisa" and "JazzCash" as
separate sections rather than both lumped under one hard-coded
"Easypaisa" heading.

## Consequences

- The API still exposes `accountType`, so a client can style or group by
  it without knowing about payment-method kinds.
- Adding a provider is a `payment_method` row, not a schema change and
  not a new enum value.
- `accountTypeForKind` is the one place the mapping lives; a kind with
  no natural provider (`card`) is `other` rather than being forced into
  one of the two.
