# Architecture

This document describes the system as actually shipped, kept current in the
same commit as any change that makes it wrong. For the reasoning behind a
specific, non-obvious choice, see `docs/decisions/`.

## Status

Built so far: **platform** (money type, event bus, SQLite/Kysely, migrations,
the durable sync-queue seam), **identity** (users, PIN login, roles, audit
log), **catalog** (categories, items, effective-dated prices, modifier
groups/modifiers, availability), and **ordering** (orders, lines, order-level
discount proration, the open→billed pro-forma-bill flow, line and order
void). Everything else — the partner allocation engine,
billing/payments/printing, service charge, consumption, shifts, reporting,
and the frontend — is designed for (the module boundaries and seams below
exist) but not built yet. Each lands as its own milestone; this file's
"Modules" section says, per module, what exists today.

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
                  sync-queue                                     [BUILT — see below]
  catalog/        items, categories, modifiers, prices           [BUILT]
  ordering/       orders, order lines, discounts, lifecycle      [BUILT — open/billed/voided; see below]
  billing/        payments, bill/receipt printing, invoice #s    [not yet built]
  tax/            configurable tax rules (disabled at launch)    [not yet built]
  partners/       partners, ownership shares, allocation engine  [not yet built]
  consumption/    staff and owner meals                          [not yet built]
  gratuity/       service charge, waiter attribution              [not yet built]
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
