# Architecture

This document describes the system as actually shipped, kept current in the
same commit as any change that makes it wrong. For the reasoning behind a
specific, non-obvious choice, see `docs/decisions/`.

## Status

Built so far: **platform** (money type, event bus, SQLite/Kysely, migrations,
the durable sync-queue seam, ESC/POS printing), **identity** (users, PIN
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
and **consumption** (staff and owner meals — a named person, a per-person
meal policy that decides what they're charged, and a settlement record
for the gap, all while the owning partner is still credited in full).
Everything else — shifts, reporting, and the frontend — is designed for
(the module boundaries and seams below exist) but not built yet. Each
lands as its own milestone; this file's "Modules" section says, per
module, what exists today.

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
  identity/       users, PIN login, roles, audit log            [BUILT]
  platform/       event bus, money-adjacent infra, db/migrations,
                  sync-queue, ESC/POS printing                   [BUILT — see below]
  catalog/        items, categories, modifiers, prices           [BUILT]
  ordering/       orders, order lines, discounts, lifecycle      [BUILT — open/billed/voided; see below]
  billing/        payments, bill/receipt printing, invoice #s    [BUILT — see below]
  tax/            configurable tax rules (disabled at launch)    [not yet built]
  partners/       partners, ownership shares, allocation engine  [BUILT — see below]
  consumption/    staff and owner meals                          [BUILT — see below]
  gratuity/       service charge, waiter attribution              [BUILT — see below]
  shifts/         shift open/close, Z-reports                    [not yet built]
  reporting/      read-only cross-module queries                 [not yet built]

packages/shared/src/
  money/          the Paisa branded type + all money arithmetic  [BUILT]

apps/frontend/    React PWA                                      [not yet built]
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
when, and from which terminal (audit_log — `identity/tables.ts`). PIN login
(`identity/auth.ts`) issues a bearer token whose *hash* (not the token
itself) is stored in the `session` table, bound to the terminal it was
issued from; a Fastify `preHandler` hook resolves that token into
`request.actor` for every route. A module that needs to attribute a write
takes an `ActorContext { actorId: number | null; terminalId: string }` —
`actorId: null` is reserved for a genuine system action with no human actor
(e.g. the eventual seed script creating the very first admin account,
which can't attribute itself to a user that doesn't exist yet).

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
- **Tax is hardcoded to zero** in `billOrder` — there is no `tax_rule`
  table or engine yet (that's a later milestone, alongside shifts). One
  line in the pipeline changes when it lands; nothing else does.
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
- **No `gratuity/routes.ts` yet, deliberately.** The spec's 12-screen list
  has no dedicated service-charge screen — entry happens implicitly
  through the bill screen ordering already built (entering a service
  charge amount when billing an order), and the payout sheet is a
  shift-close deliverable that belongs to the shifts milestone once
  shifts exist to scope it to. There is nothing for an HTTP route to do
  yet that isn't already reachable through billing's own routes.

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
