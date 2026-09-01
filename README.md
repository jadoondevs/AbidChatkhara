# Restaurant POS

A local-first, single-writer point-of-sale system for a single restaurant in
Pakistan. See `ARCHITECTURE.md` for how it's put together and why, and
`docs/decisions/` for the reasoning behind specific, non-obvious choices.

This system is being built incrementally, one milestone per branch, merged
to `main` as each lands. **Status: platform, the money module, identity
(users, username/password login, audit log), catalog (menu, prices, modifiers), ordering
(orders through the pro-forma bill, line/order void), partners (the
allocation engine, effective-dated ownership), billing (payments,
settlement, invoice numbering, refunds, ESC/POS printing), gratuity
(service charge held as a liability for the waiter, not revenue; waiter
payout totals), consumption (staff and owner meals — a per-person
meal policy, settled separately from the partner's own full-value
credit), tax (configurable rules, shipped with none active), shifts
(open/close, cash reconciliation, Z-report, waiter payout sheet),
reporting (all six spec-required reports, each CSV-exportable), and the
frontend (an installable React PWA covering all twelve screens) are
done, and the definition-of-done pass is complete** — a seed script,
plus an executable full-day test that runs the spec's whole scenario
offline and checks every closing figure it names. See `ARCHITECTURE.md`
for how it's put together.

## Requirements

- Node.js 22 or later
- A C/C++ toolchain (`gcc`/`g++`/`make`, or the platform equivalent) to
  build `better-sqlite3`'s native module on `npm install`
- No internet connection required to run

## Setup

```bash
npm install
cp .env.example .env   # adjust POS_PORT / POS_DB_PATH if needed
```

## Running it

One process serves both the JSON API and the tablet app, so a normal
run is: build the frontend once, then start the server.

```bash
npm run build:frontend   # writes apps/frontend/dist
npm run start            # serves the API and that build on :4000
```

Open `http://<server-ip>:4000` on the till. Migrations are applied on
startup; `GET /api/health` responds `{"ok":true}`.

Build the frontend **before** starting the server, not after: the server
indexes `apps/frontend/dist` when it boots, so a rebuild while it is
running leaves it serving asset filenames that no longer exist (a blank
page). Restart it after any rebuild.

A freshly-migrated database has no users, so nothing can log in yet. For
a demo or a test day, seed it:

```bash
npm run seed          # honours POS_DB_PATH, same as the server
```

That creates an obviously-fictional restaurant: five users, a menu of
eight items across four categories, three partners (some items
single-owner, some shared, one modifier owned separately from the item
it sits on), six people on every different meal policy, and the three
payment methods, three payment accounts, and placeholder restaurant
details. Sign in as `amina` with password `9999`. **Change every
password and the placeholder account details before going live** —
they're sequential and fake on purpose. The script refuses to run
against a database that already has users, so it can't quietly
double-seed a real till.

For a real restaurant, create the first admin account directly instead
— see `apps/server/src/identity/service.test.ts` for the pattern
(`createUser` with `actorId: null`, a system action, is how the very first
user is created without an existing actor to attribute it to). After
that, everything else is configured from the app: **Settings** (admin
only) holds the restaurant's name and address, the receipt wording, the
printer, the Easypaisa and bank accounts money arrives in, and the login
accounts themselves.

### Payment accounts

Easypaisa and bank payments have to say **which** of the restaurant's
accounts received the money, so each non-cash method needs at least one
active account configured under **Settings → Payment accounts** before a
cashier can accept it:

| Active accounts for the method | What the cashier sees |
| ------------------------------ | --------------------- |
| none | The method is flagged "not set up" and the payment is blocked, with the reason and where to fix it |
| one  | It is selected automatically; the screen names where the money is going |
| two or more | An account picker, required before the payment can be recorded |

Cash needs no account — it is handed over at the till and lands in the
drawer. The rule is enforced in the service, not just the screen (see
`docs/decisions/017`), so it holds for any caller.

Accounts are **deactivated, never deleted**: a payment references the
account it landed in, and deleting one would orphan that answer on every
historical payment. Deactivating the last active account for a method is
the same statement as "we no longer take Easypaisa" — that method is
then blocked until another is added.

### Printing

Printer configuration is **optional**. Receipts print by whichever route
is available:

1. **A configured, reachable POS printer** — the receipt goes straight
   to it as ESC/POS over raw TCP, with no dialog, exactly as before.
2. **No printer configured, or the configured one cannot be reached** —
   the server hands the till the same ticket as HTML and the browser
   opens the normal Windows print dialog, where **Microsoft Print to
   PDF** and every installed printer are available.

A print is never allowed to fail a sale. By the time a receipt is
printed the payment is already recorded, so a missing printer, an
unreachable one, or a cancelled print dialog all leave the sale intact
and Reprint receipt available. Both paths render the same ticket data,
so the total on a PDF printed from Windows is the total on the thermal
ticket to the paisa (see `docs/decisions/018`).

Account numbers are masked to their last four digits on a printed
ticket.

### Upgrading an existing database

Sign-in changed from "pick your user id, tap a PIN" to a username and a
password typed on a keyboard. Migration `0011` adds a `username` to
every existing user, derived from the first word of their name
(`Amina Qureshi` → `amina`), and **nobody's credential is touched** — the
PIN they already had is still their password, because a PIN is just a
short password and the column has always held a salted hash of whatever
they type. Two people sharing a first name get `name.id` (`ali.3`), and
an admin can rename anyone from Settings → Users afterwards.

**One thing does need doing by hand after upgrading**: an existing
database has no payment accounts, so Easypaisa and bank transfers are
blocked until an admin adds at least one under Settings → Payment
accounts. Cash is unaffected and keeps working throughout. The till says
exactly this when a cashier selects a method with no account, rather
than failing at the moment of payment — but a restaurant that takes
Easypaisa should configure it before its next service rather than
discover it at the counter.

Nothing else needs to be done by hand: start the new server against the
existing database and it migrates on startup, as always. Historical
payments recorded before this rule keep their empty account and are left
untouched.

### Developing

```bash
npm run dev:server     # API on :4000, restarts on change
npm run dev:frontend   # Vite on :5173, proxying /api to :4000
```

With no `apps/frontend/dist` present the server runs API-only and every
non-API path 404s, which is exactly what you want while Vite is serving
the app itself.

### Installing on the till

The frontend is a PWA: open it in Chrome and use "Install". It is built
for a normal POS computer with a mouse and a physical keyboard —
1280×800 and up, laid out so nothing important scrolls out of reach at
the narrow end. The built app shell is cached by a service worker so a
reload still works if the server blips. API responses are deliberately never cached — a
cashier must never be shown a stale order list, or a bill another
terminal has already settled.

## Testing, linting, type-checking

```bash
npm test          # vitest, once, across every workspace package
npm run test:watch
npm run lint
npm run typecheck  # tsc --noEmit in every workspace package
```

The test suite includes the money-arithmetic guard
(`tools/money-arithmetic-guard`), which type-checks every source file
under `apps/` and `packages/` and fails if a `*` or `/` operator appears on
a `Paisa`-typed value anywhere outside `packages/shared/src/money` — see
`docs/decisions/001-integer-money-and-paisa-type.md`.

## Configuration

Configuration is environment-variable based (see `.env.example`), never
committed to git:

| Variable           | Default             | Meaning                                              |
| ------------------ | -------------------- | ----------------------------------------------------- |
| `POS_PORT`         | `4000`                | HTTP port                                              |
| `POS_HOST`         | `0.0.0.0`             | Bind address                                           |
| `POS_DB_PATH`      | `./data/pos.sqlite`   | SQLite database file                                   |
| `POS_PRINTER_HOST` | unset                 | Fallback receipt-printer address; **Settings → Printer wins over this** |
| `POS_PRINTER_PORT` | `9100`                | Printer's raw ESC/POS TCP port (9100 is the standard "JetDirect" port) |
| `POS_FRONTEND_DIR` | `apps/frontend/dist`  | Built PWA to serve; API-only if it holds no `index.html` |

The printer is normally configured in the app, under **Settings →
Printer**, which is where an admin can change it without touching the
machine. `POS_PRINTER_HOST` remains as a fallback for a server that has
never had one set, and a Settings value always wins — an admin who has
typed an address into the POS is stating the current truth, and should
not have to know a stale value exists in a `.env` file. Printing can
also be switched off there entirely, which is what you want while the
printer is away for repair: prints then fail immediately with a clear
message instead of every bill waiting on a connection that will never
answer.

Neither configured is a supported, working state — the server runs
normally and print routes respond `503` with a clear message instead of
attempting to connect anywhere.

**Restaurant name, address, phone and receipt wording are NOT
environment variables and are not compiled in.** They live in the
database, set from Settings, and an installation that has configured
none prints a ticket with no restaurant identity at all rather than a
placeholder somebody has to notice and remove.

## Backup and restore

The database is a single SQLite file in WAL mode at `POS_DB_PATH` (plus
its `-wal` and `-shm` siblings, which must be backed up alongside it if the
server is running at backup time — see below).

**Backup while the server is stopped** (simplest, always safe): copy the
three files (`pos.sqlite`, `pos.sqlite-wal`, `pos.sqlite-shm` — the latter
two may not exist if WAL has fully checkpointed) to your backup location.

**Backup while the server is running**: use SQLite's online backup
mechanism rather than copying the file directly, since a plain file copy
of a live WAL-mode database can capture an inconsistent state. From a
shell with `sqlite3` installed:

```bash
sqlite3 /path/to/pos.sqlite ".backup /path/to/backups/pos-$(date +%Y%m%d-%H%M%S).sqlite"
```

This produces a single consistent snapshot file, safe to copy off-box
immediately. Run this on a schedule (e.g. a nightly cron job) and keep
backups off the restaurant's own machine — a local-only backup does not
protect against the machine itself failing.

**Restore**:

1. Stop the server.
2. Move the current `POS_DB_PATH` file (and any `-wal`/`-shm` siblings)
   aside rather than deleting them, in case the restore needs to be
   aborted.
3. Copy the chosen backup file to `POS_DB_PATH`.
4. Start the server. It will apply any migrations newer than the backup
   automatically, the same as on any other startup.
5. Verify: `GET /api/health` responds, and a spot-check query (e.g. listing
   users) returns the data you expect from that backup.

The underlying mechanism (SQLite's online backup API, which `sqlite3
<db> ".backup ..."` invokes) is exercised by an automated test —
`apps/server/src/platform/db/backup-restore.test.ts` — that opens a
database exactly as the server does, backs it up while the handle stays
open (simulating a live server), restores it by moving the snapshot into
place, and confirms every row survives intact. The standalone `sqlite3`
CLI itself wasn't available in the environment this was built in, so the
test drives the same backup API through `better-sqlite3`'s `.backup()`
method instead — the same underlying SQLite mechanism, exercised the way
Node code would call it directly if you'd rather script backups than
shell out to the CLI.

## Repository layout

See `ARCHITECTURE.md`.
