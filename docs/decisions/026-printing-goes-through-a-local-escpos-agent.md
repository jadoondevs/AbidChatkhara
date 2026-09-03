# 26. Printing goes through a local ESC/POS agent, not the browser

## Context

The BIXOLON's Windows driver renders blank pages — confirmed on the
hardware. So the till could not print through Windows at all, and the
POS's `window.print()` fallback (docs/decisions/018 kept it as the
path for a till with no networked thermal printer) was, on this
hardware, a path that reliably produced blank paper AND hid the failure:
the browser cannot tell a completed print from a cancelled one, so a
blank page and a real one looked the same to the cashier.

A separate local Node service — the "agent" — solves the hardware
problem: it writes raw ESC/POS bytes to the printer, bypassing the
driver entirely. It runs on the till at `http://127.0.0.1:7777`, exposes
`GET /health` (reachable? — prints nothing) and `POST /print`, and
queues jobs internally.

## Decision

The till's **browser** calls its **own local agent**; there is no
`window.print()` fallback any more.

- **The browser, not the server, talks to the agent.** Each till prints
  to the printer on its own counter, so "the printer" is a per-browser
  fact, exactly as `window.print()` was. A server calling `127.0.0.1`
  would only ever reach one machine's printer. So the front-end POSTs to
  `127.0.0.1:7777`, which also keeps the whole path on localhost and
  offline.
- **The server builds the payload; the browser only forwards it.** The
  agent's contract is a small JSON ticket. The server already assembles
  every field of it (`buildBillTicketData` / `buildReceiptTicketData`),
  and — the deciding reason — it **masks the account numbers there**
  (`****7890`), so the full number never reaches a browser that a
  customer's bill was printed from. New read-only endpoints
  `GET /api/orders/:id/bill-ticket` and `/receipt-ticket` return the
  masked payload.
- **A failed print throws, and is shown, never swallowed.** `printViaAgent`
  resolves only on `200 {ok:true}`; every other outcome rejects. The
  bill and payment screens turn that into a clear "it didn't print" with
  a Retry — and, because the sale is already finalised (018), a way to
  carry on — but never a silent fall-back to Windows, and never marking
  the order as printed when it wasn't.
- **The connection is shown live.** A `PrinterStatus` indicator polls
  `/health` and reads connected / not connected off the real hardware,
  replacing the old fixed "No POS printer is connected" sentence, which
  was about configuration, not reachability.

The agent is money in this decision only in that it must never receive
an un-masked account number; masking stays on the server for that
reason.

## Where the agent lives, and why it's committed alongside

The agent is in `agent/` in this repository, committed with the POS, but
**run as its own process** on the till.

- **Same repo** because it shares a contract with the POS: the ticket
  payload shape is defined on both sides, and a change to it must land
  in both at once. One repo makes that a single commit and a single
  source of truth; two repos invite silent drift where the POS sends a
  field the agent doesn't print.
- **Its own process** because it is a localhost daemon that must be up
  whenever the till takes payment, restart on failure, and start at
  boot — a lifecycle the POS server does not share.
- It is **not** an npm workspace and pulls in **no dependencies**: it is
  plain Node ESM with its own `node --test` suite, so it neither drags
  the POS's toolchain onto the till nor gets swept into the POS's
  vitest/eslint/tsc runs. The root ESLint ignores `agent/**` for the
  same reason.

## Consequences

- The server's older thermal-printer path (a networked printer by IP,
  `printBill`/`printReceipt` returning a `PrintOutcome`, and the
  `/print-bill` / `/print-receipt` / `test-print` routes) is no longer on
  the till's print path. It is left in place — still rendering, still
  tested — rather than torn out in the same change; the front-end simply
  no longer calls it. A later cleanup can remove it.
- The in-app receipt **preview** (Settings, and the print dialog) is
  untouched: it renders HTML through `renderBillHtml`, which has nothing
  to do with how the ticket is finally printed.
- Print darkness now lives in the agent's own config (`PRINTER_DENSITY`),
  because the agent is what emits the ESC/POS. The Settings "Print
  darkness" control, which drove the old server path, is gone from that
  screen.
