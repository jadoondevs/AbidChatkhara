import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openSqlite } from './platform/db/connection.js';
import { createDb } from './platform/db/kysely.js';
import { runMigrations } from './platform/db/migrate.js';
import { seed } from './seed.js';

/**
 * `npm run seed` — migrates a database if needed, then fills it with the
 * demo restaurant in seed.ts. Refuses to touch a database that already
 * has users, so it can never quietly double-seed a real till.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const sqlite = openSqlite(config.dbPath);
  runMigrations(sqlite, config.migrationsDir);
  const db = createDb(sqlite);

  const result = await seed(db);

  /* eslint-disable no-console -- a CLI's whole output is its console */
  console.log(`Seeded ${config.dbPath}`);
  console.log(`  users:           ${Object.keys(result.users).length} (sign in as "${result.usernames.admin}" / 9999 — change before going live)`);
  console.log(`  partners:        ${Object.keys(result.partners).length}`);
  console.log(`  menu items:      ${Object.keys(result.items).length}`);
  console.log(`  people:          ${Object.keys(result.people).length}`);
  console.log(`  payment methods: ${Object.keys(result.paymentMethods).length}`);
  console.log(`  payment accounts:${Object.keys(result.paymentAccounts).length}`);
  /* eslint-enable no-console */

  sqlite.close();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
