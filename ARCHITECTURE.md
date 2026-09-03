# Architecture

This document describes the system as actually shipped, kept current in the
same commit as any change that makes it wrong. For the reasoning behind a
specific, non-obvious choice, see `docs/decisions/`.

## Status

Built so far: **platform** (money type, event bus, SQLite/Kysely, migrations,
the durable sync-queue seam, ESC/POS printing), **identity** (users,
login, roles, audit log), **catalog** (categories, items, effective-dated
prices, modifier groups/modifiers, availability), **ordering** (orders,
lines, order-level discount proration, the open→billed pro-forma-bill flow,
line and order void), **partners** (partners, effective-dated ownership
shares, the pure allocation engine, the append-only allocation ledger with
snapshotted-share reversal), **billing** (payment methods, split
payments, the billed→closed settlement transition with gap-free invoice
numbering, refunds, bill/receipt printing), **gratuity** (the service
charge recorded as a liability held for the waiter, never revenue; its own
append-only ledger with reversal on full refund; waiter payout totals),
**consumption** (staff and owner meals — a named person, a per-person
meal policy that decides what they're charged, and a settlement record
for the gap, all while the owning partner is still credited in full),
**tax** (configurable rules, shipped active-rule-free so `tax_minor` is
zero everywhere until a manager turns one on), **shifts** (open/
close, cash reconciliation scoped to what actually moved through that
shift, a Z-report, and the waiter payout sheet), **reporting** (all
six spec-required reports, CSV-exportable, built on the other modules'
own read seams rather than re-deriving their figures), and the
**frontend** (an installable React PWA covering all twelve screens,
served by this same server process). The system is complete: a seed
script populates a demo restaurant, and
`apps/server/src/definition-of-done.test.ts` runs the spec's entire day
end to end — offline, against a real printer socket — checking every
closing figure the definition of done names.

## Why local-first and single-writer

This runs a single restaurant's till. It has to keep taking orders,
printing bills, and closing sales with no internet connection — Wi-Fi to
the printers and tablets is the only network dependency that can never be
allowed to fail the business. That constraint shapes almost everything
else:

- **One process, one database file, one writer.** SQLite in WAL mode
  (`apps/server/src/platform/db`) gives one writer and many concurrent
  readers against a single file with no server process of its own to keep
  running, back up, or fail over. There is no multi-device write path to
  reconcile, no eventual consistency, no conflict resolution — a whole
  class of distributed-systems problems simply doesn't exist here, because
  it doesn't need to. Terminals (tablets) are thin clients against this one
  server over the restaurant's local network; nothing is ever written
  directly by a terminal.
- **Everything the business needs to keep running is local.** Orders,
  bills, payments, and shift close all work with the server unreachable
  from the internet — because the server never needs the internet for any
  of that. Anything that does need the internet (today: nothing at
  launch; eventually, tax e-invoicing) goes through
  `platform/sync-queue` — a durable, retrying queue backed by the same
  SQLite database, so a task survives a server restart and gets retried
  with backoff rather than being attempted once, inline, and lost if the
  connection is down. Nothing customer-facing ever blocks on that queue
  draining.
- **better-sqlite3's synchronous API is used as-is, not wrapped in an
  artificial async layer** (a worker thread, a queue, a promise wrapper
  around a callback that was never actually async). A single writer with
  synchronous calls is simpler to reason about than any alternative that
  reintroduces concurrency this system doesn't need. Kysely's query
  builder API is Promise-based (that's Kysely's normal API surface, and
  what `dependencies` on that library get), but the underlying execution
  against better-sqlite3 is still synchronous, single-threaded, and
  immediate — there's no real asynchrony being added, just the type of
  interface Kysely exposes.

## Module layout

```
apps/server/src/
  identity/       users, username/password login, roles, audit   [BUILT]
  platform/       event bus, money-adjacent infra, db/migrations,
                  sync-queue, ESC/POS printing                   [BUILT — see below]
  catalog/        items, categories, modifiers, prices           [BUILT]
  ordering/       orders, order lines, discounts, lifecycle      [BUILT — open/billed/voided; see below]
  billing/        payments, bill/receipt printing, invoice #s    [BUILT — see below]
  tax/            configurable tax rules (disabled at launch)    [BUILT — see below]
  partners/       partners, ownership shares, allocation engine  [BUILT — see below]
  consumption/    staff and owner meals                          [BUILT — see below]
  gratuity/       service charge, waiter attribution              [BUILT — see below]
  shifts/         shift open/close, Z-reports                    [BUILT — see below]
  reporting/      read-only cross-module queries                 [BUILT — see below]

packages/shared/src/
  money/          the Paisa branded type + all money arithmetic  [BUILT]

apps/frontend/    React PWA                                      [BUILT — see below]
```

Each module owns its own database tables and exposes a service interface
(plain async functions taking a `Kysely<Database>` and returning typed
results) — other modules call that interface, never another module's
tables directly. Kysely needs one `Database` schema type to query against;
`apps/server/src/platform/db/types.ts` is the one place that composes each
module's own `XxxTables` interface into it, so the "who owns which table"
boundary is enforced by where a table's type is *defined* (in that
module), not weakened by where Kysely's schema type has to live.

### Where the money module actually lives, and why

The spec's module list names `platform/money`. The money module instead
lives in the shared workspace package,
`packages/shared/src/money`, consumed by both `apps/server` and (once it
exists) `apps/frontend` as `@pos/shared`. This is a deliberate deviation:
the spec separately requires "shared types between server and frontend via
a workspace package", and money is exactly such a type — the frontend
needs the identical `Paisa` type and the identical `format()` function the
server uses, not a re-implementation of currency formatting maintained in
two places. See `docs/decisions/001-integer-money-and-paisa-type.md`.
Everywhere else, "platform/" concerns (the event bus, migrations, the
sync-queue, and printing once it's built) live in `apps/server/src/platform`,
matching the spec's layout exactly, because those are genuinely
server-only (they touch the filesystem, TCP sockets, or the database) with
nothing for the frontend to share.

## Domain events

`apps/server/src/platform/events` is an in-process, synchronous
publish/subscribe bus (`EventBus`). The event map
(`platform/events/types.ts`) starts empty on purpose: `platform/` doesn't
know what `ordering` or `billing`'s events look like. A module that
publishes an event augments the map via TypeScript declaration merging
where it defines the event, e.g. (illustrative — `ordering` doesn't exist
yet):

```ts
declare module '../../platform/events/types.js' {
  interface DomainEventMap {
    OrderClosed: { orderId: number; invoiceNo: number; closedAt: string /* ... */ };
  }
}
```

so `eventBus.on('OrderClosed', handler)` is fully typed without
`platform/` ever importing from a domain module. `OrderClosed`,
`OrderVoided`, `RefundIssued`, `PaymentRecorded`, and `ShiftClosed` will be
added as the modules that emit them are built (ordering, billing, shifts).
Nothing subscribes to anything yet — the bus exists and is tested, but its
only current subscribers are its own test suite's fixtures.

**Where inventory and staff management will plug in**: both are explicitly
out of scope for this build (see the original spec's "Scope — do not
build"). The seam for both is this event bus: inventory will subscribe to
`OrderClosed` to deduct stock and will eventually supply an alternative
weight to the partner-allocation `distribute()` primitive (a cost-based
allocation mode, behind the same strategy interface the
`NET_SALES_EX_TAX` mode will use); staff management will subscribe to
`OrderClosed`/`ShiftClosed` for `payroll_deduction` consumption records and
service-charge payout data. Neither module exists, and none of today's
code imports from where they would live — the event bus is the whole
integration surface they'll need.

## Identity and attribution

Every mutation anywhere in the system is expected to record who did it,
when, and from which terminal (audit_log — `identity/tables.ts`). Login
(`identity/auth.ts`) takes a username and a password and issues a bearer
token whose *hash* (not the token itself) is stored in the `session`
table, bound to the terminal it was issued from; a Fastify `preHandler` hook resolves that token into
`request.actor` for every route. A module that needs to attribute a write
takes an `ActorContext { actorId: number | null; terminalId: string }` —
`actorId: null` is reserved for a genuine system action with no human actor
(e.g. the eventual seed script creating the very first admin account,
which can't attribute itself to a user that doesn't exist yet).

**Credentials.** The stored secret is a salted scrypt hash of whatever
the user types — a 4-digit PIN carried over from the tablet era, or a
real password. Both go through one code path (`identity/credentials.ts`)
and one column, `user.pin_hash`, which keeps its original name because
renaming it would rewrite every deployed database's schema for a
cosmetic gain. Usernames are normalised (trimmed, lowercased) on the way
in and on the way to a lookup, so the unique index on `user.username`
means what it looks like it means.

A wrong password and an unknown username return the same answer, and
take the same time: the miss is verified against a throwaway hash rather
than returning early, so a login form cannot be used to enumerate who
works here. A credential change is audited as *having happened*, never
with the old or new value — a hash in the audit log would be an
offline-crackable copy of every password the restaurant has ever used,
sitting in the one table nothing is ever deleted from.

**Two rosters, on purpose.** `/api/users` is the admin's view: it
carries usernames and active flags and is manager+. `/api/roster` is
names only, readable by anyone signed in, and is what the floor board
and the waiter picker use — a waiter who cannot see their colleagues'
names cannot take a dine-in order, which is what a single manager-only
list was quietly causing.

Roles (`server | cashier | manager | admin`) are ranked
(`identity/roles.ts`, `hasAtLeastRole`) so a route can require "at least
manager" without hard-coding every qualifying role — used wherever the
spec names a minimum role for an action (e.g. ownership edits require
manager). Where the spec instead names an exact, non-hierarchical actor
("the cashier enters the service charge"), the code checks the role
directly rather than via the hierarchy helper.

## Auth is wired once, globally, not per-module

The bearer-token-to-`request.actor` resolution used to live inside
`identity`'s own route plugin as a `preHandler` hook. That only ever
protected identity's own routes: Fastify's plugin encapsulation means a
hook registered inside one plugin does not apply to a sibling plugin
registered separately (`app.register(catalogRoutes, ...)` next to
`app.register(identityRoutes, ...)`) — each plugin is its own
encapsulation context. Adding `catalog` surfaced this, so the hook moved
to `app.ts`, registered on the root app instance before any route plugin
is registered; every module's routes now get `request.actor` for free.
`identity/require-auth.ts` exports the reusable `requireAuth`/`requireRole`
helpers every module's routes call — a plain function taking
`(request, reply)`, not tied to any one plugin's closure.

## Catalog

Items, categories, modifier groups/modifiers, and item availability
(`apps/server/src/catalog`). Two things worth calling out:

- **Only prices are effective-dated.** `item_price` follows the same
  "close the open row, insert a new one, never update in place" pattern
  ownership shares will use later (see the spec's partners section) —
  enforced both by the service function (`setItemPrice`) and by a partial
  unique index (`item_price(item_id) WHERE valid_to IS NULL`) so at most
  one row can be open per item even if a caller bypassed the service
  layer. Every other catalog field (an item's name, a modifier's price
  delta, a category's sort order) is a plain mutable column — the spec's
  domain model only shapes `item_price` this way, and a sale's own
  `order_line` row will separately snapshot the unit price actually
  charged, so catalog-level price history and a specific sale's price are
  two different things protected two different ways.
- **`item_availability` is a 1:1 sidecar, not a log.** One row per item,
  updated in place (there's no historical-sales reason for it to be
  append-only), created automatically alongside the item itself so no
  caller ever has to handle "no availability recorded yet" — `createItem`
  always inserts both rows in the same call. `changed_by`/`changed_at`
  plus the same `audit_log` entry every mutation writes are enough
  history for "who last 86'd this item and when" without a full ledger.

## Ordering

Orders, order lines, and order-line modifiers (`apps/server/src/ordering`).
This module builds the order lifecycle up through the pro-forma bill —
`open → billed` — and voiding, both line-level and whole-order. It
deliberately stops there: `billed → closed` (invoice numbering, partner
allocations, payment recording) is the billing module's job (a later
milestone), because closing needs machinery — a dedicated invoice counter,
the partner allocation engine, payment rows — that doesn't exist yet. See
docs/decisions/005-ordering-stops-at-billed.md.

- **No current order, anywhere.** Every mutating route takes an explicit
  order id (`/api/orders/:id/...`); there is no route, no server-side
  session field, no in-memory map keyed by terminal, that means "the
  order this terminal is working on". Two terminals editing two different
  orders never interact; the test proving this
  (`service.test.ts`, "every order is independently addressable") adds
  lines to two orders concurrently via `Promise.all` and checks each
  order ends up with only its own lines.
- **The money pipeline is recomputed from scratch on every change**, not
  updated incrementally: `recomputeAndPersist` re-pulls every non-voided
  line (using each line's own already-snapshotted unit price — a line's
  price is fixed at the moment it's added and never re-fetched from the
  catalog afterward) and re-runs `computeOrderPipeline`
  (`ordering/pipeline.ts`) every time a line is added or voided, or the
  discount changes. There is no incremental "subtract this line's old
  contribution, add its new one" logic to keep in sync with the database
  — the database is re-derived from its own current rows every time,
  which is simple enough to trust and cheap enough (a handful of rows per
  order) not to optimize.
- **`order.version` is bumped on every write**, but in this milestone it's
  forward-looking infrastructure more than an active guard: every
  mutation here reads the current version and writes it back inside one
  transaction, and Kysely serializes concurrent `.transaction()` calls
  against this server's single SQLite connection, so no caller can
  actually observe a stale version between two calls today. What
  prevents an invalid double-transition right now is each function's own
  status check (e.g. `billOrder` requires `status = 'open'`) — proven by
  a test that fires two concurrent `billOrder` calls at the same order
  and checks exactly one succeeds. `ConcurrentModificationError` becomes
  load-bearing once a caller supplies a version it read *separately*
  from the mutating call — exactly the spec's double-close test, which
  the billing milestone's close operation will implement on top of the
  same `versionedUpdate` helper already here.
- **Order-level discount proration happens twice**, not once: first
  across lines (by each line's full gross), then, within a line, again
  across the item's own portion and each of its modifiers' portions — so
  a modifier with its own partner ownership (spec: "modifier ownership is
  optional") gets its own `net_sales_minor`/`allocation_base_minor` for
  the allocation engine to use later. See
  docs/decisions/004-order-line-modifier-allocation-breakdown.md.
- **Tax comes from the `tax_rule` engine** (see "Tax", below), which
  ships with no rule configured and therefore charges zero until a
  restaurant that must charge it says so.
- **The order records who it is for, and each line what the kitchen was
  told.** `order.customer_name` / `order.customer_phone` and
  `order_line.note` (migration 0018) are free text and optional — a
  delivery cannot be delivered without a name and a number, a dine-in
  table normally has neither. The customer stays editable until the
  order closes, a note only until the bill is printed: by then it has
  been acted on, and rewriting it would change the record of what was
  actually cooked. Two otherwise identical lines with different notes
  never merge, because merging them would send one instruction to the
  kitchen and drop the other.
- **A modifier selection is validated against its group's min/max**, not
  just checked for existing ids — `addLine` rejects a selection that
  doesn't satisfy every linked modifier group's `min_select`/`max_select`
  (the spec's "choose your protein: min 1 max 1"), and rejects a modifier
  that belongs to a group not linked to the item at all.

## Partners and the allocation engine

`apps/server/src/partners`. The spec calls this "the most important code
in the system" and asks for it to be isolated as a pure function with no
database or I/O — `partners/engine.ts` is exactly that: `allocateOne`
takes a base amount and a set of ownership shares and returns amounts,
nothing else, wrapping the money module's `splitByShares` and re-
asserting the exact-sum invariant itself (defense in depth — `distribute`
already guarantees it, but the spec asks for the check at this layer
too, "never write a partial allocation"). `partners/service.ts` is the
database-facing orchestration around it: ownership CRUD, and
`allocateOrder`, which reads an order's lines, looks up ownership at a
given instant, and writes `line_allocation` rows.

- **`allocateOrder` isn't called from anywhere yet.** Like ordering
  stopping at "billed" (docs/decisions/005), this milestone builds and
  exhaustively tests the orchestration without wiring it into a real
  close transaction — there's no `closed` order to allocate for yet. The
  billing milestone's close operation will call `allocateOrder` (and, for
  refunds, `reverseLineAllocations`/`reverseOrderAllocations`) as part of
  its own transaction; nothing about their shape needs to change to be
  called that way.
- **A whole item's ownership split is replaced together**, never one
  partner's row at a time — `setItemOwnership` takes the complete new
  split, closes every currently-open row for the item, and inserts the
  new ones inside one transaction, so "shares sum to exactly 10000" can
  be checked before anything is written. Same effective-dating pattern
  as `item_price` (see the Catalog section above), applied to ownership.
- **A bulk apply is the same write, repeated, in one transaction.**
  `setOwnershipForCategories` gives every active item in the chosen
  categories one split, by calling the same per-item write inside a
  single transaction — so a fifty-item menu is two operations rather
  than fifty, and a failure halfway leaves nothing half-written. Each
  item still gets its own `item.set_ownership` audit entry: a bulk
  change is fifty changes to fifty items' money, and the log should say
  so item by item. Inactive items are skipped — a retired item cannot be
  sold, so there is nothing to allocate.
- **An item nobody owns cannot be sold, and the Menu screen says so.**
  Allocation splits every line's net sales across its owners, and a line
  with no owners and a nonzero base makes `splitByShares` throw rather
  than write a partial allocation — so an unowned item takes a cashier
  all the way to payment and then fails. `listItemsWithoutOwnership`
  (`GET /api/ownership/unset-items`) is what the Menu screen flags each
  such item with, where the person who can fix it is already standing.
- **Ownership shares are snapshotted onto every allocation** —
  `line_allocation.share_bp_snapshot` — so a later ownership change, or a
  refund computed after one, can never alter a historical allocation.
  See docs/decisions/006.
- **A modifier with no ownership of its own follows its item's** — its
  value simply stays inside the line's own allocation base rather than
  being carved out into a separate `line_allocation` target. A modifier
  that *does* have its own ownership rows gets its own target, and the
  item's own base is reduced by exactly that modifier's share so nothing
  is double-counted. See docs/decisions/004, from the ordering milestone,
  for why `order_line_modifier` carries its own allocation breakdown in
  the first place.
- **The allocation-base mode is a label threaded through, not a branch
  the engine takes.** `AllocationBaseMode` (today, only
  `'NET_SALES_EX_TAX'`) is attached to every `AllocationTarget` by the
  caller and copied onto every output row and onto `line_allocation`
  itself — the engine never inspects it. A future cost-based mode (once
  inventory exists) is a caller computing a different base figure and
  passing a different label; the engine and the shape of a
  `line_allocation` row are unaffected.
- **The "nightly integrity job"** the spec asks for alongside write-time
  enforcement is `checkOwnershipIntegrity`
  (sweeps every active item's, and every owned modifier's, active shares
  for a sum that's neither 0 — unconfigured, not an error — nor exactly
  10000) plus `scheduleOwnershipIntegrityCheck`, which runs it on an
  interval (default 24h) from `index.ts` and logs any violation found —
  there's nowhere else for a background finding like this to surface yet.

## Billing, payments, and printing

`apps/server/src/billing` implements stage 2 of the spec's two-stage
billing flow (ordering built stage 1 — see the Ordering section above):
payment methods, split payments, the `billed -> closed` settlement
transition, refunds, and bill/receipt printing.

- **Closing an order is one transaction spanning three modules'
  service functions**, not billing reaching into ordering's or
  partners' tables. `recordPayment` — once payments sum to
  `total_minor` — calls `allocateInvoiceNumber` (billing's own
  counter), `partners.allocateOrderInTransaction`, and
  `ordering.closeOrderInTransaction`, all inside the one transaction it
  already opened to insert the payment row. Each of those three
  functions exists in exactly this composable, no-transaction-of-its-
  own shape (see the refactor commit at the start of this milestone)
  specifically so this could be one atomic commit rather than three
  separately-committed steps with a window for a crash to leave them
  inconsistent.
- **Invoice numbers are allocated at settlement, never at print** — see
  docs/decisions/007. A bill printed first can close after a bill
  printed later and get the *higher* number; that's correct, not a race
  to fix.
- **The double-close and "settle out of print order" scenarios are both
  proven, not just designed for.** `billing/service.test.ts` fires two
  `recordPayment` calls at the same order via `Promise.allSettled` and
  checks exactly one succeeds — the other gets `OrderStateError`
  ("already settled"), not a duplicate invoice number or a duplicate
  allocation row. A second test bills four tables, settles them in a
  different order than they were billed (with one billed and settled in
  the middle of the others), and checks invoice numbers come out
  sequential and gap-free in *settlement* order, with every order's own
  total unaffected by the others.
- **A cash overpayment's change is computed, never stored.** `tenderedMinor`
  (what the customer handed over) is an input to `recordPayment` used
  only to compute `changeMinor` in the response — the `payment` row
  itself always records the applied amount, matching the spec's literal
  `payment` schema, which has no tendered/change columns.
- **A refund reverses through the same snapshot mechanism partners
  already built** (`reverseLineAllocationsInTransaction` /
  `reverseOrderAllocationsInTransaction`, docs/decisions/006) and records
  a negative `payment` row referencing the original via
  `reversed_by_payment_id` — both in the one transaction `refundOrder`
  opens, so a refund's ledger entry and its allocation reversal can never
  commit one without the other.
- **Printing is server-rendered and fire-and-forget.** `platform/printing`
  is a small, purposeful ESC/POS command builder (`ReceiptBuilder`) plus
  a raw-TCP client (`sendToPrinter`) — not a general ESC/POS library, just
  the handful of commands a bill/receipt ticket and a drawer kick need.
  `billing/printing.ts` assembles the actual ticket content (joining
  order lines back to catalog item/modifier names, since the ticket is
  rendered here, server-side, not by a frontend that already has that
  data) and sends it. A print failure (`PrintError`: printer off,
  wrong IP, connection timeout) never crashes the request that
  triggered it — order-taking and billing must keep working with a dead
  printer, per the local-first principle — it's mapped to a clean 502 at
  the HTTP layer instead.
- **The cash drawer only kicks on a receipt with a cash payment**, never
  on a bill (there's nothing to make change for yet) and never on a
  receipt paid entirely by wallet/bank transfer — `cashPaymentReceived`
  on `ReceiptTicketData` is exactly that check, computed from the
  order's actual payment rows.
- **The printer's address is environment-configured**
  (`POS_PRINTER_HOST`/`POS_PRINTER_PORT`), not a database table — the
  spec's screen list has no "printer config" screen, so this follows
  `POS_PORT`/`POS_DB_PATH`'s existing pattern instead of inventing an
  admin UI surface nothing asked for. Print routes respond `503` with a
  clear message when it's unset, rather than attempting to connect
  anywhere.

## Service charge / gratuity

`apps/server/src/gratuity` treats a service charge as money the
restaurant holds in custody for the waiter who earned it, never as the
business's own revenue — see docs/decisions/008 for the full reasoning.
The module is small on purpose: one append-only table
(`service_charge_entry`) and the service functions that write to it.

- **Recorded from billing's close transaction, not ordering's.** Ordering
  computes and validates `order.service_charge_minor` when a bill is
  printed (money pipeline stage 6), but the entry that actually credits a
  waiter only gets written once the order is *paid* —
  `recordServiceChargeEntryInTransaction` is called from
  `billing.recordPayment`'s close branch, alongside
  `partners.allocateOrderInTransaction`, inside the same transaction
  that also calls `ordering.closeOrderInTransaction`. An order that's
  billed but never settled never generates a payout entry, matching the
  spec: nothing is owed until money actually changes hands.
- **The liability framing is structural, not a filter.** Service charge
  never enters `subtotal_minor` or `allocation_base_minor` in the money
  pipeline (ordering) and is never summed into anything the partner
  allocation engine reads — there's no code path by which it could reach
  a partner's allocation, so no report or query needs to remember to
  subtract it back out. `gratuity/service.test.ts` checks this directly:
  an order with both a service charge and a partner-owned item closes
  with `sum(line_allocation.amount_minor) === netSalesMinor`, not
  `totalMinor`.
- **A no-op is the common case, not an error.** Most orders carry no
  service charge; `recordServiceChargeEntryInTransaction` reads
  `order.service_charge_minor`, returns `null` and writes nothing when
  it's zero, and only throws if it finds a *positive* charge with no
  waiter to attribute it to — a defensive re-check of a guard ordering's
  own `billOrder` already enforces, which should be unreachable in
  practice.
- **Reversal follows the full order, not the line.** A full-order refund
  (`refundOrder` with no `orderLineId`) reverses every not-yet-reversed
  entry for the order the same way partner allocation reverses — a new
  row with a negated amount, referencing the original via
  `reverses_entry_id`, never an edit — and is idempotent: calling it
  again finds nothing left to reverse. A **partial**, single-line refund
  deliberately does *not* touch the service charge: it's an order-level
  figure, not a per-line one, and the waiter is still owed it regardless
  of which item came back.
- **`waiterPayoutTotals` is the source of truth for what's owed** — it
  sums each waiter's entries (reversals net out automatically, since
  they're just negative rows in the same sum) and drops any waiter whose
  net is exactly zero, rather than a report deriving the figure by
  summing `order.service_charge_minor` across orders after the fact. It
  already takes an optional date range, ready for two later milestones to
  reuse the exact same query shape: shifts (8) scoping it to one shift's
  `opened_at`/`closed_at` window for the spec's payout sheet, and
  reporting (9) for a "service charge report, per date range."
- **What the charge IS comes from one function.**
  `ordering.computeServiceCharge` is the only place a service charge is
  ever worked out: from the `serviceCharge` settings group (on/off,
  rate in basis points, display name, dine-in only). `billOrder` and
  `previewBillTotals` both run it through `computeBillTotals`, so the
  amount the bill screen previews is the amount the bill charges, by
  construction rather than by two implementations agreeing. Switched
  off, it is zero everywhere at once — including a cashier's attempt to
  enter one by hand, which is refused rather than silently kept.
- **The rate that applied is stored on the order.**
  `order.service_charge_rate_bp` (migration 0016) records the rate that
  produced `service_charge_minor`, or NULL when no rate did — a cashier
  waiving or overriding the amount claims no percentage, because no
  percentage produced it. Every screen and both ticket renderers read
  the rate from the order, so a bill taken while the rate was 5% still
  reads 5% after an admin sets 10%, and a receipt reprinted a year
  later still matches the paper the customer took home. See
  docs/decisions/019.
- **No `gratuity/routes.ts`, deliberately.** The charge is configured in
  Settings (`PUT /api/settings/service-charge`), applied by ordering,
  and paid out through the shift's payout sheet. There is nothing left
  for a route of its own to do that isn't already reachable through
  those.

## Consumption (staff and owner meals)

`apps/server/src/consumption` implements the spec's "Staff and owner
meals": a named person (`person` — never free text, "so reports can
total per person") consumes food that goes through the ordinary sales
pipeline at full menu price, and what they actually pay is a completely
separate figure, driven by their own meal policy.

- **The order carries the full menu price; the discount lives entirely
  outside the money pipeline.** `channel: 'staff_meal' | 'owner_meal'`
  (already reserved on `order` since migration 0004) picks a person at
  order-creation time, the same moment a dine_in order picks its waiter
  — the spec's "Staff meal flow: pick person first". `setDiscount`
  actively refuses a non-zero order-level discount on such an order,
  because `net_sales_minor` doubles as both the pipeline's own figure
  *and* `consumption_record.menu_value_minor` — an order discount here
  would silently understate what the person owes AND what the owning
  partner gets credited for, the opposite of the spec's "partner
  allocations are written as usual, so the owning partner is credited
  for food that was actually consumed."
- **Ordering validates the person without importing consumption.**
  `createOrder` reads the `person` table directly via Kysely — active,
  right `kind` for the channel (`staff_meal` needs `kind: 'staff'`,
  `owner_meal` needs `kind: 'partner'`) — the same "read the table
  directly for a simple check" convention billing already uses for
  `order`/`payment_method` (see the Billing section above). Importing
  consumption's *service module* from ordering would create the one
  import cycle this codebase otherwise avoids end to end: consumption
  itself has to call back into ordering to close a settled meal, so the
  dependency has to run one way only.
- **Settling a meal is its own entry point, not a variant of
  recordPayment.** `billing.settleConsumption` is `recordPayment`'s
  sibling — same one-transaction shape (invoice number, partner
  allocation, service charge entry, `closeOrderInTransaction`) — but a
  different completion condition. `recordPayment` closes once payments
  sum to `total_minor`; a staff/owner meal is very often not paying
  `total_minor` at all, so `settleConsumption` instead computes
  `chargedMinor` from the beneficiary's policy
  (`consumption/policy.ts`'s pure `computeMealCharge`) and requires a
  payment for exactly that figure when it's positive, writing none when
  it's zero. Each entry point rejects the other's channel outright
  (`recordPayment` on a staff/owner meal, or `settleConsumption` on a
  customer order, both fail loudly rather than doing the wrong thing
  quietly).
- **"Must not count toward expected cash unless the person actually paid
  cash" falls out of that structurally, not as a special case.** A free
  or `payroll_deduction`-policy meal writes zero `payment` rows —
  there's nothing to collect — so a later shift's cash reconciliation
  will sum `payment` rows exactly the way it already does for every
  other order and simply never see one. No filter, no channel check
  anywhere in that future reconciliation code.
- **`meal_policy` decides what's charged; `settlement_type` is the
  caller's own choice for the gap, not derived from the policy** — see
  docs/decisions/009 for the full reasoning, including why `free` and
  `payroll_deduction` charge identically (nothing collected at the till
  either way) and differ only in what `settlement_type` defaults to.
- **The policy is snapshotted at settlement, not order-creation.**
  `consumption_record.policy_snapshot` freezes whatever the person's
  `meal_policy`/`meal_discount_bp` *are at the moment the order is
  settled* — same "snapshot, never recompute" rule as ownership shares
  (docs/decisions/006) — so a policy change afterward can never rewrite
  an already-closed consumption_record, provable the same way: settle,
  change the person's policy, reload the record, see it unchanged.
- **No reversal column on `consumption_record`, unlike
  `service_charge_entry`.** The spec's own schema for this table has no
  `reverses_*` field — a refund of a staff/owner meal order still
  reverses the payment and the partner allocation through the usual
  mechanisms, but the consumption_record itself stands as the
  historical fact of what was charged and settled.
- **`listConsumptionRecords`** is this milestone's reporting seam, the
  same role `waiterPayoutTotals` plays for gratuity: an itemised,
  date-range-filterable query (spec: "menu value, amount charged, and
  amount settled") that the reporting milestone builds its CSV export
  and cross-report rollups (the daily sales "combined total" line, a
  partner statement's customer-vs-consumption split) on top of, rather
  than re-deriving from `order` rows.

## Tax (configurable, shipped disabled)

`apps/server/src/tax` is the money pipeline's stage 5, built and wired
in now — "build the module and the schema now... ship with no active
rules" — so `tax_minor` is genuinely zero on every order today, and
turning it on later is a configuration change, never a code change.

- **`computeTax` (`tax/engine.ts`) is pure**, same shape as partners'
  `allocateOne` and consumption's `computeMealCharge`: given each line's
  already-discount-prorated `net_sales_minor`, the order's type, and a
  list of rules, it returns a tax figure per line and a total — no
  database, no I/O. `tax/service.ts`'s `computeTaxForOrder` is the
  DB-facing wrapper `ordering.billOrder` calls: it loads the order's own
  non-voided lines, each line's category (read directly from catalog's
  `item` table — the same convention as every other "just a lookup"
  cross-module read in this codebase), and every rule whose
  `valid_from`/`valid_to` window covers the instant of billing.
- **`inclusive` changes how a rule's rate is computed, never whether the
  result is added to the total** — see docs/decisions/010. The money
  pipeline's stage 7 total is one unconditional formula
  (`net_sales_minor + tax_minor + service_charge_minor`); making
  `inclusive` skip that addition would mean either breaking that
  formula or shrinking `net_sales_minor` to compensate, and the latter
  would shrink every partner's allocation too — exactly what the spec's
  definition-of-done test forbids. `tax/service.test.ts` proves the
  actual invariant end to end: bills and closes an order with an active
  16% rule and a configured partner, and checks the partner's allocation
  still equals the untaxed net sales exactly.
- **A new money primitive, not a reuse of `distribute`/`splitByShares`.**
  `packages/shared/src/money/rate.ts`'s `proportionalAmount` computes a
  single proportional amount (`round_half_up(amount * numerator /
  denominator)`) — unlike `distribute`, it isn't splitting a whole into
  parts that must sum back exactly, so ordinary rounding, not
  largest-remainder, is the right and simpler tool.
- **A tax rule's rate, scope, and inclusive flag are set once, at
  creation** — `updateTaxRule` only ever touches `name`/`active`/
  `valid_to`, the same "correcting a figure is a new row, never an edit
  to the historical one" principle as ownership and price
  effective-dating, applied here to activation rather than a value.

## Settings, and what is NOT compiled in

`app_setting` (migration 0012) is one key/value table holding a JSON
document per setting group — restaurant identity, receipt wording,
printer. One row per group rather than a column per setting, because the
set of settings grows every time a restaurant wants one more line on its
receipt, and each addition would otherwise be a migration. The shape is
enforced in code instead, by `settings/schema.ts`: one Zod schema per
group, parsed on write so a malformed value cannot be stored, and parsed
again on read so a hand-edited row falls back to defaults rather than
failing a print. A settings read is on the path of every bill, so it must
never be the thing that fails one. Partial documents are filled in
field-by-field from the defaults, so adding a setting does not invalidate
what a restaurant has already saved.

**No restaurant identity is compiled in.** The print templates take a
`TicketBranding` as input rather than reading settings themselves, which
keeps them pure functions and lets the printing tests assert on exact
bytes with no database. An installation that has configured nothing
prints a ticket with no name, address or phone — not a placeholder
somebody has to notice and remove.

**The printer is resolved per request, not at boot**
(`resolvePrinterTarget`): an address configured in Settings wins over the
`POS_PRINTER_HOST` the server started with, so an admin can move the
printer without restarting mid-service, and does not have to know that a
stale value exists in a `.env` file on the machine. Setting
`enabled: false` disables printing outright, which is what a restaurant
whose printer is away for repair actually wants — prints fail
immediately with a clear message instead of every bill stalling on a
connection that will never answer.

### The service charge group

`serviceCharge` is `{ enabled, rateBp, displayName, dineInOnly }` and
ships disabled with a zero rate, so an upgraded till charges nothing
until someone decides otherwise. It is readable by any signed-in user —
the bill screen has to show the charge and its rate is on the
customer's receipt — and writable only by an admin. `rateBp` is capped
at 5,000 (50%) at the schema boundary: a typo that turns 5% into 500%
should be refused where every other implausible number is.

## Payment methods and payment accounts are different tables for a reason

A **method** is what a customer paid with — cash, a wallet, a bank
transfer, a card. An **account** is where the money went, and one method
can have several: a restaurant with two Easypaisa wallets has one method
and two accounts.

The method table still carries `account_title`, `account_number`,
`bank_name`, `instructions_line` and `print_on_bill` from before
accounts existed. They are superseded and no longer read or written
(migration 0019) — they remain only because dropping a column in SQLite
rewrites the table, and 0019's backfill read them.

`payment_account.print_on_receipt` decides whether an account's details
print for a customer to pay into, and is **independent of `active`**.
The old per-method flag meant hiding one wallet from a ticket required
deactivating it, which stops the till using it; "live but not
advertised" is a real configuration and now has a representation. See
docs/decisions/022.

Every payment stores what the method and the account were CALLED when
the money arrived, and whether that account was printing then. The
`payment_account_id` link stays for reports that group by account; what
is printed and displayed comes from the snapshot, so correcting an
account holder's name never rewrites a receipt handed over months ago.

## Payment accounts

`payment_method` has always carried a single `account_title`/
`account_number`, which is enough to *print* one set of payment
instructions on a bill and cannot answer "which of our three Easypaisa
wallets received this transfer?". `payment_account` (migration 0013) is
that answer: its own row per account, referenced by
`payment.payment_account_id`.

The two coexist rather than one replacing the other, because they are
different things. A method's own account fields are the "pay us here"
line on a pro-forma bill — advertising an account. An account row is the
record of receipt. Accounts are deactivated, never deleted: a `payment`
references the one it landed in, and deleting it would orphan that
answer on every historical payment.

**A non-cash payment must name its account.** `recordPayment` and
`settleConsumption` resolve it through one rule before writing anything:
no active account for the method refuses the payment, exactly one is
used without asking, two or more with none chosen refuses rather than
guessing, and a chosen account is validated as active and belonging to
that method. Cash is exempt — it lands in the drawer. The rule is in the
service rather than the payment screen, because a rule about money has
to hold for any caller; `/api/payment-options` exists so the screen can
show the server's own words instead of keeping a second copy that drifts
(docs/decisions/017).

An account's type (easypaisa / bank) is derived from its payment
method's `kind` rather than stored, so the two can never disagree, and a
restaurant that adds a second wallet provider gets its own method, its
own accounts and its own block message with no code change
(docs/decisions/016).

**Cash change** is recorded here too, in `payment.tendered_minor` and
`payment.change_minor`. `amount_minor` stays exactly what it has always
been — the amount *applied to the bill* — so sales, partner allocations
and expected cash are all computed from it and are entirely unaffected
by change. The tender and the change exist for the audit trail and the
Z-report's "cash handled" line; nothing financial is derived from them.
That is why a cash overpayment needed no change to the shift
reconciliation at all: the drawer nets out to what was applied either
way.

Cash and non-cash diverge deliberately in `recordPayment`. Cash applies
what the bill can absorb and returns the rest as change, because an
Rs 2,000 note for an Rs 1,800 bill is the single most common transaction
in the restaurant and used to be an outright error. A wallet or bank
transfer of more than the bill cannot be handed back from the drawer, so
it stays a rejection the cashier has to resolve deliberately.

## Thermal darkness is the printer's job; emphasis is the heading's

A thermal head burns dots for a fixed time at a fixed intensity. How
dark ordinary text comes out is therefore a property of the PRINTER —
its density setting — not of the text, and the only text-level lever
that changes it is emphasis, which is also the ticket's one weight
difference.

Using emphasis for darkness costs the difference. That is exactly what
happened here: `init` emitted `ESC E 1` for the whole ticket and
`bold(false)` returned to that base, so a receipt printed dark and
uniform, with a total indistinguishable from the line above it.

So:

- `init` sends `ESC @`, `ESC M 0` (Font A, 12×24 — not Font B's thin
  9×17), `ESC t 0`, and `GS ( K` function 49 with the configured
  density level. Level 0 sends no density command at all.
- `bold()` is emphasis, and it turns off again. `ESC E 1` before a
  heading and a TOTAL, `ESC E 0` after, nothing emphasised in between.

`GS ( K` is the length-prefixed ESC/POS family: pL/pH say how many
bytes follow, so a printer that does not implement function 49 skips
exactly those bytes rather than printing them. That framing is why it
is this command and not `ESC 7 n1 n2 n3` or `DC2 # n`, which have no
length prefix and litter the paper on hardware that ignores them.

The level lives in Settings → Printer because the correct value is the
one that reads well on the paper in that restaurant, and no test in
this repository can see paper. Settings prints a test strip — one block
of ordinary text, one emphasised block, and the level that produced
them — which is the only acceptance test that means anything here. A
printer that ignores the command shows no difference between levels,
and the answer is then its own configuration utility.

## Printing: two renderers, one calculation

Receipts reach paper by one of two routes, and the choice is the
server's:

```
buildReceiptTicketData  ──┬──►  renderReceiptTicket  ──►  ESC/POS over TCP
   (the one calculation)  │
                          └──►  renderReceiptHtml    ──►  browser print dialog
```

`printOrFallBack` tries the configured printer and, when there is none
or it cannot be reached, returns the HTML instead. Both renderers are
pure functions of the same ticket data and neither does arithmetic, so a
total cannot differ between the paths — the frontend prints that HTML in
an off-screen iframe, which is how a till with no POS printer reaches
Microsoft Print to PDF and every other Windows printer.

Printing never fails a sale. By the time either print route is called
the bill is finalised or the payment recorded; a missing printer, an
unreachable one and a cancelled print dialog are all outcomes, not
errors (docs/decisions/018). Only a non-print fault still throws.

## Shifts

`apps/server/src/shifts` is shift open/close and cash reconciliation
(spec, screen 12): an opening float, a closing count, the variance
between them, a Z-report, and the waiter payout sheet — all scoped to
exactly what happened during that one shift.

- **At most one shift is ever open at a time**, enforced in
  `openShift` (SQLite has no direct "at most one row where X"
  constraint) — a second `openShift` call while one is already open
  fails with `ShiftStateError` rather than silently starting a second,
  overlapping shift.
- **`order.shift_id` is best-effort, not required** — `createOrder`
  tags a new order with whichever shift is currently open, if any, but
  does not refuse to open one when none is. See docs/decisions/011 for
  why: making an open shift a hard prerequisite would be the
  operationally correct rule, but it would also require every other
  module's test fixtures (which call `createOrder` constantly and have
  nothing to do with shifts) to open one first, for a rule real usage
  already satisfies on its own by opening a shift before the day's first
  order. `service_charge_entry.shift_id` follows the same rule, copied
  from the order at the moment gratuity records the entry — and a
  reversal always carries the *original* entry's `shift_id`, never
  whatever shift is open when the reversal itself happens, so a refund
  processed on a later shift still nets against the shift the original
  charge belonged to.
- **Refusing to close lists exactly what's blocking it.**
  `ShiftCloseBlockedError` carries the full list of orders tagged with
  this shift that are still `open` or `billed` (spec: "refuse to close
  while any order is still open or awaiting payment, listing which
  ones") — `shifts/routes.ts` maps it to a 422 with that list in the
  response body, not just a count.
- **And the same list is a query, not only a rejection.**
  `GET /api/shifts/:id/blocking-orders` answers it before the attempt,
  and each entry carries `lineCount` so the screen can offer to delete
  the ones that were never orders. The till used to learn about
  blockers only from a 422 and keep them in component state, so
  clearing one — deleting an empty order, taking the last payment —
  left it displaying a snapshot of a request that had since become
  wrong. Read live, deleting the last empty order removes the blocker
  and enables the close, because the server stops returning it.
- **Expected cash is opening float plus every unreversed *cash* payment**
  against an order this shift owns — wallet/bank payments never count
  (they're not physical cash in the drawer), and a cash refund is
  already a negative `payment` row, so it nets out of the same sum with
  no special case. A cash-collected service charge is already inside
  that same payment amount (it's part of what the customer physically
  handed over), so it's included in expected cash exactly as the spec
  requires ("included in total_minor and therefore in expected cash")
  without `computeExpectedCash` needing to know service charge exists
  at all — the figure the Z-report shows *separately*
  (`serviceChargeCollectedMinor`, from gratuity's own ledger) is what
  makes it visible as cash held, not earned, per the spec, rather than
  quietly folded into "sales."
- **The Z-report splits customer sales from consumption** (spec:
  "default the headline number to customer sales only, with consumption
  on its own line directly beneath it") by grouping `order.channel`
  within the shift, scoped by `order.shift_id`, rather than any date
  math — since a shift's own orders are the natural, already-correct
  scope, and by the time a shift is closeable every one of them is
  `closed` or `voided` (the close-blocking check above guarantees it),
  so summing every order regardless of status is equivalent to summing
  only the closed ones.
- **The payout sheet reuses gratuity's `waiterPayoutTotals`** with its
  `shiftId` filter, rather than shifts computing its own version of the
  same figure — one ledger, one query, two callers (this module's Z-report
  companion, and the reporting milestone's own per-date-range service
  charge report).

## The cashier's path: order → bill dialog → payment

The three screens a cashier lives in are deliberately not three
places.

- **The bill is a dialog over the order**, not a page of its own
  (`BillPanel`, opened from `OrderScreen`). Reviewing an order's total
  is a step in taking the order; leaving the screen to look at its own
  figures was a page change that bought nothing. `/orders/:id/bill`
  still renders the same panel as a page, so a reload or a bookmark
  lands somewhere sensible, and the panel itself is the one definition
  of what a bill shows.
- **Printing the bill opens payment for that order id.** The cashier
  who printed the bill is the person about to take the money for it.
  The old flow sent them back to the floor to find the order in
  "awaiting payment" — the longest detour in the day, and one that got
  longer as the restaurant got busier.
- **What the printer did is a question, not an outcome.** A browser
  cannot tell a saved PDF from a cancelled dialog: `afterprint` fires
  for both, and it fires for "printed" and "pressed Escape" alike. So
  anything that did not go straight to a thermal printer ends in
  `PrintDecision` — continue, retry, or cancel the sale — which is what
  the old POS asked, for the same reason. Cancelling uses the system's
  own mechanism: a void before payment, a refund after. Continuing is
  always safe, because by then the bill is finalised or the payment is
  recorded.

## Historical orders: the record

`apps/server/src/ordering/history.ts` answers one question —
"what actually happened on this order?" — as one read-only query, and
`GET /api/orders/:id/history` is the only route that serves it. The
frontend's `/orders/:id/detail` is the whole of it on one page: the
order's own header, its totals with the rate that produced them, its
lines under the names they were sold as, every payment with account,
reference, tender and change, and the partner split at the shares in
force when it closed. Opening it cannot modify anything, because there
is nothing there to modify with.

- **Every figure is read back, never recomputed.** Prices come from the
  order line (snapshotted since the order was taken), item and modifier
  NAMES from the line's own `item_name_snapshot` /
  `modifier_name_snapshot` (migration 0017), the service-charge rate
  from the order, the payment account and reference from the payment
  row, the ownership shares from `line_allocation.share_bp_snapshot`.
  Renaming a dish, changing the rate, or deactivating an account
  changes nothing on a past order. See docs/decisions/020.
- **People are the deliberate exception.** Waiter, cashier and partner
  NAMES are read live, because a person who marries and changes their
  name is still the person who served that table — the identity is the
  row, not the string. A renamed menu item, by contrast, is a different
  thing being sold.
- **The floor routes to it.** A completed order's row opens its record
  rather than the payment screen's "Paid in full" card; an
  awaiting-payment row still opens the till, because what that cashier
  needs is to take the money, and the record is one click away from
  there too.

## Floor and Orders are different questions

`getFloorBoard` answers "what is happening now": every live order, plus
a short tail of completed ones, refetched on a timer and watched by a
cashier. `searchOrders` answers "what happened": a date window, an
optional search term, and a hard limit.

They are separate because the failure modes are opposite. A floor that
grew to a thousand rows would be useless; a history that only showed
today would not be a history. And a lookup that loaded every order by
default is a screen that breaks precisely when the restaurant succeeds
— six months of trading is tens of thousands of rows to render twenty.

An order is dated by `COALESCE(closed_at, opened_at)`, so one opened at
11pm and paid at 12:10am belongs to the night it was paid for, and one
still open belongs to the day it was started on. Days are resolved in
the restaurant's own local time by `platform/date-range.ts`, the same
helper the reports use — it lives in platform/ because both need to
know what "today" means and neither should import the other to ask.

## Reporting

`apps/server/src/reporting` implements the spec's six required reports
— daily sales, partner statement, item mix, consumption, service
charge, void and discount — each CSV-exportable. It's deliberately a
thin layer: most of the real work already lives in the module that owns
the underlying figures, and reporting composes those seams rather than
re-deriving anything from raw tables a second time.

- **Reuses, rather than reimplements, three other modules' own
  query shapes.** The service-charge report is `gratuity.waiterPayoutTotals`
  directly (already date-range- and shift-scoped); the consumption
  report wraps `consumption.listConsumptionRecords` with a per-person
  rollup; the daily sales report's payment-method breakdown is the same
  shape shifts' own Z-report already built (kept as a small local
  duplicate rather than a shared cross-module helper — the scoping key
  differs, order-closed-date-range here versus `shift_id` there, and
  the duplication is a few lines, not worth a fragile shared internal).
- **The partner-statement reconciliation counts only *original*
  allocations, deliberately excluding reversals** — see
  docs/decisions/012. Summing every `line_allocation` row (reversals
  included) against a line's immutable `allocation_base_minor` breaks
  the moment an order in the period is refunded, since the base never
  changes to reflect a refund but the reversal legitimately cancels the
  original allocation — a false alarm on the one figure the spec
  requires to always read zero. Excluding reversals makes the
  reconciliation prove what it's actually meant to: that the allocation
  engine distributed every sale correctly *at the time it happened*,
  independent of anything that happened to that order afterwards.
  `partnerStatement`'s own headline totals are a separate query and are
  **not** narrowed this way — they're net of refunds, because "how much
  has this partner actually been allocated" is exactly what a partner
  wants their own statement to answer.
- **Every date-range figure is scoped by which *order* closed in
  range**, not by a sub-row's own timestamp — `order.closed_at` decides
  which orders are in scope, and every related row (a payment, a
  `line_allocation`, an `order_line`) is then pulled in by belonging to
  one of those orders. This is what lets the reconciliation stay
  correct regardless of when a refund happens: the reversal is tied to
  the same order as the original sale, so scoping by the order's own
  close date, not the reversal's timestamp, keeps them together.
- **The void-and-discount report reads `audit_log`, not `order`/
  `order_line`'s own columns** — only a line-level void carries its own
  `void_approved_by`; an order-level void's and a discount's actor exist
  only in the audit trail, which was built for exactly this
  ("theft control": who did what, when). A line void's audit entry
  stores the *line* id, not the order id, so its order is resolved via
  one extra lookup against `order_line` — the only place this report
  needs to reach past `audit_log` itself. A discount cleared back to
  zero is excluded from the listing; it isn't a discount that needs
  scrutiny.
- **CSV export is one generic path, not a bespoke shape per report.**
  `reporting/csv.ts`'s `toCsv` is pure and reused by every route: an
  array response becomes one row per element; a single-object response
  (daily sales, a partner statement) becomes one row of its own
  top-level fields, with any nested array/object field (like
  `paymentMethodBreakdown`) JSON-encoded inside its own cell rather than
  spawning a second, nested CSV shape.

## The frontend

`apps/frontend` is a React + Vite PWA covering the spec's twelve
screens, built to `apps/frontend/dist` and served by the same Fastify
process as the API (`buildApp`'s `frontendDir`), so a tablet talks to
exactly one origin and there is no CORS, no second server, and nothing
to keep in sync between two deployments.

### The look is one stylesheet, and it is a design system

`apps/frontend/src/index.css` carries the whole visual language: a token
sheet, then a component layer keyed to the same semantic class names the
screens have always used (`.item-tile`, `.bill-line`, `.floor-list-open`,
`.blocked-notice`, `.pill`). That indirection is the point — the design
was re-cut from a dark slate theme to the Modernist system (light ground,
a single red accent, Archivo, zero corner radius, 2px rules) by rewriting
tokens and rules, not by touching a screen's logic. No component owns a
colour.

Three consequences worth stating, because each was a decision:

- **Archivo is vendored, not fetched.** `@fontsource-variable/archivo` is
  imported in `main.tsx` and its `.woff2` files are built into `dist` and
  precached by the service worker. A till on a restaurant LAN may have no
  route to the internet at all, and type that only arrives when Google is
  reachable is not local-first.
- **Darkness and emphasis are still separate ideas.** The screen shouts
  with case and weight; the receipt does not inherit any of it. The HTML
  receipt renderer and the ESC/POS builder are untouched by this
  stylesheet — see "Thermal darkness is the printer's job".
- **Only labels are uppercased, never amounts.** `text-transform` applies
  to the label half of a total line and to status pills. Money renders
  exactly as `format` produced it, because "RS 880.00" is a number a
  cashier has to decode rather than read.
- **A preview is the real renderer or it is a lie.** Settings shows an
  80mm sample bill, and the print dialog shows the ticket that was just
  sent. Both are `renderBillHtml` output in a sandboxed iframe — the
  same function the fallback print path calls. Re-marking a receipt up
  in React would have been a third renderer, free to disagree with the
  two that reach a customer. `POST /api/printer/receipt-preview` takes
  the DRAFT settings in its body and writes nothing, so the paper
  follows what an admin is typing rather than what they last saved.

The system's own rules are followed rather than approximated: nothing is
rounded, dividers are 2px between sections and 1px between rows, the
accent is spent on the primary action and small emphasis only, and
keyboard focus is a 2px accent ring rather than the browser's blue.

- **There is no "current order" in the frontend either.** Every order
  screen is addressed by its own id in the URL (`/orders/42/bill`), so
  two tills can work two orders at once and a reload lands back on the
  same one. The floor view is a live board of both queues, polled on a
  short interval — this system has one server on one LAN and no push
  channel by design, and a 4-second poll is the simplest thing that
  keeps two tills honest about each other.
- **Money never becomes a bare number on the way through the UI.**
  `MoneyInput` parses what staff type with the money module's own
  `parseRupees`, and every figure on screen renders through `format` —
  the same functions the server uses, from `@pos/shared`. The
  money-arithmetic guard scans `.tsx` as well as `.ts`, so a stray
  `paisa / 100` in a component fails the suite exactly as it would on
  the server — it caught the payment screen's quick-cash suggestions
  doing exactly that, which is why `roundUpTo` now lives in the money
  module rather than in a screen.
- **Adding an item is one click, and the running bill is editable in
  place.** Tapping an item adds it; tapping it again increments the same
  line, because the server merges an identical repeat into it. A dialog
  appears only for an item with modifier groups, and every mandatory
  group opens pre-selected with its first option — a required choice
  needs a default the cashier can confirm or change, not an empty list
  and a server rejection. Quantity is a real input committed on blur or
  Enter, so setting a line to 10 is two keystrokes rather than nine
  clicks.
- **The floor board's three lists come from one server query.** Open,
  awaiting payment and completed are derived server-side from
  `order.status` and the payments recorded against each order
  (`getFloorBoard`), with what is still owed on a part-paid bill. No
  screen filters its own copy, so no screen can leave a settled bill
  sitting in a list of things that still need paying.
- **The bill total shown before printing is the total that prints.**
  `previewBillTotals` runs the same `computeBillTotals` that `billOrder`
  runs, over the same order. Recomputing tax, service charge and
  rounding in the browser would have been a second implementation of the
  money pipeline, free to disagree with the first.
- **Manager approval doesn't sign the till over.** A line void by a
  non-manager gets a 403 from the server; the screen then asks a manager
  for their own username and password, authenticates them for that one call
  (`AuthContext.approveAs`), and retries the void with that token —
  which is dropped immediately after. The cashier stays logged in, and
  the audit row records the manager as the approver, which is what the
  void's `void_approved_by` is for.
- **The server stays the authority on permissions.** Manager-only
  screens are hidden from a cashier's navigation, but that's cosmetic —
  every route behind them enforces its own role server-side, and the UI
  simply avoids showing a screen whose every call would 403.
- **A staff/owner meal settles through a different screen path**, not a
  variant of the payment form: the payment screen switches to the
  consumption settlement form when the order's channel isn't
  `customer`, because the server settles those through
  `settle-consumption`, not `payments`. The settlement-type selector
  disappears entirely for a `full_price` person, since the server
  rejects a settlement type when there's no gap to apply it to.
- **A dead printer never blocks the flow.** Printing is a separate call
  after the bill is already finalised server-side, so a 502/503 from an
  unreachable printer surfaces as "the bill is finalised, only the
  printer failed" with a way onward — matching the local-first rule that
  order-taking and billing keep working with a dead printer.
- **Offline caching is the app shell only.** The service worker
  precaches the built HTML/JS/CSS so a reload survives a server blip,
  and deliberately caches no API response — a cashier must never be
  shown a stale order list, or a bill another terminal has already
  settled. `navigateFallbackDenylist` keeps `/api/*` off the fallback
  entirely so a fetch never receives an HTML shell where it expects
  JSON.
- **`@fastify/static` is registered last, and only when a build
  exists.** Registering it after every route plugin means no static file
  can shadow an API path; skipping it when `apps/frontend/dist` has no
  `index.html` means a server-only deployment and a `vite dev` session
  both work unchanged, with every non-API path simply 404ing.

## Testing approach

- **Unit tests** sit next to the code they test (`*.test.ts`), run by
  Vitest across every workspace package from one root config.
- **Property tests** (`fast-check`) verify the money module's invariants —
  most importantly, that `distribute` (largest-remainder splitting, behind
  both discount proration and, later, partner allocation) always sums
  exactly to its input — over thousands of generated cases, not just a
  handful of examples.
- **The money-arithmetic guard** (`tools/money-arithmetic-guard`) is a
  type-aware static check, run as part of the test suite: it builds a real
  TypeScript `Program` over every source file in `apps/` and `packages/`
  and fails if a `*` or `/` operator appears on a `Paisa`-typed operand
  outside `packages/shared/src/money`. It has its own fixture-based unit
  tests proving the detector actually catches what it claims to (multiply,
  divide, compound-assignment, right-hand-side operands, exclusion paths)
  before it's trusted as a gate over the real workspace.
- **Integration tests** build the real Fastify app (`buildApp`) against a
  real (in-memory) SQLite database and drive it through `app.inject()` —
  no mocking of the database or the HTTP layer.
- **The definition-of-done test**
  (`apps/server/src/definition-of-done.test.ts`) runs the spec's whole
  day as one executable scenario against a seeded database: open the
  shift; a dine-in order with a waiter, a service charge and a line
  voided by a manager; a takeaway with an order-level discount; a
  delivery that is later refunded; a staff meal and an owner meal on
  different policies; a payment split across cash and Easypaisa; the
  bill printed, then paid, then the receipt printed; then close the
  shift and read the Z-report and every partner statement. Then it
  checks the four figures the spec insists on: allocations sum exactly
  to net sales, every partner statement's reconciliation variance is
  exactly zero, expected cash matches a figure computed by hand in a
  comment beside the assertion, and the service charge shows separately
  as held-not-earned rather than inside sales. A second test proves
  that enabling a tax rule changes tax and totals while leaving every
  partner's allocation byte-for-byte identical.
  Printing is not stubbed: the test opens a real TCP socket and the
  ESC/POS bytes genuinely go down it, so the print steps are exercised
  rather than skipped.
- **The concurrency and double-close scenarios** the spec calls out
  separately live in `billing/service.test.ts`, where they belong —
  four tables billed and settled out of order with gap-free invoice
  numbers, and two simultaneous settlements of one order where exactly
  one wins.
