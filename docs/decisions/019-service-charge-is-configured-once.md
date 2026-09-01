# 19. The service charge is configured once, and each order keeps the rate it was billed at

## Context

The service charge was a number a cashier typed into the bill screen on
every order. Nothing said what it should be, so nothing could be wrong:
5% on one table and 500 rupees on the next were equally acceptable to
the system. Reports could total the money but could not say what rule
had produced it, and a restaurant that wanted to stop charging one had
to ask every cashier to stop typing it.

## Decision

The charge is configured once, in Settings: enabled, a rate in basis
points, a display name, and whether it applies to dine-in only.

`ordering.computeServiceCharge` is the only function that works out a
service charge. `billOrder` and `previewBillTotals` both reach it
through `computeBillTotals`, so the amount previewed on the bill screen
is the amount the bill charges — not because two implementations agree,
but because there is one.

A cashier may still override the amount for one bill, including to
zero. An override while the charge is switched off is refused rather
than silently accepted.

`order.service_charge_rate_bp` stores the rate that produced the charge,
or NULL when no rate did — an override names no percentage. Every
screen, both ticket renderers and the order record read the rate from
the order, never from today's settings.

## Why

**A bill is a statement to a customer, and a rate is part of it.**
"Service Charge (5%) — Rs 96.50" is checkable arithmetic; "Service
charge — Rs 96.50" is a number the customer has to take on trust. The
rate has to be on the bill, which means it has to be knowable, which
means it has to be configured rather than typed.

**A percentage on a receipt must be one the amount actually came from.**
When a cashier waives or adjusts the charge, no rate produced the
result, so the order records none and the ticket prints none. Claiming
"(5%)" over an amount that is not 5% of anything would be a lie on a
document the restaurant hands to a customer.

**A rate change is not a correction of the past.** Raising the charge
from 5% to 10% is a decision about future sales. If historical orders
recomputed, every past receipt, every partner statement and every
payout sheet would silently disagree with the paper the customer
already holds — and the waiter who was paid 5% last month would appear
to be owed 10%. Storing the rate on the order makes the change
forward-only by construction, the same way `item_price` and
`line_allocation.share_bp_snapshot` already work.

**Disabled has to mean zero everywhere.** A restaurant that switches
the charge off is making one decision, not fourteen. The single
calculation is what makes that one decision reach the preview, the
bill, the receipt, the reports and the Z-report at the same moment.

## Consequences

- A restaurant upgrading from an older database gets the charge
  switched off with a zero rate, and charges nothing until an admin
  turns it on. Orders billed before the upgrade keep their charge and
  name no rate, which is exactly what happened: a human typed the
  amount.
- The rate is capped at 50% at the settings boundary. A typo that turns
  5% into 500% is refused where every other implausible number is.
- Reports read the service charge from the orders, not from the payout
  sheet, so a charge on an order whose waiter has since been removed is
  still counted as money the restaurant took.
