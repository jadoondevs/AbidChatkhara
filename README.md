# Restaurant POS

A local-first, single-writer point-of-sale system for a single restaurant in
Pakistan. See `ARCHITECTURE.md` for how it's put together and why, and
`docs/decisions/` for the reasoning behind specific, non-obvious choices.

This system is being built incrementally, one milestone per branch, merged
to `main` as each lands. **Status: platform, the money module, identity
(users, PIN login, audit log), catalog (menu, prices, modifiers), ordering
(orders through the pro-forma bill, line/order void), partners (the
allocation engine, effective-dated ownership), billing (payments,
settlement, invoice numbering, refunds, ESC/POS printing), and gratuity
(service charge held as a liability for the waiter, not revenue; waiter
payout totals) are done.**
Consumption, shifts, reporting, and the frontend are not
built yet — see `ARCHITECTURE.md` for the current module status.

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

## Running locally

```bash
npm run dev:server
```

This starts the Fastify server (default `http://0.0.0.0:4000`), applying
any pending database migrations on startup. `GET /api/health` should
respond `{"ok":true}`.

There is no seed script yet (that lands with the Definition-of-Done
milestone), so a freshly-migrated database has no users. To create the
first admin account for local testing, use the identity service directly
— see `apps/server/src/identity/service.test.ts` for the pattern
(`createUser` with `actorId: null`, a system action, is how the very first
user is created without an existing actor to attribute it to).

For production use, run the compiled/served process the same way — this
is a single process serving both the JSON API and (once the frontend
milestone lands) the built PWA. `npm run start` runs the same entrypoint
as `dev:server` without the file-watcher.

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
| `POS_PRINTER_HOST` | unset                 | Receipt printer's IP address on the local network      |
| `POS_PRINTER_PORT` | `9100`                | Printer's raw ESC/POS TCP port (9100 is the standard "JetDirect" port) |

`POS_PRINTER_HOST` unset is a supported, working state — the server runs
normally and print routes respond `503` with a clear message instead of
attempting to connect anywhere. There's no admin screen for this (the
spec's screen list doesn't have one), so it's environment-configured like
everything else here rather than a database table.

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
