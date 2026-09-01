# 18. Printing falls back to the browser; it never fails a sale

## Context

Printing went to a network thermal printer over raw TCP. With none
configured, the print routes answered `503` and the till showed
"Something went wrong: no printer configured" — over a sale that had in
fact completed. A restaurant without a POS printer, or with one that is
switched off, could not print a receipt at all.

## Decision

Print routes always answer `200` with an outcome:

- `{ method: 'thermal' }` — the configured printer took it.
- `{ method: 'fallback', reason, detail, html }` — nothing configured,
  or it could not be reached. `html` is the same ticket rendered for a
  browser, which the till prints through `window.print()` in an
  off-screen iframe.

That dialog is the operating system's, so Microsoft Print to PDF and
every installed Windows printer are available without the POS knowing
they exist.

## Why

**A print is not part of the transaction.** By the time either route is
called the bill is finalised or the payment recorded. A printer that is
off, missing or misconfigured has no bearing on whether the restaurant
was paid, and an error that implies otherwise teaches cashiers to
distrust successful sales.

**Two renderers, one calculation.** `renderReceiptTicket` (ESC/POS) and
`renderReceiptHtml` are both pure functions of the same
`ReceiptTicketData` that `buildReceiptTicketData` produces. Neither does
arithmetic. A total therefore cannot differ between the two print
paths — a test asserts the same amount and invoice number appear down
both — and adding the fallback added no second place for the money to be
worked out.

**Rendering server-side keeps it to one renderer.** The HTML could have
been assembled in the browser from a JSON ticket, but that would be a
third place receipt layout lives, in a different language, free to drift
from the other two.

**An iframe, not a popup or the main document.** A popup would be
blocked (by the time the server answers, the browser no longer
attributes the print to a click), and printing the main document would
print the POS around the receipt.

**Cancelled and printed are deliberately not distinguished.**
`afterprint` fires for both and the browser does not say which. Neither
is a failure: the sale stands, and Reprint receipt is available either
way. Treating a cancel as an error would be the old bug in a new place.

## Consequences

- A `PrintError` from the socket becomes a fallback rather than a `502`.
  Only a non-print fault still throws, because that is a real fault in
  this server.
- The `detail` field carries the underlying socket error, so whoever
  maintains the printer can still see why it was unreachable.
- Configuring a printer is optional. Settings says which mode the till
  is in rather than presenting the unconfigured state as incomplete.
- Account numbers are masked to their last four digits on a printed
  ticket: a receipt is handed over and then left on a table.
