# Feature parity with the previous POS

The previous POS is the functional reference for this system. This
document classifies every meaningful function of it, so that nothing was
lost quietly. Four classifications:

- **Preserved** — the same capability, working the same way.
- **Improved** — the same capability, done better.
- **Replaced** — the need is met by a different mechanism.
- **Removed** — deliberately not carried over, with the reason.

A caveat worth stating plainly: the old POS's source was not available
while this was written. The rows below are the functions this project
was told about or could infer from the workflows the restaurant already
runs. If something the old till did is missing from this table, it was
missed rather than judged, and it belongs in the next pass.

## Sales workflow

| Old POS function | Class | Notes |
| --- | --- | --- |
| Start an order | Improved | Reachable from every screen (`+ New order`), not only the floor. Table optional on every order type — a counter sale is a real sale. |
| Pick order type (dine-in / takeaway / delivery) | Preserved | |
| Assign a waiter | Preserved | Required for dine-in, because the service charge and payout are attributed to a person. |
| Add items | Improved | One tap adds; a second tap increments the same line. A dialog appears only when the item genuinely needs an answer. |
| Choose modifiers | Improved | Required groups open pre-selected, so "Add" cannot produce the rejection the old flow produced. Min/max enforced server-side. |
| Change a quantity | Preserved | On the line, in the running bill. |
| Remove an item | Improved | Split into two operations: a correction before the bill is printed, a manager-approved void after. Both stay on the record (`docs/decisions/014`). |
| Kitchen note on an item | Preserved | Free text per line, printed under the line, and part of the historical record. |
| Customer name and phone | Preserved | Captured on takeaway and delivery, editable until the order closes. |
| Hold an order and come back to it | Improved | There is no "current order" at all: every order is addressable by id from any till, so two cashiers can never fight over one. |

## Bills, discounts, service charge

| Old POS function | Class | Notes |
| --- | --- | --- |
| Print a pro-forma bill | Preserved | Clearly marked "not a receipt"; no invoice number until it is paid. |
| Review the bill without leaving the order | Preserved | The bill is a dialog over the order screen, as it was on the old till, not a separate page. |
| Go straight from the bill to taking payment | Preserved | Printing the bill opens payment for that order. |
| "Printing failed — cancel / continue / retry" | Preserved | The old POS asked because a browser or a driver cannot tell a cancelled print from a completed one. Neither can this one, so it asks too. |
| Order-level discount | Improved | A reason is required for a non-zero discount, and both appear on the record and in the voids-and-discounts report. |
| Service charge as a rupee amount | Preserved | The cashier types rupees on the bill, as before — never a percentage. |
| Service charge | Improved | A configured rate does the arithmetic and seeds the field (on/off, rate, name, dine-in only); one calculation feeds every screen; each order keeps the rate it was billed at (`docs/decisions/019`). |
| Waive the service charge on one bill | Preserved | As an explicit override, recorded as naming no rate. |
| Bill total on screen before printing | Improved | Previewed by the server's own bill calculation, rounding included, rather than a second implementation in the browser. |
| Tax | Improved | Rule-driven and configurable, shipped with no rule active (`docs/decisions/010`). |

## Payments

| Old POS function | Class | Notes |
| --- | --- | --- |
| Cash | Preserved | |
| Change calculation | Improved | The cashier keys what was handed over; the bill takes what it can and the rest is change, recorded as `tendered`/`change` (`docs/decisions/013`). |
| Easypaisa | Improved | Now names the account the money landed in. |
| Bank transfer | Improved | As above. |
| Multiple accounts per method | Added | Zero blocks the method with a reason, one auto-selects, two or more require a choice — enforced in the service, not the screen (`docs/decisions/017`). |
| Reference number | Preserved | Optional, as it was: a customer paying in person often has none. |
| Split payment across methods | Preserved | Partial payments accumulate; the order stays awaiting payment until they add up. |
| Refunds | Preserved | Append-only reversal rows, never an edit. |

## Receipts and printing

| Old POS function | Class | Notes |
| --- | --- | --- |
| Print to a POS thermal printer | Preserved | ESC/POS over raw TCP, no dialog. |
| Print through Windows when there is no POS printer | Preserved | The server hands back the same ticket as HTML and the till opens the system dialog — Microsoft Print to PDF included (`docs/decisions/018`). |
| Reprint a receipt | Preserved | From the settled screen and from any historical order. Reprinting never re-takes money. |
| Receipt wording, header and footer | Improved | Configurable per restaurant instead of compiled in; an unconfigured install prints no identity rather than a placeholder. |
| Open the cash drawer | Preserved | Only on a receipt where cash was actually taken. |

## Historical orders and past transactions

| Old POS function | Class | Notes |
| --- | --- | --- |
| Look up a past order | Improved | A dedicated Orders section: today by default, any date or range, searchable by order number, invoice, customer, table, staff or payment reference. |
| See a past order in full | Improved | The complete record — order, items, financials, payments, partner split — on one read-only page (`docs/decisions/020`). |
| See how a past order was paid | Improved | Per payment: method, amount, account, reference, time, cashier, cash received and change. |
| Reprint from history | Preserved | |
| Historical prices and names | Improved | Snapshotted, so editing the menu cannot rewrite a past bill. |

## Reports

| Old POS function | Class | Notes |
| --- | --- | --- |
| Daily sales | Improved | Gross, discounts, net, tax, service charge and total collected, each on its own line, plus the payment-method breakdown. |
| Single-day reporting | Preserved | Both dates inclusive, so "31 August to 31 August" means that day. |
| Item mix | Preserved | With ownership shown per item. |
| Staff/owner consumption | Improved | Itemised: every item consumed, by whom, under which policy, and how it was settled — not a total per person. |
| Service charge owed per waiter | Preserved | |
| Voids and discounts | Preserved | With who did it, when, and why. |
| Partner statements | Improved | With a reconciliation whose variance must be zero. |
| CSV export | Preserved | Every report, from the same endpoint that draws the screen. |

## Shifts and cash

| Old POS function | Class | Notes |
| --- | --- | --- |
| Open and close a shift | Preserved | |
| Opening float | Preserved | |
| Count the drawer at close | Preserved | With the variance stated rather than hidden. |
| Z-report | Improved | Gross, discounts, voids, tax, service charge, cash, non-cash, cash received, change given, expected drawer, counted, variance, payment-method breakdown — in the order a manager reads them. |
| Waiter payout sheet | Preserved | |

## Configuration

| Old POS function | Class | Notes |
| --- | --- | --- |
| Menu, categories, prices | Improved | Prices are effective-dated, so a price change never edits a past sale. |
| Modifiers and modifier groups | Preserved | With min/max selection rules. |
| Item availability (86-ing) | Preserved | |
| Rename a menu item | Added | Safe only because names are snapshotted; audited. |
| Staff | Improved | Users (who can sign in) are separate from people (who eat staff meals) — `docs/decisions/015`. |
| Roles and permissions | Preserved | Enforced on the server, not just by hiding buttons. |
| Partners | Improved | Create, rename, mark as left, bring back, and a full record of what they own and are owed. |
| Ownership splits | Preserved | Effective-dated; past sales keep their shares. |
| Payment methods | Improved | In Settings beside the accounts they receive money into. A method is a TYPE — name, code, kind, active — with edit and activate/deactivate; a code already in use says so instead of failing with a server error. |
| Payment accounts | Improved | Add, edit, activate, deactivate, and a per-account "prints on receipt" that is independent of active — an account can take money without being advertised on the ticket (`docs/decisions/022`). |
| Account details on a past receipt | Improved | Snapshotted on the payment, so editing an account never rewrites a receipt or an order record from before the edit. |
| Payment accounts | Added | Easypaisa and bank accounts, activatable, never deleted. |
| Restaurant name and receipt details | Improved | In the database, set from Settings, not compiled in. |
| Printer address | Improved | Set from Settings; the environment variable is only a fallback. |

## Intentionally not carried over

| Old POS function | Reason |
| --- | --- |
| PIN-pad login | Replaced by a username and password typed on the keyboard, which is what the restaurant asked for. Every existing PIN still works as the password — a PIN was always just a short password, and migration `0011` derives usernames from names without touching a single credential. |
| A single "current order" per till | Removed deliberately. It is the mechanism by which two cashiers overwrite each other's work, and every screen here addresses an order by its own id instead. |
| Clearing an order opened by mistake | Preserved as deletion, and only for an order with no items, no payment and no figures (`docs/decisions/021`). Anything real is voided or refunded. |
| Deleting a menu item, an account or a partner | Removed in favour of deactivation. A deleted row orphans the answer to "what was on that bill" or "where did that money go" on every historical record that referenced it. |
| Editing a settled order | Removed deliberately. A settled sale is a financial record; corrections happen as refunds and reversals, which leave both the original and the correction visible. |

## Customer-facing features not present in either POS

Loyalty schemes, table reservations, a customer database, delivery-rider
dispatch and kitchen display screens are absent from both systems. They
are not regressions, and none of them is in scope here — this list
exists so nobody has to re-derive that answer later.
