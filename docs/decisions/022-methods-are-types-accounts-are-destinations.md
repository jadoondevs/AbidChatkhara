# 22. A payment method is a type; a payment account is a destination

## Context

`payment_method` carried `account_title`, `account_number`, `bank_name`,
`instructions_line` and `print_on_bill`. So the configuration screen for
"what can a customer pay with" also asked for an account holder and an
account number — and, because a method exists once, a restaurant with
two Easypaisa wallets had nowhere to put the second one until
`payment_account` was added later. After that the columns were two
answers to one question, and the older one was the one on the screen.

`print_on_bill` had the same shape problem in a worse place. It decided
whether a method's details printed on the bill, per METHOD. Hiding one
wallet from the ticket therefore meant deactivating it — which stops the
cashier taking payments into it. "Live, but not advertised" could not be
expressed at all.

## Decision

A **method** is what the customer paid with: a display name, a code, a
kind (cash, wallet, bank transfer, card) and whether it is active. That
is the whole of it, in the API and on the screen.

An **account** is where the money went: label, account title, number,
bank, active, and `print_on_receipt` — its own flag, independent of
`active`.

The bill's payment-options block is built from active accounts marked to
print, grouped under their method's name. A method with nothing to send
money to prints nothing.

`payment` records what the method and the account were CALLED when the
money arrived, and whether that account was printing then. The
`payment_account_id` link stays; what is printed and displayed comes
from the snapshot.

## Why

**The two questions have different cardinality.** One method, many
accounts. Any model that puts an account on a method is wrong the moment
a restaurant opens a second wallet — and this one did, then kept the
broken half on the screen.

**Independence is the whole point of the flag.** A restaurant that wants
customers paying into the counter wallet but not the delivery wallet is
making a printing decision, not a till decision. Tying it to `active`
forced them to choose between advertising an account and being able to
use it.

**A receipt is a record.** Correcting a spelling in an account holder's
name must not rewrite what a customer was handed three months ago, and
the same goes for the method's display name. The account details on a
reprint were a live join, which meant every past receipt silently
followed today's configuration — exactly what docs/decisions/020 forbids
for item names, for the same reasons.

**The print preference is snapshotted too.** A reprint has to reproduce
the ticket that was handed over. "Changing it affects future receipts"
means receipts for payments taken after the change; a payment already
taken carries the decision that was in force for it.

## Consequences

- Migration 0019 adds the flag and the snapshot columns and backfills
  both from what each row points at, so an install prints exactly what
  it printed the day before the upgrade.
- The superseded columns on `payment_method` stay. Dropping a column in
  SQLite means rewriting the table, and that data is what the backfill
  read; nothing writes or reads them now.
- A method's `code` is fixed once created. It is the identifier
  historical payments and reports refer to; the display name is the
  part that can change, and it is snapshotted where it matters.
