import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openSqlite } from './platform/db/connection.js';
import { runMigrations } from './platform/db/migrate.js';
import { countTransactional, resetTransactionalData } from './reset.js';

/* eslint-disable no-console -- a CLI's whole output is its console */

/**
 * `npm run reset:sales -- --confirm` — clear the test orders, payments
 * and shifts so the till can start its real record, keeping the menu and
 * all setup. Backs the database up first, and does nothing at all without
 * the explicit --confirm flag.
 *
 * Run it with the till closed: it is a one-time, pre-go-live action, not
 * something the running app should ever do to itself.
 */

/** A filename-safe local timestamp: 2026-09-04T13:15:07 → 20260904-131507. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes('--confirm') || process.argv.includes('--yes');
  const config = loadConfig();
  mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const sqlite = openSqlite(config.dbPath);
  runMigrations(sqlite, config.migrationsDir);

  const counts = countTransactional(sqlite);

  if (!confirmed) {
    console.log('This will PERMANENTLY delete the test trading record and start fresh:');
    console.log(`  • ${counts.orders} order(s), ${counts.payments} payment(s), ${counts.shifts} shift(s)`);
    console.log('  • the Z-reports, staff/owner-meal records and partner allocations that go with them');
    console.log('  • invoices and order numbers restart at 1');
    console.log('');
    console.log('It KEEPS your menu, prices, modifiers, users, partners, people, payment methods and settings.');
    console.log('A timestamped backup of the whole database is written first.');
    console.log('');
    console.log('Close the till app, then run it again with --confirm to go ahead:');
    console.log('  npm run reset:sales -- --confirm');
    sqlite.close();
    return;
  }

  if (counts.orders === 0 && counts.payments === 0 && counts.shifts === 0) {
    console.log('Nothing to clear — there are no orders, payments or shifts on the books. Left everything as it is.');
    sqlite.close();
    return;
  }

  // Back up the whole database to a fresh file next to it before touching
  // anything. VACUUM INTO writes a single consistent copy (WAL included),
  // so the backup is a complete, openable database on its own.
  const dir = path.dirname(config.dbPath);
  const base = path.basename(config.dbPath).replace(/\.[^.]+$/, '');
  let backupPath = path.join(dir, `${base}-backup-${stamp()}.sqlite`);
  // Never overwrite an existing file — add a counter in the unlikely
  // event two runs land in the same second.
  for (let n = 2; existsSync(backupPath); n += 1) backupPath = path.join(dir, `${base}-backup-${stamp()}-${n}.sqlite`);
  sqlite.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`Backed up to ${backupPath}`);

  const cleared = resetTransactionalData(sqlite);
  // Reclaim the space the deleted rows held.
  sqlite.exec('VACUUM');

  console.log('Cleared the test trading record:');
  console.log(`  • ${cleared.orders} order(s), ${cleared.payments} payment(s), ${cleared.shifts} shift(s) removed`);
  console.log('  • invoices and order numbers now start at 1');
  console.log('Kept the menu, users, partners, people, payment methods and settings.');
  console.log('');
  console.log(`If anything looks wrong, the backup at ${backupPath} is the database exactly as it was.`);

  sqlite.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

/* eslint-enable no-console */
